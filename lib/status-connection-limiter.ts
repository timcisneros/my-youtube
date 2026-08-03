import { incrementMetric, setMetricGauge } from './performance-metrics.js';

type StatusTransport = 'sse' | 'duration_sse' | 'websocket';

const workerCount = Math.max(1, Number(process.env.CLUSTER_WORKER_COUNT) || 1);
const globalConnectionBudget = Math.max(1, Number(process.env.STATUS_MAX_CONNECTIONS) || 1_000);
const localConnectionBudget = Math.max(1, Math.ceil(globalConnectionBudget / workerCount));
const perIpConnectionBudget = Math.max(1, Number(process.env.STATUS_MAX_CONNECTIONS_PER_IP) || 8);
const activeByIp = new Map<string, number>();
const activeByTransport: Record<StatusTransport, number> = { sse: 0, duration_sse: 0, websocket: 0 };
let activeConnections = 0;

function updateStatusConnectionMetrics() {
  setMetricGauge('status_connections_active', activeConnections);
  setMetricGauge('status_connection_limit', localConnectionBudget);
  for (const transport of Object.keys(activeByTransport) as StatusTransport[]) {
    setMetricGauge('status_connections_active_transport', activeByTransport[transport], { transport });
  }
}

function acquireStatusConnection(ip: string, transport: StatusTransport) {
  const key = ip || 'unknown';
  const ipActive = activeByIp.get(key) || 0;
  if (activeConnections >= localConnectionBudget) {
    incrementMetric('status_connection_rejections_total', { transport, reason: 'global_limit' });
    return null;
  }
  if (ipActive >= perIpConnectionBudget) {
    incrementMetric('status_connection_rejections_total', { transport, reason: 'ip_limit' });
    return null;
  }

  activeConnections++;
  activeByTransport[transport]++;
  activeByIp.set(key, ipActive + 1);
  incrementMetric('status_connections_total', { transport, result: 'accepted' });
  updateStatusConnectionMetrics();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeConnections = Math.max(0, activeConnections - 1);
    activeByTransport[transport] = Math.max(0, activeByTransport[transport] - 1);
    const remaining = (activeByIp.get(key) || 1) - 1;
    if (remaining > 0) activeByIp.set(key, remaining);
    else activeByIp.delete(key);
    updateStatusConnectionMetrics();
  };
}

function getStatusConnectionState() {
  return {
    active: activeConnections,
    activeByIp: new Map(activeByIp),
    activeByTransport: { ...activeByTransport },
    localLimit: localConnectionBudget,
    perIpLimit: perIpConnectionBudget,
  };
}

updateStatusConnectionMetrics();

export { acquireStatusConnection, getStatusConnectionState };
export type { StatusTransport };
