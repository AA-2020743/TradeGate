import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Who may change server state, and what the browser may load.
 *
 * TradeGate has exactly one mutating endpoint - the shared watchlists - and it
 * was open to anyone who could reach the server. On a public deployment that
 * means any visitor, or any page they happen to have open in another tab, can
 * overwrite the watchlists everyone else reads. The rule here fails closed:
 *
 * - With TRADEGATE_WRITE_TOKEN set, a write needs `Authorization: Bearer <it>`.
 * - Without it, a write is accepted only from a genuinely local, unproxied
 *   connection - the development server - and refused from the internet.
 *
 * "Local" deliberately means the socket peer is loopback AND no proxy header
 * is present. Behind the shipped nginx config every request arrives from
 * 127.0.0.1, so trusting the peer address alone would have treated the whole
 * internet as local; the forwarded header is what tells the two apart.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

/**
 * Constant-time comparison. Hashing both sides first gives equal-length inputs,
 * so neither the content nor the length of the token leaks through timing.
 */
export function tokensMatch(presented, expected) {
  if (!presented || !expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function bearerToken(request) {
  const header = request.headers?.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function isUnproxiedLoopback(request) {
  const peer = request.socket?.remoteAddress ?? '';
  const proxied = Boolean(request.headers?.['x-forwarded-for'] || request.headers?.forwarded || request.headers?.['x-real-ip']);
  return LOOPBACK.has(peer) && !proxied;
}

/**
 * A browser will attach cookies and send a cross-site write if a page asks it
 * to. There are no cookies here today, but a write that arrives with an Origin
 * naming another site is never legitimate, so it is refused regardless of
 * credentials - the cheapest defence against the day someone adds a session.
 */
function crossOrigin(request) {
  const origin = request.headers?.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers?.host;
  } catch {
    return true;
  }
}

export function authorizeWrite(request, { token = '' } = {}) {
  if (crossOrigin(request)) {
    return { allowed: false, status: 403, reason: 'Cross-origin writes are refused.' };
  }
  if (token) {
    if (tokensMatch(bearerToken(request), token)) return { allowed: true, mode: 'token' };
    return { allowed: false, status: 401, reason: 'This server requires a write token for changes.', writeProtected: true };
  }
  if (isUnproxiedLoopback(request)) return { allowed: true, mode: 'local' };
  return {
    allowed: false,
    status: 403,
    reason: 'Writes are disabled on this server: no TRADEGATE_WRITE_TOKEN is configured, and the request did not come from a local, unproxied connection.',
    writeProtected: true,
  };
}

/** What /api/health reports, so an exposed write path is visible rather than assumed. */
export function describeWriteProtection(token) {
  return token
    ? { mode: 'token', read: 'Writes require the configured bearer token.' }
    : { mode: 'local-only', read: 'No write token is configured, so writes are accepted only from local, unproxied connections.' };
}

/**
 * Inline scripts are allowed by hash, computed from the HTML actually being
 * served. A hand-maintained hash goes stale the first time someone edits the
 * theme bootstrap, and the failure mode - the script silently blocked and the
 * page flashing the wrong theme - is the kind nobody files a bug for.
 */
export function inlineScriptHashes(html) {
  const hashes = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html ?? '')) !== null) {
    if (!match[1].trim()) continue;
    hashes.push(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  }
  return hashes;
}

export function contentSecurityPolicy(html) {
  const scripts = ["'self'", ...inlineScriptHashes(html)].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    // React writes style attributes, and the stylesheet imports Google Fonts.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    // Every data request goes through this server's own /api; the browser
    // never needs to reach a provider directly, so it is not permitted to.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders({ csp }) {
  return (request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (csp) response.setHeader('Content-Security-Policy', csp);
    // Only over HTTPS: sent on plain HTTP it is ignored at best, and at worst
    // it pins a host to HTTPS before a certificate exists for it.
    if (request.secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}
