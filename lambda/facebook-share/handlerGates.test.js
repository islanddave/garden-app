// FIRST EXECUTION COVERAGE for lambda/facebook-share/index.js.
//
// Until now this file could not be imported by the unit run at all — its AWS/Clerk/Neon deps live in
// this directory's own package.json and are absent from the repo root. So the 433 lines that publish
// to a public Facebook Page had ZERO tests that ran them. Every other test in this folder covers a
// pure sibling module (graph, exif, altText, batch, orphans); none touched the handler itself.
// vitest.config.ts now aliases those four specifiers to lambda/_test-stubs/, which is what makes
// this file possible.
//
// SCOPE, DELIBERATE. This covers the GATES — auth, admin, kill switch, method routing, validation —
// because they are the controls standing between the internet and a live post, and because they run
// before any Graph call, so nothing here can post. The publish path itself (S3 -> strip -> Graph)
// needs fetch interception and is left for a follow-up; what matters is that the gates are no
// longer unexecuted.
//
// A NOTE ON WHAT A PASS MEANS: these assertions prove the gate LOGIC. They do not prove the
// deployed function is configured correctly — ADMIN_CLERK_SUBS and FB_SHARE_ENABLED are live
// environment variables, and this suite sets them itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const ADMIN = 'user_admin_stub';
const OUTSIDER = 'user_outsider_stub';

// index.js throws at module scope without this, which is itself a deliberate fail-fast. Must be set
// BEFORE the import below.
process.env.S3_PHOTOS_BUCKET = 'garden-photos-stub';
const { handler } = await import('./index.js');

// The handler is imported ONCE, deliberately. `vi.resetModules()` would hand it a fresh copy of the
// stub-state module — a different object from the one this file imported — so every stub reply would
// come back unconfigured. It is also unnecessary: ADMIN_CLERK_SUBS and FB_SHARE_ENABLED are read
// per-call inside isAdmin() and the kill-switch check, not captured at module scope, so setting them
// per test is enough. (S3_PHOTOS_BUCKET is the exception — module scope — hence the line above.)
function configure({ admins = ADMIN, enabled = '1' } = {}) {
  process.env.ADMIN_CLERK_SUBS = admins;
  if (enabled === null) delete process.env.FB_SHARE_ENABLED;
  else process.env.FB_SHARE_ENABLED = enabled;
  return handler;
}
const loadHandler = async (opts) => configure(opts);

const post = (body = {}, headers = { authorization: 'Bearer stub-token' }) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/share/facebook',
  headers,
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: ADMIN };
});

describe('facebook-share handler — the gates in front of a public publish endpoint', () => {
  it('CORS preflight short-circuits before any auth work', async () => {
    const handler = await loadHandler();
    const res = await handler({ requestContext: { http: { method: 'OPTIONS' } } });
    expect(res.statusCode).toBe(204);
    expect(stubState.verifyTokenCalls).toHaveLength(0);
  });

  it('401s when the token does not verify — and does not reach the admin gate', async () => {
    stubState.verifyTokenResult = new Error('jwt malformed');
    const handler = await loadHandler();
    const { status, body } = parse(await handler(post({ photo_ids: ['a'] })));
    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  // V4-AUTHZRESIDUE-001. householdScope('') returns [''] and `'' = ANY(ARRAY[''])` is TRUE in
  // Postgres, so an empty subject would be a live ownership value rather than a no-match. The
  // handler defends against it explicitly; this executes that defence.
  it('401s on a verified token carrying an EMPTY subject', async () => {
    stubState.verifyTokenResult = { sub: '' };
    const handler = await loadHandler();
    const { status } = parse(await handler(post({ photo_ids: ['a'] })));
    expect(status).toBe(401);
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('403s a verified NON-admin', async () => {
    stubState.verifyTokenResult = { sub: OUTSIDER };
    const handler = await loadHandler();
    const { status, body } = parse(await handler(post({ photo_ids: ['a'] })));
    expect(status).toBe(403);
    expect(body.error).toBe('Admin only');
  });

  // The fail-closed property the code comments claim: an EMPTY allowlist must admit nobody, not
  // everybody. This is the assertion that would catch an inverted or short-circuiting isAdmin.
  it('an EMPTY admin allowlist admits NO ONE, including a valid user', async () => {
    const handler = await loadHandler({ admins: '' });
    const { status } = parse(await handler(post({ photo_ids: ['a'] })));
    expect(status).toBe(403);
  });

  it('tolerates whitespace and blanks in the allowlist without admitting a blank subject', async () => {
    const handler = await loadHandler({ admins: ` , ${ADMIN} , ` });
    stubState.verifyTokenResult = { sub: ADMIN };
    // Admin passes the gate, so it proceeds past 403 (validation then rejects the empty body).
    expect(parse(await handler(post({ photo_ids: ['a'] }))).status).not.toBe(403);
    stubState.verifyTokenResult = { sub: '' };
    expect(parse(await handler(post({ photo_ids: ['a'] }))).status).toBe(401);
  });

  // The kill switch is the last thing between an admin and a live post.
  it('503s when the kill switch is ABSENT — default off, not default on', async () => {
    const handler = await loadHandler({ enabled: null });
    const { status, body } = parse(await handler(post({ photo_ids: ['a'] })));
    expect(status).toBe(503);
    expect(body.error).toBe('facebook_sharing_disabled');
  });

  it('503s when the kill switch is set to anything other than exactly "1"', async () => {
    for (const v of ['0', 'true', 'yes', 'TRUE', '']) {
      const handler = await loadHandler({ enabled: v });
      expect(parse(await handler(post({ photo_ids: ['a'] }))).status,
        `FB_SHARE_ENABLED=${JSON.stringify(v)} must not enable posting`).toBe(503);
    }
  });

  it('the kill switch is checked AFTER auth, so a disabled endpoint is not an auth oracle', async () => {
    stubState.verifyTokenResult = new Error('bad token');
    const handler = await loadHandler({ enabled: null });
    // 401, not 503 — an unauthenticated caller learns nothing about the feature flag.
    expect(parse(await handler(post({ photo_ids: ['a'] }))).status).toBe(401);
  });

  it('405s an unknown method on the share path', async () => {
    const handler = await loadHandler();
    const res = await handler({
      requestContext: { http: { method: 'PUT' } },
      rawPath: '/api/share/facebook',
      headers: { authorization: 'Bearer t' },
    });
    expect(parse(res).status).toBe(405);
  });

  it('400s malformed JSON rather than throwing', async () => {
    const handler = await loadHandler();
    const res = await handler({
      requestContext: { http: { method: 'POST' } },
      rawPath: '/api/share/facebook',
      headers: { authorization: 'Bearer t' },
      body: '{not json',
    });
    const { status, body } = parse(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_json');
  });

  it('400s a request with no photo_ids, and writes nothing to share_log', async () => {
    const handler = await loadHandler();
    const { status, body } = parse(await handler(post({})));
    expect(status).toBe(400);
    expect(body.error).toBe('validation_failed');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  // The observability seam added alongside these tests. `attempt` must be emitted BEFORE the work,
  // so a function that dies mid-post still leaves evidence it was tried.
  it('emits a SHARE_METRIC attempt line, and an outcome line, for a POST', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      const handler = await loadHandler();
      await handler(post({}));                       // rejected at validation
      const metrics = logs.filter((l) => l.startsWith('SHARE_METRIC'));
      expect(metrics.some((l) => l.startsWith('SHARE_METRIC attempt'))).toBe(true);
      expect(metrics.some((l) => l.startsWith('SHARE_METRIC rejected'))).toBe(true);
      // A refused request is NOT a publish and must never be counted as one.
      expect(metrics.some((l) => l.startsWith('SHARE_METRIC posted'))).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('does not emit any SHARE_METRIC for a request rejected at auth', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      stubState.verifyTokenResult = new Error('bad token');
      const handler = await loadHandler();
      await handler(post({ photo_ids: ['a'] }));
      expect(logs.filter((l) => l.startsWith('SHARE_METRIC'))).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
});
