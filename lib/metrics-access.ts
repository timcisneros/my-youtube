import { timingSafeEqual } from 'node:crypto';

function normalizedAddress(value: unknown) {
  return String(value || '').trim().replace(/^::ffff:/, '');
}

function isLoopback(value: unknown) {
  const address = normalizedAddress(value);
  return address === '127.0.0.1' || address === '::1';
}

function requestClientAddress(req) {
  const peerAddress = normalizedAddress(req.socket?.remoteAddress);
  // Forwarding headers are trusted only from a loopback reverse proxy. This
  // prevents a direct client from spoofing X-Forwarded-For to bypass protection.
  if (isLoopback(peerAddress)) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return normalizedAddress(forwarded.split(',')[0]);
  }
  return peerAddress;
}

function safeTokenEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function metricsTokenFromRequest(req) {
  const authorization = String(req.headers?.authorization || '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
  return String(req.headers?.['x-metrics-token'] || '').trim();
}

function isMetricsRequestAuthorized(req) {
  if (process.env.METRICS_ALLOW_PUBLIC === '1') return true;
  const expectedToken = String(process.env.METRICS_TOKEN || '').trim();
  const actualToken = metricsTokenFromRequest(req);
  if (expectedToken && actualToken && safeTokenEqual(actualToken, expectedToken)) return true;
  return isLoopback(requestClientAddress(req));
}

export { isMetricsRequestAuthorized };
