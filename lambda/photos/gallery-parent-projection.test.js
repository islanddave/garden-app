// BUG-PHOTOPARENTUNDELIVERED-001 — the gallery must DELIVER the fields photoModel reads, not merely
// have a client that reads them.
//
// THE DEFECT CLASS. src/lib/photoModel.js reads a set of fields off the raw API row: six parent FKs
// (PARENT_FIELDS), the intake_status escape hatch, and the render fields. GET /api/photos projected
// four of the six parents and neither of the other two, so those fields were `undefined` on every
// gallery row and every predicate keyed on them was dead. Measured on prod 2026-08-31 (garden_ro):
//
//   inventory_item_id — 6 live photos carry it, and all 6 have plant_id, event_id, project_id,
//     location_id and space_id ALL NULL. Undelivered, each reads parentCount=0 / isAttached=false,
//     so PhotoLibrary's Untagged chip flags them as unfinished work forever. These are the same six
//     photoModel.js:15-17 already describes as "fully attached".
//   intake_status — 1 live row (54777683-2244-449c-bbbb-4a65396963e8, all six parent FKs null).
//     Undelivered, `pendingTag` is permanently false and the row classifies PARENTAGE.ORPHAN, which
//     photoModel.js:45 documents as "an INVALID state that the CHECK forbids".
//
// WHY THE ROW SHAPES BELOW ARE DERIVED FROM THE SQL RATHER THAN WRITTEN OUT. A hand-written
// `{ inventory_item_id: 'x' }` fixture re-tests photoModel and nothing else — it passes identically
// with the SELECT change reverted, because the fixture supplies the field the server never sent.
// src/__tests__/photoModel.test.js already owns those model-level assertions and passed throughout
// the defect. The gap this file closes is the WIRE, so `wireRow()` builds the row by intersecting a
// full server-side record with the columns a template actually projects: a column dropped from the
// SQL is a key absent from the object, exactly as it is absent from the JSON response.
//
// THE CENSUS TEST AT THE BOTTOM IS THE POINT. Two columns were found independently, which is reason
// to distrust any hand-written list of "the columns that matter". So the census derives the field set
// FROM photoModel's own source and requires every one to land in a declared bucket. A new field read
// off a raw row, or a seventh parent kind, fails here until someone decides how it is delivered.
//
// Static-source rather than import: lambda/photos/index.js loads @neondatabase/serverless and
// @clerk/backend at module scope (the constraint select-columns.test.js records).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPhoto, PARENTAGE, PARENT_KINDS, PARENT_FIELDS } from '../../src/lib/photoModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — without this, deleting a column and leaving
// `// was: p.inventory_item_id` behind would satisfy every assertion below. Same helper as
// select-columns.test.js and space-photos.test.js.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const MODEL_SRC = decomment(readFileSync(resolve(__dirname, '../../src/lib/photoModel.js'), 'utf8'));

function sqlTemplates(src) {
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// The five GET /api/photos list branches (attachedTo, location_id, project_id, space_id, unfiltered).
// Keyed on the container join every one of them carries and nothing else in this handler does.
const GALLERY = sqlTemplates(SRC).filter((t) => /pp\.display_name AS project_name/.test(t));

// The field names a template's projection puts on the wire: `p.foo` -> foo, `x.y AS z` -> z.
function projectedFields(template) {
  const m = template.match(/SELECT\s+([\s\S]*?)\s+FROM\s+photos\s+p\b/i);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).map((expr) => {
    const alias = expr.match(/\bAS\s+([A-Za-z_]\w*)\s*$/i);
    return alias ? alias[1] : expr.replace(/^[A-Za-z_]\w*\./, '');
  });
}

// A full server-side photos row. Individual tests vary the parent columns; wireRow() then discards
// whatever a given template does not project, which is what makes these tests about the SQL.
const RECORD = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  project_id: null,
  event_id: null,
  location_id: null,
  plant_id: null,
  inventory_item_id: null,
  space_id: null,
  intake_status: null,
  storage_path: 'plants/P/a.jpg',
  caption: null,
  is_public: true,
  created_at: '2026-08-31T13:25:06.284742Z',
  taken_at: null,
  project_name: null,
  view_url: 'https://s3.example/full?sig=1',
});

// The one live pending photo, measured on prod 2026-08-31: intake_status='pending_tag' with all six
// parent FKs null. 1395 of 1396 live rows carry intake_status NULL; this is the only exception.
const LIVE_PENDING = Object.freeze({
  ...RECORD,
  id: '54777683-2244-449c-bbbb-4a65396963e8',
  intake_status: 'pending_tag',
  storage_path: 'inbox/54777683-2244-449c-bbbb-4a65396963e8.jpg',
});

// The six live inventory-only photos: inventory_item_id set, every other parent NULL. Measured
// 2026-08-31 — 6 rows with inventory_item_id NOT NULL, and the same 6 with no other parent at all.
const LIVE_INVENTORY_ONLY = Object.freeze({
  ...RECORD,
  id: '00000000-0000-4000-8000-00000000000f',
  inventory_item_id: '11111111-1111-4111-8111-111111111111',
  storage_path: 'inventory/I/a.jpg',
});

// Simulate the response: the client sees a key only if the SELECT projected it. view_url is added by
// the presign pass (index.js, `withUrls`) after the query, so it survives regardless of projection.
function wireRow(template, record) {
  const fields = projectedFields(template);
  const row = { view_url: record.view_url };
  for (const f of fields) if (f in record) row[f] = record[f];
  return row;
}

// Every gallery template, or the test is checking one branch and reporting on five.
const forEachTemplate = (fn) => { for (const t of GALLERY) fn(t); };

describe('BUG-PHOTOPARENTUNDELIVERED-001 — extraction guards', () => {
  it('found the five gallery templates and can parse their projections', () => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(5);
    forEachTemplate((t) => {
      const fields = projectedFields(t);
      expect(fields, `unparseable projection:\n${t}`).toBeTruthy();
      // If the parse silently produced garbage every assertion below would pass vacuously.
      expect(fields).toEqual(expect.arrayContaining(['id', 'storage_path', 'created_at', 'project_name']));
    });
  });

  it('photoModel still counts inventory_item_id as a parent (the fix depends on it)', () => {
    // Delivering the column changes NOTHING unless the model's parent census names it. Asserted
    // against the model's own exports rather than assumed from the fact that the column now arrives —
    // shipping a projection whose field no consumer counts is the same defect wearing the fix's face.
    expect(PARENT_KINDS).toContain('inventory');
    expect(PARENT_FIELDS.inventory).toBe('inventory_item_id');
  });
});

describe('BUG-PHOTOPARENTUNDELIVERED-001 — inventory_item_id', () => {
  it('classifies the 6 live inventory-only photos by their inventory parent, not as untagged', () => {
    forEachTemplate((t) => {
      const photo = toPhoto(wireRow(t, LIVE_INVENTORY_ONLY));
      expect(photo.parentCount).toBe(1);
      expect(photo.parentKinds).toEqual(['inventory']);
      expect(photo.parents.inventory).toBe(LIVE_INVENTORY_ONLY.inventory_item_id);
      expect(photo.parentage).toBe(PARENTAGE.SINGLE);
      // The user-visible half: PhotoLibrary's Untagged chip filters on !isAttached.
      expect(photo.isAttached).toBe(true);
      expect(photo.isOrphan).toBe(false);
    });
  });

  it('a photo with NO inventory item and no other parent is still ORPHAN', () => {
    // The other direction. Without it the test above is satisfied by anything that forces a parent —
    // a blanket default would hide the real CHECK violation ORPHAN exists to surface.
    forEachTemplate((t) => {
      const photo = toPhoto(wireRow(t, { ...LIVE_INVENTORY_ONLY, inventory_item_id: null }));
      expect(photo.parentCount).toBe(0);
      expect(photo.parentage).toBe(PARENTAGE.ORPHAN);
      expect(photo.isAttached).toBe(false);
    });
  });
});

describe('BUG-PHOTOPARENTUNDELIVERED-001 — intake_status', () => {
  it('classifies the live parentless pending_tag photo as PENDING, not the CHECK-forbidden ORPHAN', () => {
    forEachTemplate((t) => {
      const photo = toPhoto(wireRow(t, LIVE_PENDING));
      expect(photo.parentCount, 'fixture must be parentless or it proves nothing').toBe(0);
      expect(photo.parentage).toBe(PARENTAGE.PENDING);
      expect(photo.pendingTag).toBe(true);
      expect(photo.isOrphan).toBe(false);
    });
  });

  it('still classifies a genuinely parentless NON-pending photo as ORPHAN', () => {
    forEachTemplate((t) => {
      const photo = toPhoto(wireRow(t, { ...LIVE_PENDING, intake_status: null }));
      expect(photo.parentCount).toBe(0);
      expect(photo.parentage).toBe(PARENTAGE.ORPHAN);
      expect(photo.pendingTag).toBe(false);
      expect(photo.isOrphan).toBe(true);
    });
  });

  it('an attached photo is unaffected by intake_status either way', () => {
    // Delivering these columns must not reclassify the 1395 rows that have parents and NULL intake.
    forEachTemplate((t) => {
      expect(toPhoto(wireRow(t, { ...RECORD, plant_id: 'plant-1' })).parentage).toBe(PARENTAGE.SINGLE);
    });
  });
});

// ── The class-closing census ──────────────────────────────────────────────────────────────────────
// Two independent misses in one projection is evidence that a hand-written list of "columns that
// matter" is not trustworthy. Both tests below derive their subject from photoModel's own source.

// space_id is the one parent this route delivers by a route OTHER than projection, and that is
// deliberate: it is gated on SPACE_PHOTOS_ENABLED so the five templates stay byte-identical with the
// flag off (space-photos.test.js pins that invariant). Named here with its mechanism so the guard
// stays honest instead of being loosened to `>= 5 of 6`.
const DELIVERED_BY_DECORATION = {
  space_id: /if \(spacePhotosEnabled && rows\.length\)[\s\S]{0,400}?SELECT id, space_id FROM photos/,
};

// Fields photoModel reads that this route does not send, each with the reason it is not a defect.
// Anything NOT in a bucket fails the census — the point is that adding a field forces a decision.
const NOT_SENT_BY_THIS_ROUTE = {
  // Added after the query by the presign pass (`withUrls`), so projection is irrelevant to them.
  view_url: 'post-query presign',
  thumb_url: 'post-query presign',
  // Belong to OTHER Lambdas' list projections (plants/projects/spaces featured photos), never to
  // GET /api/photos. photoModel accepts both spellings so one model serves both wire shapes.
  featured_photo_view_url: 'foreign route (plants/projects/spaces)',
  featured_photo_thumb_url: 'foreign route (plants/projects/spaces)',
  // Read as `takenAt` but consumed by NO production surface (repo-wide search 2026-08-31: every other
  // takenAt is the EXIF upload path, which WRITES taken_at). Deliberately not projected.
  // NOT justified by photoModel.js:18-20's "100% NULL" claim, which is STALE — measured 2026-08-31,
  // 127 of 1396 live rows carry a non-null taken_at. It is inert for want of a READER, not of data.
  taken_at: 'no production reader of photo.takenAt',
};

describe('BUG-PHOTOPARENTUNDELIVERED-001 — class-closing census', () => {
  it('EVERY parent kind photoModel counts is reachable on EVERY gallery template', () => {
    // Driven by PARENT_KINDS, not by a list written here: a seventh parent kind added to the model
    // reds this until it is either projected or given a decoration entry above.
    for (const kind of PARENT_KINDS) {
      const field = PARENT_FIELDS[kind];
      if (field in DELIVERED_BY_DECORATION) {
        expect(SRC, `${field} claims decoration but the decorating query is gone`)
          .toMatch(DELIVERED_BY_DECORATION[field]);
        continue;
      }
      forEachTemplate((t) => {
        expect(t, `gallery SELECT missing p.${field}:\n${t}`).toMatch(new RegExp(`\\bp\\.${field}\\b`));
      });
    }
  });

  it('EVERY field photoModel reads off a raw row is accounted for', () => {
    // The field set is parsed out of photoModel.js so it cannot drift from what the model actually
    // reads. `raw[PARENT_FIELDS[kind]]` is a computed access, so the six FKs are added explicitly.
    const read = new Set([
      ...(MODEL_SRC.match(/\braw\.([a-z_][a-z0-9_]*)/g) ?? []).map((s) => s.slice(4)),
      ...PARENT_KINDS.map((k) => PARENT_FIELDS[k]),
    ]);
    expect(read.size, 'parsed nothing from photoModel — the regex broke').toBeGreaterThanOrEqual(12);

    const unaccounted = [];
    for (const field of read) {
      if (field in NOT_SENT_BY_THIS_ROUTE) continue;
      if (field in DELIVERED_BY_DECORATION) continue;
      const missing = GALLERY.filter((t) => !new RegExp(`\\bp\\.${field}\\b`).test(t));
      if (missing.length) unaccounted.push(`${field} (absent from ${missing.length}/${GALLERY.length})`);
    }
    // A field here is either a new defect of this exact class or a deliberate omission that needs an
    // entry in NOT_SENT_BY_THIS_ROUTE with its reason. Either way a human decides, not silence.
    expect(unaccounted, 'photoModel reads fields the gallery never sends').toEqual([]);
  });
});
