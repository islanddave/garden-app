// BUG-PHOTODEDUPDROP-001 — the photos upsert's ON CONFLICT arm must ADD the caller's parent, never
// discard it.
//
// THE DEFECT THIS FILE EXISTS FOR: `ON CONFLICT (created_by, content_hash) DO UPDATE SET
// updated_at = now()` returns the EXISTING row and answers 200, so re-uploading the same bytes
// against a different planting/event/inventory item stored NOTHING and told the caller it worked.
// V4-SPACEPHOTO-001 had already COALESCEd space_id in the widened branch — the other five parent
// columns, and the whole flag-OFF branch, were still dropping.
//
// STRUCTURE: same extract-and-execute pattern as space-photos.test.js / household-mode.test.js —
// index.js is not importable from repo root (its @aws-sdk/@clerk/@neondatabase deps are per-Lambda),
// so the functions under test are pulled verbatim from source and instantiated. That runs the REAL
// code against a recording fake `sql` instead of asserting on a string that merely resembles it.
// Route-level behaviour against real Postgres belongs to the integration suite.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct (household-mode.test.js). The `//` arm is
// URL-safe; the `--` arm requires surrounding space so a JS decrement is never read as SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

function extractFunction(src, header) {
  const start = src.indexOf(header);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function makeSql() {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('¶'), values });
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

const buildSrc = extractFunction(SRC, 'function buildPhotoInsert');
const unhonoredSrc = extractFunction(SRC, 'function unhonoredParents');
const constSrc = SRC.match(/^const PHOTO_PARENT_COLUMNS = .*$/m)?.[0];
const instantiate = (fnSrc) => new Function(`return (${fnSrc});`)();

// unhonoredParents closes over PHOTO_PARENT_COLUMNS, so the const comes along for the ride.
const unhonoredParents = new Function(`${constSrc}; return (${unhonoredSrc});`)();

// Every parent column the INSERT names, flag-OFF list first. The dedupe must COALESCE all of them.
const OFF_PARENTS = ['project_id', 'event_id', 'location_id', 'plant_id', 'inventory_item_id'];
const ON_PARENTS = [...OFF_PARENTS, 'space_id'];

const FULL_BODY = {
  storage_path: 's3/x.jpg', caption: 'cap', project_id: 'proj-1', event_id: 'ev-1',
  location_id: 'loc-1', plant_id: 'pl-1', inventory_item_id: 'inv-1', space_id: 'space-1',
  taken_at: 't', content_hash: 'h', file_size_bytes: 1, mime_type: 'image/jpeg',
  original_filename: 'f.jpg', gps_lat: 1, gps_lon: 2, intake_status: null,
};

const emitted = (spaceEnabled, body = FULL_BODY) => {
  const sql = makeSql();
  instantiate(buildSrc)(sql, body, 'user_dave', spaceEnabled);
  return sql.calls[0];
};

describe('BUG-PHOTODEDUPDROP-001 — ON CONFLICT adds the parent instead of dropping it', () => {
  it('both functions were extracted (guard for the extraction itself)', () => {
    expect(buildSrc).toBeTruthy();
    expect(unhonoredSrc).toBeTruthy();
    expect(constSrc).toBeTruthy();
  });

  it('the flag-OFF dedupe COALESCEs EVERY parent column, not just updated_at', () => {
    // This is the assertion that reds on the shipped statement: flag-OFF was a bare
    // `DO UPDATE SET updated_at = now()`, so a second target was discarded outright.
    const { text } = emitted(false);
    for (const c of OFF_PARENTS) {
      expect(text, `flag-OFF dedupe drops ${c}`)
        .toMatch(new RegExp(`${c} = COALESCE\\(photos\\.${c}, EXCLUDED\\.${c}\\)`));
    }
    // The column that does not exist on this branch must stay absent — flag-OFF byte-identity.
    expect(text).not.toMatch(/space_id/);
  });

  it('the flag-ON dedupe COALESCEs all six, keeping the space_id arm it already had', () => {
    const { text } = emitted(true);
    for (const c of ON_PARENTS) {
      expect(text, `flag-ON dedupe drops ${c}`)
        .toMatch(new RegExp(`${c} = COALESCE\\(photos\\.${c}, EXCLUDED\\.${c}\\)`));
    }
  });

  it('no parent is bare-assigned from EXCLUDED — a re-point is not the fix for a drop', () => {
    // Overwriting an occupied slot would trade a silent DROP for a silent MOVE: bytes already on
    // planting A, re-uploaded against planting B, would vanish from A's gallery. COALESCE only.
    for (const flag of [false, true]) {
      const setClause = emitted(flag).text.split(/DO UPDATE SET/)[1];
      for (const c of ON_PARENTS) {
        expect(setClause, `bare EXCLUDED assignment for ${c} (flag=${flag})`)
          .not.toMatch(new RegExp(`${c} = EXCLUDED\\.${c}`));
      }
    }
  });

  it('adds NO bound parameter — the fix is column references only', () => {
    // The flag-OFF/flag-ON parameter parity space-photos.test.js pins is a rollback invariant.
    // A COALESCE that reached for `${body.x}` would bind a second copy of every parent and break it.
    const off = emitted(false);
    const on = emitted(true);
    expect(on.values.filter((v) => v !== 'space-1')).toEqual(off.values);
    expect(off.values.filter((v) => v === 'pl-1')).toHaveLength(1);
  });
});

describe('BUG-PHOTODEDUPDROP-001 — unhonoredParents discloses what one column cannot hold', () => {
  it('reports nothing when the returned row carries every requested parent', () => {
    // The COALESCE case: the row came back with the slots this call filled, so nothing was lost.
    const row = { plant_id: 'pl-1', event_id: 'ev-1', project_id: null, location_id: null, inventory_item_id: null, space_id: null };
    expect(unhonoredParents({ plant_id: 'pl-1', event_id: 'ev-1' }, row, true)).toEqual([]);
  });

  it('names an ALREADY-OCCUPIED slot the caller asked to change', () => {
    // Bytes on planting A re-uploaded against planting B. COALESCE keeps A (no silent move); this
    // is what stops the 200 from also being a silent NO.
    const row = { plant_id: 'pl-A', event_id: null, project_id: null, location_id: null, inventory_item_id: null, space_id: null };
    expect(unhonoredParents({ plant_id: 'pl-B' }, row, false))
      .toEqual([{ column: 'plant_id', requested: 'pl-B', kept: 'pl-A' }]);
  });

  it('reports each occupied slot independently — a filled one does not mask a dropped one', () => {
    const row = { plant_id: 'pl-A', event_id: 'ev-1', project_id: null, location_id: null, inventory_item_id: 'inv-B', space_id: null };
    const out = unhonoredParents({ plant_id: 'pl-B', event_id: 'ev-1', inventory_item_id: 'inv-C' }, row, false);
    expect(out.map((u) => u.column)).toEqual(['plant_id', 'inventory_item_id']);
  });

  it('ignores space_id when the flag is off (the row has no such column to compare)', () => {
    // Flag-off, a body space_id is already ignored upstream; reporting it as "unhonored" would
    // invent a failure the contract never promised.
    const row = { plant_id: null, event_id: null, project_id: null, location_id: null, inventory_item_id: null };
    expect(unhonoredParents({ space_id: 'space-1' }, row, false)).toEqual([]);
    expect(unhonoredParents({ space_id: 'space-1' }, row, true))
      .toEqual([{ column: 'space_id', requested: 'space-1', kept: null }]);
  });

  it('a parent the caller did not send is never reported', () => {
    const row = { plant_id: 'pl-A', event_id: null, project_id: null, location_id: null, inventory_item_id: null, space_id: null };
    expect(unhonoredParents({ caption: 'x' }, row, true)).toEqual([]);
  });
});

describe('BUG-PHOTODEDUPDROP-001 — the duplicate return is wired to the disclosure', () => {
  it('the duplicate 200 computes and returns unhonored_parents', () => {
    // A helper nothing calls is decoration. Asserted on DECOMMENTED source, so describing the call
    // in a comment cannot hold this green.
    expect(SRC).toMatch(/const unhonored = unhonoredParents\(body, inserted, spacePhotosEnabled\);/);
    expect(SRC).toMatch(/duplicate: true, unhonored_parents: unhonored/);
  });

  it('an unhonored request is logged server-side, mirroring warnRejectedFk', () => {
    // This class was invisible for its whole life because nothing ever recorded it. The response
    // field alone repeats that mistake: no shipped client reads it yet.
    expect(SRC).toMatch(/msg: 'photo-dedupe-parent-unhonored'/);
  });
});
