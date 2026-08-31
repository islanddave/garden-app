// Execution coverage for the PUBLISH path of lambda/facebook-share/index.js.
//
// Companion to handlerGates.test.js, which covers everything before the work starts. This file
// covers the work itself: S3 read -> JPEG guard -> EXIF strip -> Graph upload -> share_log, plus
// the orphan cleanup that runs when the feed call fails. All of it previously unexecuted.
//
// The single most important assertion here is the FAIL-CLOSED strip guard. `stripJpegExif` reports
// `incompleteWalk` when its segment walk breaks partway, which means everything past that offset was
// copied through UNEXAMINED — an EXIF/GPS block living there is still in the output bytes. This is
// the only exit that sends a photo outside the household, so "we could not prove it is clean" has to
// stop the publish. A regression there does not throw or crash; it silently publishes a photo with
// its coordinates attached. Nothing else in the suite executes that branch.
//
// Graph I/O is intercepted at global fetch — the handler's only network surface.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const ADMIN = 'user_admin_stub';
process.env.S3_PHOTOS_BUCKET = 'garden-photos-stub';
const { handler } = await import('./index.js');

// ── JPEG fixtures, each verified against the real exif.js before being relied on here ─────────────
const bytes = (...x) => Uint8Array.from(x.flat());
const seg = (m, p) => [0xFF, m, ((p.length + 2) >> 8) & 0xFF, (p.length + 2) & 0xFF, ...p];
const SOI = [0xFF, 0xD8], EOI = [0xFF, 0xD9];
const APP0 = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const APP1_EXIF = seg(0xE1, [0x45, 0x78, 0x69, 0x66, 0, 0, 9, 9, 9, 9]);
const SOS = [0xFF, 0xDA, 0x00, 0x08, 1, 0, 0, 0, 0, 0];
// Clean, walkable JPEG carrying an EXIF block the stripper removes. incompleteWalk === false.
const GOOD_JPEG = bytes(SOI, APP0, APP1_EXIF, SOS, [1, 2, 3, 4], EOI);
// Valid magic bytes, then a segment whose declared length runs past the buffer: reason
// 'bad-length', incompleteWalk === true. This is a JPEG the guard must REFUSE, not repair.
const MALFORMED_JPEG = bytes(SOI, [0xFF, 0xE1, 0x00, 0x40], [1, 2]);
const NOT_A_JPEG = bytes([0x89, 0x50, 0x4E, 0x47], [1, 2, 3]);

const photoRow = (id) => ({
  id, storage_path: `photos/${id}.jpg`,
  planting_name: 'Tie-Dye Tomato', variety_name: 'Tie-Dye', crop_name: 'Tomato', event_type: 'harvest',
});

function sqlRouter({ photos = [], prior = [] } = {}) {
  return (text) => {
    if (/FROM share_log/i.test(text)) return prior;      // idempotency replay lookup
    if (/FROM\s+photos/i.test(text)) return photos;      // household-scoped existence check
    return [];                                            // INSERT / UPDATE
  };
}

const post = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/share/facebook',
  headers: { authorization: 'Bearer stub' },
  body: JSON.stringify(body),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') });

let fetchMock;
const graphCalls = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url), method: init?.method ?? 'GET', body: init?.body,
}));
const uploads = () => graphCalls().filter((c) => c.method === 'POST' && c.url.includes('/photos'));
const feeds = () => graphCalls().filter((c) => c.method === 'POST' && c.url.includes('/feed'));
const deletes = () => graphCalls().filter((c) => c.method === 'DELETE');
const publishedFlagOf = (call) => call.body?.get?.('published');

const okJson = (json) => ({ ok: true, status: 200, json: async () => json });
const errJson = (status, json) => ({ ok: false, status, json: async () => json });

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: ADMIN };
  stubState.s3Bytes = GOOD_JPEG;
  process.env.ADMIN_CLERK_SUBS = ADMIN;
  process.env.FB_SHARE_ENABLED = '1';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('facebook-share publish path', () => {
  it('single photo: one published upload, caption inline, row marked posted', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'MEDIA1', post_id: 'POST1' }))  // /photos
             .mockResolvedValueOnce(okJson({}));                                  // read-back
    const { status, body } = parse(await handler(post({ photo_ids: ['p1'], caption: '  hi  ' })));

    expect(status).toBe(201);
    expect(body.post_id).toBe('POST1');
    expect(uploads()).toHaveLength(1);
    expect(publishedFlagOf(uploads()[0])).toBe('true');
    expect(feeds()).toHaveLength(0);            // single photo never touches /feed
    const updates = stubState.sqlCalls.filter((c) => /UPDATE share_log/i.test(c.text));
    expect(updates.some((c) => c.values.includes('posted'))).toBe(true);
  });

  it('multi photo: unpublished uploads, then ONE feed call carrying the caption', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1'), photoRow('p2')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'M1' }))
             .mockResolvedValueOnce(okJson({ id: 'M2' }))
             .mockResolvedValueOnce(okJson({ id: 'POSTX' }))   // /feed
             .mockResolvedValueOnce(okJson({}));               // read-back
    const { status, body } = parse(await handler(post({ photo_ids: ['p1', 'p2'], caption: 'two' })));

    expect(status).toBe(201);
    expect(body.post_id).toBe('POSTX');
    expect(uploads()).toHaveLength(2);
    for (const u of uploads()) expect(publishedFlagOf(u)).toBe('false');
    expect(feeds()).toHaveLength(1);
  });

  // ── BUG-FBPERMALINK-001: the permalink reaches share_log, not just the response ─────────────────
  //
  // The Instagram equivalent (handlerInstagram.test.js) has asserted this since V4-IGSHARE-001; the
  // Facebook side had NO permalink assertion at all, which is how a setStatus with no `permalink`
  // column in it shipped and stayed green. share_log is append-only, so a row that cannot say where
  // its photo went is unrecoverable history.
  //
  // The URL shape is the one live Graph returned for a real Page post (v21.0), not an invented
  // facebook.com/p1 — a fixture that cannot occur in prod proves nothing about the path that runs.
  const PERMALINK = 'https://www.facebook.com/122102484477456294/posts/122101954179456294';

  it('single photo: the permalink from the read-back is persisted AND returned', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'MEDIA1', post_id: 'POST1' }))
             .mockResolvedValueOnce(okJson({ permalink_url: PERMALINK }));   // read-back
    const { status, body } = parse(await handler(post({ photo_ids: ['p1'], caption: 'hi' })));

    expect(status).toBe(201);
    expect(body.permalink).toBe(PERMALINK);
    // The load-bearing half. `permalink` now appears in EVERY setStatus statement, so matching the
    // text alone would pass even if no call site ever supplied a value — the bound value is what
    // proves the column is actually written.
    const updates = stubState.sqlCalls.filter((c) => /UPDATE share_log/i.test(c.text));
    expect(updates.some((c) => /permalink/.test(c.text) && c.values.includes(PERMALINK))).toBe(true);
    // And it costs no extra Graph call: the field rides the read-back GET that already ran.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(graphCalls().find((c) => c.method === 'GET').url).toContain('permalink_url');
  });

  it('multi photo: every row in the group gets the post-level permalink', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1'), photoRow('p2')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'M1' }))
             .mockResolvedValueOnce(okJson({ id: 'M2' }))
             .mockResolvedValueOnce(okJson({ id: 'POSTX' }))                 // /feed
             .mockResolvedValueOnce(okJson({ permalink_url: PERMALINK }));   // read-back
    const { status, body } = parse(await handler(post({ photo_ids: ['p1', 'p2'], caption: 'two' })));

    expect(status).toBe(201);
    // This path returned no `permalink` key AT ALL before — a multi-photo post answered with a
    // different response shape than a single-photo one for no reason the client could see.
    expect(body.permalink).toBe(PERMALINK);
    const carrying = stubState.sqlCalls
      .filter((c) => /UPDATE share_log/i.test(c.text) && c.values.includes(PERMALINK));
    expect(carrying).toHaveLength(2);           // one per photo, not just the first
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 uploads + feed + read-back; no new call
  });

  it('a read-back that yields no permalink leaves the column alone rather than nulling it', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'MEDIA1', post_id: 'POST1' }))
             .mockResolvedValueOnce(okJson({}));   // read-back with no permalink_url
    const { status, body } = parse(await handler(post({ photo_ids: ['p1'] })));

    expect(status).toBe(201);
    expect(body.permalink).toBeNull();
    // One status write, not a second no-op UPDATE. The publish still succeeded — a missing permalink
    // is cosmetic and must never look like a failure.
    expect(stubState.sqlCalls.filter((c) => /UPDATE share_log/i.test(c.text))).toHaveLength(1);
  });

  // ── The guard this file exists for ────────────────────────────────────────────────────────────
  it('FAIL-CLOSED: a malformed JPEG is refused and NOTHING is sent to Graph', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    stubState.s3Bytes = MALFORMED_JPEG;
    const { status, body } = parse(await handler(post({ photo_ids: ['p1'] })));

    expect(status).toBe(422);
    expect(body.error).toBe('unshareable_photo');
    expect(body.message).toMatch(/metadata could not be fully removed/i);
    // The assertion that matters: no upload happened at all. A regression here does not crash —
    // it publishes a photo whose GPS block was copied through unexamined.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-JPEG before any network call', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    stubState.s3Bytes = NOT_A_JPEG;
    const { status, body } = parse(await handler(post({ photo_ids: ['p1'] })));
    expect(status).toBe(422);
    expect(body.message).toMatch(/not a JPEG/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a photo outside the household is "not found", never an existence oracle', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [] });   // row exists but is not household-scoped
    const { status, body } = parse(await handler(post({ photo_ids: ['someone-elses'] })));
    expect(status).toBe(404);
    expect(body.error).toBe('photos_not_found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Orphan cleanup, end to end through the handler ────────────────────────────────────────────
  it('a failed /feed deletes every already-uploaded media and records the outcome', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1'), photoRow('p2')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'M1' }))
             .mockResolvedValueOnce(okJson({ id: 'M2' }))
             .mockResolvedValueOnce(errJson(400, { error: { message: 'feed boom', code: 100 } }))
             .mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    const { status } = parse(await handler(post({ photo_ids: ['p1', 'p2'], caption: 'x' })));

    expect(status).toBe(502);
    const deletedIds = deletes().map((d) => d.url);
    expect(deletedIds).toHaveLength(2);
    expect(deletedIds.join(' ')).toContain('M1');
    expect(deletedIds.join(' ')).toContain('M2');
    const updates = stubState.sqlCalls.filter((c) => /UPDATE share_log/i.test(c.text));
    expect(updates.some((c) => c.values.includes('orphan_cleaned'))).toBe(true);
  });

  it('when a delete is NOT confirmed, the row says stranded — not cleaned', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1'), photoRow('p2')] });
    let call = 0;
    fetchMock.mockImplementation(async (url, init) => {
      call += 1;
      if (call === 1) return okJson({ id: 'M1' });
      if (call === 2) return okJson({ id: 'M2' });
      if (String(url).includes('/feed')) return errJson(400, { error: { message: 'boom', code: 100 } });
      if (init?.method === 'DELETE') return { ok: false, status: 500, json: async () => ({}) };
      return okJson({});
    });
    await handler(post({ photo_ids: ['p1', 'p2'], caption: 'x' })).catch(() => {});

    const updates = stubState.sqlCalls.filter((c) => /UPDATE share_log/i.test(c.text));
    expect(updates.some((c) => c.values.includes('orphan_cleanup_failed'))).toBe(true);
    expect(updates.some((c) => c.values.includes('orphan_cleaned'))).toBe(false);
  });

  // ── Pre-publish content assertion (boss condition 6's named control) ──────────────────────────
  // The point is not that a verdict is produced — contentAssertion.test.js covers that — but that
  // an unsafe verdict actually STOPS the publish. A control that returns "unsafe" and posts anyway
  // is worse than none, because it reports coverage it does not provide.
  it('a coordinate pair in the caption blocks the post before any Graph call', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    const { status, body } = parse(
      await handler(post({ photo_ids: ['p1'], caption: 'by the shed at 42.4712, -72.6009' })));

    expect(status).toBe(422);
    expect(body.error).toBe('content_blocked');
    expect(body.fields).toContain('caption');
    expect(fetchMock).not.toHaveBeenCalled();
    // failAll inlines the status as a LITERAL ('failed') rather than passing it as a parameter, so
    // this asserts on the statement text. setStatus is the opposite — it binds status as a value —
    // which is why the "marked posted" test above checks values instead. Same table, two shapes.
    const updates = stubState.sqlCalls.filter((c) => /UPDATE share_log/i.test(c.text));
    expect(updates.some((c) => /status = 'failed'/.test(c.text))).toBe(true);
  });

  // THE ALT TEXT IS PUBLISHED TOO, AND WAS UNGUARDED. Every test in this suite passed with the
  // handler's `altTexts:` argument replaced by `[]` (measured 2026-08-28 by mutation), so boss
  // condition 6's control could have been silently narrowed to the caption alone on the LIVE
  // Facebook path without a single failure. That is the more dangerous half: a caption is typed
  // deliberately, whereas alt text is DERIVED from planting/variety/crop display names that were
  // authored for private use and can say anything — including where something is.
  it('a coordinate pair in the ALT TEXT blocks the post, not just one in the caption', async () => {
    stubState.sqlHandler = sqlRouter({
      photos: [{ ...photoRow('p1'), planting_name: 'bed at 42.4712, -72.6009' }],
    });
    const { status, body } = parse(
      await handler(post({ photo_ids: ['p1'], caption: 'lovely afternoon' })));

    expect(status).toBe(422);
    expect(body.error).toBe('content_blocked');
    // The offending FIELD is named as an alt, which is what proves the caption did not trip it.
    expect(body.fields.join(',')).toMatch(/alt/);
    expect(body.fields).not.toContain('caption');
    expect(fetchMock).not.toHaveBeenCalled();

    // And the SENTENCE must not send the user to the wrong place. "Edit the caption and try again"
    // is wrong advice here — the offending text is derived from the planting/variety/crop name, so
    // editing the caption changes nothing and they retry into the same refusal.
    expect(body.message).toMatch(/description/i);
    expect(body.message).not.toMatch(/Edit the caption/i);
  });

  it('a configured forbidden term blocks the post, and the response never echoes the term', async () => {
    const secret = 'Mathews Road';
    process.env.SHARE_FORBIDDEN_TERMS = JSON.stringify([secret]);
    try {
      stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
      const res = await handler(post({ photo_ids: ['p1'], caption: `harvest from ${secret}` }));
      const { status, body } = parse(res);
      expect(status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.body).not.toContain(secret);       // the refusal must not republish the secret
    } finally { delete process.env.SHARE_FORBIDDEN_TERMS; }
  });

  // Malformed config must fail CLOSED. Degrading to "no terms configured" would leave the weaker
  // control running under the name of the stronger one — green, and quietly less safe.
  it('malformed SHARE_FORBIDDEN_TERMS refuses to publish rather than degrading', async () => {
    process.env.SHARE_FORBIDDEN_TERMS = 'not-json';
    try {
      stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
      const { status, body } = parse(await handler(post({ photo_ids: ['p1'], caption: 'totally fine' })));
      expect(status).toBe(500);
      expect(body.error).toBe('content_check_misconfigured');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { delete process.env.SHARE_FORBIDDEN_TERMS; }
  });

  it('an ordinary caption still publishes — the control is not a blanket refusal', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'M1', post_id: 'P1' }))
             .mockResolvedValueOnce(okJson({}));
    const { status } = parse(
      await handler(post({ photo_ids: ['p1'], caption: 'First ripe Tie-Dye of the year, 3.5 lbs' })));
    expect(status).toBe(201);
    expect(uploads()).toHaveLength(1);
  });

  // ── Idempotency, the reason the whole client-side key work exists ──────────────────────────────
  it('replays a prior posted row instead of posting again', async () => {
    stubState.sqlHandler = sqlRouter({
      photos: [photoRow('p1')],
      prior: [{ post_group_id: 'GROUP-OLD', fb_post_id: 'POST-OLD' }],
    });
    const { status, body } = parse(
      await handler(post({ photo_ids: ['p1'], client_request_id: 'req-1' })));

    expect(status).toBe(200);
    expect(body.replay).toBe(true);
    expect(body.post_id).toBe('POST-OLD');
    expect(fetchMock).not.toHaveBeenCalled();   // the whole point: no second post
  });

  // Two assertions, two different regressions, neither catching the other's: the response check
  // fails if `permalink` is dropped from resp(), the SQL check fails if it is dropped from the
  // SELECT. The stub returns `prior` whole whatever columns the query names, so the response
  // assertion alone would stay green over a query that no longer reads the column.
  it('a replay hands back the stored permalink, not just the post id', async () => {
    stubState.sqlHandler = sqlRouter({
      photos: [photoRow('p1')],
      prior: [{ post_group_id: 'GROUP-OLD', fb_post_id: 'POST-OLD', permalink: PERMALINK }],
    });
    const { status, body } = parse(
      await handler(post({ photo_ids: ['p1'], client_request_id: 'req-replay-link' })));

    expect(status).toBe(200);
    expect(body.replay).toBe(true);
    expect(body.permalink).toBe(PERMALINK);
    const replayQuery = stubState.sqlCalls.map((c) => c.text).find((t) => /FROM share_log/i.test(t));
    expect(replayQuery).toContain('permalink');
  });

  // Rows written before BUG-FBPERMALINK-001 have permalink NULL. The replay must degrade to the
  // synthesised facebook.com/{post_id} link the sheet builds, not send `undefined` to the client.
  it('an older row with no permalink replays a null, leaving the sheet to synthesise', async () => {
    stubState.sqlHandler = sqlRouter({
      photos: [photoRow('p1')],
      prior: [{ post_group_id: 'GROUP-OLD', fb_post_id: 'POST-OLD', permalink: null }],
    });
    const { body } = parse(
      await handler(post({ photo_ids: ['p1'], client_request_id: 'req-replay-old' })));
    expect(body.replay).toBe(true);
    expect(body.permalink).toBeNull();
    expect(body.post_id).toBe('POST-OLD');
  });

  // The replay lookup is scoped to target='facebook'. Today that predicate matches nothing extra —
  // the shipping client gives each target its own id — so it is a safety property of the QUERY
  // rather than a behaviour anyone can observe. It is pinned because the failure it prevents is
  // silent and severe: under a shared-id scheme (which the rescued Instagram lane used) an Instagram
  // row would answer this lookup, and the endpoint would return replay:true with an Instagram media
  // id as post_id — the sheet reporting a Facebook post that was never made.
  it('scopes the replay lookup to target=facebook in the SQL it actually issues', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'M1', post_id: 'P1' })).mockResolvedValueOnce(okJson({}));
    await handler(post({ photo_ids: ['p1'], client_request_id: 'req-fb-1' }));
    const replayQuery = stubState.sqlCalls.map((c) => c.text).find((t) => /FROM share_log/i.test(t));
    expect(replayQuery).toBeTruthy();
    expect(replayQuery).toContain("target = 'facebook'");
  });

  it('without a client_request_id there is no replay lookup, so a repost really posts', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    fetchMock.mockResolvedValueOnce(okJson({ id: 'M9', post_id: 'P9' }))
             .mockResolvedValueOnce(okJson({}));
    const { status } = parse(await handler(post({ photo_ids: ['p1'] })));
    expect(status).toBe(201);
    expect(stubState.sqlCalls.some((c) => /FROM share_log/i.test(c.text))).toBe(false);
  });
});
