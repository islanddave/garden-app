// V1.2a-4 S1.A-hotfix regression test (projects companion).
// Static-source assertion that the projects Lambda GET LIST SELECT clauses
// include the 3 PROJ-RESCOPE columns landed on plant_projects by
// migrations/proj-rescope-s1-0a-additive.sql: kind, target_end_date,
// kind_set_at.
//
// Pre-hotfix smoke verdict (v12a4-s1-chrome-smoke-verdict-20260518.md) verified
// the by-id path returned all three. The list path returned kind +
// target_end_date but NOT kind_set_at — hotfix adds it for symmetry.
//
// Three list SELECT blocks exist: parent_id IS NULL / parent_id = <uuid> /
// no parent_id filter. By-id is handled in a Promise.all with a different
// shape (includes joins) and is asserted separately.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

const PROJ_RESCOPE_PROJECT_COLUMNS = ['kind', 'target_end_date', 'kind_set_at'];

// Extract each SELECT...FROM plant_projects block (no alias).
// Match BOTH list shape ("FROM plant_projects\n") and by-id shape
// ("FROM plant_projects pp"). Both groups must include the 3 columns to be
// fully symmetric.
function extractSelectBlocks(src) {
  const re = /SELECT\s+([\s\S]*?)\s+FROM\s+plant_projects(?:\s+pp)?/g;
  const blocks = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

describe('projects Lambda SELECT clauses (S1.A-hotfix regression guard)', () => {
  const selectBlocks = extractSelectBlocks(SRC);

  it('exposes at least 4 SELECT blocks (by-id + 3 list variants)', () => {
    // 1 by-id + 3 list variants. Other SELECTs in the file (e.g., COUNT(*)
    // from plants, schema_version probe) target different tables and are
    // excluded by the FROM plant_projects regex.
    expect(selectBlocks.length).toBeGreaterThanOrEqual(4);
  });

  for (const col of PROJ_RESCOPE_PROJECT_COLUMNS) {
    it(`every plant_projects SELECT block includes ${col}`, () => {
      for (const [idx, block] of selectBlocks.entries()) {
        // The column can appear bare (kind), aliased via to_char (target_end_date),
        // or as a column name. Word-boundary match covers all three.
        const present = new RegExp(`\\b${col}\\b`).test(block);
        expect(present, `SELECT block #${idx} missing ${col}`).toBe(true);
      }
    });
  }
});
