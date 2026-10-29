// BUG-AUTHZLAMBDA-001 (B4/I19) — the merge route's `overrides` map gets the PUT/POST guards.
//
// THE DEFECT. POST /api/plants/:id/merge passed body.overrides straight into mergeCore, whose winner
// UPDATE writes `location_id = ${resolved.location_id}` (and qty_lost, loss_cause, container_type)
// with an override beating every reconciliation rule. The only check was validateQuantity, so an
// authenticated caller could pin the winner to another household's location: a cross-household FK
// write plus a read leak through every surface that JOINs locations. A string or number `overrides`
// also threw inside mergeCore's `col in overrides` (500).
//
// The stub in lambda/_test-stubs never evaluates index.js's SQL, so — like every other guard in this
// directory — this reads the decommented source. The location gate is ALSO counted by lambda/authz-write-fk.test.js SITES
// (plants/index.js location_id = 3); this file pins that the third gate is the MERGE one, and that
// every guard sits before the mergeCore call.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decommentSqlDashSpace as decomment } from '../_test-stubs/handlerSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const START = SRC.indexOf('if (mergeMatch) {');
const CALL = SRC.indexOf('await mergeCore(', START);
// The merge route from its branch head up to (not including) the mergeCore call: every guard must
// sit in here, or a rejected override still reaches the UPDATE.
const GUARDS = SRC.slice(START, CALL);
const CALL_ARGS = SRC.slice(CALL, SRC.indexOf('});', CALL));

describe('BUG-AUTHZLAMBDA-001 merge overrides — guards before mergeCore', () => {
  it('finds the merge route and its mergeCore call', () => {
    expect(START).toBeGreaterThan(-1);
    expect(CALL).toBeGreaterThan(START);
  });

  it('refuses a non-object overrides with a 400', () => {
    expect(GUARDS).toMatch(/const ov = body\.overrides \?\? \{\};/);
    expect(GUARDS).toMatch(
      /if \(typeof ov !== 'object' \|\| ov === null \|\| Array\.isArray\(ov\)\) \{\s*return resp\(400/,
    );
  });

  it('gates overrides.location_id with loadOwnedLocation, the warn line and the generic 400', () => {
    // Same three parts as the PUT/POST gates: the negated loader, the server-side log, and the
    // message that is identical for "not yours" and "does not exist" (no existence oracle).
    expect(GUARDS).toMatch(
      /if \(ov\.location_id != null\) \{\s*if \(!await loadOwnedLocation\(sql, ov\.location_id, householdIds\)\) \{\s*warnRejectedFk\(userId, 'plants', 'location_id', ov\.location_id\);\s*return resp\(400, \{ error: 'location_id does not match a location you can use' \}\);/,
    );
  });

  it('runs validateQtyLost on the override map and 400s on its error', () => {
    expect(GUARDS).toMatch(/const _qlErrMerge = validateQtyLost\(ov\);\s*if \(_qlErrMerge\) return resp\(400/);
  });

  it('keeps the quantity guard (BUG-PLANTQTYSTEP-001)', () => {
    expect(GUARDS).toMatch(/validateQuantity\(body\.overrides \?\? \{\}\)/);
  });

  it('hands mergeCore the SAME validated map, not a fresh read of the body', () => {
    // `overrides: body.overrides ?? {}` would still be the same object today, but a later edit that
    // normalises `ov` must not be bypassed by a second read of the raw body.
    expect(CALL_ARGS).toMatch(/overrides: ov,/);
    expect(CALL_ARGS).not.toMatch(/overrides: body\.overrides/);
  });
});
