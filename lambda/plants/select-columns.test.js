// V1.2a-4 S1.A-hotfix regression test.
// Static-source assertion that the plants Lambda GET SELECT clauses (by-id +
// list-with-project + list-without-project) include every PROJ-RESCOPE column
// landed by migrations/proj-rescope-s1-0a-additive.sql.
//
// Why static: lambda/plants/index.js imports @neondatabase/serverless +
// @clerk/backend + @aws-sdk/* at module load time; the existing test
// scaffolding (lambda/dashboard/) sidesteps that by exporting pure handlers
// from a separate file. plants/ has no such split. Refactoring to a
// handlers.js split is out-of-scope for this hotfix. Static source
// inspection is the lowest-risk regression gate that catches the bug class
// (Anomaly #A in v12a4-s1-chrome-smoke-verdict-20260518.md: POST persisted,
// GET SELECT did not list new columns).
//
// Failure mode this guards against: a future edit removes one of the
// PROJ-RESCOPE columns from a SELECT clause and silently breaks write->read
// symmetry again. This test fails loudly in CI / vitest before merge.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Per migrations/proj-rescope-s1-0a-additive.sql, the 21 columns added to
// public.plants (excluding pre-existing variety_id/metadata/source_inventory_item_id
// from VARIETY-REF S2 which were already returned).
const PROJ_RESCOPE_PLANT_COLUMNS = [
  'sown_at', 'sown_at_approx',
  'germinated_at', 'germinated_at_approx',
  'transplanted_at', 'transplanted_at_approx',
  'planted_out_at', 'planted_out_at_approx',
  'qty_initial', 'qty_current', 'qty_harvested', 'qty_lost', 'loss_cause',
  'source_type', 'source_ref', 'source_generation',
  'parent_plant_id', 'divergence_type', 'lineage_note',
  'succession_group_id', 'succession_order',
];

// Extract each SELECT...FROM block from the source. Three are expected:
// 1) GET by-id (idMatch branch)
// 2) GET list with projectId
// 3) GET list without projectId
// The UPDATE statement also contains column names but is between SET and
// FROM/WHERE, not SELECT...FROM, so the regex below correctly excludes it.
function extractSelectBlocks(src) {
  const re = /SELECT\s+([\s\S]*?)\s+FROM\s+plants\s+p/g;
  const blocks = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

describe('plants Lambda GET SELECT clauses (S1.A-hotfix regression guard)', () => {
  const selectBlocks = extractSelectBlocks(SRC);

  it('exposes exactly 3 SELECT...FROM plants p blocks (by-id + list+pid + list-all)', () => {
    expect(selectBlocks.length).toBe(3);
  });

  for (const col of PROJ_RESCOPE_PLANT_COLUMNS) {
    it(`every SELECT block includes p.${col}`, () => {
      for (const [idx, block] of selectBlocks.entries()) {
        const present = new RegExp(`\\bp\\.${col}\\b`).test(block);
        expect(present, `SELECT block #${idx} missing p.${col}`).toBe(true);
      }
    });
  }
});
