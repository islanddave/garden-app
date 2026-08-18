// V4-LOSSEVENT-001 — qty_lost non-negative guard, and the deploy ordering it exists to satisfy.
//
// THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE. migrations/v4-losscapture-001 arms
// `chk_plants_qty_lost_nonneg` on plants.qty_lost. A CHECK added NOT VALID exempts EXISTING rows and
// constrains every SUBSEQUENT write — so the arming step is a change to the CONTRACT the deployed
// writer must already satisfy, not an additive schema change. The deployed plants Lambda wrote
// body.qty_lost through a plain COALESCE (PUT) and `?? 0` (POST) with no floor, so arming the CHECK
// against that artifact converts a client-supplied negative from a stored bad row into a 23514 -> 500
// on a live route. Arming a CHECK is a deploy, not a migration: this guard ships FIRST.
//
// WHY IT IS SHAPED THIS WAY. validateQtyLost is a pure function in validate.js, so the behavioural
// half below runs the REAL code rather than asserting on source text — index.js cannot be imported
// under CI's root `npm ci` (it pulls @neondatabase/serverless and the AWS/Clerk SDKs, which are
// installed per-Lambda-dir and absent from the root tree; validate.js's own header documents this).
// The wiring half is therefore source-text, because that is the only reachable way to prove both
// verbs call it — a validator nothing calls is the failure mode this pairing closes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQtyLost } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — same decommenter the sibling vocabulary
// guards use, so `// was: validateQtyLost(body)` cannot satisfy a wiring assertion.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const LAMBDA_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const BUNDLE = resolve(__dirname, '../../migrations/v4-losscapture-001');
const sqlOf = (f) => readFileSync(resolve(BUNDLE, f), 'utf8').replace(/--[^\n]*/g, '');

describe('V4-LOSSEVENT-001 qty_lost guard — behaviour', () => {
  it('exists as an exported function', () => {
    // Named explicitly so a revert reads as "the guard is not there" rather than as a TypeError
    // thrown from somewhere inside the next assertion.
    expect(typeof validateQtyLost).toBe('function');
  });

  it('accepts absent, null and undefined — both verbs treat those as no-ops', () => {
    expect(validateQtyLost({})).toBeNull();
    expect(validateQtyLost({ qty_lost: null })).toBeNull();
    expect(validateQtyLost({ qty_lost: undefined })).toBeNull();
  });

  it('accepts zero and positive integers', () => {
    expect(validateQtyLost({ qty_lost: 0 })).toBeNull();
    expect(validateQtyLost({ qty_lost: 1 })).toBeNull();
    expect(validateQtyLost({ qty_lost: 4200 })).toBeNull();
  });

  it('REJECTS negatives — the exact population chk_plants_qty_lost_nonneg would 23514 on', () => {
    for (const bad of [-1, -7, -0.5, Number.MIN_SAFE_INTEGER]) {
      expect(validateQtyLost({ qty_lost: bad }), `qty_lost=${bad} must be rejected`)
        .toMatch(/non-negative integer/);
    }
  });

  it('rejects non-integers and non-numbers rather than coercing them', () => {
    // Strictness matches validateAcquiredMature: the column is `integer`, so a coerced "3" or 3.5
    // writes a number nobody chose onto a real plant's attrition record. `'-5'` is the one that
    // matters most — a bare `< 0` test on a string is exactly how a floor gets bypassed.
    for (const bad of ['3', '-5', 3.5, true, [], {}, NaN, Infinity]) {
      expect(validateQtyLost({ qty_lost: bad }), `qty_lost=${String(bad)} must be rejected`)
        .toMatch(/non-negative integer/);
    }
  });
});

describe('V4-LOSSEVENT-001 qty_lost guard — wiring', () => {
  it('is imported by index.js', () => {
    expect(LAMBDA_SRC).toMatch(/import\s*\{[^}]*\bvalidateQtyLost\b[^}]*\}\s*from\s*'\.\/validate\.js'/);
  });

  it('is called on BOTH write paths (PUT and POST)', () => {
    // Two call sites, exactly as validateAcquiredMature has two. One would leave the other verb as
    // an open channel to a negative, which is a live 500 the moment the CHECK is armed.
    const calls = [...LAMBDA_SRC.matchAll(/validateQtyLost\s*\(\s*body\s*\)/g)];
    expect(calls, 'expected validateQtyLost(body) on both the PUT and the POST path').toHaveLength(2);
  });

  it('every call site 400s on the error rather than dropping it', () => {
    const returns = [...LAMBDA_SRC.matchAll(
      /const\s+(\w+)\s*=\s*validateQtyLost\s*\(\s*body\s*\);\s*\n\s*if\s*\(\s*\1\s*\)\s*return\s+resp\(400/g,
    )];
    expect(returns, 'a validator whose result is not returned is not a guard').toHaveLength(2);
  });
});

describe('V4-LOSSEVENT-001 qty_lost guard — deploy ordering against the migration bundle', () => {
  it('the CHECK is armed in its own phase file, not in the column-add file', () => {
    // THE ORDERING FIX. Adding a column is backward-compatible; arming a CHECK over it is not, so
    // the two cannot share a phase — the column add may run against the old artifact, the arming
    // may not.
    expect(sqlOf('0a-additive-ddl.sql')).not.toMatch(/chk_plants_qty_lost_nonneg/);
    expect(sqlOf('0b-arm-checks.sql')).toMatch(/chk_plants_qty_lost_nonneg/);
  });

  it('the armed CHECK is the >= 0 predicate this guard mirrors', () => {
    expect(sqlOf('0b-arm-checks.sql')).toMatch(/qty_lost\s*>=\s*0/);
  });

  it('the arming file is added NOT VALID, so no full-table lock is taken at arm time', () => {
    const arm = sqlOf('0b-arm-checks.sql');
    const stmt = arm.slice(arm.indexOf('chk_plants_qty_lost_nonneg'));
    expect(stmt.slice(0, stmt.indexOf(';'))).toMatch(/NOT VALID/);
  });

  it('the bundle refuses to arm until this guard is deployed', () => {
    // gate_runner reports a `manual: true` gate as MANUAL and does NOT count it as a pass, so this
    // is the machine-readable form of the ordering precondition. Without it the ordering lives only
    // in prose, and prose does not stop an apply.
    const gates = readFileSync(resolve(BUNDLE, 'gates.yml'), 'utf8');
    expect(gates).toMatch(/pre_qty_lost_guard_is_deployed/);
    expect(gates).toMatch(/manual:\s*true/);
  });

  it('the post-deploy validator sweeps the FULL table, not just live rows', () => {
    // The 2026-08-03 outage class: a pre-VALIDATE sweep scoped to `deleted_at IS NULL` passes green
    // and then VALIDATE scans the heap and fails on a soft-deleted row.
    const validate = sqlOf('0c-validate.sql');
    expect(validate).toMatch(/VALIDATE CONSTRAINT chk_plants_qty_lost_nonneg/);
    expect(validate).not.toMatch(/deleted_at IS NULL/);
  });
});
