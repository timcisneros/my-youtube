import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import LRUMap from './lru-map.js';
import { incrementMetric } from './performance-metrics.js';
import { projectPath } from './project-paths.js';

const DOWNLOADS_DIR = projectPath('data', 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

type DownloadedFormat = {
  formatId: string;
  filePath: string;
  size: number;
  ranges?: DownloadedFormatRanges;
};

type DownloadedFormatRanges = {
  initRange: string;
  indexRange: string;
};

const statCache = new LRUMap<string, { entry: DownloadedFormat | null; expiresAt: number }>(2000);
const manifestCache = new LRUMap<string, {
  exists: boolean;
  entries: DownloadedFormat[];
  expiresAt: number;
}>(2000);
const manifestWrites = new Map<string, Promise<DownloadedFormat[]>>();
const STAT_CACHE_TTL_MS = 5000;
// A modest positive TTL keeps segment requests syscall-free while bounding
// cross-worker staleness when another worker finishes a new local format.
const MANIFEST_CACHE_TTL_MS = Math.min(5 * 60_000, Math.max(
  5_000,
  Number(process.env.DOWNLOAD_MANIFEST_CACHE_TTL_MS) || 30_000,
));
const MANIFEST_NEGATIVE_TTL_MS = Math.min(30_000, Math.max(
  1_000,
  Number(process.env.DOWNLOAD_MANIFEST_NEGATIVE_TTL_MS) || 5_000,
));

function validPart(value: string) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function downloadedFormatPath(videoId: string, formatId: string) {
  if (!validPart(videoId) || !validPart(formatId)) throw new Error('Invalid download file identifier');
  return path.join(DOWNLOADS_DIR, `mycache-${videoId}-${formatId}.dat`);
}

function downloadedFormatManifestPath(videoId: string) {
  if (!validPart(videoId)) throw new Error('Invalid download file identifier');
  return path.join(DOWNLOADS_DIR, `mycache-${videoId}.formats.json`);
}

function validByteRange(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d+)-(\d+)$/);
  return Boolean(match && Number(match[2]) >= Number(match[1]));
}

function normalizedRanges(value: unknown): DownloadedFormatRanges | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ranges = value as Partial<DownloadedFormatRanges>;
  if (!validByteRange(ranges.initRange) || !validByteRange(ranges.indexRange)) return undefined;
  return { initRange: ranges.initRange, indexRange: ranges.indexRange };
}

function invalidateDownloadedVideo(videoId: string) {
  manifestCache.delete(videoId);
  for (const key of [...statCache.keys()]) {
    if (key.startsWith(`${videoId}:`)) statCache.delete(key);
  }
}

async function discoverDownloadedFormats(videoId: string): Promise<DownloadedFormat[]> {
  const prefix = `mycache-${videoId}-`;
  const directory = await fs.promises.opendir(DOWNLOADS_DIR).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!directory) return [];
  const formatIds: string[] = [];
  for await (const entry of directory) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.dat')) continue;
    const formatId = entry.name.slice(prefix.length, -4);
    if (validPart(formatId)) formatIds.push(formatId);
  }
  const entries = await Promise.all(formatIds.map(formatId => statDownloadedFormat(videoId, formatId)));
  return entries.filter((entry): entry is DownloadedFormat => entry !== null);
}

async function writeDownloadedFormatManifest(videoId: string, entries: DownloadedFormat[]) {
  const manifestPath = downloadedFormatManifestPath(videoId);
  const temporaryPath = `${manifestPath}.part-${process.pid}-${randomUUID()}`;
  const normalized = entries
    .filter(entry => validPart(entry.formatId) && entry.size > 0)
    .sort((a, b) => a.formatId.localeCompare(b.formatId));
  const payload = JSON.stringify({
    version: 1,
    formats: normalized.map(entry => ({
      formatId: entry.formatId,
      size: entry.size,
      ...(entry.ranges ? { ranges: entry.ranges } : {}),
    })),
  });
  await fs.promises.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.promises.rename(temporaryPath, manifestPath);
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  manifestCache.set(videoId, { exists: true, entries: normalized, expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS });
  return normalized;
}

function queueManifestWrite(
  videoId: string,
  operation: () => Promise<DownloadedFormat[]>,
): Promise<DownloadedFormat[]> {
  const previous = manifestWrites.get(videoId);
  const write = (previous !== undefined ? previous.catch(() => []) : Promise.resolve([]))
    .then(operation)
    .finally(() => {
      if (manifestWrites.get(videoId) === write) manifestWrites.delete(videoId);
    });
  manifestWrites.set(videoId, write);
  return write;
}

async function refreshDownloadedFormatManifest(videoId: string): Promise<DownloadedFormat[]> {
  if (!validPart(videoId)) return [];
  return queueManifestWrite(videoId, async () => {
    const previous = await readDownloadedFormatManifest(videoId);
    invalidateDownloadedVideo(videoId);
    const entries = await discoverDownloadedFormats(videoId);
    const previousById = new Map(previous.entries.map(entry => [entry.formatId, entry]));
    return writeDownloadedFormatManifest(videoId, entries.map(entry => {
      const ranges = previousById.get(entry.formatId)?.ranges;
      return ranges ? { ...entry, ranges } : entry;
    }));
  });
}

async function recordDownloadedFormats(
  videoId: string,
  formats: Array<{ formatId: string; size: number }>,
) {
  if (!validPart(videoId)) return [];
  const normalized = formats.filter(format => validPart(format.formatId) && Number(format.size) > 0);
  if (!normalized.length) return listDownloadedFormats(videoId);
  return queueManifestWrite(videoId, async () => {
    const manifest = await readDownloadedFormatManifest(videoId);
    const merged = new Map(manifest.entries.map(entry => [entry.formatId, entry]));
    for (const format of normalized) {
      const existing = merged.get(format.formatId);
      merged.set(format.formatId, {
        formatId: format.formatId,
        filePath: downloadedFormatPath(videoId, format.formatId),
        size: Number(format.size),
        ...(existing?.ranges ? { ranges: existing.ranges } : {}),
      });
    }
    return writeDownloadedFormatManifest(videoId, [...merged.values()]);
  });
}

async function recordDownloadedFormatRanges(
  videoId: string,
  rangesByFormat: Record<string, DownloadedFormatRanges>,
) {
  if (!validPart(videoId)) return [];
  const updates = Object.entries(rangesByFormat)
    .filter(([formatId, ranges]) => validPart(formatId) && Boolean(normalizedRanges(ranges)));
  if (!updates.length) return listDownloadedFormats(videoId);
  return queueManifestWrite(videoId, async () => {
    const manifest = await readDownloadedFormatManifest(videoId);
    if (!manifest.exists) return [];
    const byId = new Map(manifest.entries.map(entry => [entry.formatId, entry]));
    for (const [formatId, ranges] of updates) {
      const existing = byId.get(formatId);
      const normalized = normalizedRanges(ranges);
      if (existing && normalized) byId.set(formatId, { ...existing, ranges: normalized });
    }
    return writeDownloadedFormatManifest(videoId, [...byId.values()]);
  });
}

async function removeDownloadedFormatRecords(videoId: string, formatIds: string[]) {
  if (!validPart(videoId)) return [];
  const removals = new Set(formatIds.filter(validPart));
  if (!removals.size) return listDownloadedFormats(videoId);
  return queueManifestWrite(videoId, async () => {
    const manifest = await readDownloadedFormatManifest(videoId);
    if (!manifest.exists) return [];
    return writeDownloadedFormatManifest(
      videoId,
      manifest.entries.filter(entry => !removals.has(entry.formatId)),
    );
  });
}

async function readDownloadedFormatManifest(videoId: string): Promise<{
  exists: boolean;
  entries: DownloadedFormat[];
}> {
  try {
    const raw = await fs.promises.readFile(downloadedFormatManifestPath(videoId), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.formats)) throw new Error('Invalid download manifest');
    const entries = parsed.formats
      .filter(entry => entry && validPart(String(entry.formatId)) && Number(entry.size) > 0)
      .map(entry => ({
        formatId: String(entry.formatId),
        filePath: downloadedFormatPath(videoId, String(entry.formatId)),
        size: Number(entry.size),
        ...(normalizedRanges(entry.ranges) ? { ranges: normalizedRanges(entry.ranges) } : {}),
      }));
    return { exists: true, entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError
      || (error as Error).message === 'Invalid download manifest') return { exists: false, entries: [] };
    throw error;
  }
}

async function backfillDownloadedFormatManifests(concurrency = 8, batchSize = 256) {
  const directory = await fs.promises.opendir(DOWNLOADS_DIR).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!directory) return 0;
  const boundedConcurrency = Math.min(32, Math.max(1, concurrency));
  const boundedBatchSize = Math.min(2_000, Math.max(boundedConcurrency, batchSize));
  let grouped = new Map<string, Set<string>>();
  let batchedFiles = 0;
  let created = 0;
  const flush = async () => {
    const videos = [...grouped.entries()];
    grouped = new Map();
    batchedFiles = 0;
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(boundedConcurrency, videos.length) }, async () => {
      while (nextIndex < videos.length) {
        const [videoId, formatIds] = videos[nextIndex++];
        const previous = await readDownloadedFormatManifest(videoId);
        const discovered = (await Promise.all([...formatIds]
          .map(formatId => statDownloadedFormat(videoId, formatId))))
          .filter((entry): entry is DownloadedFormat => entry !== null);
        const merged = new Map(previous.entries.map(entry => [entry.formatId, entry]));
        for (const entry of discovered) {
          const ranges = merged.get(entry.formatId)?.ranges;
          merged.set(entry.formatId, ranges ? { ...entry, ranges } : entry);
        }
        await writeDownloadedFormatManifest(videoId, [...merged.values()]);
        if (!previous.exists) created++;
      }
    });
    await Promise.all(workers);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  for await (const entry of directory) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^mycache-([A-Za-z0-9_-]{11})-([A-Za-z0-9_-]{1,64})\.dat$/);
    if (!match) continue;
    const formats = grouped.get(match[1]) || new Set<string>();
    formats.add(match[2]);
    grouped.set(match[1], formats);
    batchedFiles++;
    if (batchedFiles >= boundedBatchSize) await flush();
  }
  if (batchedFiles > 0) await flush();
  return created;
}

async function statDownloadedFormat(videoId: string, formatId: string): Promise<DownloadedFormat | null> {
  const key = `${videoId}:${formatId}`;
  const cached = statCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.entry;
  const filePath = downloadedFormatPath(videoId, formatId);
  let entry: DownloadedFormat | null = null;
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile() && stat.size > 0) entry = { formatId, filePath, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  statCache.set(key, { entry, expiresAt: Date.now() + (entry ? STAT_CACHE_TTL_MS : 500) });
  return entry;
}

async function getDownloadedFormat(videoId: string, formatId: string): Promise<DownloadedFormat | null> {
  if (!validPart(videoId) || !validPart(formatId)) return null;
  const entries = await listDownloadedFormats(videoId);
  return entries.find(entry => entry.formatId === formatId) || null;
}

async function listDownloadedFormats(videoId: string): Promise<DownloadedFormat[]> {
  if (!validPart(videoId)) return [];
  const cached = manifestCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  const manifest = await readDownloadedFormatManifest(videoId);
  if (manifest.exists) {
    manifestCache.set(videoId, {
      exists: true,
      entries: manifest.entries,
      expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS,
    });
    return manifest.entries;
  }
  // Deployment migration and download completion maintain manifests. A
  // request must not turn a missing/corrupt index into an O(library) scan.
  incrementMetric('download_manifest_misses_total');
  manifestCache.set(videoId, {
    exists: false,
    entries: [],
    expiresAt: Date.now() + MANIFEST_NEGATIVE_TTL_MS,
  });
  return [];
}

async function deleteVideoDownloadFiles(videoId: string) {
  if (!validPart(videoId)) return 0;
  invalidateDownloadedVideo(videoId);
  const entries = await listDownloadedFormats(videoId);
  const deletedSizes = await Promise.all(entries.map(entry => fs.promises.unlink(entry.filePath)
    .then(() => entry.size, () => 0)));
  await fs.promises.unlink(downloadedFormatManifestPath(videoId)).catch(() => {});
  invalidateDownloadedVideo(videoId);
  return deletedSizes.reduce((total, size) => total + size, 0);
}

export {
  DOWNLOADS_DIR,
  backfillDownloadedFormatManifests,
  deleteVideoDownloadFiles,
  downloadedFormatManifestPath,
  downloadedFormatPath,
  getDownloadedFormat,
  invalidateDownloadedVideo,
  listDownloadedFormats,
  recordDownloadedFormats,
  recordDownloadedFormatRanges,
  removeDownloadedFormatRecords,
  refreshDownloadedFormatManifest,
};
export type { DownloadedFormat, DownloadedFormatRanges };
