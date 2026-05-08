import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const FIXTURE_VIDEO_ID = 'PLAYERTEST1';
const FIXTURE_DIR = path.join(os.tmpdir(), 'my-youtube-player-fixtures');
const FIXTURE_DURATION = 6;
const FIXTURE_VIDEO_REPS = [
  { formatId: 'v240', width: 426, height: 240, bandwidth: 350_000, bitrate: '350k' },
  { formatId: 'v360', width: 640, height: 360, bandwidth: 800_000, bitrate: '800k' },
  { formatId: 'v720', width: 1280, height: 720, bandwidth: 1_800_000, bitrate: '1800k' },
];
const fixtureFaultCounts = new Map<string, number>();
const fixtureLiveSeq = new Map<string, number>();

type BoxRange = { start: number; end: number };
type FixtureFormat = {
  formatId: string;
  filePath: string;
  contentType: string;
  initRange: BoxRange;
  indexRange: BoxRange;
  bandwidth: number;
  codecs: string;
  width?: number;
  height?: number;
  audioSamplingRate?: number;
};

function isPlayerFixtureEnabled() {
  return process.env.PLAYER_FIXTURES === '1';
}

function isPlayerFixtureVideo(videoId: string) {
  return isPlayerFixtureEnabled() && videoId === FIXTURE_VIDEO_ID;
}

function ensureFixtureFiles() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const audioPath = path.join(FIXTURE_DIR, 'audio.mp4');
  const videoPaths = FIXTURE_VIDEO_REPS.map(rep => path.join(FIXTURE_DIR, `${rep.formatId}.mp4`));
  if (fs.existsSync(audioPath) && videoPaths.every(filePath => fs.existsSync(filePath))) return;

  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=${FIXTURE_VIDEO_REPS[0].width}x${FIXTURE_VIDEO_REPS[0].height}:rate=24:duration=${FIXTURE_DURATION}`,
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${FIXTURE_DURATION}`,
    ...FIXTURE_VIDEO_REPS.flatMap((rep, index) => [
      '-map', '0:v',
      '-an',
      '-vf', `scale=${rep.width}:${rep.height}`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-profile:v', 'baseline',
      '-level:v', '3.1',
      '-pix_fmt', 'yuv420p',
      '-b:v', rep.bitrate,
      '-maxrate', rep.bitrate,
      '-bufsize', rep.bitrate,
      '-g', '24',
      '-keyint_min', '24',
      '-sc_threshold', '0',
      '-movflags', '+faststart+dash+frag_keyframe+global_sidx',
      videoPaths[index],
    ]),
    '-map', '1:a',
    '-vn',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-movflags', '+faststart+dash+frag_keyframe+global_sidx',
    audioPath,
  ], { stdio: 'ignore' });
}

function fixtureVideoFormats(): Record<string, FixtureFormat> {
  return Object.fromEntries(FIXTURE_VIDEO_REPS.map(rep => {
    const filePath = path.join(FIXTURE_DIR, `${rep.formatId}.mp4`);
    return [rep.formatId, {
      formatId: rep.formatId,
      filePath,
      contentType: 'video/mp4',
      ...rangesFor(filePath),
      bandwidth: rep.bandwidth,
      codecs: 'avc1.42c01f',
      width: rep.width,
      height: rep.height,
    }];
  }));
}

function getFixtureFormats(): Record<string, FixtureFormat> {
  ensureFixtureFiles();
  const audioPath = path.join(FIXTURE_DIR, 'audio.mp4');
  return {
    ...fixtureVideoFormats(),
    a64: {
      formatId: 'a64',
      filePath: audioPath,
      contentType: 'audio/mp4',
      ...rangesFor(audioPath),
      bandwidth: 64_000,
      codecs: 'mp4a.40.2',
      audioSamplingRate: 44100,
    },
  };
}

function rangeAttr(range: BoxRange) {
  return `${range.start}-${range.end}`;
}

function buildFixtureMPD(videoId: string, query: Record<string, unknown> = {}) {
  const formats = getFixtureFormats();
  const videos = FIXTURE_VIDEO_REPS.map(rep => formats[rep.formatId]);
  const audio = formats.a64;
  const faultQuery = fixtureFaultQuery(query);
  const templateMode = firstQueryValue(query.fixtureTemplate);
  const segmentListMode = firstQueryValue(query.fixtureSegmentList);
  if (firstQueryValue(query.fixtureLive)) return buildFixtureLiveMPD(videoId, videos, audio, query);
  if (templateMode) return buildFixtureTemplateMPD(videoId, videos, audio, templateMode);
  if (segmentListMode) return buildFixtureSegmentListMPD(videoId, videos, audio, segmentListMode);
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT${FIXTURE_DURATION}.000S" minBufferTime="PT0.5S">
<Period duration="PT${FIXTURE_DURATION}.000S">
<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
${videos.map(video => `<Representation id="${video.formatId}" bandwidth="${video.bandwidth}" width="${video.width}" height="${video.height}" codecs="${video.codecs}">
<BaseURL>/api/stream/${videoId}/fmt/${video.formatId}${faultQuery}</BaseURL>
<SegmentBase indexRange="${rangeAttr(video.indexRange)}"><Initialization range="${rangeAttr(video.initRange)}"/></SegmentBase>
</Representation>`).join('\n')}
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">
<Representation id="${audio.formatId}" bandwidth="${audio.bandwidth}" codecs="${audio.codecs}" audioSamplingRate="${audio.audioSamplingRate}">
<BaseURL>/api/stream/${videoId}/fmt/${audio.formatId}${faultQuery}</BaseURL>
<SegmentBase indexRange="${rangeAttr(audio.indexRange)}"><Initialization range="${rangeAttr(audio.initRange)}"/></SegmentBase>
</Representation>
</AdaptationSet>
</Period>
</MPD>`;
}

function buildFixtureHlsMaster(videoId: string, query: Record<string, unknown> = {}) {
  const formats = getFixtureFormats();
  const videos = FIXTURE_VIDEO_REPS.map(rep => formats[rep.formatId]);
  const mediaGroups = firstQueryValue(query.fixtureHls) === 'groups';
  const hlsQuery = mediaGroups ? 'fixtureHls=groups' : 'fixtureHls=1';
  const subtitleData = encodeURIComponent('WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nNative HLS captions\n');
  return `#EXTM3U
#EXT-X-VERSION:7
${mediaGroups ? `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="/api/stream/${videoId}/hls/a64.m3u8?${hlsQuery}",CODECS="mp4a.40.2"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English captions",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="data:text/vtt,${subtitleData}"` : ''}
${videos.map(video => `#EXT-X-STREAM-INF:BANDWIDTH=${video.bandwidth + (mediaGroups ? formats.a64.bandwidth : 0)},RESOLUTION=${video.width}x${video.height},CODECS="${mediaGroups ? `${video.codecs},mp4a.40.2` : video.codecs}"${mediaGroups ? ',AUDIO="audio-main",SUBTITLES="subs"' : ''}
/api/stream/${videoId}/hls/${video.formatId}.m3u8?${hlsQuery}`).join('\n')}`;
}

function buildFixtureHlsMedia(videoId: string, formatId: string) {
  const fmt = getFixtureFormats()[formatId];
  if (!fmt) return '';
  const segments = segmentsFor(fmt.filePath, fmt.indexRange.end);
  if (!segments.length) return '';
  const targetDuration = Math.max(1, Math.ceil(Math.max(...segments.map(seg => seg.end - seg.start))));
  return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="/api/stream/${videoId}/fmt/${fmt.formatId}",BYTERANGE="${fmt.initRange.end - fmt.initRange.start + 1}@${fmt.initRange.start}"
${segments.map(seg => `#EXTINF:${(seg.end - seg.start).toFixed(3)},
#EXT-X-BYTERANGE:${seg.range.end - seg.range.start + 1}@${seg.range.start}
/api/stream/${videoId}/fmt/${fmt.formatId}`).join('\n')}
#EXT-X-ENDLIST`;
}

function buildFixtureLiveMPD(videoId: string, videos: FixtureFormat[], audio: FixtureFormat, query: Record<string, unknown> = {}) {
  const publishTime = new Date().toISOString();
  const availabilityStartTime = new Date(Date.now() - 60_000).toISOString();
  const sliding = firstQueryValue(query.fixtureLive) === 'sliding';
  const multiperiod = firstQueryValue(query.fixtureLive) === 'multiperiod';
  if (multiperiod) return buildFixtureLiveMultiPeriodMPD(videoId, videos, audio, availabilityStartTime, publishTime);
  const seq = fixtureLiveSequence(videoId, query, sliding);
  const templateAttrs = (fmt: FixtureFormat) => {
    const allSegments = segmentsFor(fmt.filePath, fmt.indexRange.end);
    const segments = sliding ? slidingLiveSegments(allSegments, seq) : allSegments;
    return `<SegmentTemplate timescale="1000" presentationTimeOffset="0" initialization="/api/stream/${videoId}/tmpl/${fmt.formatId}/init" media="/api/stream/${videoId}/tmpl/${fmt.formatId}/seg/$Time$"><SegmentTimeline>${segments.map(seg => `<S t="${Math.round(seg.start * 1000)}" d="${Math.round((seg.end - seg.start) * 1000)}"/>`).join('')}</SegmentTimeline></SegmentTemplate>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="dynamic" availabilityStartTime="${availabilityStartTime}" publishTime="${publishTime}" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT30S" minBufferTime="PT0.5S">
<Period id="live" start="PT0S">
<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
${videos.map(video => `<Representation id="${video.formatId}" bandwidth="${video.bandwidth}" width="${video.width}" height="${video.height}" codecs="${video.codecs}">
${templateAttrs(video)}
</Representation>`).join('\n')}
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1" lang="en" label="English">
<Representation id="${audio.formatId}" bandwidth="${audio.bandwidth}" codecs="${audio.codecs}" audioSamplingRate="${audio.audioSamplingRate}">
${templateAttrs(audio)}
</Representation>
</AdaptationSet>
</Period>
</MPD>`;
}

function buildFixtureLiveMultiPeriodMPD(videoId: string, videos: FixtureFormat[], audio: FixtureFormat, availabilityStartTime: string, publishTime: string) {
  const periodAttrs = (fmt: FixtureFormat, periodStart: number, periodDuration: number) => {
    const segments = segmentsFor(fmt.filePath, fmt.indexRange.end)
      .filter(seg => seg.start >= periodStart && seg.start < periodStart + periodDuration);
    return `<SegmentTemplate timescale="1000" presentationTimeOffset="${periodStart * 1000}" initialization="/api/stream/${videoId}/tmpl/${fmt.formatId}/init" media="/api/stream/${videoId}/tmpl/${fmt.formatId}/seg/$Time$"><SegmentTimeline>${segments.map(seg => `<S t="${Math.round(seg.start * 1000)}" d="${Math.round((seg.end - seg.start) * 1000)}"/>`).join('')}</SegmentTimeline></SegmentTemplate>`;
  };
  const period = (id: string, start: number, duration: number) => `<Period id="${id}" start="PT${start}S" duration="PT${duration}S">
<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
${videos.map(video => `<Representation id="${video.formatId}" bandwidth="${video.bandwidth}" width="${video.width}" height="${video.height}" codecs="${video.codecs}">
${periodAttrs(video, start, duration)}
</Representation>`).join('\n')}
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1" lang="en" label="English">
<Representation id="${audio.formatId}" bandwidth="${audio.bandwidth}" codecs="${audio.codecs}" audioSamplingRate="${audio.audioSamplingRate}">
${periodAttrs(audio, start, duration)}
</Representation>
</AdaptationSet>
</Period>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="dynamic" availabilityStartTime="${availabilityStartTime}" publishTime="${publishTime}" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT30S" minBufferTime="PT0.5S">
${period('live-a', 0, 2)}
${period('live-b', 2, 4)}
</MPD>`;
}

function fixtureLiveSequence(videoId: string, query: Record<string, unknown>, sliding: boolean) {
  const explicit = firstQueryValue(query.fixtureLiveSeq);
  if (explicit != null) return boundedInt(explicit, 0, 100);
  if (!sliding) return 0;
  const key = `${videoId}:${firstQueryValue(query.fixtureLiveKey) || 'default'}`;
  const next = fixtureLiveSeq.get(key) || 0;
  fixtureLiveSeq.set(key, next + 1);
  return next;
}

function slidingLiveSegments(segments: Array<{ start: number; end: number; range: BoxRange }>, seq: number) {
  if (segments.length <= 2) return segments;
  const start = Math.min(Math.max(0, seq), Math.max(0, segments.length - 2));
  return segments.slice(start, Math.min(segments.length, start + 2));
}

function buildFixtureTemplateMPD(videoId: string, videos: FixtureFormat[], audio: FixtureFormat, templateMode: string) {
  const timeline = templateMode === 'timeline';
  const templateAttrs = (fmt: FixtureFormat) => {
    const segments = segmentsFor(fmt.filePath, fmt.indexRange.end);
    const duration = segments[0] ? Math.round((segments[0].end - segments[0].start) * 1000) : FIXTURE_DURATION * 1000;
    if (timeline) {
      return `<SegmentTemplate timescale="1000" initialization="/api/stream/${videoId}/tmpl/${fmt.formatId}/init" media="/api/stream/${videoId}/tmpl/${fmt.formatId}/seg/$Time$"><SegmentTimeline>${segments.map(seg => `<S t="${Math.round(seg.start * 1000)}" d="${Math.round((seg.end - seg.start) * 1000)}"/>`).join('')}</SegmentTimeline></SegmentTemplate>`;
    }
    return `<SegmentTemplate timescale="1000" duration="${duration}" startNumber="1" initialization="/api/stream/${videoId}/tmpl/${fmt.formatId}/init" media="/api/stream/${videoId}/tmpl/${fmt.formatId}/seg/$Number$"/>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT${FIXTURE_DURATION}.000S" minBufferTime="PT0.5S">
<Period duration="PT${FIXTURE_DURATION}.000S">
<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
${videos.map(video => `<Representation id="${video.formatId}" bandwidth="${video.bandwidth}" width="${video.width}" height="${video.height}" codecs="${video.codecs}">
${templateAttrs(video)}
</Representation>`).join('\n')}
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">
<Representation id="${audio.formatId}" bandwidth="${audio.bandwidth}" codecs="${audio.codecs}" audioSamplingRate="${audio.audioSamplingRate}">
${templateAttrs(audio)}
</Representation>
</AdaptationSet>
</Period>
</MPD>`;
}

function buildFixtureSegmentListMPD(videoId: string, videos: FixtureFormat[], audio: FixtureFormat, segmentListMode: string) {
  const rangeMode = segmentListMode === 'range';
  const listAttrs = (fmt: FixtureFormat) => {
    const segments = segmentsFor(fmt.filePath, fmt.indexRange.end);
    const duration = segments[0] ? Math.round((segments[0].end - segments[0].start) * 1000) : FIXTURE_DURATION * 1000;
    if (rangeMode) {
      return `<BaseURL>/api/stream/${videoId}/fmt/${fmt.formatId}</BaseURL>
<SegmentList timescale="1000" duration="${duration}">
<Initialization range="${rangeAttr(fmt.initRange)}"/>
${segments.map(seg => `<SegmentURL mediaRange="${rangeAttr(seg.range)}"/>`).join('\n')}
</SegmentList>`;
    }
    return `<SegmentList timescale="1000" duration="${duration}">
<Initialization sourceURL="/api/stream/${videoId}/tmpl/${fmt.formatId}/init"/>
${segments.map(seg => `<SegmentURL media="/api/stream/${videoId}/tmpl/${fmt.formatId}/seg/${Math.round(seg.start * 1000)}"/>`).join('\n')}
</SegmentList>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT${FIXTURE_DURATION}.000S" minBufferTime="PT0.5S">
<Period duration="PT${FIXTURE_DURATION}.000S">
<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
${videos.map(video => `<Representation id="${video.formatId}" bandwidth="${video.bandwidth}" width="${video.width}" height="${video.height}" codecs="${video.codecs}">
${listAttrs(video)}
</Representation>`).join('\n')}
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">
<Representation id="${audio.formatId}" bandwidth="${audio.bandwidth}" codecs="${audio.codecs}" audioSamplingRate="${audio.audioSamplingRate}">
${listAttrs(audio)}
</Representation>
</AdaptationSet>
</Period>
</MPD>`;
}

function serveFixtureFormat(videoId: string, formatId: string, req, res) {
  if (!isPlayerFixtureVideo(videoId)) return false;
  const fmt = getFixtureFormats()[formatId];
  if (!fmt) {
    res.status(404).json({ error: 'Fixture format not found' });
    return true;
  }
  const stat = fs.statSync(fmt.filePath);
  const rangeHeader = req.headers.range as string | undefined;
  const match = rangeHeader && rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) {
    res.status(200);
    res.set('Content-Type', fmt.contentType);
    res.set('Content-Length', String(stat.size));
    res.set('Accept-Ranges', 'bytes');
    fs.createReadStream(fmt.filePath).pipe(res);
    return true;
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || end < start) {
    res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
    return true;
  }
  const fault = fixtureFaultFor(req.query, formatId, fmt, start, end);
  if (fault.status) {
    res.status(fault.status).set('Cache-Control', 'no-store').end(`fixture fault ${fault.status}`);
    return true;
  }
  const sendRange = () => {
    res.status(206);
    res.set('Content-Type', fmt.contentType);
    res.set('Content-Length', String(end - start + 1));
    res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.set('Accept-Ranges', 'bytes');
    fs.createReadStream(fmt.filePath, { start, end }).pipe(res);
  };
  if (fault.delayMs > 0) {
    setTimeout(sendRange, fault.delayMs);
    return true;
  }
  sendRange();
  return true;
}

function serveFixtureProgressive(videoId: string, req, res) {
  if (!isPlayerFixtureVideo(videoId)) return false;
  const fmt = getFixtureFormats().v360;
  const stat = fs.statSync(fmt.filePath);
  const rangeHeader = req.headers.range as string | undefined;
  const match = rangeHeader && rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  res.set('Content-Type', fmt.contentType);
  res.set('Accept-Ranges', 'bytes');
  if (!match) {
    res.status(200);
    res.set('Content-Length', String(stat.size));
    fs.createReadStream(fmt.filePath).pipe(res);
    return true;
  }
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || end < start) {
    res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
    return true;
  }
  res.status(206);
  res.set('Content-Length', String(end - start + 1));
  res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  fs.createReadStream(fmt.filePath, { start, end }).pipe(res);
  return true;
}

function serveFixtureTemplatePart(videoId: string, formatId: string, part: string, _req, res) {
  if (!isPlayerFixtureVideo(videoId)) return false;
  const fmt = getFixtureFormats()[formatId];
  if (!fmt) {
    res.status(404).json({ error: 'Fixture format not found' });
    return true;
  }
  const range = templatePartRange(fmt, part);
  if (!range) {
    res.status(404).json({ error: 'Fixture template part not found' });
    return true;
  }
  res.status(200);
  res.set('Content-Type', fmt.contentType);
  res.set('Content-Length', String(range.end - range.start + 1));
  res.set('Cache-Control', 'no-store');
  fs.createReadStream(fmt.filePath, { start: range.start, end: range.end }).pipe(res);
  return true;
}

function templatePartRange(fmt: FixtureFormat, part: string) {
  if (part === 'init') return fmt.initRange;
  const segments = segmentsFor(fmt.filePath, fmt.indexRange.end);
  const number = parseInt(part, 10);
  if (Number.isFinite(number) && number >= 1 && number <= segments.length) return segments[number - 1].range;
  const time = parseInt(part, 10);
  const seg = segments.find(s => Math.round(s.start * 1000) === time);
  return seg ? seg.range : null;
}

function fixtureFaultQuery(query: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const key of ['fixtureDelayMs', 'fixtureFailStatus', 'fixtureFailCount', 'fixtureFailFormat', 'fixtureFailPhase']) {
    const value = firstQueryValue(query[key]);
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text.replace(/&/g, '&amp;')}` : '';
}

function fixtureFaultFor(query, formatId: string, fmt: FixtureFormat, start: number, end: number) {
  const phase = fixtureRangePhase(fmt, start, end);
  const targetFormat = firstQueryValue(query.fixtureFailFormat);
  const targetPhase = firstQueryValue(query.fixtureFailPhase) || 'media';
  const delayMs = targetMatches(firstQueryValue(query.fixtureDelayMs), formatId, targetFormat, phase, targetPhase)
    ? boundedInt(firstQueryValue(query.fixtureDelayMs), 0, 2000)
    : 0;
  const status = boundedInt(firstQueryValue(query.fixtureFailStatus), 0, 599);
  if (!status || !targetMatches(String(status), formatId, targetFormat, phase, targetPhase)) return { delayMs, status: 0 };
  const count = boundedInt(firstQueryValue(query.fixtureFailCount), 1, 20);
  const key = [
    firstQueryValue(query.fixtureFailStatus),
    firstQueryValue(query.fixtureFailCount),
    targetFormat || '*',
    targetPhase,
    formatId,
    phase,
    start,
    end,
  ].join(':');
  const seen = fixtureFaultCounts.get(key) || 0;
  if (seen >= count) return { delayMs, status: 0 };
  fixtureFaultCounts.set(key, seen + 1);
  return { delayMs, status };
}

function fixtureRangePhase(fmt: FixtureFormat, start: number, end: number) {
  if (start === fmt.initRange.start && end === fmt.initRange.end) return 'init';
  if (start === fmt.indexRange.start && end === fmt.indexRange.end) return 'index';
  return 'media';
}

function targetMatches(value: string | undefined, formatId: string, targetFormat: string | undefined, phase: string, targetPhase: string) {
  if (!value) return false;
  if (targetFormat && targetFormat !== formatId) return false;
  return targetPhase === 'all' || targetPhase === phase;
}

function firstQueryValue(value: unknown) {
  if (Array.isArray(value)) return value[0] == null ? undefined : String(value[0]);
  return value == null ? undefined : String(value);
}

function boundedInt(value: string | undefined, min: number, max: number) {
  const parsed = parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(min, Math.min(max, parsed));
}

function readTopLevelBoxes(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const boxes: Array<{ type: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(offset + 8));
    if (!size || offset + size > buf.length) break;
    boxes.push({ type, start: offset, end: offset + size - 1 });
    offset += size;
  }
  return boxes;
}

function rangesFor(filePath: string) {
  const boxes = readTopLevelBoxes(filePath);
  const moov = boxes.find(box => box.type === 'moov');
  const sidx = boxes.find(box => box.type === 'sidx');
  if (!moov || !sidx) throw new Error('Fixture MP4 missing moov/sidx boxes');
  return {
    initRange: { start: 0, end: moov.end },
    indexRange: { start: sidx.start, end: sidx.end },
  };
}

function segmentsFor(filePath: string, indexEnd: number) {
  const range = rangesFor(filePath).indexRange;
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(range.end - range.start + 1);
  fs.readSync(fd, buf, 0, buf.length, range.start);
  fs.closeSync(fd);
  let pos = 0;
  const size = buf.readUInt32BE(pos); pos += 4;
  const type = buf.toString('ascii', pos, pos + 4); pos += 4;
  if (type !== 'sidx') return [];
  if (size === 1) pos += 8;
  const version = buf.readUInt8(pos); pos += 4;
  pos += 4;
  const timescale = buf.readUInt32BE(pos); pos += 4;
  let firstOffset = 0;
  if (version === 0) {
    pos += 4;
    firstOffset = buf.readUInt32BE(pos);
    pos += 4;
  } else {
    pos += 8;
    firstOffset = Number(buf.readBigUInt64BE(pos));
    pos += 8;
  }
  pos += 2;
  const count = buf.readUInt16BE(pos); pos += 2;
  let byteStart = indexEnd + 1 + firstOffset;
  let time = 0;
  const segments: Array<{ start: number; end: number; range: BoxRange }> = [];
  for (let i = 0; i < count; i++) {
    const ref = buf.readUInt32BE(pos); pos += 4;
    const refType = ref >>> 31;
    const refSize = ref & 0x7fffffff;
    const dur = buf.readUInt32BE(pos); pos += 4;
    pos += 4;
    if (refType === 0 && refSize > 0) {
      const seconds = dur / timescale;
      segments.push({ start: time, end: time + seconds, range: { start: byteStart, end: byteStart + refSize - 1 } });
      time += seconds;
      byteStart += refSize;
    }
  }
  return segments;
}

export {
  FIXTURE_VIDEO_ID,
  buildFixtureHlsMaster,
  buildFixtureHlsMedia,
  buildFixtureMPD,
  isPlayerFixtureEnabled,
  isPlayerFixtureVideo,
  serveFixtureFormat,
  serveFixtureProgressive,
  serveFixtureTemplatePart,
};
