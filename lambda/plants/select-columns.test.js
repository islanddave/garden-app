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
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// L-081 schema-audit declared contract (scripts/dev-main-schema-audit.py Phase 1):
// the prod relation(s) every *_COLUMNS array below must exist in. Since Foundation
// V101 every read/write in index.js binds the canonical view public.garden_node
// (zero live `FROM plants` refs remain -- the `plants` half of the
// extractSelectBlocks alternation is rename-tolerance for source text only), so
// the audit contract is the view the code actually queries.
const AUDIT_TABLES = ['garden_node'];

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
  const re = /SELECT\s+((?:(?!\bFROM\b)[\s\S])*?)\s+FROM\s+(?:plants|public\.garden_node)\s+p/g;
  const blocks = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

describe('plants Lambda GET SELECT clauses (S1.A-hotfix regression guard)', () => {
  const selectBlocks = extractSelectBlocks(SRC);

  // 3 -> 5: V4-RESTORESURFACE-001 added the GET /deleted list and the restore preflight. The
  // list carries the full PROJ_RESCOPE column set like every other client-facing read, which is
  // the property the per-column assertions below actually enforce.
  it('exposes exactly 4 SELECT...FROM plants p blocks (by-id + list+pid + list-all + deleted-list)', () => {
    expect(selectBlocks.length).toBe(4);
  });

  for (const col of PROJ_RESCOPE_PLANT_COLUMNS) {
    it(`every SELECT block includes p.${col}`, () => {
      for (const [idx, block] of selectBlocks.entries()) {
        const present = new RegExp(`\\bp\\.${col}\\b`).test(block);
        expect(present, `SELECT block #${idx} missing p.${col}`).toBe(true);
      }
    });
  }

  // BUG-PLANTREAD-001 (2026-07-07): the container/location read-back columns were OMITTED
  // from all 3 SELECTs, so the planting edit form + Today location grouping read back blank
  // even though the write path persisted them (8 prod trough rows). Guard them the same way
  // so a future edit can't silently drop write->read symmetry again (L-091/L-190 class).
  const CONTAINER_LOCATION_READBACK_COLUMNS = ['container_type', 'container_size', 'location_id'];
  for (const col of CONTAINER_LOCATION_READBACK_COLUMNS) {
    it(`every SELECT block includes p.${col} (BUG-PLANTREAD-001)`, () => {
      for (const [idx, block] of selectBlocks.entries()) {
        const present = new RegExp(`\\bp\\.${col}\\b`).test(block);
        expect(present, `SELECT block #${idx} missing p.${col}`).toBe(true);
      }
    });
  }

  // Lambda 2.0.5 cleanup — VARIETY-REF S3 prep.
  // The 3 legacy text columns are removed from every SELECT clause in 2.0.5;
  // the subsequent VARIETY-REF S3 destructive DDL drops them from the table
  // entirely. This assertion catches a regression where a future edit (e.g.,
  // copy-paste from an old branch) reintroduces legacy columns to a SELECT
  // and would 500 every plants endpoint post-DDL.
  const LEGACY_COLUMNS_REMOVED_IN_2_0_5 = ['genus', 'species', 'variety'];
  for (const col of LEGACY_COLUMNS_REMOVED_IN_2_0_5) {
    it(`every SELECT block has dropped legacy p.${col}`, () => {
      for (const [idx, block] of selectBlocks.entries()) {
        const present = new RegExp(`\\bp\\.${col}\\b`).test(block);
        expect(present, `SELECT block #${idx} still references p.${col}`).toBe(false);
      }
    });
  }

  // Foundation V101 repoint guard (L-152): the 3 reads now bind to the widened
  // canonical view public.garden_node, which RENAMES name->display_name,
  // project_id->container_id, variety_id->cultivar_id. Each read MUST alias the
  // renamed column back to its API key or the JSON contract silently breaks
  // (mock-SQL/static tests are blind to the value; only the data-layer golden-diff
  // catches the value-level break, this catches the source-level regression).
  // Read-path guard: scoped to the 3 SELECT blocks (robust to write-path RETURNING alias-backs added in Foundation V101 writes).
  const readSrc = selectBlocks.join('\n');
  for (const [needle, label] of [
    [/p\.display_name AS name\b/g, 'p.display_name AS name'],
    [/p\.container_id AS project_id\b/g, 'p.container_id AS project_id'],
    [/p\.cultivar_id AS variety_id\b/g, 'p.cultivar_id AS variety_id'],
  ]) {
    it(`aliases back ${label} in all 4 reads`, () => {
      // 3 -> 4: V4-RESTORESURFACE-001's GET /deleted list is a fourth client-facing read and
      // aliases the same trio back, which is exactly what this guard wants of it.
      expect((readSrc.match(needle) || []).length, `expected 4 of ${label} across the read SELECT blocks`).toBe(4);
    });
  }

  // Foundation V101 WRITE-path repoint guard (L-152): PUT/INSERT/succession also
  // bind public.garden_node and MUST alias renamed columns back in RETURNING, or the
  // create/update JSON response silently changes keys (name->display_name etc.).
  it('PUT RETURNING aliases back all 3 renamed columns (p.-prefixed)', () => {
    for (const needle of [/p\.display_name AS name\b/, /p\.container_id AS project_id\b/, /p\.cultivar_id AS variety_id\b/]) {
      expect(needle.test(SRC), `PUT RETURNING missing ${needle}`).toBe(true);
    }
  });
  it('INSERT + succession RETURNING alias back all 3 renamed columns (unprefixed, 2 each)', () => {
    for (const [needle, label] of [
      [/(?<!\.)\bdisplay_name AS name\b/g, 'display_name AS name'],
      [/(?<!\.)\bcontainer_id AS project_id\b/g, 'container_id AS project_id'],
      [/(?<!\.)\bcultivar_id AS variety_id\b/g, 'cultivar_id AS variety_id'],
    ]) {
      expect((SRC.match(needle) || []).length, `expected 2 unprefixed ${label}`).toBe(2);
    }
  });

  // V4-HARVUNITDEFAULT-001: the harvest unit selector in EventNew.jsx pre-selects a crop's
  // crop_types.default_unit, and this JSON key is the ONLY way that value reaches the client —
  // there is no separate crop-types endpoint. Drop it from a variety_ref block and the selector
  // silently reverts to guessing from the global last-used unit, which is the cross-crop
  // wrong-unit bug the feature exists to close. Exactly the write->read symmetry class the rest
  // of this file guards, so it is guarded the same way: source-level, all 3 reads.
  // ct is the crop_types LEFT JOIN already present for dtm_basis; default_unit is crop-scoped
  // only (plant_varieties has unit_weights/weight_source/weight_confidence but NO default_unit
  // column), so it is read straight off ct with no COALESCE — do not add a pv. arm here.
  it("every variety_ref block carries 'default_unit', ct.default_unit (V4-HARVUNITDEFAULT-001)", () => {
    const hits = SRC.match(/'default_unit',\s*ct\.default_unit\b/g) || [];
    expect(hits.length, 'expected default_unit in all 3 variety_ref JSON blocks').toBe(3);
  });

  // V4-MATURITYREPEAT-001: computeMaturity() decides whether to print a CLOSING date off
  // variety_ref.harvest_habit. Drop this key from a variety_ref block and the client sees undefined,
  // falls back to the non-continuous wording, and silently re-ships the exact bug — a pepper being
  // actively picked reading "Harvest window open — through Aug 12". Same write->read symmetry class
  // and same source-level guard as default_unit above. harvest_habit is crop-scoped only
  // (plant_varieties has no such column), so it reads straight off ct with no COALESCE.
  it("every variety_ref block carries 'harvest_habit', ct.harvest_habit (V4-MATURITYREPEAT-001)", () => {
    const hits = SRC.match(/'harvest_habit',\s*ct\.harvest_habit\b/g) || [];
    expect(hits.length, 'expected harvest_habit in all 3 variety_ref JSON blocks').toBe(3);
  });

  it('joins crop_types in all 3 reads so ct.default_unit resolves', () => {
    const joins = SRC.match(/LEFT JOIN public\.crop_types ct ON ct\.slug = pv\.crop_type_slug/g) || [];
    expect(joins.length, 'expected the crop_types join in all 3 reads').toBe(3);
  });
});
