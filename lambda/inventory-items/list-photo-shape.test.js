// V5-SEEDCARDS-001 — the packet photo a seed row carries, driven through the REAL handler (the
// _test-stubs seam, as seed-lot-shape.test.js does) rather than read off its source.
//
// What the seed card and the packet page READ, and what must never ride along:
//   - hero_photo_id is the DERIVED hero (explicit pointer, else the lot's newest photo). The list must
//     NOT write it into featured_photo_id: the client PUTs a list row back whole (quantityAdjuster.js,
//     SavedSeeds' listRowPutBody), and a derived id there would promote the fallback photo to the
//     explicit pointer — after which Dave's own next photo could never become the cover.
//   - NO list signs a URL (BUG-SEEDLISTSIGNING-001). v4.140.0 signed a view and a thumb URL for every
//     seed row on every load and the seed list went from sub-second to multi-second; the row now
//     carries the photo id and My seeds mints the thumbs it draws. A presign here is the regression.
//   - the join-only columns (storage path, effective id) never leave the Lambda.
// Found by the pre-promote QA pass (review/qa-v4140.md): every one of these could break with the
// whole lambda/ suite still green (mutants L1-L5, L13, L14).
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

process.env.S3_PHOTOS_BUCKET = 'qa-bucket'; // read at module load (index.js BUCKET)
const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const KEY = `inventory/${LOT}/ph-9.jpg`;
// What the list SELECT hands back for a lot whose hero is the FALLBACK photo (306 of 327 prod seed
// rows on 2026-09-19): the raw pointer is null, the derived id is not.
const listRow = () => ({
  id: LOT, category: 'seeds', name: 'Carolina Reaper', featured_photo_id: null,
  effective_featured_photo_id: 'ph-9', featured_is_explicit: false, featured_photo_storage_path: KEY,
  scoville_min: 1400000, scoville_max: 2200000, scoville_source: 'vendor_catalog',
});
const get = (rawPath, qs) => ({
  requestContext: { http: { method: 'GET' } }, rawPath,
  headers: { authorization: 'Bearer stub-token' }, queryStringParameters: qs,
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || 'null') });

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
});

describe('seed list rows carry the packet photo the card reads', () => {
  it('?category=seeds: hero_photo_id is the DERIVED id, featured_photo_id stays RAW, NOTHING signed, no join-only keys', async () => {
    // Many rows, so a per-row presign cannot hide behind a one-row fixture.
    stubState.sqlHandler = () => Array.from({ length: 40 }, () => listRow());
    const { status, body } = parse(await handler(get('/api/inventory-items', { category: 'seeds' })));
    expect(status).toBe(200);
    expect(body).toHaveLength(40);
    const [r] = body;
    expect(r.hero_photo_id).toBe('ph-9');
    expect(r.featured_photo_id).toBeNull();
    expect(r).not.toHaveProperty('featured_photo_view_url');
    expect(r).not.toHaveProperty('featured_photo_thumb_url');
    expect(r).not.toHaveProperty('featured_photo_storage_path');
    expect(r).not.toHaveProperty('effective_featured_photo_id');
    expect(stubState.presigns).toEqual([]);
  });

  it('the list logs its route, row count and elapsed ms under tag inv-list', async () => {
    stubState.sqlHandler = () => [listRow(), listRow()];
    const logged = [];
    const orig = console.log;
    console.log = (line) => { logged.push(line); };
    try {
      await handler(get('/api/inventory-items', { category: 'seeds' }));
    } finally {
      console.log = orig;
    }
    const line = logged.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((o) => o?.tag === 'inv-list');
    expect(line).toMatchObject({ tag: 'inv-list', filter: 'seeds', rows: 2 });
    expect(Number.isInteger(line.ms) && line.ms >= 0).toBe(true);
  });

  it('unfiltered list: hero_photo_id present, NO URL keys, nothing signed', async () => {
    stubState.sqlHandler = () => [listRow()];
    const { status, body } = parse(await handler(get('/api/inventory-items', undefined)));
    expect(status).toBe(200);
    expect(body[0].hero_photo_id).toBe('ph-9');
    expect(body[0].featured_photo_id).toBeNull();
    expect(body[0]).not.toHaveProperty('featured_photo_view_url');
    expect(body[0]).not.toHaveProperty('featured_photo_thumb_url');
    expect(body[0]).not.toHaveProperty('featured_photo_storage_path');
    expect(stubState.presigns).toEqual([]);
  });

  it('by-id: hero_photo_id repeats the derived id the page hands lotPhoto()', async () => {
    stubState.sqlHandler = (text) => (/FROM inventory_items i/.test(text) ? [listRow()] : []);
    const { status, body } = parse(await handler(get(`/api/inventory-items/${LOT}`)));
    expect(status).toBe(200);
    expect(body.hero_photo_id).toBe('ph-9');
    expect(body.featured_photo_id).toBe('ph-9');
    expect(body.featured_photo_view_url).toContain(KEY);
  });
});
