// V4-EVTDELCONFIRM-001 — the event-photos read (eventPhotos.js) + its GET-arm wiring.
//
// Two tiers, per the photoDelete.js / edit-metadata.test.js precedent:
//   1. EXECUTING tests drive loadEventPhotos through a recording fake `sql` — proving the query
//      RUNS, what it binds, and that rows come back mapped (the tier SQL-text assertions cannot
//      reach; this repo has shipped an inert feature that passed a full green suite without it).
//   2. STATIC-SOURCE assertions pin the index.js wiring: the GET /api/events/:id arm calls the
//      loader AFTER both ownership gates, non-fatally, and spreads `photos` into the 200 body.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEventPhotos } from './eventPhotos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const HOUSE = ['user_a', 'user_b'];

// Tagged-template recorder (photoDelete.test.js pattern, single-statement subset).
function fakeSql(rows = []) {
  const calls = [];
  const fn = (strings, ...values) => {
    calls.push({ text: norm(strings.join('?')), values });
    return Promise.resolve(rows);
  };
  fn.calls = calls;
  return fn;
}

describe('loadEventPhotos — executed against a recording fake sql', () => {
  it('is one statement, keyed on the event id and household scope, and returns the rows', async () => {
    const rows = [{ id: 'ph-1', storage_path: 'events/e1/a.jpg', cover_for: [] }];
    const sql = fakeSql(rows);
    const out = await loadEventPhotos(sql, EVENT_ID, HOUSE);
    expect(out).toBe(rows);
    expect(sql.calls).toHaveLength(1);
    const { text, values } = sql.calls[0];
    expect(text).toContain('FROM photos ph');
    expect(text).toContain('ph.event_id = ?');
    expect(text).toContain('ph.created_by = ANY(?)');
    expect(values).toEqual([EVENT_ID, HOUSE]);
  });

  it('soft-delete filtering per house rules: the photos read AND every cover arm', async () => {
    const sql = fakeSql();
    await loadEventPhotos(sql, EVENT_ID, HOUSE);
    const { text } = sql.calls[0];
    // The photo list itself — an already-deleted photo must not inflate the offer count.
    expect(text).toContain('ph.deleted_at IS NULL');
    // Each cover arm — a soft-deleted parent's hero pointer is not an actionable disclosure.
    for (const alias of ['gn', 'pp', 'l', 'ii']) {
      expect(text, `cover arm ${alias} must filter deleted_at`).toContain(`${alias}.deleted_at IS NULL`);
    }
  });

  it('cover_for enumerates BOTH display-pointer columns on all four cover entities', async () => {
    // The set softDeletePhoto NULLs on the checked path (PHOTO_POINTERS), minus ledger/catalog
    // pointers and the flag-gated spaces arm — see eventPhotos.js header for each exclusion.
    const sql = fakeSql();
    await loadEventPhotos(sql, EVENT_ID, HOUSE);
    const { text } = sql.calls[0];
    const arms = [
      ['planting', 'public.garden_node gn', 'gn'],
      ['project', 'public.container pp', 'pp'],
      ['location', 'public.locations l', 'l'],
      ['inventory_item', 'public.inventory_items ii', 'ii'],
    ];
    for (const [kind, from, alias] of arms) {
      expect(text).toContain(`'${kind}' AS kind`);
      expect(text).toContain(`FROM ${from}`);
      expect(text).toContain(`${alias}.featured_photo_id = ph.id OR ${alias}.featured_image_id = ph.id`);
    }
    // Spaces stays OUT until SPACE_PHOTOS_ENABLED graduates (every spaces statement is gated on
    // that flag, which this Lambda does not read). This pin makes adding it a deliberate act.
    expect(text).not.toContain('spaces');
  });

  it('shape is stable: [] cover_for fallback, stable ORDER, and no URL/presign in this Lambda', async () => {
    const sql = fakeSql();
    await loadEventPhotos(sql, EVENT_ID, HOUSE);
    const { text } = sql.calls[0];
    expect(text).toContain(`'[]'::json`);         // a photo covering nothing reads [], never null
    expect(text).toContain('ORDER BY ph.created_at ASC, ph.id ASC');
    expect(text).toContain('ph.storage_path');    // the KEY ships; presigning is lambda/photos' job
    expect(text).not.toMatch(/view_url|thumb_url|presign/i);
  });
});

// ── index.js wiring — static-source (L-072), decommented per the edit-metadata.test.js hazard: a
// construct NAMED IN A COMMENT is not that construct. ────────────────────────────────────────────
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The GET arm of /api/events/:id, isolated: from its method test to its 200 response. Anchored on
// the response spread itself so a second `if (method === 'GET')` elsewhere cannot mislead the slice.
const getArm = () => {
  const j = SRC.indexOf('return resp(200, { ...detail, photos });');
  expect(j, 'the GET arm must return { ...detail, photos }').toBeGreaterThan(-1);
  const i = SRC.lastIndexOf("if (method === 'GET')", j);
  expect(i).toBeGreaterThan(-1);
  return SRC.slice(i, j + 60);
};

describe('GET /api/events/:id — the photos key is wired, gated, and non-fatal (source)', () => {
  it('imports the loader from the executable module (not a re-inlined copy)', () => {
    expect(SRC).toContain("import { loadEventPhotos } from './eventPhotos.js';");
  });

  it('calls loadEventPhotos AFTER both ownership gates, with the household scope', () => {
    const arm = getArm();
    const owned = arm.indexOf('isEventOwned(rows[0], householdIds)');
    const load = arm.indexOf('loadEventPhotos(sql, eventId, householdIds)');
    expect(owned, 'the second ownership gate must be inside the arm').toBeGreaterThan(-1);
    expect(load, 'the loader call must be inside the arm').toBeGreaterThan(owned);
  });

  it('is best-effort: the loader is inside a try/catch and a failure cannot 500 the event read', () => {
    const arm = getArm();
    const load = arm.indexOf('loadEventPhotos(');
    const tryIdx = arm.lastIndexOf('try {', load);
    const catchIdx = arm.indexOf('} catch', load);
    expect(tryIdx, 'loader must sit inside a try').toBeGreaterThan(-1);
    expect(catchIdx, 'loader must have its own catch').toBeGreaterThan(load);
    // The catch logs and falls through to the 200 — no resp(5xx) between catch and the return.
    const tail = arm.slice(catchIdx);
    expect(tail).toContain('console.error');
    expect(tail).not.toMatch(/resp\(5\d\d/);
  });

  it('the 200 response carries photos as an ADDITIVE key over the unchanged detail shape', () => {
    const arm = getArm();
    // detail is still the owner-column-stripped row — the pre-existing wire contract, untouched.
    expect(arm).toContain('const { project_owner_id: _po, plant_owner_id: _pn, ...detail } = rows[0];');
    expect(arm).toContain('let photos = [];');
    expect(arm).toContain('return resp(200, { ...detail, photos });');
  });
});
