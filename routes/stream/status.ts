import { extractionStatus } from './shared.js';
import * as wsStatus from '../../lib/ws-status.js';
import { acquireStatusConnection } from '../../lib/status-connection-limiter.js';

const STATUS_CONNECTION_MAX_AGE_MS = Math.max(10_000, Number(process.env.STATUS_CONNECTION_MAX_AGE_MS) || 45_000);

// SSE: push extraction progress to the client as backends are tried
const extractionListeners = new Map(); // videoId -> Set<res>
wsStatus.setStatusProvider((videoId) => extractionStatus.get(videoId));

function notifyExtractionStep(videoId, step) {
  extractionStatus.set(videoId, { step, ts: Date.now() });
  // WebSocket notification
  if (wsStatus.isAvailable()) wsStatus.notify(videoId, { step });
  // SSE notification
  const listeners = extractionListeners.get(videoId);
  if (listeners) {
    for (const res of listeners) {
      try {
        if (!res.write(`data: ${JSON.stringify({ step })}\n\n`)) res.end();
        if (typeof res.flush === 'function') res.flush();
      } catch { listeners.delete(res); }
    }
    if (listeners.size === 0) extractionListeners.delete(videoId);
  }
}

function notifyExtractionDone(videoId) {
  extractionStatus.delete(videoId);
  // WebSocket notification
  if (wsStatus.isAvailable()) wsStatus.notify(videoId, { done: true });
  // SSE notification
  const listeners = extractionListeners.get(videoId);
  if (listeners) {
    for (const res of listeners) {
      try {
        res.write('event: done\ndata: {}\n\n');
        res.end();
      } catch {}
    }
    extractionListeners.delete(videoId);
  }
}

function mountStatusRoutes(router) {
  router.get('/:videoId/status', (req, res) => {
    const { videoId } = req.params;
    const releaseConnection = acquireStatusConnection(req.ip, 'sse');
    if (!releaseConnection) {
      res.set('Retry-After', '5');
      return res.status(429).end();
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    // Send current step immediately if extraction is in-flight
    const current = extractionStatus.get(videoId);
    if (current) {
      res.write(`data: ${JSON.stringify({ step: current.step })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
    // Keep connection open — extraction may start soon (e.g. manifest request pending)
    // Auto-close even if a client forgets to disconnect after extraction.
    if (!extractionListeners.has(videoId)) extractionListeners.set(videoId, new Set());
    extractionListeners.get(videoId).add(res);
    const timeout = setTimeout(() => {
      res.write('event: done\ndata: {}\n\n');
      res.end();
    }, STATUS_CONNECTION_MAX_AGE_MS);
    timeout.unref?.();
    let cleanedUp = false;
    const cleanupConnection = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      releaseConnection();
      const set = extractionListeners.get(videoId);
      if (set) { set.delete(res); if (set.size === 0) extractionListeners.delete(videoId); }
    };
    req.once('aborted', cleanupConnection);
    res.once('close', cleanupConnection);
    res.once('finish', cleanupConnection);
  });
}

export {
  notifyExtractionStep,
  notifyExtractionDone,
  mountStatusRoutes,
};
