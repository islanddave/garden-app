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
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

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
