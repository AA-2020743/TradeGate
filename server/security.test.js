import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorizeWrite, contentSecurityPolicy, inlineScriptHashes, tokensMatch } from './security.js';

/** A request as Express would present it, from a chosen peer with chosen headers. */
function request({ peer = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: peer }, headers: { host: 'research.example.com', ...headers } };
}

test('without a token, a request that came through the proxy cannot write', () => {
  // Behind nginx every request arrives from 127.0.0.1. Trusting the peer alone
  // would have treated the whole internet as local; the forwarded header is
  // what distinguishes a proxied visitor from the development server.
  const proxied = authorizeWrite(request({ headers: { 'x-forwarded-for': '203.0.113.9' } }));
  assert.equal(proxied.allowed, false);
  assert.equal(proxied.status, 403);
  assert.equal(proxied.writeProtected, true);

  assert.equal(authorizeWrite(request({ headers: { 'x-real-ip': '203.0.113.9' } })).allowed, false);
  assert.equal(authorizeWrite(request({ headers: { forwarded: 'for=203.0.113.9' } })).allowed, false);
});

test('without a token, a remote peer cannot write', () => {
  assert.equal(authorizeWrite(request({ peer: '203.0.113.9' })).allowed, false);
});

test('without a token, the local development server can still write', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const result = authorizeWrite(request({ peer }));
    assert.equal(result.allowed, true, peer);
    assert.equal(result.mode, 'local');
  }
});

test('with a token, only the matching bearer token writes - proxied or not', () => {
  const token = 'correct horse battery staple';
  const proxiedHeaders = { 'x-forwarded-for': '203.0.113.9' };
  assert.equal(authorizeWrite(request({ headers: { ...proxiedHeaders, authorization: `Bearer ${token}` } }), { token }).allowed, true);
  assert.equal(authorizeWrite(request({ headers: { ...proxiedHeaders, authorization: 'Bearer wrong' } }), { token }).status, 401);
  assert.equal(authorizeWrite(request({ headers: proxiedHeaders }), { token }).status, 401);
  // Configuring a token must not leave the old local exemption open beside it.
  assert.equal(authorizeWrite(request(), { token }).allowed, false);
});

test('a cross-origin write is refused even with valid credentials', () => {
  const token = 't0k3n';
  const result = authorizeWrite(request({ headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` } }), { token });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
  // Same origin is fine.
  assert.equal(authorizeWrite(request({ headers: { origin: 'https://research.example.com', authorization: `Bearer ${token}` } }), { token }).allowed, true);
  // A malformed Origin is not given the benefit of the doubt.
  assert.equal(authorizeWrite(request({ headers: { origin: 'not a url' } })).allowed, false);
});

test('token comparison rejects near misses and empty values', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'abcd'), false);
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch(null, 'abc'), false);
});

test('the policy allows exactly the inline scripts the served page contains', () => {
  const body = "document.documentElement.dataset.theme = 'dark';";
  const html = `<script>${body}</script><div id="root"></div><script type="module" src="/assets/app.js"></script>`;
  const expected = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
  assert.deepEqual(inlineScriptHashes(html), [expected]);
  const csp = contentSecurityPolicy(html);
  assert.match(csp, new RegExp(`script-src 'self' ${expected.replace(/[+/=]/g, (c) => `\\${c}`)}`));
  // External module scripts are covered by 'self' and are not hashed.
  assert.equal(inlineScriptHashes('<script src="/a.js"></script>').length, 0);
  // Nothing the page does not need: no eval, no remote scripts, no framing.
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
});

test('the policy hashes the real built page, so the theme bootstrap is not blocked', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const page = existsSync('dist/index.html') ? readFileSync('dist/index.html', 'utf8') : readFileSync('index.html', 'utf8');
  // The page has an inline theme script; if the hash were missing, the browser
  // would block it and every load would flash the wrong theme.
  assert.ok(/<script>/.test(page), 'expected the inline theme bootstrap in the page');
  assert.equal(inlineScriptHashes(page).length >= 1, true);
});
