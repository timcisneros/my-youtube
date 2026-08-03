const MAX_EXTRACTION_FORMATS = Math.max(64, Number(process.env.EXTRACTION_MAX_FORMATS) || 512);
const MAX_STORYBOARD_FRAGMENTS = Math.max(100, Number(process.env.EXTRACTION_MAX_STORYBOARD_FRAGMENTS) || 2000);
const MAX_MANUAL_SUBTITLE_LANGUAGES = Math.max(10, Number(process.env.EXTRACTION_MAX_SUBTITLE_LANGUAGES) || 100);
const MAX_SUBTITLE_VARIANTS = 8;
const MAX_CHAPTERS = 500;

const FORMAT_FIELDS = [
  'format_id', 'itag', 'url', 'manifest_url', 'protocol', 'ext', 'container',
  'format', 'format_note', 'resolution', 'width', 'height', 'fps', 'aspect_ratio',
  'vcodec', 'acodec', 'abr', 'vbr', 'tbr', 'asr', 'audio_channels',
  'filesize', 'filesize_approx', 'language', 'language_preference',
  'quality', 'source_preference', 'preference', 'dynamic_range',
] as const;

const TOP_LEVEL_FIELDS = [
  'id', 'title', 'uploader', 'channel_id', 'description', 'duration', 'language',
  'live_status', 'is_live', 'was_live', 'upload_date', 'timestamp', 'release_timestamp',
  'view_count', 'concurrent_view_count', 'like_count', 'channel_follower_count',
  '_unavailable', '_pending', '_overloaded', '_permanent', '_scheduledStart', '_extractedVia', '_extractionTimings',
] as const;

function copyDefined(source, keys: readonly string[]) {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function compactFormat(format) {
  const result = copyDefined(format, FORMAT_FIELDS);
  if (format?.protocol === 'mhtml' && Array.isArray(format.fragments)) {
    result.fragments = format.fragments.slice(0, MAX_STORYBOARD_FRAGMENTS).map(fragment => ({
      ...(fragment.url !== undefined ? { url: fragment.url } : {}),
      ...(fragment.path !== undefined ? { path: fragment.path } : {}),
      ...(fragment.duration !== undefined ? { duration: fragment.duration } : {}),
    }));
    if (format.rows !== undefined) result.rows = format.rows;
    if (format.columns !== undefined) result.columns = format.columns;
  }
  return result;
}

function compactFormats(formats) {
  if (!Array.isArray(formats)) return [];
  if (formats.length <= MAX_EXTRACTION_FORMATS) return formats.map(compactFormat);
  // Preserve storyboard formats even when an extractor returns an unexpectedly
  // large media ladder; they are usually last and would otherwise be truncated.
  const storyboards = formats.filter(format => format?.protocol === 'mhtml');
  const media = formats.filter(format => format?.protocol !== 'mhtml');
  return [
    ...media.slice(0, Math.max(0, MAX_EXTRACTION_FORMATS - storyboards.length)),
    ...storyboards.slice(0, MAX_EXTRACTION_FORMATS),
  ].slice(0, MAX_EXTRACTION_FORMATS).map(compactFormat);
}

function compactSubtitleTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  return tracks.slice(0, MAX_SUBTITLE_VARIANTS).map(track => ({
    ...(track.ext !== undefined ? { ext: track.ext } : {}),
    ...(track.name !== undefined ? { name: track.name } : {}),
    // Retain the selected caption URL so the web process can fetch VTT
    // directly. Subtitle routes validate the hostname before using it and
    // fall back to yt-dlp if the signed URL has expired.
    ...(track.ext === 'vtt' && track.url !== undefined ? { url: track.url } : {}),
  }));
}

function compactSubtitleMap(source, automatic = false) {
  if (!source || typeof source !== 'object') return {};
  const entries = automatic
    ? ['en', 'en-orig'].filter(key => Array.isArray(source[key])).map(key => [key, source[key]])
    : Object.entries(source).slice(0, MAX_MANUAL_SUBTITLE_LANGUAGES);
  return Object.fromEntries(entries.map(([language, tracks]) => [language, compactSubtitleTracks(tracks)]));
}

function compactExtractionResult(info) {
  if (!info || typeof info !== 'object') return info;
  const result = copyDefined(info, TOP_LEVEL_FIELDS);
  const stringLimits = {
    id: 100, title: 1000, uploader: 500, channel_id: 200,
    description: 20_000, language: 100, live_status: 100,
    upload_date: 20, _unavailable: 2_000, _scheduledStart: 100, _extractedVia: 200,
  };
  for (const [field, limit] of Object.entries(stringLimits)) {
    if (result[field] !== undefined) result[field] = String(result[field]).slice(0, limit);
  }
  result.formats = compactFormats(info.formats);
  if (Array.isArray(info.tags)) result.tags = info.tags.slice(0, 50).map(value => String(value).slice(0, 200));
  if (Array.isArray(info.keywords)) result.keywords = info.keywords.slice(0, 50).map(value => String(value).slice(0, 200));
  if (info.subtitles) result.subtitles = compactSubtitleMap(info.subtitles);
  if (info.automatic_captions) result.automatic_captions = compactSubtitleMap(info.automatic_captions, true);
  if (Array.isArray(info.chapters)) {
    result.chapters = info.chapters.slice(0, MAX_CHAPTERS).map(chapter => ({
      start_time: chapter.start_time,
      end_time: chapter.end_time,
      title: String(chapter.title || '').slice(0, 500),
    }));
  }
  return result;
}

export { compactExtractionResult };
