/**
 * Structured JSON logger — outputs one JSON object per line to stdout.
 * In production (NODE_ENV=production), all output is JSON for log aggregation.
 * In development, uses human-readable format.
 *
 * No dependencies — uses console.log with JSON.stringify.
 */

const isProduction = process.env.NODE_ENV === 'production';

function _log(level, msg, meta) {
  if (isProduction) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      pid: process.pid,
      ...meta
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
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
  warn(msg, meta?) { _log('warn', msg, meta); },
  error(msg, meta?) { _log('error', msg, meta); },
  debug(msg, meta?) { if (!isProduction) _log('debug', msg, meta); },
};

export default logger;
