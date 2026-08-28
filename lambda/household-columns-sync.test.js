import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// OPS-SCHEMAAUDITJOIN-001. household-columns.test.js carries the L-081 keyed column contract for the
// four relations household.js queries. Phase 4 of scripts/dev-main-schema-audit.py credits a contract
// ONLY to the handler's own directory, and only when the AUDIT_COLUMNS literal sits in that file's
// own source text — so the contract is copied beside every household.js: the 18 per-Lambda copies
// plus canonical lambda/ itself, 19 files in total.
//
// Nineteen hand-copied files drift exactly the way the hand-maintained DIRS list in
// household-copies-sync.test.js did — 'daily-plan-read' shipped a household.js copy that no
// byte-equality check covered (V4-AUTHZSWEEP-001). This derives the expected set from disk rather
// than enumerating it, so a new copy dir cannot go unguarded the same way.
//
// Named *-sync.test.js deliberately: the auditor's PHASE1_GLOB is `*columns.test.js`, which this
// filename does NOT match, so this file is never parsed as a contract.
const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = 'household-columns.test.js';

const copyDirs = readdirSync(here, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((d) => existsSync(join(here, d, 'household.js')))
  .sort();

describe('household-columns.test.js stays in sync across every household.js dir', () => {
  const canonical = readFileSync(join(here, CONTRACT), 'utf8');

  it('finds all 18 per-Lambda household.js dirs on disk', () => {
    // A guard on the guard: if this ever read 0, the per-dir assertions below would vanish and the
    // suite would still go green having checked nothing.
    expect(copyDirs).toHaveLength(18);
  });

  it('every dir shipping household.js also ships the contract beside it', () => {
    // A copy without its contract is four relation refs the audit counts as uncovered again, which
    // pushes the Phase 4 count back above scripts/schema-audit-join-baseline.json and FAILs the
    // ratchet on the next push to dev.
    expect(copyDirs.filter((d) => !existsSync(join(here, d, CONTRACT)))).toEqual([]);
  });

  for (const d of copyDirs) {
    it(`${d}/${CONTRACT} === canonical lambda/${CONTRACT}`, () => {
      expect(readFileSync(join(here, d, CONTRACT), 'utf8')).toBe(canonical);
    });
  }
});
