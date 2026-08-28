// The ig_not_configured branch — deliberately its own file.
//
// index.js caches the facebook-page-token secret in module scope for 5 minutes (SECRETS_TTL_MS), so
// the FIRST getFbSecret() of a test file fixes that value for every later test in it. A sibling test
// that needs ig_user_id PRESENT and one that needs it ABSENT cannot share a file without either
// depending on test order or reaching into production code to add a cache-reset export. Vitest gives
// each file its own module registry, which is the clean seam — so this is one file, one branch.
//
// WHAT IT GUARDS. The Instagram path needs a field the Facebook path never reads: ig_user_id. If it
// is missing the handler must fail LOUDLY and BEFORE any work — not fetch photos, not stage bytes,
// not create a container against `undefined`. `graph.facebook.com/v21.0/undefined/media` is a real
// URL that returns a confusing Graph error, so an unguarded miss would look like an API problem
// rather than a configuration one. This is also a live deployment prerequisite: enabling
// IG_SHARE_ENABLED without adding ig_user_id to the secret gets a 500, by design.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const ADMIN = 'user_admin_stub';
process.env.S3_PHOTOS_BUCKET = 'garden-photos-stub';
const { handler } = await import('./index.js');

const igPost = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/share/instagram',
  headers: { authorization: 'Bearer stub' },
  body: JSON.stringify(body),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') });

let fetchMock;
beforeEach(() => {
  resetStubs();
  // The whole point of this file: ig_user_id absent, and never populated by an earlier test.
  delete stubState.secrets['garden-app/facebook-page-token'].ig_user_id;
  stubState.verifyTokenResult = { sub: ADMIN };
  stubState.sqlHandler = (text) => (/FROM\s+photos/i.test(text) ? [{ id: 'p1', storage_path: 'photos/p1.jpg' }] : []);
  stubState.s3Bytes = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xD9]);
  process.env.ADMIN_CLERK_SUBS = ADMIN;
  process.env.IG_SHARE_ENABLED = '1';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.IG_SHARE_ENABLED;
});

describe('instagram path without ig_user_id in the secret', () => {
  it('500s ig_not_configured and never contacts Meta or stages anything', async () => {
    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1'] })));
    expect(status).toBe(500);
    expect(body.error).toBe('ig_not_configured');
    expect(body.message).toMatch(/ig_user_id/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stubState.s3Puts).toHaveLength(0);
  });

  it('fails before writing any share_log row — no orphaned pending rows to reconcile', async () => {
    await handler(igPost({ photo_ids: ['p1'] }));
    expect(stubState.sqlCalls.filter((c) => /INSERT INTO share_log/.test(String(c)))).toHaveLength(0);
  });
});
