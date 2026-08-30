// IG_STAGING_BUCKET routing — deliberately its own file.
//
// index.js resolves IG_STAGING_BUCKET at MODULE SCOPE (`process.env.IG_STAGING_BUCKET || BUCKET`),
// so the value is fixed by the first import of index.js in a file and cannot be changed per-test.
// Vitest gives each file its own module registry, which is the only clean seam: this file pins the
// var SET, and handlerInstagram.test.js (which never sets it) covers the fallback. Setting it in a
// beforeEach would silently do nothing.
//
// WHAT IT GUARDS. The Instagram flow parks an EXIF-stripped copy of a private photo in S3 and hands
// Meta a presigned URL to it. That scratch copy used to land in S3_PHOTOS_BUCKET —
// garden-photos-prod — which is versioned AND replicates every object to garden-photos-replica-usw2
// with delete-marker replication disabled. Because S3 never replicates version-specific deletes,
// NO deletion of any kind reached the replica: every staged copy of a private photo accumulated in
// us-west-2 permanently, and the handler's own sweep reported success.
//
// The three assertions here are not interchangeable, and each fails independently:
//   1. the PUT goes to the staging bucket   — otherwise the bytes land in the replicated bucket;
//   2. the PRESIGN names the same bucket    — a presign left on the old bucket 404s for Meta, and
//                                             nothing else in this suite would notice;
//   3. the DELETE targets the same bucket   — a sweep aimed at the wrong bucket silently no-ops and
//                                             leaves the stripped copy behind, which is the exact
//                                             failure mode that reads as success.
// A change that updates only the PUT passes 1 and fails 2 and 3 — which is the point.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const ADMIN = 'user_admin_stub';
const PHOTOS_BUCKET = 'garden-photos-stub';
const STAGING_BUCKET = 'garden-derivatives-stub';

// BOTH set before the import, and to DIFFERENT values — if they matched, every assertion below
// would pass even with the routing reverted to BUCKET.
process.env.S3_PHOTOS_BUCKET = PHOTOS_BUCKET;
process.env.IG_STAGING_BUCKET = STAGING_BUCKET;
const { handler } = await import('./index.js');

const bytes = (...x) => Uint8Array.from(x.flat());
const seg = (m, p) => [0xFF, m, ((p.length + 2) >> 8) & 0xFF, (p.length + 2) & 0xFF, ...p];
const SOI = [0xFF, 0xD8], EOI = [0xFF, 0xD9];
const APP0 = seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const APP1_EXIF = seg(0xE1, [0x45, 0x78, 0x69, 0x66, 0, 0, 9, 9, 9, 9]);
const SOS = [0xFF, 0xDA, 0x00, 0x08, 1, 0, 0, 0, 0, 0];
const GOOD_JPEG = bytes(SOI, APP0, APP1_EXIF, SOS, [1, 2, 3, 4], EOI);

const photoRow = (id) => ({
  id, storage_path: `photos/original-${id}.jpg`,
  planting_name: 'Tie-Dye Tomato', variety_name: 'Tie-Dye', crop_name: 'Tomato', event_type: 'harvest',
});

const sqlRouter = ({ photos = [], prior = [] } = {}) => (text) => {
  if (/FROM share_log/i.test(text)) return prior;
  if (/FROM\s+photos/i.test(text)) return photos;
  return [];
};

const igPost = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/share/instagram',
  headers: { authorization: 'Bearer stub' },
  body: JSON.stringify(body),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') });

const okJson = (json) => ({ ok: true, status: 200, json: async () => json });
const FINISHED = okJson({ status_code: 'FINISHED' });

let fetchMock;
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
});

function mockSingleOk() {
  fetchMock
    .mockResolvedValueOnce(okJson({ id: 'CONTAINER1' }))
    .mockResolvedValueOnce(FINISHED)
    .mockResolvedValueOnce(okJson({ id: 'IGMEDIA1' }))
    .mockResolvedValueOnce(okJson({ permalink: 'https://instagram.com/p/xyz' }));
}

describe('IG staging bucket routing', () => {
  it('stages, presigns and sweeps in IG_STAGING_BUCKET — never the replicated photos bucket', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    const { status } = parse(await handler(igPost({ photo_ids: ['p1'], caption: 'hello' })));
    expect(status).toBe(201);

    // 1. the scratch copy is written to the unreplicated bucket
    expect(stubState.s3Puts).toHaveLength(1);
    expect(stubState.s3Puts[0].Bucket).toBe(STAGING_BUCKET);
    expect(stubState.s3Puts[0].Bucket).not.toBe(PHOTOS_BUCKET);

    // 2. the URL handed to Meta points at that same bucket — a presign left on the old bucket would
    //    404 on Meta's fetch and produce no other signal in this suite
    expect(stubState.presigns).toHaveLength(1);
    expect(stubState.presigns[0].bucket).toBe(STAGING_BUCKET);
    expect(stubState.presigns[0].key).toBe(stubState.s3Puts[0].Key);

    // 3. the sweep deletes from the bucket it actually wrote to
    expect(stubState.s3Deletes.length).toBeGreaterThan(0);
    for (const d of stubState.s3Deletes) expect(d.Bucket).toBe(STAGING_BUCKET);
  });

  it('still READS the original from S3_PHOTOS_BUCKET — the split is staging-only', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    await handler(igPost({ photo_ids: ['p1'] }));
    // The source photo lives in the photos bucket and must keep being read from there; only the
    // scratch copy moved. If a blanket find-and-replace swapped every BUCKET reference, this fails.
    // s3Calls is the GetObject log (PutObject and DeleteObject are recorded separately), so asserting
    // it is non-empty FIRST keeps the bucket check from passing vacuously on an empty array.
    expect(stubState.s3Calls.length).toBeGreaterThan(0);
    for (const g of stubState.s3Calls) expect(g.Bucket).toBe(PHOTOS_BUCKET);
    expect(stubState.s3Puts[0].Bucket).toBe(STAGING_BUCKET);
  });

  // Mutation-driven. Reverting the TOMBSTONE fallback to `Bucket: BUCKET` initially SURVIVED the
  // three tests above, because none of them reach that branch: it runs only when a version-aware
  // delete is DENIED, and the default stub returns no VersionId at all. An unexercised line is an
  // unguarded line — and this one matters precisely in the fallback configuration, where
  // IG_STAGING_BUCKET is unset and staging lands back on the versioned photos bucket.
  it('the tombstone fallback also targets the staging bucket when a versioned delete is denied', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    stubState.s3PutVersionId = 'v-stub-1';      // emulate a VERSIONED staging bucket
    stubState.s3DeleteVersionDenied = true;     // and the exec role lacking s3:DeleteObjectVersion
    mockSingleOk();
    const { status } = parse(await handler(igPost({ photo_ids: ['p1'] })));
    expect(status).toBe(201);                   // a cleanup failure must never change the outcome

    // Both deletes happen: the denied version-aware one, then the tombstone fallback.
    expect(stubState.s3Deletes).toHaveLength(2);
    expect(stubState.s3Deletes[0].VersionId).toBe('v-stub-1');
    expect(stubState.s3Deletes[1].VersionId).toBeUndefined();
    for (const d of stubState.s3Deletes) expect(d.Bucket).toBe(STAGING_BUCKET);
  });

  it('the staged bytes are still the STRIPPED bytes — moving buckets must not skip the strip', async () => {
    stubState.sqlHandler = sqlRouter({ photos: [photoRow('p1')] });
    mockSingleOk();
    await handler(igPost({ photo_ids: ['p1'] }));
    expect(stubState.s3Puts[0].Body.byteLength).toBeLessThan(GOOD_JPEG.byteLength);
  });
});
