// V4-SEEDINV-001 static-source guard (inventory-items Lambda).
// Asserts the SEEDINV literal sub-routes (GET sow-candidates, POST extract-seeds)
// are checked BEFORE the /api/inventory-items/:id idMatch, that the sow-candidates
// SQL is household-scoped against v_sow_candidates, that the 501 not-configured
// branch exists, and that the Anthropic Messages endpoint appears exactly once.
//
// Why static (same rationale as lambda/plants/select-columns.test.js): index.js
// imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load
// time, so it cannot be imported by unit tests. extract.js logic is unit-tested
// directly in extract.test.js; this file guards the index.js wiring.
//
// Failure mode guarded: a future edit reorders the routes below the idMatch —
// 'sow-candidates'/'extract-seeds' then match /:id and the routes silently 404
// (GET) or 405 (POST) in prod. This fails loudly in CI before merge.

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

describe('inventory-items Lambda — SEEDINV literal sub-routes (static-source guard)', () => {
  const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
  const sowIdx = SRC.indexOf("rawPath === '/api/inventory-items/sow-candidates'");
  const extractIdx = SRC.indexOf("rawPath === '/api/inventory-items/extract-seeds'");

  it('declares the idMatch regex and both literal-route branches', () => {
    expect(idMatchIdx).toBeGreaterThan(-1);
    expect(sowIdx).toBeGreaterThan(-1);
    expect(extractIdx).toBeGreaterThan(-1);
  });

  it('both literal-route branches appear textually BEFORE the idMatch regex declaration', () => {
    expect(sowIdx, 'sow-candidates branch must precede idMatch').toBeLessThan(idMatchIdx);
    expect(extractIdx, 'extract-seeds branch must precede idMatch').toBeLessThan(idMatchIdx);
  });

  it('sow-candidates SQL reads v_sow_candidates with household scope', () => {
    // Scope the assertions to the sow-candidates branch (it precedes extract-seeds).
    const branch = SRC.slice(sowIdx, extractIdx);
    expect(branch).toContain('FROM v_sow_candidates');
    expect(branch).toContain('created_by = ANY');
    expect(branch).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
  });

  it("has the 501 'extractor_not_configured' branch (ANTHROPIC_API_KEY absent)", () => {
    expect(SRC).toMatch(/resp\(501,\s*\{\s*error:\s*'extractor_not_configured'\s*\}\)/);
  });

  it('references api.anthropic.com/v1/messages exactly once', () => {
    const matches = SRC.match(/api\.anthropic\.com\/v1\/messages/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// V4-SOWARCHIVE-001 static-source guard — PATCH /api/inventory-items/:id/sow-archive.
// Static for the same reason as the block above (index.js cannot be imported by unit tests).
//
// Failure modes guarded here, all of which are silent in prod rather than loud:
//   - the route drifts below idMatch and stops being reachable;
//   - the household scope is dropped, letting one household stamp another's packets;
//   - the category='seeds' guard is dropped, stamping a Sow-Now-only field onto a shovel;
//   - the season range check is removed, letting a packet be archived into a season that never
//     arrives — i.e. hidden forever with no UI to recover it.
describe('inventory-items Lambda — SOWARCHIVE route (static-source guard)', () => {
  const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
  const archiveIdx = SRC.indexOf('const sowArchiveMatch = rawPath.match');
  const archiveBranch = SRC.slice(archiveIdx, idMatchIdx);

  it('declares the sow-archive branch BEFORE the idMatch regex', () => {
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(archiveIdx, 'sow-archive branch must precede idMatch').toBeLessThan(idMatchIdx);
  });

  it('is PATCH-only', () => {
    expect(archiveBranch).toMatch(/method !== 'PATCH'/);
    expect(archiveBranch).toMatch(/resp\(405/);
  });

  it('writes both archive columns together and stamps updated_at', () => {
    // chk_sow_archive_pair rejects a half-write at the DB, but writing both here is what keeps
    // the constraint from ever being the thing that surfaces the bug.
    expect(archiveBranch).toContain('sow_archived_season =');
    expect(archiveBranch).toContain('sow_archived_at =');
    expect(archiveBranch).toContain('updated_at = NOW()');
  });

  it('un-archives symmetrically ({archived:false} clears both)', () => {
    expect(archiveBranch).toMatch(/body\.archived !== false/);
    expect(archiveBranch).toMatch(/CASE WHEN \$\{archived\} THEN NOW\(\) ELSE NULL END/);
  });

  it('scopes the UPDATE to the household, to live rows, and to seed packets only', () => {
    expect(archiveBranch).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(archiveBranch).toContain('deleted_at IS NULL');
    expect(archiveBranch).toContain("category = 'seeds'");
  });

  it('range-checks the season rather than trusting the client', () => {
    expect(archiveBranch).toMatch(/season < 2000 \|\| season > 2100/);
    expect(archiveBranch).toMatch(/invalid_season/);
  });

  it('404s when the UPDATE matches nothing (wrong household, or not a seed packet)', () => {
    expect(archiveBranch).toMatch(/if \(!rows\.length\) return resp\(404/);
  });
});
