// Execution coverage for the INSTAGRAM path of lambda/facebook-share/index.js (V4-IGSHARE-001).
//
// Companion to handlerGates.test.js (the controls before the work) and handlerPublish.test.js (the
// Facebook publish). This file covers the path Instagram needs and Facebook does not: stage the
// EXIF-stripped bytes to S3, presign THAT object, create container(s), poll to FINISHED, publish,
// then sweep staging.
//
// THE ASSERTION THIS FILE EXISTS FOR is `presigns the STAGED key, never the original object`.
// Instagram has no byte-upload — Meta fetches a URL we hand it — so unlike Facebook, the privacy
// guarantee is not enforced by the shape of the call. Presigning `storage_path` instead of the
// staging key compiles, passes every other test here, posts successfully, and publishes the
// untouched original with its GPS EXIF intact. Measured 2026-08-21: 4 of 5 sampled prod photos
// carry GPS. That regression has no symptom other than this test.
//
// An Instagram post also CANNOT be deleted through the API (verified 2026-08-21: DELETE -> code 10),
// so every guard that stops a bad publish matters more here than on the Facebook side, where a
// mistake is at least recallable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const ADMIN = 'user_admin_stub';
process.env.S3_PHOTOS_BUCKET = 'garden-photos-stub';
const { handler } = await import('./index.js');

// Same fixtures as handlerPublish.test.js — a clean walkable JPEG carrying an EXIF block.
const bytes = (...x) => Uint8Array.from(x.flat());
const seg = (m, p) => [0xFF, m, ((p.length + 2) >> 8) & 0xFF, (p.length + 2) & 0xFF, ...p];
const SOI = [0xFF, 0xD8], EOI = [0xFF, 0xD9];
const APP0 = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const APP1_EXIF = seg(0xE1, [0x45, 0x78, 0x69, 0x66, 0, 0, 9, 9, 9, 9]);
const SOS = [0xFF, 0xDA, 0x00, 0x08, 1, 0, 0, 0, 0, 0];
const GOOD_JPEG = bytes(SOI, APP0, APP1_EXIF, SOS, [1, 2, 3, 4], EOI);

const photoRow = (id) => ({ id, storage_path: `photos/original-${id}.jpg` });

function sqlRouter({ photos = [], prior = [] } = {}) {
  const seen = [];
  const fn = (text) => {
    seen.push(text);
    if (/FROM share_log/i.test(text)) return prior;
    if (/FROM\s+photos/i.test(text)) return photos;
    return [];
  };
  fn.seen = seen;
  return fn;
}

const igPost = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/share/instagram',
  headers: { authorization: 'Bearer stub' },
  body: JSON.stringify(body),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') });

let fetchMock;
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url), method: init?.method ?? 'GET', body: init?.body,
}));
// igMediaUrl ends '/media'; igPublishUrl ends '/media_publish'. A naive includes('/media') matches
// both, which would make "did we publish?" unanswerable — split them precisely.
const containers = () => calls().filter((c) => c.method === 'POST' && /\/media(\?|$)/.test(c.url));
const publishes = () => calls().filter((c) => c.method === 'POST' && c.url.includes('/media_publish'));
const fieldOf = (c, k) => c.body?.get?.(k);

const okJson = (json) => ({ ok: true, status: 200, json: async () => json });
const errJson = (status, json) => ({ ok: false, status, json: async () => json });
const FINISHED = okJson({ status_code: 'FINISHED' });

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: ADMIN };
  stubState.s3Bytes = GOOD_JPEG;
  process.env.ADMIN_CLERK_SUBS = ADMIN;
  process.env.IG_SHARE_ENABLED = '1';
  process.env.FB_SHARE_ENABLED = '1';
  delete process.env.SHARE_FORBIDDEN_TERMS;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.IG_SHARE_ENABLED;
  delete process.env.SHARE_FORBIDDEN_TERMS;
});

// A complete single-photo happy path: container -> poll FINISHED -> publish -> permalink.
function mockSingleOk() {
  fetchMock
    .mockResolvedValueOnce(okJson({ id: 'CONTAINER1' }))
    .mockResolvedValueOnce(FINISHED)
    .mockResolvedValueOnce(okJson({ id: 'IGMEDIA1' }))
    .mockResolvedValueOnce(okJson({ permalink: 'https://instagram.com/p/xyz' }));
}

describe('instagram publish path', () => {
  it('PRIVACY: presigns the STAGED key, never the original object', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    const { status } = parse(await handler(igPost({ photo_ids: ['p1'], caption: 'hello' })));
    expect(status).toBe(201);

    // Exactly one object was staged, and it is the ig-staging/ key — not photos/original-p1.jpg.
    expect(stubState.s3Puts).toHaveLength(1);
    expect(stubState.s3Puts[0].Key).toBe('ig-staging/' + stubState.s3Puts[0].Key.split('/')[1] + '/p1.jpg');
    expect(stubState.s3Puts[0].Key).toMatch(/^ig-staging\/[0-9a-f-]{36}\/p1\.jpg$/);

    // The presign — the URL actually handed to Meta — points at that staged key.
    expect(stubState.presigns).toHaveLength(1);
    expect(stubState.presigns[0].key).toBe(stubState.s3Puts[0].Key);
    expect(stubState.presigns[0].key).not.toContain('original');

    // And the image_url field on the container carries it.
    const url = fieldOf(containers()[0], 'image_url');
    expect(url).toContain('ig-staging/');
    expect(url).not.toContain('photos/original-p1.jpg');
  });

  it('PRIVACY: the staged bytes are the STRIPPED bytes, shorter than the original', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    await handler(igPost({ photo_ids: ['p1'] }));
    // GOOD_JPEG carries an APP1/EXIF segment; the staged body must be the stripped copy, so it is
    // strictly smaller than what came out of S3. Equal length would mean the original was staged.
    expect(stubState.s3Puts[0].Body.byteLength).toBeLessThan(GOOD_JPEG.byteLength);
  });

  it('presigns with a SHORT ttl — the URL must not outlive its purpose', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    await handler(igPost({ photo_ids: ['p1'] }));
    expect(stubState.presigns[0].expiresIn).toBe(600);
  });

  it('sweeps every staged key on SUCCESS', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    await handler(igPost({ photo_ids: ['p1'] }));
    expect(stubState.s3Deletes.map((d) => d.Key)).toEqual(stubState.s3Puts.map((p) => p.Key));
  });

  it('sweeps every staged key on FAILURE too — the finally, not the happy path', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock.mockResolvedValueOnce(errJson(400, { error: { message: 'nope', code: 100 } }));
    // instagramShare throws; the handler's outer catch maps GraphError to a 502 RESPONSE, so this
    // resolves rather than rejecting. The error code reads 'facebook_error' even for an Instagram
    // failure because both targets share one Graph error classifier and one Page token — accurate,
    // if awkwardly named. What matters here is that the staging sweep ran on the throwing path.
    const { status } = parse(await handler(igPost({ photo_ids: ['p1'] })));
    expect(status).toBe(502);
    expect(stubState.s3Puts).toHaveLength(1);
    expect(stubState.s3Deletes.map((d) => d.Key)).toEqual(stubState.s3Puts.map((p) => p.Key));
  });

  it('a failed sweep never masks the real outcome', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    stubState.s3DeleteThrows = true;
    mockSingleOk();
    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1'] })));
    expect(status).toBe(201);
    expect(body.media_id).toBe('IGMEDIA1');
  });

  it('single photo: one container, publishes it, persists the permalink', async () => {
    const sql = sqlRouter({ photos: [photoRow('p1')] });
    stubState.sqlHandler = sql;
    mockSingleOk();
    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1'], caption: 'toms' })));

    expect(status).toBe(201);
    expect(body.media_id).toBe('IGMEDIA1');
    expect(body.carousel).toBe(false);
    expect(body.permalink).toBe('https://instagram.com/p/xyz');
    expect(containers()).toHaveLength(1);
    expect(publishes()).toHaveLength(1);
    expect(fieldOf(publishes()[0], 'creation_id')).toBe('CONTAINER1');
    // The permalink reaches share_log, not just the response — an IG post cannot be deleted via the
    // API, so "where is it" is the only actionable fact a human has.
    expect(sql.seen.some((t) => /UPDATE share_log/.test(t) && /permalink/.test(t))).toBe(true);
  });

  it('carousel: children first, then a parent, and it publishes the PARENT not a child', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1'), photoRow('p2')] });
    fetchMock
      .mockResolvedValueOnce(okJson({ id: 'CHILD1' }))
      .mockResolvedValueOnce(okJson({ id: 'CHILD2' }))
      .mockResolvedValueOnce(FINISHED)                    // poll CHILD1
      .mockResolvedValueOnce(FINISHED)                    // poll CHILD2
      .mockResolvedValueOnce(okJson({ id: 'PARENT' }))
      .mockResolvedValueOnce(FINISHED)                    // poll PARENT
      .mockResolvedValueOnce(okJson({ id: 'IGMEDIA2' }))
      .mockResolvedValueOnce(okJson({ permalink: 'https://instagram.com/p/abc' }));

    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1', 'p2'], caption: 'two' })));
    expect(status).toBe(201);
    expect(body.carousel).toBe(true);
    expect(body.count).toBe(2);

    const [c1, c2, parent] = containers();
    expect(fieldOf(c1, 'is_carousel_item')).toBe('true');
    expect(fieldOf(c2, 'is_carousel_item')).toBe('true');
    // Children carry NO caption — it belongs on the parent and is silently ignored on a child.
    expect(fieldOf(c1, 'caption')).toBeFalsy();
    expect(fieldOf(parent, 'media_type')).toBe('CAROUSEL');
    expect(fieldOf(parent, 'children')).toBe('CHILD1,CHILD2');
    expect(fieldOf(parent, 'caption')).toBe('two');
    // Publishing a CHILD yields a one-image post and silently drops the rest — the classic mistake.
    expect(fieldOf(publishes()[0], 'creation_id')).toBe('PARENT');
  });

  it('carousel order follows the REQUESTED order, which is the display order', async () => {
    // Rows come back from Postgres in an arbitrary order; the carousel must not inherit it.
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p2'), photoRow('p1')] });
    fetchMock
      .mockResolvedValueOnce(okJson({ id: 'FIRST' }))
      .mockResolvedValueOnce(okJson({ id: 'SECOND' }))
      .mockResolvedValueOnce(FINISHED).mockResolvedValueOnce(FINISHED)
      .mockResolvedValueOnce(okJson({ id: 'PARENT' })).mockResolvedValueOnce(FINISHED)
      .mockResolvedValueOnce(okJson({ id: 'IGM' })).mockResolvedValueOnce(okJson({}));

    await handler(igPost({ photo_ids: ['p1', 'p2'] }));
    expect(stubState.presigns[0].key).toContain('/p1.jpg');
    expect(stubState.presigns[1].key).toContain('/p2.jpg');
  });

  it('does NOT publish a container that never reached FINISHED', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock
      .mockResolvedValueOnce(okJson({ id: 'CONTAINER1' }))
      .mockResolvedValueOnce(okJson({ status_code: 'ERROR', status: 'media fetch failed' }));
    const res = await handler(igPost({ photo_ids: ['p1'] }));
    expect(parse(res).status).toBe(422);
    expect(publishes()).toHaveLength(0);
  });

  it('EXPIRED is terminal and is not retried into a loop', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock
      .mockResolvedValueOnce(okJson({ id: 'CONTAINER1' }))
      .mockResolvedValueOnce(okJson({ status_code: 'EXPIRED', status: 'container aged out' }));
    expect(parse(await handler(igPost({ photo_ids: ['p1'] }))).status).toBe(422);
    expect(publishes()).toHaveLength(0);
    expect(calls().filter((c) => c.method === 'GET')).toHaveLength(1); // polled once, then stopped
  });

  it('rejects an oversize image BEFORE spending a container (quota is consumed by rejects)', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    // 9MB of JPEG-shaped bytes: over Instagram's 8MB ceiling, under Facebook's 10MB.
    stubState.s3Bytes = bytes(SOI, APP0, SOS, new Array(9 * 1024 * 1024).fill(1), EOI);
    const { status } = parse(await handler(igPost({ photo_ids: ['p1'] })));
    expect(status).toBe(422);
    expect(containers()).toHaveLength(0);
    expect(stubState.s3Puts).toHaveLength(0);   // not even staged
  });

  // ── The pre-publish content assertion, on the path that cannot be un-published ──
  it('BLOCKS a caption carrying a coordinate pair, before any container', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    const { status, body } = parse(await handler(igPost({
      photo_ids: ['p1'], caption: 'the beds at 42.4712, -72.6009 are going well',
    })));
    expect(status).toBe(422);
    expect(body.error).toBe('content_blocked');
    expect(containers()).toHaveLength(0);
    expect(publishes()).toHaveLength(0);
    expect(stubState.s3Puts).toHaveLength(0);
  });

  it('BLOCKS a configured forbidden term', async () => {
    process.env.SHARE_FORBIDDEN_TERMS = JSON.stringify(['Elmwood']);
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    const { status, body } = parse(await handler(igPost({
      photo_ids: ['p1'], caption: 'down at Elmwood the squash came in',
    })));
    expect(status).toBe(422);
    expect(body.error).toBe('content_blocked');
    expect(containers()).toHaveLength(0);
    // The response must not echo the term back — that would republish what it blocks.
    expect(JSON.stringify(body)).not.toContain('Elmwood');
  });

  it('FAILS CLOSED on a malformed term list rather than degrading to no check', async () => {
    process.env.SHARE_FORBIDDEN_TERMS = '{not-an-array';
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1'], caption: 'fine' })));
    expect(status).toBe(500);
    expect(body.error).toBe('content_check_misconfigured');
    expect(containers()).toHaveLength(0);
  });

  it('an ABSENT term list is not malformed — coordinates still checked, publish still allowed', async () => {
    delete process.env.SHARE_FORBIDDEN_TERMS;
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    expect(parse(await handler(igPost({ photo_ids: ['p1'], caption: 'plain' }))).status).toBe(201);
  });

  // ── Kill switch: per-target, and independent in BOTH directions ──
  it('503s when IG_SHARE_ENABLED is absent, even with Facebook fully enabled', async () => {
    delete process.env.IG_SHARE_ENABLED;
    process.env.FB_SHARE_ENABLED = '1';
    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1'] })));
    expect(status).toBe(503);
    expect(body.error).toBe('instagram_sharing_disabled');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('demands exactly "1" — no truthy-string enablement', async () => {
    for (const v of ['0', 'true', 'yes', 'TRUE', '']) {
      process.env.IG_SHARE_ENABLED = v;
      expect(parse(await handler(igPost({ photo_ids: ['p1'] }))).status,
        `IG_SHARE_ENABLED=${JSON.stringify(v)} must not enable posting`).toBe(503);
    }
  });

  it('turning Facebook OFF does not turn Instagram off with it', async () => {
    delete process.env.FB_SHARE_ENABLED;
    process.env.IG_SHARE_ENABLED = '1';
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    expect(parse(await handler(igPost({ photo_ids: ['p1'] }))).status).toBe(201);
  });

  it('is admin-gated and auth-gated like every other path', async () => {
    stubState.verifyTokenResult = new Error('bad token');
    expect(parse(await handler(igPost({ photo_ids: ['p1'] }))).status).toBe(401);
    stubState.verifyTokenResult = { sub: 'someone_else' };
    expect(parse(await handler(igPost({ photo_ids: ['p1'] }))).status).toBe(403);
  });

  // ── Idempotency replay, scoped by target ──
  it('replays a prior Instagram post instead of publishing again', async () => {
    stubState.sqlHandler = sqlRouter({
      photos: [photoRow('p1')],
      prior: [{ post_group_id: 'G-OLD', fb_post_id: 'IGMEDIA-OLD' }],
    });
    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1'], client_request_id: 'req-1' })));
    expect(status).toBe(200);
    expect(body.replay).toBe(true);
    expect(body.media_id).toBe('IGMEDIA-OLD');
    expect(publishes()).toHaveLength(0);
  });

  it('scopes the replay lookup to target=instagram in the SQL it actually issues', async () => {
    const sql = sqlRouter({ photos: [photoRow('p1')] });
    stubState.sqlHandler = sql;
    mockSingleOk();
    await handler(igPost({ photo_ids: ['p1'], client_request_id: 'req-2' }));
    const replayQuery = sql.seen.find((t) => /FROM share_log/.test(t));
    expect(replayQuery).toBeTruthy();
    // Without this predicate a Facebook row under the same id answers the Instagram lookup.
    expect(replayQuery).toContain("target = 'instagram'");
  });

  it('writes target=instagram rows, never defaulting to facebook', async () => {
    const sql = sqlRouter({ photos: [photoRow('p1')] });
    stubState.sqlHandler = sql;
    mockSingleOk();
    await handler(igPost({ photo_ids: ['p1'] }));
    const insert = sql.seen.find((t) => /INSERT INTO share_log/.test(t));
    expect(insert).toContain("'instagram'");
  });

  it('404s a photo outside the household without staging or contacting Meta', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [] });
    const { status, body } = parse(await handler(igPost({ photo_ids: ['not-mine'] })));
    expect(status).toBe(404);
    expect(body.error).toBe('photos_not_found');
    expect(stubState.s3Puts).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it('validates against INSTAGRAM limits, not Facebook ones', async () => {
    // 3000 chars is legal for Facebook (5000) and illegal for Instagram (2200).
    const { status, body } = parse(await handler(igPost({ photo_ids: ['p1'], caption: 'x'.repeat(3000) })));
    expect(status).toBe(400);
    expect(body.details.join(' ')).toMatch(/2200/);
    expect(calls()).toHaveLength(0);
  });
});
