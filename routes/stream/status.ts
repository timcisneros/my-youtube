import { extractionStatus } from './shared.js';
import * as wsStatus from '../../lib/ws-status.js';

// SSE: push extraction progress to the client as backends are tried
const extractionListeners = new Map(); // videoId -> Set<res>

function notifyExtractionStep(videoId, step) {
  extractionStatus.set(videoId, { step, ts: Date.now() });
  // WebSocket notification
  if (wsStatus.isAvailable()) wsStatus.notify(videoId, { step });
  // SSE notification
  const listeners = extractionListeners.get(videoId);
  if (listeners) {
    for (const res of listeners) {
      try {
        res.write(`data: ${JSON.stringify({ step })}\n\n`);
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
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    // Send current step immediately if extraction is in-flight
    const current = extractionStatus.get(videoId);
    if (current) {
      res.write(`data: ${JSON.stringify({ step: current.step })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
    // Keep connection open — extraction may start soon (e.g. manifest request pending)
    // Auto-close after 30s if no extraction happens
    if (!extractionListeners.has(videoId)) extractionListeners.set(videoId, new Set());
    extractionListeners.get(videoId).add(res);
    const timeout = setTimeout(() => {
      res.write('event: done\ndata: {}\n\n');
      res.end();
      const set = extractionListeners.get(videoId);
      if (set) { set.delete(res); if (set.size === 0) extractionListeners.delete(videoId); }
    }, 30000);
    req.on('close', () => {
      clearTimeout(timeout);
      const set = extractionListeners.get(videoId);
      if (set) { set.delete(res); if (set.size === 0) extractionListeners.delete(videoId); }
    });
  });
}

export {
  notifyExtractionStep,
  notifyExtractionDone,
  mountStatusRoutes,
};
