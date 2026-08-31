// BUG-PHOTOINTAKEUNDELIVERED-001 — the gallery must DELIVER intake_status, not merely have a client
// that reads it.
//
// THE DEFECT. src/lib/photoModel.js:72 computes `pendingTag = raw.intake_status === 'pending_tag'`
// and :74-76 uses it to split a parentless photo into PARENTAGE.PENDING (legal — the seventh clause
// of photos_must_have_parent) or PARENTAGE.ORPHAN, which photoModel.js:45 documents as "an INVALID
// state that the CHECK forbids". None of the five gallery SELECT templates projected the column, so
// `raw.intake_status` was `undefined` on every gallery row, `pendingTag` could never be true, and the
// one legitimately-pending photo in prod was reported as a constraint violation.
//
// WHY THE ROW SHAPES BELOW ARE DERIVED FROM THE SQL RATHER THAN WRITTEN OUT. A hand-written
// `{ intake_status: 'pending_tag' }` fixture re-tests photoModel and nothing else — it passes
// identically with the SELECT change reverted, because the fixture supplies the field the server
// never sent. src/__tests__/photoModel.test.js:49 already owns that assertion. The gap this file
// closes is the WIRE, so `wireRow()` builds the row by intersecting a full server-side record with
// the columns a template actually projects: a column dropped from the SQL is a key absent from the
// object, exactly as it is absent from the JSON response. Mutation-verified 2026-08-31 — removing
// `p.intake_status` from the five templates reds the PENDING case.
//
// Static-source rather than import: lambda/photos/index.js loads @neondatabase/serverless and
// @clerk/backend at module scope (same constraint select-columns.test.js records).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPhoto, PARENTAGE } from '../../src/lib/photoModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — without this, deleting the column and
// leaving `// was: p.intake_status` behind would satisfy every assertion below. Same helper as
// select-columns.test.js and space-photos.test.js.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

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

// The full server-side record for the ONE live pending photo, measured on prod Neon 2026-08-31 as
// garden_ro: 1395 live rows carry intake_status NULL and exactly one carries 'pending_tag' —
// 54777683-2244-449c-bbbb-4a65396963e8, with all six parent FKs null. storage_path and created_at
// are the real shape; caption is null on 1092/1094 rows so null is the common case, not an edge one.
const LIVE_PENDING_RECORD = Object.freeze({
  id: '54777683-2244-449c-bbbb-4a65396963e8',
  project_id: null,
  event_id: null,
  location_id: null,
  plant_id: null,
  inventory_item_id: null,
  space_id: null,
  intake_status: 'pending_tag',
  storage_path: 'inbox/54777683-2244-449c-bbbb-4a65396963e8.jpg',
  caption: null,
  is_public: true,
  created_at: '2026-08-31T13:25:06.284742Z',
  project_name: null,
  view_url: 'https://s3.example/full?sig=1',
});

// Simulate the response: the client sees a key only if the SELECT projected it. view_url is added
// by the presign pass after the query, so it survives regardless of the projection.
function wireRow(template, record) {
  const fields = projectedFields(template);
  const row = { view_url: record.view_url };
  for (const f of fields) if (f in record) row[f] = record[f];
  return row;
}

describe('BUG-PHOTOINTAKEUNDELIVERED-001 — gallery delivers intake_status', () => {
  it('found the five gallery templates and can parse their projections (guard for the extraction)', () => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(5);
    for (const t of GALLERY) {
      const fields = projectedFields(t);
      expect(fields, `unparseable projection:\n${t}`).toBeTruthy();
      // If the parse silently produced garbage every assertion below would pass vacuously.
      expect(fields).toEqual(expect.arrayContaining(['id', 'storage_path', 'created_at', 'project_name']));
    }
  });

  it('enumeration (class-closing): EVERY gallery SELECT projects intake_status', () => {
    // A new list branch added by copy-paste inherits the column; one that drops it fails here rather
    // than silently re-opening the misclassification on whichever view it serves.
    for (const t of GALLERY) {
      expect(t, `gallery SELECT missing p.intake_status:\n${t}`).toMatch(/\bp\.intake_status\b/);
    }
  });

  it('classifies the live parentless pending_tag photo as PENDING, not the CHECK-forbidden ORPHAN', () => {
    for (const t of GALLERY) {
      const photo = toPhoto(wireRow(t, LIVE_PENDING_RECORD));
      expect(photo.parentCount, 'fixture must be parentless or it proves nothing').toBe(0);
      expect(photo.parentage).toBe(PARENTAGE.PENDING);
      expect(photo.pendingTag).toBe(true);
      expect(photo.isOrphan).toBe(false);
    }
  });

  it('still classifies a genuinely parentless NON-pending photo as ORPHAN', () => {
    // The other direction. Without it the test above is satisfied by anything that forces PENDING —
    // a blanket default would hide the real CHECK violation this state exists to surface.
    const record = { ...LIVE_PENDING_RECORD, id: 'not-pending', intake_status: null };
    for (const t of GALLERY) {
      const photo = toPhoto(wireRow(t, record));
      expect(photo.parentCount).toBe(0);
      expect(photo.parentage).toBe(PARENTAGE.ORPHAN);
      expect(photo.pendingTag).toBe(false);
      expect(photo.isOrphan).toBe(true);
    }
  });

  it('an attached photo is unaffected by intake_status either way', () => {
    // Delivering the column must not reclassify the 1395 rows that carry NULL and have parents.
    const attached = { ...LIVE_PENDING_RECORD, plant_id: 'plant-1', intake_status: null };
    for (const t of GALLERY) {
      expect(toPhoto(wireRow(t, attached)).parentage).toBe(PARENTAGE.SINGLE);
    }
  });
});
