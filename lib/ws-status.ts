/**
 * WebSocket extraction status — replaces SSE for real-time bidirectional
 * extraction progress. Falls back to SSE when ws module unavailable.
 *
 * Attach to HTTP server: import('./lib/ws-status.js').then(m => m.attach(server))
 */
let wss = null;
const listeners = new Map(); // videoId → Set<ws>
let getCurrentStatus: ((videoId: string) => { step?: string } | null | undefined) | null = null;

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

      if (!listeners.has(videoId)) listeners.set(videoId, new Set());
      listeners.get(videoId).add(ws);
      const current = getCurrentStatus ? getCurrentStatus(videoId) : null;
      if (current) {
        try { ws.send(JSON.stringify({ step: current.step })); } catch {}
      }

      ws.on('close', () => {
        const set = listeners.get(videoId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) listeners.delete(videoId);
        }
      });

      ws.on('error', () => {
        const set = listeners.get(videoId);
        if (set) set.delete(ws);
      });
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
      if (ws.readyState === 1) ws.send(msg); // 1 = OPEN
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
