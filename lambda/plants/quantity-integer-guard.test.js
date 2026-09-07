// BUG-PLANTQTYSTEP-001 — plants.quantity is a whole number of plants, enforced server-side.
//
// WHAT WAS OPEN, measured against live prod 2026-09-07 before any code was written:
//
//   plants.quantity        numeric(10,3) NOT NULL DEFAULT 1, chk_plants_quantity CHECK (quantity >= 1)
//   qty_initial/_current/_harvested/_lost, seeds_sown/_germinated   ALL integer
//   320 rows ever written (271 live + soft-deleted), 0 with a fractional quantity
//
// The CHECK constrains the RANGE only, so the column's numeric(10,3) scale was the entire distance
// between a request and a stored 2.500. Three writers reach that column, and they did not agree:
// POST clamped (`parseInt(body.quantity, 10)`), the PUT bound body.quantity straight into
// `COALESCE(${body.quantity ?? null}, p.quantity)`, and the merge route passed
// body.overrides.quantity through to merge.js:579 unread. Two of the three were open.
//
// WHY A GUARD RATHER THAN FRACTIONAL SUPPORT. This is NOT the planting half of
// BUG-INVQTYROUNDTRIP-001, which is how it was first briefed. An inventory quantity is a MEASURE
// and rounding it destroys a real value; a planting quantity is a COUNT and 2.5 plants denotes
// nothing. The schema already says so — quantity is the lone numeric in a family of six integers,
// and lambda/events casts `p.quantity::int` (index.js:2640, :3452) when it derives qty_current, so a
// stored fraction would be silently rounded by the next loss or undo write regardless.
//
// SHAPED LIKE qty-lost-guard.test.js, for the reason its header records: index.js cannot be
// imported under CI's root `npm ci` (it pulls @neondatabase/serverless + the AWS/Clerk SDKs, which
// are installed per-Lambda-dir and absent from the root tree). So behaviour runs the REAL exported
// function, and the wiring half is source-text — because a validator nothing calls is exactly the
// failure this pairing exists to close, and here it must be proved THREE times, not two.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQuantity, QUANTITY_ERROR } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — same decommenter the sibling guards use,
// so `// was: validateQuantity(body)` cannot satisfy a wiring assertion. This file's own header
// mentions the call several times, which is precisely why the source must be stripped first.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const LAMBDA_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('BUG-PLANTQTYSTEP-001 quantity guard — behaviour', () => {
  it('is exported as a function', () => {
    // Named on its own so a revert reads as "the guard is gone" rather than as a TypeError thrown
    // from the middle of the next assertion.
    expect(typeof validateQuantity).toBe('function');
  });

  it('REFUSES 2.5 — the defect, in the shape a client would send it', () => {
    expect(validateQuantity({ quantity: 2.5 })).toBe(QUANTITY_ERROR);
  });

  it("REFUSES '2.500' — the pg-serialized spelling of the same fraction", () => {
    // numeric(10,3) comes back off the wire as a STRING, so this is the form a round-tripping
    // client actually resends. Rejecting 2.5 but accepting '2.500' would leave the hole open on the
    // only path that was ever likely to reach it.
    expect(validateQuantity({ quantity: '2.500' })).toBe(QUANTITY_ERROR);
  });

  it('ACCEPTS whole numbers as number AND as string, including the trailing-zero spelling', () => {
    // The coercion-tolerant call, and the reason it differs from validateQtyLost's strict typeof
    // gate: '2.000' is what a client gets when it READS this column, so echoing it back into a PUT
    // is legitimate. A typeof check would reject it alongside the fraction.
    for (const ok of [1, 3, 12, '3', '2.000', '12', 2.0]) {
      expect(validateQuantity({ quantity: ok }), `rejected ${JSON.stringify(ok)}`).toBeNull();
    }
  });

  it('is a NO-OP when quantity is absent or explicitly null', () => {
    // POST defaults an absent quantity to 1 and the PUT's COALESCE preserves the prior value. Both
    // must stay reachable, or this guard would break every partial update in the app.
    expect(validateQuantity({})).toBeNull();
    expect(validateQuantity({ quantity: null })).toBeNull();
    expect(validateQuantity({ quantity: undefined })).toBeNull();
    expect(validateQuantity()).toBeNull();
  });

  it('refuses the values that coerce to a whole number without denoting one', () => {
    // '' and '   ' are Number()-0, which would sail through a naive Number.isInteger(Number(v)).
    // Nobody types an empty quantity meaning "none"; on the PUT these reached Postgres and 500'd.
    for (const bad of ['', '   ', 'abc', NaN, Infinity, -Infinity, true, [], {}, [5]]) {
      expect(validateQuantity({ quantity: bad }), `accepted ${JSON.stringify(bad)}`).toBe(QUANTITY_ERROR);
    }
  });

  it('leaves RANGE alone — 0 and negatives are not this guard\'s business', () => {
    // Deliberate scope line, pinned so a later reader does not "complete" the guard by accident.
    // 0/-3 are whole numbers; POST clamps them to 1 and the PUT lets chk_plants_quantity raise
    // 23514. Widening this into a range check would change POST's create contract, which this
    // ticket has no evidence about. Recorded as an adjacent finding, not fixed here.
    expect(validateQuantity({ quantity: 0 })).toBeNull();
    expect(validateQuantity({ quantity: -3 })).toBeNull();
  });

  it('names the unit in its message, so a 400 tells the caller what to send', () => {
    expect(QUANTITY_ERROR).toMatch(/whole number/i);
  });
});

describe('BUG-PLANTQTYSTEP-001 quantity guard — wiring (all three writers)', () => {
  it('is imported by index.js', () => {
    expect(LAMBDA_SRC).toMatch(/import\s*\{[^}]*\bvalidateQuantity\b[^}]*\}\s*from\s*'\.\/validate\.js'/);
  });

  it('is called exactly three times — PUT, POST and the merge route', () => {
    // A COUNT, not a mere presence check: the three writers are the whole point, and a guard wired
    // into two of them would pass every "does it exist" assertion while leaving the merge override
    // hole open. Raise this number only alongside a new call site.
    const calls = LAMBDA_SRC.match(/validateQuantity\s*\(/g) ?? [];
    expect(calls).toHaveLength(3);
  });

  it('guards the PUT — the writer that bound body.quantity straight into SQL', () => {
    expect(LAMBDA_SRC).toMatch(/const\s+_qErr\s*=\s*validateQuantity\(body\);\s*if\s*\(_qErr\)\s*return\s+resp\(400/);
  });

  it('guards the POST', () => {
    expect(LAMBDA_SRC).toMatch(/const\s+_qErrPost\s*=\s*validateQuantity\(body\);\s*if\s*\(_qErrPost\)\s*return\s+resp\(400/);
  });

  it('guards the merge route, reading overrides rather than the body root', () => {
    // merge.js:394 lets overrides.quantity beat every reconciliation rule, so the value being
    // judged has to be the override map. Asserting the ARGUMENT, not just the call, because
    // validateQuantity(body) here would type-check, pass, and guard nothing.
    expect(LAMBDA_SRC).toMatch(/validateQuantity\(body\.overrides\s*\?\?\s*\{\}\)/);
  });

  it('runs BEFORE mergeCore, so a rejected override never reaches the UPDATE', () => {
    const guard = LAMBDA_SRC.indexOf('validateQuantity(body.overrides');
    const call = LAMBDA_SRC.indexOf('await mergeCore(');
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it('still clamps on the POST path — the guard replaces nothing', () => {
    // The parseInt clamp is what defaults an absent or unparseable quantity to 1. The guard sits in
    // front of it; if a later edit swapped one for the other, absent-quantity creates would break.
    expect(LAMBDA_SRC).toMatch(/parseInt\(body\.quantity,\s*10\)/);
  });
});
