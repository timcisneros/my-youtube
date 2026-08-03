/**
 * Small local-file helper retained for compatibility with existing callers
 * and tests. Production downloads use download-files.ts and are guarded by
 * download-storage.ts; the unused S3 client was removed from the runtime.
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { projectPath } from './project-paths.js';

const DATA_DIR = projectPath('data', 'downloads');

function localPath(key: string) {
  return path.join(DATA_DIR, key);
}

async function initStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  return false;
}

function isS3() {
  return false;
}

async function putBuffer(key: string, buffer: Buffer, _metadata: { contentType?: string } = {}) {
  const filePath = localPath(key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function getStream(key: string) {
  const filePath = localPath(key);
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return createReadStream(filePath);
}

async function stat(key: string) {
  try {
    const entry = await fs.stat(localPath(key));
    return { size: entry.size, exists: true };
  } catch {
    return { size: 0, exists: false };
  }
}

async function del(key: string) {
  await fs.rm(localPath(key), { force: true }).catch(() => {});
}

export { initStorage, isS3, putBuffer, getStream, stat, del };
