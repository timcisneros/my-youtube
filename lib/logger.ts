/**
 * Structured JSON logger — outputs one JSON object per line to stdout.
 * In production (NODE_ENV=production), all output is JSON for log aggregation.
 * In development, uses human-readable format.
 *
 * No dependencies. Production output is bounded and honors stdout
 * backpressure so a slow container log collector cannot grow heap forever.
 */

const isProduction = process.env.NODE_ENV === 'production';
const configuredDetailSampleRate = Number(process.env.LOG_DETAIL_SAMPLE_RATE);
const detailSampleRate = Number.isFinite(configuredDetailSampleRate)
  ? Math.min(1, Math.max(0, configuredDetailSampleRate))
  : 0.05;
const maxBufferedBytes = Math.max(64 * 1024, Number(process.env.LOG_MAX_BUFFER_BYTES) || 1024 * 1024);
const maxWriteBytes = Math.max(4 * 1024, Number(process.env.LOG_WRITE_BATCH_BYTES) || 64 * 1024);
let stdoutBlocked = false;
let drainListenerArmed = false;
let bufferedOutput = '';
let bufferedBytes = 0;
let droppedEntries = 0;

function armDrainListener() {
  if (drainListenerArmed) return;
  drainListenerArmed = true;
  process.stdout.once('drain', () => {
    drainListenerArmed = false;
    stdoutBlocked = false;
    flushBufferedOutput();
  });
}

function appendBuffered(line: string) {
  const bytes = Buffer.byteLength(line);
  if (bytes > maxBufferedBytes || bufferedBytes + bytes > maxBufferedBytes) {
    droppedEntries++;
    return;
  }
  bufferedOutput += line;
  bufferedBytes += bytes;
}

function flushBufferedOutput() {
  if (stdoutBlocked) return;
  if (droppedEntries > 0) {
    const droppedLine = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: 'structured log entries dropped due to stdout backpressure',
      pid: process.pid,
      droppedEntries,
    }) + '\n';
    droppedEntries = 0;
    appendBuffered(droppedLine);
  }
  while (bufferedOutput.length > 0 && !stdoutBlocked) {
    // Flush whole JSON lines so a chunk boundary cannot split a Unicode
    // surrogate pair and corrupt otherwise valid structured output.
    let cut = Math.min(maxWriteBytes, bufferedOutput.length);
    const newline = bufferedOutput.lastIndexOf('\n', cut - 1);
    if (newline >= 0) cut = newline + 1;
    else {
      const nextNewline = bufferedOutput.indexOf('\n', cut);
      cut = nextNewline >= 0 ? nextNewline + 1 : bufferedOutput.length;
    }
    const chunk = bufferedOutput.slice(0, cut);
    bufferedOutput = bufferedOutput.slice(chunk.length);
    bufferedBytes = Math.max(0, bufferedBytes - Buffer.byteLength(chunk));
    try {
      stdoutBlocked = !process.stdout.write(chunk);
    } catch {
      stdoutBlocked = false;
      bufferedOutput = '';
      bufferedBytes = 0;
      return;
    }
    if (stdoutBlocked) armDrainListener();
  }
}

function writeProductionLine(line: string) {
  if (stdoutBlocked || bufferedOutput.length > 0) {
    appendBuffered(line);
    return;
  }
  try {
    stdoutBlocked = !process.stdout.write(line);
    if (stdoutBlocked) armDrainListener();
  } catch {
    // Logging must never crash request or worker processing.
  }
}

function _log(level, msg, meta) {
  if (isProduction) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      pid: process.pid,
      ...meta
    };
    let line: string;
    try {
      line = JSON.stringify(entry) + '\n';
    } catch {
      line = JSON.stringify({
        ts: new Date().toISOString(), level, msg, pid: process.pid,
        metaSerializationError: true,
      }) + '\n';
    }
    writeProductionLine(line);
  } else {
    const prefix = `[${level}]`;
    if (meta && Object.keys(meta).length > 0) {
      console.log(prefix, msg, meta);
    } else {
      console.log(prefix, msg);
    }
  }
}

const logger = {
  info(msg, meta?) { _log('info', msg, meta); },
  sampledInfo(_sampleKey, msg, meta?, sampleRate = detailSampleRate) {
    if (!isProduction || Math.random() < Math.min(1, Math.max(0, Number(sampleRate) || 0))) {
      _log('info', msg, meta);
    }
  },
  sampledInfoLazy(_sampleKey, msg, metaFactory: () => unknown, sampleRate = detailSampleRate) {
    if (!isProduction || Math.random() < Math.min(1, Math.max(0, Number(sampleRate) || 0))) {
      _log('info', msg, metaFactory());
    }
  },
  warn(msg, meta?) { _log('warn', msg, meta); },
  error(msg, meta?) { _log('error', msg, meta); },
  debug(msg, meta?) { if (!isProduction) _log('debug', msg, meta); },
};

export default logger;
