// V4-LOGMANYUXREFRESH-001 S1 — the Log Many dry-run preview must carry each planting's crop type,
// and must carry it WITHOUT losing a planting on the way.
//
// WHY THE JOIN IS THE RISK AND NOT THE COLUMN. This is the same resolver
// BUG-LOGMANYPROJECTLESS-001 was filed against: it INNER-joined container, so every project-less
// planting was invisible to Log Many entirely — absent from the preview, absent from the review
// list, absent from the write, with nothing anywhere saying so. Adding a second relation to that
// statement re-opens the identical hazard against a different table. `pv` must only be able to fail
// to NAME a planting, never to eliminate one.
//
// MEASURED on prod 2026-08-31 through the read-only role: 228 eligible plantings, of which 3 carry
// no cultivar_id and 3 resolve to no crop_type_slug. Small — which is exactly why an inner join
// here would have gone unnoticed.
//
// Static-source (L-072), DB-free — the same house pattern and the same deliberate weakness as
// logmany-projectless.test.js: what a real cultivar_id-NULL row does against the real view belongs
// to the integration suite. What THIS file buys is a guard that runs on every push to dev.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the comment above the join in index.js
// quotes the inner-join hazard verbatim, so an un-decommented assertion would find its own warning
// and pass. Same contract as logmany-projectless.test.js.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

function slice(startNeedle, endNeedle, from = SRC) {
  const start = from.indexOf(startNeedle);
  if (start < 0) return '';
  const end = from.indexOf(endNeedle, start + startNeedle.length);
  return end > start ? from.slice(start, end) : '';
}

const BATCH = slice("rawPath === '/api/events/batch' && method === 'POST'",
                    "rawPath === '/api/events/batches'");
// The SQL of the scope resolver only — from its SELECT list to its ORDER BY.
const RESOLVER = slice('SELECT p.id AS plant_id', 'ORDER BY p.display_name, p.id', BATCH);
// The JS that turns `resolved` into the two things the route uses: the wire preview and the ids the
// write is keyed on. Bounded by the dry_run return so it cannot run on into the INSERT.
const PROJECTION = slice('const capped = resolved.length > 500', 'if (dryRun) return resp', BATCH);

describe('events Lambda — Log Many preview carries crop_type_slug (V4-LOGMANYUXREFRESH-001 S1)', () => {
  it('the slices are still locatable (the foundation these assertions stand on)', () => {
    for (const [name, s] of Object.entries({ BATCH, RESOLVER, PROJECTION })) {
      expect(s, `${name} slice went empty — its anchor moved or was deleted`).not.toBe('');
    }
  });

  it('the resolver selects the crop slug through plant_varieties', () => {
    expect(RESOLVER).toMatch(/pv\.crop_type_slug AS crop_type_slug/);
    expect(RESOLVER).toMatch(/JOIN public\.plant_varieties pv ON pv\.id = p\.cultivar_id/);
  });

  // THE KEYSTONE. Stated as a positive enumeration rather than a bare negation so it cannot pass by
  // there being no plant_varieties join at all — a "cleanup" that deleted the join would otherwise
  // satisfy `not.toMatch(/JOIN/)` while quietly removing the whole feature.
  it('EVERY plant_varieties join in the batch route is a LEFT join — a planting can never be eliminated by it', () => {
    const joins = [...BATCH.matchAll(/(.{0,12})\bJOIN\s+public\.plant_varieties\b/g)].map((m) => m[1]);
    expect(joins.length).toBeGreaterThan(0);
    for (const before of joins) expect(before).toMatch(/LEFT\s+$/);
  });

  // The join key must be the FK COLUMN on the node, not the joined row. Keying an ownership or
  // filter term on `pv.id IS NULL` is the exact rewrite logmany-projectless.test.js:133 already
  // bans on the container join, and it reads identically to someone "testing the join".
  it('nothing in the resolver filters on the JOINED variety row', () => {
    expect(RESOLVER).not.toMatch(/pv\.id IS NOT NULL/);
    expect(RESOLVER).not.toMatch(/AND pv\.crop_type_slug IS NOT NULL/);
    // pv may narrow itself (its own soft-delete) and nothing else.
    const pvTerms = [...RESOLVER.matchAll(/\bpv\.([a-z_]+)/g)].map((m) => m[1]);
    expect([...new Set(pvTerms)].sort()).toEqual(['crop_type_slug', 'deleted_at', 'id']);
  });

  // "plantings selected == events written", asserted at the seam where they could diverge: the ids
  // the write is keyed on must come from the SAME rows the preview was built from, not be re-derived
  // from previewRows (which a crop-type filter could later narrow) or from a second query.
  it('plantIds and previewRows are the same slice of the same resolved rows', () => {
    expect(PROJECTION).toMatch(/const plantIds = resolved\.slice\(0, 500\)\.map\(\(r\) => r\.plant_id\)/);
    expect(PROJECTION).toMatch(/const previewRows = resolved\.slice\(0, 500\)/);
    // The one rewrite that would break the invariant while looking like a tidy-up.
    expect(PROJECTION).not.toMatch(/previewRows\.(map|filter)/);
  });

  // A missing key and an explicit null are NOT the same thing to the client: `undefined` would be
  // dropped by JSON.stringify and the planting would arrive with no crop field at all, which the
  // Ungrouped bucket cannot distinguish from a malformed row.
  it('a planting with no cultivar arrives as an explicit null, never an absent key', () => {
    expect(PROJECTION).toMatch(/crop_type_slug: r\.crop_type_slug \?\? null/);
  });

  // The three keys this slice put on the wire, asserted as a PREFIX rather than as the whole
  // object literal. S4 appends two conditional keys (requested_count / unresolved_plant_ids) to
  // this same return, so an exact-shape match would have to be rewritten by every later slice that
  // adds a field — and a test that must be edited to stay green stops being evidence. What has to
  // hold is that the dry run returns `previewRows` UNFILTERED and counts `plantIds`; the S4 keys
  // are pinned by their own file (logmany-scopeids.test.js).
  it('the dry-run response still returns the preview rows unfiltered', () => {
    expect(BATCH).toMatch(/if \(dryRun\) return resp\(200, \{\s*count: plantIds\.length, capped, plantings: previewRows,/);
    // The mutation this really guards: narrowing what the preview returns to what some filter
    // matched. `plantings:` must be the projection itself, never a derived list.
    expect(BATCH).not.toMatch(/plantings: previewRows\.(filter|slice|map)/);
  });
});
