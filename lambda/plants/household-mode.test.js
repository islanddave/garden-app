// HOUSEHOLD-MODE static-source guard (plants Lambda).
// Plants scope via parent project pp.created_by. Asserts widening, INSERT integrity,
// import presence, and uploaded_by->created_by switch. Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('plants Lambda — Household Mode scope widening', () => {
  it('imports householdScope + computes householdIds', () => {
    expect(SRC).toMatch(/import \{ householdScope \} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('ownership reads/guards via pp.created_by use = ANY(${householdIds})', () => {
    // LIST + UPDATE + DELETE + 2 list/get SELECTs = 5 pp.created_by sites.
    const matches = SRC.match(/pp\.created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('featured-photo subquery SWITCHED uploaded_by -> created_by = ANY(${householdIds})', () => {
    expect(SRC).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    // No remaining uploaded_by scope filter (plants has no uploaded_by INSERT column).
    expect(SRC).not.toMatch(/uploaded_by = \$\{userId\}/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });

  it('INSERT still binds created_by = ${userId}', () => {
    const insIdx = SRC.indexOf('INSERT INTO public.garden_node');
    // window widened 800->1000 for the V3-PLANTLOC-001 location_id column (shifted ${userId} offset)
    const block = SRC.slice(insIdx, insIdx + 1000);
    expect(block).toMatch(/\$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });
});
