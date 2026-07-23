// HOUSEHOLD-MODE isolation guard (G3).
// Asserts householdScope is imported in EXACTLY the 6 in-scope surfaces and in NONE of
// the out-of-scope Lambdas. Catches accidental scope creep (a future edit that widens an
// out-of-scope handler) and accidental scope loss (an in-scope file losing the import).
// Static-source / filesystem scan — DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAMBDA_ROOT = __dirname;

// In-scope: the 6 surfaces that import householdScope.
const IN_SCOPE = [
  'projects/index.js',
  'plants/index.js',
  'events/index.js',
  'inventory-items/index.js',
  'photos/index.js',
  'dashboard/handlers.js',
  'locations/index.js',
  'critter/index.js', // shared critter stickerbook is household-scoped (created_by = ANY(householdIds))
  'findings/index.js', // DRG findings read model — household-scoped reads (created_by = ANY(householdIds))
  'tags/index.js', // V4-TAGSUB faceted tag visibility — shared tags widen to householdScope
  'daily-plan-read/index.js', // V4-ASSIGNLENS-001 — OPT-IN ?include=household widening (default stays per-user)
  'preservation/index.js', // V4-HARVESTCENTER-001 — Put-Up log is household-shared inventory (user_id = ANY(householdIds))
  'storage-location/index.js', // V4-HARVESTCENTER-001 — Put-Up storage vocab, household-scoped like locations
  'harvests/index.js', // V4-HARVESTVIEW-001 — Harvests read model, household-scoped (plant_projects.created_by = ANY(householdIds))
  'facebook-share/index.js', // V4-FBSHARE-001 — admin-only FB share; photo fetch scoped to household (photos.created_by = ANY(householdIds))
];

// Out-of-scope: must NOT import householdScope.
const OUT_OF_SCOPE = [
  'achievements/index.js',
  'favorites/index.js',
  'xp-reconcile/index.js',
  'varieties/index.js',
  'app-events/index.js',
  'dashboard/index.js', // wrapper — householdScope is computed inside builders, not the wrapper
];

const IMPORT_RE = /import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/;

function read(rel) {
  return readFileSync(resolve(LAMBDA_ROOT, rel), 'utf8');
}

function exists(rel) {
  try { statSync(resolve(LAMBDA_ROOT, rel)); return true; } catch { return false; }
}

describe('Household Mode — surface isolation (G3)', () => {
  for (const f of IN_SCOPE) {
    it(`${f} imports householdScope (in scope)`, () => {
      expect(read(f)).toMatch(IMPORT_RE);
    });
  }

  for (const f of OUT_OF_SCOPE) {
    it(`${f} does NOT import householdScope (out of scope)`, () => {
      if (!exists(f)) return; // tolerate absent optional lambdas
      expect(read(f)).not.toMatch(/householdScope/);
    });
  }

  it('no Lambda outside the 6 in-scope surfaces references householdScope', () => {
    // Walk all index.js + handlers.js under lambda/ and assert householdScope appears
    // ONLY in the in-scope set. This catches any new out-of-scope file we did not enumerate.
    const inScopeAbs = new Set(IN_SCOPE.map(r => resolve(LAMBDA_ROOT, r)));
    const offenders = [];
    for (const entry of readdirSync(LAMBDA_ROOT)) {
      const dir = join(LAMBDA_ROOT, entry);
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      for (const name of ['index.js', 'handlers.js']) {
        const abs = join(dir, name);
        if (!exists(abs)) continue;
        const src = readFileSync(abs, 'utf8');
        if (/householdScope/.test(src) && !inScopeAbs.has(abs)) {
          offenders.push(`${entry}/${name}`);
        }
      }
    }
    expect(offenders, `unexpected householdScope reference(s): ${offenders.join(', ')}`).toEqual([]);
  });
});
