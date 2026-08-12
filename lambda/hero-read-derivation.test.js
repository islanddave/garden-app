// W-HERO / BUG-PHOTOHEROMOVE-001 — INV-HERO is enforced READ-SIDE, and this file is the proof.
//
// INV-HERO: a parent's featured_photo_id must resolve to a photo that is (a) not soft-deleted and
// (b) still parented to that row. Reassign ships today (PhotoLibrary's tag modal, full-replace
// PUT): moving photo P from parent A to B re-parents the row and leaves A.featured_photo_id = P.
// NOTHING IS DELETED, so no deleted_at filter can ever catch it — only a membership re-check can.
// The fix is to DERIVE the hero at read time (the fetchSpaceHero shape, lambda/photos/index.js)
// rather than trust the stored pointer.
//
// This is an ENUMERATION guard, not an audit: "W-HERO done" is defined as this file green. It
// finds every hero-resolving SELECT in the fleet by SHAPE and holds each to the full contract, so
// a fifth parent added later is covered the day it lands rather than the day someone remembers.
//
// Static-source (L-072), DB-free — same tier and rationale as
// lambda/photos/read-paths-deletedat.test.js, whose enumeration clause this mirrors. These
// handlers are not importable from repo root (their @aws-sdk/@clerk/@neondatabase deps are
// per-Lambda), so SQL *text* is the only thing this tier can assert. Row-level behavior is
// integration-tier and out of scope here by construction.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Decommenting matters for the same reason read-paths-deletedat.test.js decomments: a construct
// NAMED IN A COMMENT is not that construct. Without this, deleting the derivation and leaving
// `-- was: COALESCE(fp.id, fb.id)` behind would let every assertion below find its own epitaph and
// pass. The `//` arm is URL-safe (the `[^:]` guard keeps `https://` intact); the `--` arm requires
// surrounding space so a JS decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

// Real tagged templates only (same extraction as sql-comment-hygiene.test.js / the photos guard).
function sqlTemplates(src) {
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// A hero-resolving read is identified by SHAPE: a SELECT that resolves the photos row a parent's
// featured_photo_id points at. Requiring a TABLE-QUALIFIED right-hand side (`p.featured_photo_id`,
// not `${body.featured_photo_id}`) is what separates these from the set-featured WRITE validators,
// which look superficially similar but take the candidate id from the request body.
const HERO_JOIN_RE = /(?:ON|WHERE)\s+(?:fp|ph)\.id\s*=\s*([a-z_]+)\.featured_photo_id/;

// Predicates below are matched against the PHOTO-ROW ALIASES specifically, never as bare
// /deleted_at IS NULL/ or /created_by = ANY\(/. Every one of these queries already carries both of
// those on UNRELATED tables — the parent row, its container, its cultivar — so the loose forms were
// satisfied by those and stayed green with the photo-arm predicates deleted. Both loose forms
// survived mutation testing before this helper existed. A guard that passes against the mutation it
// exists to catch is worse than no guard, because it also asserts that the mutation was checked.
const photoAliasesOf = (sql) => [...new Set(
  [...sql.matchAll(/(?:FROM|JOIN)\s+photos\s+([a-z_]+)/gi)].map((m) => m[1]),
)];
const photoScopedHits = (sql, predicate) =>
  photoAliasesOf(sql).flatMap((a) => sql.match(new RegExp(`\\b${a}\\.${predicate}`, 'g')) ?? []);

const FILES = [
  'plants/index.js',
  'projects/index.js',
  'locations/index.js',
  'inventory-items/index.js',
  'photos/index.js',
];

const heroReads = [];
for (const rel of FILES) {
  const src = decomment(readFileSync(join(here, rel), 'utf-8'));
  for (const t of sqlTemplates(src)) {
    if (!/^\s*SELECT/i.test(t)) continue;
    if (!HERO_JOIN_RE.test(t)) continue;
    heroReads.push({ file: rel, sql: t });
  }
}

describe('W-HERO — every hero-resolving read DERIVES the effective hero', () => {
  // A guard that enumerates its own inputs can go green by covering NOTHING — break the regex and
  // every assertion below runs over an empty list and passes. Pin the floor. 7 as of this commit:
  // plants x3 (by-id GET, project-scoped list, unscoped list), projects, locations,
  // inventory-items, photos/fetchSpaceHero.
  it('finds the known hero reads (anti-vacuity floor)', () => {
    expect(heroReads.length).toBeGreaterThanOrEqual(7);
    const byFile = heroReads.reduce((a, r) => ({ ...a, [r.file]: (a[r.file] ?? 0) + 1 }), {});
    expect(byFile).toMatchObject({
      'plants/index.js': 3,
      'projects/index.js': 1,
      'locations/index.js': 1,
      'inventory-items/index.js': 1,
      'photos/index.js': 1,
    });
  });

  // The class-closing clause. A new parent, or a new read path on an existing one, is held to the
  // whole contract automatically.
  it.each(FILES)('%s — all hero reads are alive-filtered, membership-rechecked and coherent', (rel) => {
    const reads = heroReads.filter((r) => r.file === rel);
    expect(reads.length).toBeGreaterThan(0);
    for (const { sql } of reads) {
      // (a) ALIVE, on BOTH arms. The stored pointer survives a soft delete (every parent FK is ON
      // DELETE SET NULL, which only fires on a HARD delete), so an unfiltered join presigns a dead
      // object.
      //
      // Scoped to the photo aliases — see photoScopedHits above for why the loose form is unsafe.
      expect(photoAliasesOf(sql).length, `hero read reads no photos rows at all:\n${sql}`).toBeGreaterThan(0);
      const aliveFilters = photoScopedHits(sql, 'deleted_at IS NULL');
      expect(aliveFilters.length, `hero read has ${aliveFilters.length} photo-scoped deleted_at filter(s), need >= 2 (explicit + fallback):\n${sql}`)
        .toBeGreaterThanOrEqual(2);

      // (b) DERIVED, not trusted. Returning the raw column while the join nulls the storage_path
      // is the incoherence DD3 names: the client feeds a stale non-null id to PhotoImg and to
      // featuredInSet badge comparisons while the url beside it is null.
      expect(sql, `hero read that does not COALESCE to an effective id:\n${sql}`)
        .toMatch(/COALESCE\(\s*fp\.id\s*,\s*fb\.id\s*\)/);
      expect(sql, `hero read whose url can disagree with its id:\n${sql}`)
        .toMatch(/COALESCE\(\s*fp\.storage_path\s*,\s*fb\.storage_path\s*\)/);

      // (c) UNAMBIGUOUS. Without this flag the response cannot distinguish "the user chose this
      // photo" from "this is merely the newest survivor", and the client's set-featured control
      // has an identity no-op guard — so tapping the photo that HAPPENS to be the fallback matched
      // the returned id, no-oped, and never persisted. That is the silent-revert bug
      // fetchSpaceHero's comment documents; the flag is what closes it.
      expect(sql, `hero read without featured_is_explicit:\n${sql}`).toMatch(/featured_is_explicit/);

      // (d) A FALLBACK ARM EXISTS. Without it, a demoted hero renders as no hero at all — the fix
      // would blank a cover photo instead of healing it.
      expect(sql, `hero read with no fallback LATERAL:\n${sql}`)
        .toMatch(/LEFT JOIN LATERAL[\s\S]*\)\s*fb\s+ON\s+TRUE/i);
    }
  });

  // The membership predicate itself, per parent. The generic clause above proves a re-check is
  // PRESENT; these prove it is the RIGHT one. Each mirrors that parent's set-featured WRITE
  // validator exactly — read half and write half of one invariant.
  it.each([
    ['projects/index.js', /fp\.project_id\s*=\s*pp\.id/, /ph\.project_id\s*=\s*pp\.id/],
    ['locations/index.js', /fp\.location_id\s*=\s*l\.id/, /ph\.location_id\s*=\s*l\.id/],
    ['inventory-items/index.js', /fp\.inventory_item_id\s*=\s*i\.id/, /ph\.inventory_item_id\s*=\s*i\.id/],
    ['photos/index.js', /fp\.space_id\s*=\s*s\.id/, /p\.space_id\s*=\s*s\.id/],
  ])('%s — membership re-check matches its write validator', (rel, explicitRe, fallbackRe) => {
    const reads = heroReads.filter((r) => r.file === rel);
    expect(reads.length).toBeGreaterThan(0);
    for (const { sql } of reads) {
      expect(sql, `explicit arm missing its membership re-check:\n${sql}`).toMatch(explicitRe);
      expect(sql, `fallback arm not scoped to this parent:\n${sql}`).toMatch(fallbackRe);
    }
  });

  // THE REGRESSION TEST FOR THE FIX ITSELF, and the most valuable assertion in this file.
  //
  // The plan this work implements specified the plants re-check as `fp.plant_id = p.id`. Measured
  // against live prod on 2026-08-12, that predicate demotes 123 of the 250 explicit plant heroes:
  // EventNew logs event photos with {project_id, event_id} and NO plant_id, so ALL 123 of those
  // heroes are attached to their planting through photos.event_id -> event_log.plant_id and carry
  // a NULL photos.plant_id. Every one of them is a correct, user-chosen hero.
  //
  // So the plant_id-only form is a mass product regression wearing the costume of a bug fix, and
  // it would pass every "is there a membership re-check?" assertion above. The event arm is the
  // ONLY thing standing between this fix and 123 blanked cover photos, and it is exactly the arm a
  // future "simplify this to match the other three parents" refactor would delete. It is also the
  // linkage the plants set-featured write validator has enforced since V4-PHOTOFEATURE-002 — so
  // dropping it here would ALSO split the read half from the write half and reintroduce the
  // silent-revert loop (write accepts the photo, read demotes it, forever).
  it('plants membership is EVENT-INCLUSIVE (123 live heroes depend on it)', () => {
    const reads = heroReads.filter((r) => r.file === 'plants/index.js');
    expect(reads).toHaveLength(3);
    for (const { sql } of reads) {
      expect(sql, `plants hero read does not join event_log:\n${sql}`)
        .toMatch(/LEFT JOIN public\.event_log e ON e\.id = ph\.event_id/);
      expect(sql, `plants hero read is plant_id-only — this demotes 123 live heroes:\n${sql}`)
        .toMatch(/\(\s*ph\.plant_id\s*=\s*p\.id\s+OR\s+e\.plant_id\s*=\s*p\.id\s*\)/);
    }
  });

  // inventory-items is the ONE surface where the SQL can be entirely correct and the response
  // still wrong, so it needs an assertion the SQL-text clauses above structurally cannot make.
  // `SELECT i.*` already emits the raw featured_photo_id column, so the derived value is aliased to
  // effective_featured_photo_id (two same-named columns in one SELECT makes the driver's
  // last-one-wins the contract) and re-projected in JS. Delete that one JS line and every clause
  // above still passes while the endpoint serves the raw, unvalidated pointer — which is precisely
  // the bug. Verified by mutation: without this, dropping the override is undetectable.
  it('inventory-items re-projects the derived hero over the raw i.* column', () => {
    const src = decomment(readFileSync(join(here, 'inventory-items/index.js'), 'utf-8'));
    expect(src, 'inventory-items GET does not override featured_photo_id with the derived value')
      .toMatch(/featured_photo_id:\s*row\.effective_featured_photo_id/);
    expect(src, 'inventory-items leaks the internal effective_featured_photo_id alias in its response')
      .toMatch(/effective_featured_photo_id:\s*_effective/);
  });

  // NEGATIVE (this repo's convention — undo-cascade.test.js: "the two most valuable assertions
  // below are the NEGATIVE ones"). The derivation must never widen household scope: every arm
  // stays created_by-scoped. RLS is not a floor here (photos has RLS enabled but NOT forced and
  // the Lambda connects as neondb_owner), so these predicates are the whole of the control — a
  // fallback arm that forgot one would surface another household's photo as a cover photo.
  it('every hero read keeps both arms household-scoped', () => {
    for (const { file, sql } of heroReads) {
      // Photo-alias-scoped for the same reason the deleted_at clause is: these queries already
      // carry `created_by = ANY(...)` on the PARENT row (pp/p/l/i), so a bare count stayed green
      // with the fallback arm's household predicate deleted. Verified by mutation.
      const scoped = photoScopedHits(sql, 'created_by = ANY\\(');
      expect(scoped.length, `${file}: hero read has ${scoped.length} photo-scoped household predicate(s), need >= 2 (explicit + fallback):\n${sql}`)
        .toBeGreaterThanOrEqual(2);
    }
  });
});
