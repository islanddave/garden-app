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
// the prod relation(s) every *_COLUMNS array below must exist in. Declared as the
// BASE TABLE plant_projects (still a live handler target: 4 FROM + 1 UPDATE in
// index.js), where kind/target_end_date/kind_set_at are all physical columns. On
// the public.container view the kind key is backed by `classification AS kind`
// (rename), so auditing `kind` against the view would false-FAIL a rename the
// handler explicitly aliases back; target_end_date + kind_set_at exist on both.
const AUDIT_TABLES = ['plant_projects'];

const PROJ_RESCOPE_PROJECT_COLUMNS = ['kind', 'target_end_date', 'kind_set_at'];

// Extract each SELECT...FROM {plant_projects | public.container} block.
// RENAME-TOLERANT (Foundation path-to-V3): the GET reads were repointed off the
// base table plant_projects onto the widened canonical view public.container
// (foundation-migration-V101). Through the view, kind is exposed as
// "classification AS kind" and the 3-column coverage must follow the reads onto
// the view -- so match BOTH the base table (still used by write-path selects) and
// the view. Matches list shape ("FROM <rel>") and by-id shape ("FROM <rel> pp").
function extractSelectBlocks(src) {
  // WHY THIS IS A SCANNER AND NOT A REGEX.
  //
  // This extractor used to be /SELECT\s+([\s\S]*?)\s+FROM\s+(?:plant_projects|public\.container)/g.
  // With a lazy `[\s\S]*?`, a match beginning at ANY earlier `SELECT` runs on to the next
  // `FROM plant_projects`, swallowing everything in between. Three of the six blocks it returned
  // over-spanned; the worst ran 598->715 (6,252 chars) and contained the entire PUT
  // `UPDATE public.container SET` list.
  //
  // Not cosmetic: deleting kind_set_at from the admin list SELECT — verbatim the S1.A regression
  // this file exists to prevent — left every assertion GREEN, because the column still appeared
  // inside the swallowed UPDATE block. The WRITE path was satisfying a READ-path assertion.
  //
  // The sibling plants/select-columns.test.js fixes this with a `(?!\bFROM\b)` lookahead, but that
  // cure does not transplant here: four of the five list variants carry an inner
  // `COALESCE((SELECT MAX(em.last_event_at) FROM entity_memory em ...))`, so a rule that refuses to
  // cross any FROM cannot reach their outer FROM at all — applying it dropped the block count from
  // 6 to 2 and silently stopped covering the very reads this file guards.
  //
  // So: find each target FROM, then walk BACKWARDS to the SELECT that owns it, tracking paren depth
  // so inner subquery SELECTs are skipped. That is the actual grammar, and it is immune to both
  // failure modes.
  function ownerSelect(src, fromIdx) {
    let depth = 0;
    for (let i = fromIdx - 1; i >= 0; i--) {
      const ch = src[i];
      if (ch === ')') depth++;
      else if (ch === '(') { if (depth === 0) return -1; depth--; }
      else if (depth === 0 && (ch === 't' || ch === 'T')) {
        const word = src.slice(i - 5, i + 1);
        const before = src[i - 6] ?? ' ';
        if (word.toUpperCase() === 'SELECT' && !/[\w$]/.test(before)) return i + 1;
      }
    }
    return -1;
  }
  const re = /\bFROM\s+(?:plant_projects|public\.container)\b/g;
  const blocks = [];
  let f;
  while ((f = re.exec(src)) !== null) {
    const start = ownerSelect(src, f.index);
    if (start === -1) continue;
    const m = [null, src.slice(start, f.index)];
    // V3-EVENT-003: skip the internal status pre-fetch (a single-column `AS old_status`
    // read used only to detect a real status change) — NOT a client GET read, so it
    // intentionally does not expose the PROJ-RESCOPE columns.
    if (/\bAS old_status\b/.test(m[1])) continue;
    // V3-REPARENT-001: skip reparent-internal selects (not client GET reads).
    if (/reparent-internal/.test(m[1])) continue;
    // WS-A1: skip the public-slug allowlist SELECT — an unauthenticated deny-by-default
    // public projection that intentionally OMITS kind/target_end_date/kind_set_at (they are
    // not public fields). Same skip precedent as reparent-internal above.
    if (/public-slug/.test(m[1])) continue;
    // V4-AUTHZSWEEP-001: skip the create-path parent ownership check — an existence/ownership
    // probe (SELECT id … created_by = ANY(householdIds)), not a client GET read, so it has no
    // business exposing the PROJ-RESCOPE columns. Same skip precedent as reparent-internal above.
    if (/authz-parent-check/.test(m[1])) continue;
    // V4-RESTORESURFACE-001: skip the restore existence/ownership probe — same class and same
    // reasoning as authz-parent-check above. The /deleted LIST is NOT skipped: it is a real client
    // GET read and carries the PROJ-RESCOPE columns like every other one.
    if (/restore-probe/.test(m[1])) continue;
    blocks.push(m[1]);
  }
  return blocks;
}

describe('projects Lambda SELECT clauses (S1.A-hotfix regression guard)', () => {
  const selectBlocks = extractSelectBlocks(SRC);

  // 6 -> 7 (V4-RESTORESURFACE-001): the GET /deleted recovery list is a seventh client read. It is
  // deliberately NOT skipped — it carries the PROJ-RESCOPE columns like the other six, and its
  // planting counts were moved out of a correlated subquery into a second query precisely so this
  // extractor can see it. A read that dodges this guard by accident is worse than one that fails it.
  it('extracts exactly the 7 client GET read blocks', () => {
    // EXACT, not >=. A floor is what let the broken extractor look healthy: it returned 6 blocks
    // too, but three of them were junk spans that happened to satisfy the floor while the real
    // reads went uncovered. A count that can only be met by the right blocks is the point.
    expect(selectBlocks.length).toBe(7);
  });

  it('no extracted block over-spans its own statement', () => {
    // The over-spanning failure mode, asserted directly rather than inferred from the count. The
    // widest legitimate block here is ~820 chars; the broken extractor's worst was 6,252 and
    // swallowed an entire UPDATE SET list. Any block an order of magnitude over the real ones has
    // run past its FROM and is matching another statement's text.
    const widest = Math.max(...selectBlocks.map((b) => b.length));
    expect(widest).toBeLessThan(1500);
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

