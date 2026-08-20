// HOUSEHOLD-MODE static-source guard (locations Lambda).
// Locations was GLOBAL pre-household (no created_by filter); this brings it into the
// household-scoped model per the 2026-05-20 "locations IN" decision. Asserts: householdScope
// import + householdIds, created_by = ANY(${householdIds}) on all locations reads/writes,
// the locations_with_path view scoped by id-subquery (view lacks created_by), featured-photo
// linkage switched uploaded_by -> household, INSERT now sets created_by = ${userId}, no spread.
// Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('locations Lambda — Household Mode scope widening', () => {
  it('imports householdScope + computes householdIds', () => {
    // V4-AUTHZSWEEP-001: match householdScope among a NAMED-IMPORT LIST, not as the sole import —
    // these handlers now also pull the write-FK ownership loaders from the same module. Mirrors the
    // IMPORT_RE pattern already used by household-isolation.test.js.
    expect(SRC).toMatch(/import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('locations reads/writes scope by created_by = ANY(${householdIds})', () => {
    // GET-by-id + PUT id-resolve + PUT UPDATE + DELETE + LIST base + LIST path subquery + POST parent = 7
    const matches = SRC.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });

  it('locations_with_path view scoped via id-subquery (view has no created_by column)', () => {
    expect(SRC).toMatch(/locations_with_path[\s\S]*?id IN \(SELECT id FROM locations WHERE deleted_at IS NULL AND created_by = ANY\(\$\{householdIds\}\)\)/);
  });

  it('featured-photo linkage is household-scoped on created_by (no uploaded_by anchor remains)', () => {
    // V4-AUTHZSWEEP-001 (V-C1): the household widening originally kept photos' legacy uploaded_by
    // column here, while inventory-items/projects/plants all anchor featured-photo checks on
    // created_by. Both columns agree on all 977 live photo rows, so this was consistency hardening —
    // but it left locations as the one surface that could accept a photo the others rejected.
    expect(SRC).not.toMatch(/uploaded_by = \$\{userId\}/);
    // Predicate form only — the word still appears in the explanatory comment at the call site.
    expect(SRC).not.toMatch(/uploaded_by\s*=/);
    expect(SRC).toMatch(/location_id = \$\{actualLocationId\}[\s\S]*?created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('INSERT now binds created_by = ${userId} (was missing pre-household)', () => {
    const insIdx = SRC.indexOf('INSERT INTO locations');
    // Bounded by the statement's own RETURNING rather than a magic character count. The old +400
    // window was already within ~90 characters of clipping ${userId}, and V4-COVEREDNOTMODELLED-001's
    // one extra column pushed it past the edge — at which point this guard stops covering the
    // binding it is named for while still looking like it does.
    const retIdx = SRC.indexOf('RETURNING', insIdx);
    expect(retIdx, 'no RETURNING after the INSERT — the block bound has gone blind').toBeGreaterThan(insIdx);
    const block = SRC.slice(insIdx, retIdx);
    // V4-COVEREDNOTMODELLED-001 inserted `covered` ahead of created_by. Still pinned as a contiguous
    // tail rather than loosened to a bare /created_by/, because the point of the assertion is that
    // created_by is IN the column list at all — a regex that matched it anywhere in the block would
    // also match the RETURNING clause and go quietly vacuous.
    expect(block).toMatch(/sort_order, description, covered, created_by/);
    expect(block).toMatch(/\$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});
