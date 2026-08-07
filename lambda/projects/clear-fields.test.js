// BUG-COALESCECLEAR-001 — the projects clear:[] channel.
//
// Static-source per the L-072 house style, matching lambda/plants/clear-fields.test.js. The
// validator half is exercised directly (it is pure); the SQL half is asserted against the source
// text, because these arms are inside one large template literal with no seam.
//
// STATIC-SOURCE ANCHORING (this codebase has been bitten four times, twice by tests that passed
// their own sanity guard while slicing the WRONG statement): every assertion below either targets a
// token proved unique by a count assertion, or targets the validator, which needs no anchoring.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEARABLE_FIELDS, CLEARABLE_SET, validateClear } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// The five that may be cleared, and the exact reason each of the excluded ones is excluded. This
// list IS the risk control — a blanket "every nullable column" allowlist would have been a worse
// bug than the one being fixed.
const EXPECTED = ['description', 'variety', 'start_date', 'target_end_date', 'location_id'];

// Excluded, with the property that makes each one unsafe. Asserted as a MAP rather than a bare list
// so a future edit cannot quietly drop one without also deleting its stated reason.
const FORBIDDEN = {
  name: 'NOT NULL (display_name) + the identity every card, picker and the public share route renders',
  status: 'NOT NULL + VALIDATED CHECK, and a clear would read as no-change and skip the status_change audit event',
  is_public: 'NOT NULL boolean — false is a value, not a clear',
  kind: 'already CASE-clearable via its own hasKind sentinel; one column, one clear channel',
  featured_photo_id: 'already CASE-clearable via its own hasFeatured sentinel',
  parent_project_id: 'already CASE-clearable via its own sentinel',
  assignee_user_id: 'already CASE-clearable via its own hasAssignee sentinel',
  created_by: 'the ownership-transfer trigger raises on ANY change including value->NULL',
};

describe('BUG-COALESCECLEAR-001: projects clear allowlist', () => {
  it('names exactly the five triaged columns', () => {
    expect([...CLEARABLE_FIELDS].sort()).toEqual([...EXPECTED].sort());
  });

  it.each(Object.entries(FORBIDDEN))('never admits %s — %s', (col) => {
    expect(CLEARABLE_SET.has(col)).toBe(false);
    expect(validateClear([col], {})).toMatch(/cannot be cleared/);
  });

  it('location_id IS clearable, and only because BUG-NOLOCOUTDOOR-001 landed first', () => {
    // Sequencing is load-bearing, so it gets its own assertion rather than a comment. Before that
    // fix, clearing a project's location made the daily-plan coverage join collapse to
    // covered=false = OUTDOOR for any planting without its own location — rain credit on an indoor
    // plant. Coverage is now a three-state and an absent location resolves to UNKNOWN, which fails
    // safe in both directions. If that fix is ever reverted, this entry must be reverted with it.
    expect(CLEARABLE_SET.has('location_id')).toBe(true);
  });
});

describe('BUG-COALESCECLEAR-001: projects validateClear contract', () => {
  it('absent / null / [] are the legacy no-op — every existing caller is byte-identical', () => {
    expect(validateClear(undefined, {})).toBeNull();
    expect(validateClear(null, {})).toBeNull();
    expect(validateClear([], {})).toBeNull();
  });

  it('rejects a non-array', () => {
    expect(validateClear('description', {})).toMatch(/must be an array/);
  });

  it('rejects clearing and setting the same key in one request', () => {
    // Ambiguous intent is refused rather than silently resolved in either direction.
    expect(validateClear(['description'], { description: 'x' })).toMatch(/both cleared and set/);
  });

  it('allows clear alongside an explicit null for the same key', () => {
    // `null` is the wire's "absent", so this is not a contradiction — it is the exact request an
    // unmodified client sends for an emptied box, and it must go through the clear channel.
    expect(validateClear(['description'], { description: null })).toBeNull();
  });

  it('caps the key count', () => {
    expect(validateClear(Array(65).fill('description'), {})).toMatch(/at most/);
  });
});

describe('BUG-COALESCECLEAR-001: projects SQL arms match the allowlist', () => {
  it('every clearable column has a CASE arm, and each token is unique in the source', () => {
    for (const col of CLEARABLE_FIELDS) {
      const token = `@> ARRAY['${col}']`;
      const n = SRC.split(token).length - 1;
      // Uniqueness proved, not assumed — a token appearing twice would let one arm's assertion be
      // satisfied by a different arm's text.
      expect(n, `${token} must appear exactly once in projects/index.js`).toBe(1);
    }
  });

  it('no FORBIDDEN column has a clear arm', () => {
    for (const col of Object.keys(FORBIDDEN)) {
      expect(SRC).not.toContain(`@> ARRAY['${col}']`);
    }
  });

  it('validateClear is called before the UPDATE that consumes clear, not after', () => {
    // Order is the contract: an un-clearable key must be a 400 with a message, never a constraint
    // violation surfacing a raw constraint name.
    //
    // ANCHORING NOTE — this assertion's first draft used indexOf('UPDATE public.container') and
    // FAILED, because that string appears in an earlier route too, so it measured against the wrong
    // statement. That is the exact class this repo has been bitten by four times, and it caught
    // itself here only because the ordering happened to be wrong for the wrong statement. Both
    // anchors below are proved unique by count first.
    const CALL = 'validateClear(body.clear';
    const ARM = "@> ARRAY['description']";
    expect(SRC.split(CALL).length - 1, 'validateClear call site must be unique').toBe(1);
    expect(SRC.split(ARM).length - 1, 'the description clear arm must be unique').toBe(1);
    expect(SRC.indexOf(CALL)).toBeLessThan(SRC.indexOf(ARM));
  });
});
