/**
 * WebSocket extraction status — replaces SSE for real-time bidirectional
 * extraction progress. Falls back to SSE when ws module unavailable.
 *
 * Attach to HTTP server: import('./lib/ws-status.js').then(m => m.attach(server))
 */
import { rawRequestClientIp } from './client-ip.js';
import { acquireStatusConnection } from './status-connection-limiter.js';

let wss = null;
const listeners = new Map(); // videoId → Set<ws>
let getCurrentStatus: ((videoId: string) => { step?: string } | null | undefined) | null = null;
const STATUS_CONNECTION_MAX_AGE_MS = Math.max(10_000, Number(process.env.STATUS_CONNECTION_MAX_AGE_MS) || 45_000);
const STATUS_WS_MAX_BUFFERED_BYTES = Math.max(16 * 1024, Number(process.env.STATUS_WS_MAX_BUFFERED_BYTES) || 256 * 1024);

async function attach(server) {
  try {
    const { WebSocketServer } = await import('ws');
    wss = new WebSocketServer({ server, path: '/ws/status' });

    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      const videoId = url.searchParams.get('v');
      if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        ws.close(1008, 'Invalid video ID');
        return;
      }
      const releaseConnection = acquireStatusConnection(rawRequestClientIp(req), 'websocket');
      if (!releaseConnection) {
        ws.close(1013, 'Status connection capacity reached');
        return;
      }

      if (!listeners.has(videoId)) listeners.set(videoId, new Set());
      listeners.get(videoId).add(ws);
      const maxAgeTimer = setTimeout(() => {
        try { ws.terminate(); } catch { ws.close(1001, 'Status connection expired'); }
      }, STATUS_CONNECTION_MAX_AGE_MS);
      maxAgeTimer.unref?.();
      const current = getCurrentStatus ? getCurrentStatus(videoId) : null;
      if (current) {
        try { ws.send(JSON.stringify({ step: current.step })); } catch {}
      }

      let cleanedUp = false;
      const cleanupConnection = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(maxAgeTimer);
        releaseConnection();
        const set = listeners.get(videoId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) listeners.delete(videoId);
        }
      };
      ws.on('close', cleanupConnection);
      ws.on('error', cleanupConnection);
    });

    console.log('[ws-status] WebSocket server attached at /ws/status');
    return true;
  } catch (err) {
    console.warn('[ws-status] WebSocket unavailable (install ws package):', err.message);
    return false;
  }
}

function notify(videoId, data) {
  const set = listeners.get(videoId);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of set) {
    try {
      if (ws.bufferedAmount > STATUS_WS_MAX_BUFFERED_BYTES) {
        ws.close(1013, 'Status client is too slow');
        set.delete(ws);
      } else if (ws.readyState === 1) ws.send(msg); // 1 = OPEN
    } catch {
      set.delete(ws);
    }
  }
  if (set.size === 0) listeners.delete(videoId);
}

function isAvailable() { return wss !== null; }

function setStatusProvider(fn: ((videoId: string) => { step?: string } | null | undefined) | null) {
  getCurrentStatus = typeof fn === 'function' ? fn : null;
}

function closeAll() {
  if (!wss) return;
  for (const client of wss.clients) {
    try { client.close(1001, 'Server shutting down'); } catch {}
  }
  wss.close();
  wss = null;
  listeners.clear();
}

export { attach, notify, isAvailable, closeAll, setStatusProvider };
