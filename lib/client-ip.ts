function trustedProxyHops() {
  return Math.max(0, Math.floor(Number(process.env.TRUST_PROXY_HOPS) || 0));
}

function normalizeAddress(value: unknown) {
  const address = typeof value === 'string' ? value.trim() : '';
  return address.startsWith('::ffff:') ? address.slice(7) : address || 'unknown';
}

/** Resolve a raw HTTP/WebSocket request consistently with Express's numeric
 * trust-proxy mode. Values supplied by clients are ignored unless the operator
 * explicitly declares at least one trusted reverse-proxy hop. */
function rawRequestClientIp(req: {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}) {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const forwarded = req.headers?.['x-forwarded-for'];
    const values = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (values.length > 0) {
      return normalizeAddress(values[Math.max(0, values.length - hops)]);
    }
  }
  return normalizeAddress(req.socket?.remoteAddress);
}

export { rawRequestClientIp, trustedProxyHops };
