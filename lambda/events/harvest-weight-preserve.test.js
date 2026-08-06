// BUG-HARVWEIGHTBLANK-001 — an unrelated harvest edit must never BLANK a stored weight.
//
// THE LIVE BUG (verified against prod Neon 2026-08-06). `resolve_harvest_weight` returns NULL when
// no tier can price a row. Wild Blackberry is such a case: plant_varieties.unit_weights is NULL for
// it, so the resolver yields (NULL, NULL). But FOUR live harvest_log rows for that variety store
// weight_basis='cultivar' with real grams (7.20, 6, 7.20, 12) from a time when a tier did resolve.
//
// The PUT wrote all three weight columns straight from the resolver, so tapping a QUALITY STAR on
// any of those rows silently discarded the weight. The pre-existing carry-forward only covers
// USER-TYPED weights (weight_estimated = false); estimated rows had no protection at all.
//
// Static source assertions, matching the house style of the sibling lambda tests
// (batch-order.test.js, undo-cascade.test.js): the UPDATE is one SQL template inside a handler that
// needs a live DB and a Clerk token to execute, so the falsifiable property is the SHAPE of the
// statement, not a round trip. The behavioural half is covered by the integration suite.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

// The harvest EDIT update, isolated so these assertions cannot accidentally match the INSERT path
// or the batch-undo soft-delete. There is more than one `UPDATE harvest_log h` in this file — the
// batch-undo one appears FIRST — so anchor on the statement that actually sets the weight columns.
const UPDATE = (() => {
  let from = 0;
  for (;;) {
    const start = SRC.indexOf('UPDATE harvest_log h', from);
    expect(start, 'no UPDATE harvest_log statement sets weight_basis').toBeGreaterThan(-1);
    const end = SRC.indexOf('RETURNING', start);
    const stmt = SRC.slice(start, end === -1 ? start + 4000 : end);
    if (stmt.includes('weight_basis')) return stmt;
    from = start + 1;
  }
})();

describe('harvest PUT preserves a stored weight the resolver can no longer price', () => {
  it.each(['weight_grams', 'weight_estimated', 'weight_basis'])(
    '%s falls back to the stored value when the resolver returns NULL',
    (col) => {
      const assign = UPDATE.match(new RegExp(`${col}\\s*=\\s*CASE[\\s\\S]*?END`));
      expect(assign, `${col} must be a guarded CASE, not a bare resolver read`).not.toBeNull();
      expect(assign[0]).toMatch(/rw\.weight_grams IS NULL/);
      expect(assign[0]).toMatch(new RegExp(`THEN h\\.${col}`));
      expect(assign[0]).toMatch(new RegExp(`ELSE rw\\.${col}`));
    }
  );

  // All three must key on the SAME condition. Two validated CHECKs depend on the triple being
  // internally consistent: chk_harvest_log_weight_basis_pairing requires
  // (weight_grams IS NULL) = (weight_basis IS NULL), and chk_harvest_log_weight_basis_estimated
  // requires weight_estimated = (weight_basis <> 'measured'). Mixing one column from the resolver
  // with another from the stored row is a hard 23514 on the harvest save path — the same failure
  // class as the 2026-08-03 outage.
  it('all three columns switch on one identical condition, so the triple stays consistent', () => {
    const conds = ['weight_grams', 'weight_estimated', 'weight_basis'].map((col) => {
      const m = UPDATE.match(new RegExp(`${col}\\s*=\\s*CASE WHEN ([\\s\\S]*?)\\s*THEN`));
      return m[1].replace(/\s+/g, ' ').trim();
    });
    expect(new Set(conds).size).toBe(1);
  });

  // An explicit clear must still clear — the guard protects against incidental blanking, not
  // against the user deliberately removing their own weight.
  it('the guard is bypassed when the user explicitly clears the weight', () => {
    const m = UPDATE.match(/weight_grams\s*=\s*CASE WHEN ([\s\S]*?)\s*THEN/);
    expect(m[1]).toMatch(/NOT \$\{hClearWeight\}/);
  });
});
