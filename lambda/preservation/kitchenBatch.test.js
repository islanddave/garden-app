// V5-INFLIGHTBATCH-001 — behavioural coverage for kitchenBatch.js.
//
// EVERY BLOCK NAMES THE MUTATION THAT MUST TURN IT RED. A green suite is not evidence a guard is
// wired, so if you edit kitchenBatch.js and this file stays green, this file is wrong, not the edit.
// The mutations are recorded in project-state/_build-inflight-20260904/lane-kitchenapi.md and each was
// applied, observed red, and reverted.
//
// LANE: the root `npm test` run (vitest run --coverage), which is blocking. Not the integration
// workflow — the kitchen_* tables do not exist in any database, so there is nothing to integrate
// against and every assertion here is a unit assertion.
//
// NO Date.now() ANYWHERE. The predicate window is validated as fixed zoneless local date literals
// ('2026-08-01'), which is what makes ci.yml's blocking TZ=America/New_York re-run non-vacuous over
// this file: a millisecond offset is TZ-invariant by construction and gives that gate nothing to bite.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KITCHEN_BATCH_KINDS, KITCHEN_START_PRECISIONS, KITCHEN_START_ANCHOR_KINDS, VERIFIABLE_ANCHOR_KINDS,
  KITCHEN_OUTCOMES,
  KITCHEN_STAGE_KINDS, KITCHEN_INPUT_KINDS, KITCHEN_QTY_UNITS,
  KITCHEN_BATCH_EDITABLE_COLUMNS, KITCHEN_BATCH_SERVER_OWNED_COLUMNS,
  KITCHEN_BATCH_CLOSE_COLUMNS, KITCHEN_PREDICATE_MAX_SPAN_DAYS,
  STAGE_LOG_ORDER, INPUT_ORDER, BATCH_LIST_ORDER,
  parseKitchenRoute, parseBatchState, normalizeText, batchUpdatePatch,
  validateBatchCreate, validateBatchUpdate, validateStage, validateInputPayload,
  normalizeInputRows, harvestIdsIn, validateClose, outputIdsIn, kitchenErrorMessage,
  validateOutputsPayload, outputLogIdsIn, predicateSpanDays,
} from './kitchenBatch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DDL = readFileSync(
  resolve(__dirname, '../../migrations/v5-inflightbatch-001/0a-additive-ddl.sql'), 'utf8');

// The vocabulary literal a named CHECK constrains. ARRAY[...] never nests a ']' in this file, so the
// first ']' after the constraint's ARRAY[ is its close.
function ddlArray(constraintName) {
  const at = DDL.indexOf(`CONSTRAINT ${constraintName} CHECK`);
  expect(at, `no CONSTRAINT ${constraintName} in the migration`).toBeGreaterThan(-1);
  const open = DDL.indexOf('ARRAY[', at);
  const close = DDL.indexOf(']', open);
  return [...DDL.slice(open, close).matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('the vocabularies match the migration, not a memory of it', () => {
  // THE DRIFT THIS PREVENTS is the one provenance.js documents: a value added to the app list and not
  // to the DB CHECK reaches a 23514 in prod, and a value added to the CHECK and not here is silently
  // unreachable. Both directions, and both sourced from the schema authority rather than restated.
  // Mutation: drop 'age' from KITCHEN_BATCH_KINDS, or add 'pickle' to it. Either turns this red.
  it('kind', () => expect(KITCHEN_BATCH_KINDS).toEqual(ddlArray('chk_kitchen_batch_kind')));
  it('start_precision', () =>
    expect(KITCHEN_START_PRECISIONS).toEqual(ddlArray('chk_kitchen_batch_start_precision')));
  it('start_anchor_kind', () =>
    expect(KITCHEN_START_ANCHOR_KINDS).toEqual(ddlArray('chk_kitchen_batch_anchor_kind')));
  it('outcome', () => expect(KITCHEN_OUTCOMES).toEqual(ddlArray('chk_kitchen_batch_outcome')));
  it('stage_kind', () => expect(KITCHEN_STAGE_KINDS).toEqual(ddlArray('chk_ksl_stage_kind')));
  it('input_kind', () => expect(KITCHEN_INPUT_KINDS).toEqual(ddlArray('chk_kbi_kind')));
  it('qty_unit', () => expect(KITCHEN_QTY_UNITS).toEqual(ddlArray('chk_kbi_qty_unit')));

  it('pins the six outcomes as literals as well, since four of them are load-bearing', () => {
    // A DDL-derived equality alone would silently follow a migration that dropped one. These four are
    // the ones a "simplify to done/failed" edit would take: put_up_different exists because candying's
    // commonest non-ideal result is a downgrade that still produces a real storable product, and
    // discarded_spoiled is split from consumed because "Jen cannot tell whether the jar was eaten or
    // thrown out" is the actual two-user hazard.
    expect(KITCHEN_OUTCOMES).toEqual([
      'put_up', 'put_up_different', 'consumed', 'given_away', 'discarded_spoiled', 'abandoned',
    ]);
  });
});

describe('every CHECK this schema ships has words a cook can act on', () => {
  // A raw 23514 surfaces as `Constraint violation: chk_kitchen_batch_start_pairing`. Enumerated from
  // the migration rather than hand-listed, so a CHECK added later fails this until it has a message.
  // Mutation: delete any one entry from CONSTRAINT_MESSAGES in kitchenBatch.js.
  const named = [...new Set([...DDL.matchAll(/CONSTRAINT\s+(chk_\w+)/g)].map((m) => m[1]))];

  it('found the constraints, so the loop below is not vacuous', () => {
    expect(named.length).toBeGreaterThanOrEqual(24);
    expect(named).toContain('chk_preservation_log_one_provenance');
  });

  it.each(named)('%s has a message', (name) => {
    const msg = kitchenErrorMessage({ code: '23514', constraint: name });
    expect(msg).toBeTruthy();
    expect(msg).not.toContain('chk_');
  });

  it('claims nothing that is not a 23514, so index.js keeps its own error map', () => {
    // Mutation: drop the `err.code !== '23514'` guard. A 23503 FK violation would then be answered
    // with a CHECK's wording, which describes the wrong failure.
    expect(kitchenErrorMessage({ code: '23503', constraint: 'chk_kitchen_batch_kind' })).toBeNull();
    expect(kitchenErrorMessage({ code: '23514', constraint: 'chk_something_else' })).toBeNull();
    expect(kitchenErrorMessage(null)).toBeNull();
  });
});

describe('parseKitchenRoute — the route table, executed', () => {
  // Mutation: swap the `sub === 'stages'` and `sub === 'inputs'` arms. The collection/batch cases stay
  // green, which is why every shape is asserted rather than a representative one.
  it('matches the nine shapes and nothing else', () => {
    expect(parseKitchenRoute('/api/kitchen-batches')).toEqual({ kind: 'collection' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1')).toEqual({ kind: 'batch', id: 'B1' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/stages')).toEqual({ kind: 'stages', id: 'B1' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/inputs')).toEqual({ kind: 'inputs', id: 'B1' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/inputs/I9'))
      .toEqual({ kind: 'input', id: 'B1', inputId: 'I9' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/close')).toEqual({ kind: 'close', id: 'B1' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/reopen')).toEqual({ kind: 'reopen', id: 'B1' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/outputs')).toEqual({ kind: 'outputs', id: 'B1' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/outputs/J7'))
      .toEqual({ kind: 'output', id: 'B1', outputId: 'J7' });
  });

  // ⚠ THE GUARD clientRouteLambdaContract.test.js STRUCTURALLY CANNOT BE. That file registers this
  // module's ONE catch-all regex as a pattern, and the regex absorbs any 1-to-3-segment path — so a
  // client typo (`/closed`, `/finish`, `/reopn`, `/output`) renders as a dynamic segment, MATCHES,
  // and passes GREEN while parseKitchenRoute returns null and the route 404s at runtime. It is also
  // path-only, never method, so a verb mistake ships green and surfaces as a silent 405. These are
  // the exact literals the client builds; asserting them here is the only place a misspelling reds.
  // Mutation: rename the 'reopen' arm to 'reopened' — this reds and nothing else in the repo does.
  it.each([
    ['close', 'close'], ['reopen', 'reopen'], ['outputs', 'outputs'],
  ])('binds the literal client sub-path /%s to kind %s', (segment, kind) => {
    expect(parseKitchenRoute(`/api/kitchen-batches/B1/${segment}`)).toEqual({ kind, id: 'B1' });
  });

  it('returns null for the near-miss spellings a client typo produces', () => {
    // The positive control is the assertion above: the same shapes with the right spelling DO parse,
    // so this absence is about the literal and not about a matcher that stopped matching anything.
    for (const p of ['closed', 'finish', 'reopn', 're-open', 'output', 'outputs2']) {
      expect(parseKitchenRoute(`/api/kitchen-batches/B1/${p}`), p).toBeNull();
    }
    // A tail is meaningful for `outputs` and meaningless for `reopen`/`close` — asserted rather than
    // assumed, because the regex admits a third segment on every sub-path.
    expect(parseKitchenRoute('/api/kitchen-batches/B1/reopen/x')).toBeNull();
    expect(parseKitchenRoute('/api/kitchen-batches/B1/close/x')).toBeNull();
  });

  it('returns null for every path that is not ours', () => {
    // THE ONE THAT MATTERS: this Lambda also serves /api/preservation. A matcher that claimed those
    // paths would take over four shipped routes, and the create/read tests below would all still pass.
    for (const p of [
      '/api/preservation', '/api/preservation/whats-put-up', '/api/preservation/abc',
      '/api/kitchen-batch', '/api/kitchen-batchesx', '/kitchen-batches', '',
    ]) expect(parseKitchenRoute(p), p).toBeNull();
    expect(parseKitchenRoute(undefined)).toBeNull();
  });

  it('rejects an unknown sub-resource rather than reading it as an id', () => {
    // Mutation: make the fallthrough `return { kind: 'batch', id }`. `/B1/delete` would then be served
    // as the batch itself and a DELETE on it would soft-delete the batch.
    expect(parseKitchenRoute('/api/kitchen-batches/B1/delete')).toBeNull();
    expect(parseKitchenRoute('/api/kitchen-batches/B1/stages/S1')).toBeNull();
    expect(parseKitchenRoute('/api/kitchen-batches/B1/close/now')).toBeNull();
  });

  it('tolerates one trailing slash on every shape', () => {
    expect(parseKitchenRoute('/api/kitchen-batches/')).toEqual({ kind: 'collection' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/')).toEqual({ kind: 'batch', id: 'B1' });
    expect(parseKitchenRoute('/api/kitchen-batches/B1/close/')).toEqual({ kind: 'close', id: 'B1' });
  });
});

describe('parseBatchState — going is the default and includes suspended', () => {
  // `going` = closed_at IS NULL. Suspended batches are IN it; the client tells them apart by
  // suspended_at. Mutation: make the default 'all'. The Going-now list would then lead with closed
  // batches, which is the one thing that view exists not to do.
  it('defaults to going for absent, empty and unknown values', () => {
    for (const v of [undefined, null, '', 'GOING', 'open', 'in_flight']) {
      expect(parseBatchState(v), String(v)).toBe('going');
    }
  });
  it('accepts exactly the two other states', () => {
    expect(parseBatchState('closed')).toBe('closed');
    expect(parseBatchState('all')).toBe('all');
  });
});

describe('the order keys, pinned as full literals', () => {
  // FULL LITERAL, BOTH KEYS AND THE SEPARATOR. `'entered_at DESC, id DESC'.includes('entered_at DESC')`
  // is true, so a substring assertion passes on a clause that has LOST its tiebreak — which is exactly
  // the defect: two rows written in one statement tie on entered_at AND created_at, leaving "current"
  // nondeterministic. That is seed_lot_stage_log's bug, and idx_ksl_batch exists to not repeat it.
  it('the stage log orders by entered_at DESC, id DESC', () => {
    expect(STAGE_LOG_ORDER).toBe('entered_at DESC, id DESC');
  });
  it('inputs order by added_at DESC, id DESC', () => {
    expect(INPUT_ORDER).toBe('added_at DESC, id DESC');
  });
  it('the batch list orders unknown starts LAST', () => {
    // NULLS LAST is the SavedSeeds.jsx:594-613 ruling. Dropping it puts every never-asked batch at the
    // top of a "check this" list, above the ones whose start is actually known.
    expect(BATCH_LIST_ORDER).toBe('started_at DESC NULLS LAST, first_recorded_at DESC');
  });
  it('every order key matches an index the migration ships', () => {
    // Ordering that does not match an index is a sort, and the whole no-cache design rests on the
    // current-stage probe being an index lookup bounded by open batches rather than log depth.
    expect(DDL).toContain('CREATE INDEX idx_ksl_batch ON public.kitchen_stage_log (batch_id, entered_at DESC, id DESC)');
    expect(DDL).toContain('CREATE INDEX idx_kbi_batch ON public.kitchen_batch_input (batch_id, added_at DESC, id DESC)');
    expect(DDL).toContain('(user_id, started_at DESC NULLS LAST)');
  });
});

describe('validateBatchCreate — a label and a photo is a COMPLETE record', () => {
  // The entire point of the capture path. Mutation: make `kind` required. This first case reds and
  // nothing else does, which is why it is asserted on its own rather than inside a bigger fixture.
  it('accepts a batch that has nothing but a label', () => {
    expect(validateBatchCreate({ label: 'Pepper mash' })).toBeNull();
  });
  it('accepts a batch with a label and a cover photo and nothing else', () => {
    expect(validateBatchCreate({
      label: 'Something in the kitchen',
      cover_photo_id: '11111111-2222-3333-4444-555555555555',
    })).toBeNull();
  });
  it('requires a non-blank label', () => {
    expect(validateBatchCreate({})).toBe('label is required');
    expect(validateBatchCreate({ label: '   ' })).toBe('label is required');
  });
  it('rejects a body the client should not be sending at all', () => {
    // Mutation: delete the KITCHEN_BATCH_SERVER_OWNED_COLUMNS filter. A client could then post a batch
    // that arrives already closed, or claim a first_recorded_at earlier than the moment it recorded.
    for (const col of KITCHEN_BATCH_SERVER_OWNED_COLUMNS) {
      expect(validateBatchCreate({ label: 'x', [col]: 'v' }), col)
        .toBe(`these fields are set by the server, not the client: ${col}`);
    }
  });
  it('rejects a non-object body', () => {
    expect(validateBatchCreate(null)).toBe('body required');
    expect(validateBatchCreate([{ label: 'x' }])).toBe('body required');
  });
});

describe('the four start states, and only those four', () => {
  // chk_kitchen_batch_start_pairing is a BICONDITIONAL. The two NULL states are DIFFERENT CLAIMS —
  // never asked (may prompt) vs asked and unknown (must never prompt again) — which is the same
  // three-valued distinction v4-putupsession-001 made deliberately for preserved_at_approx.
  // Mutation: change `dated && !graded` to `dated && graded`. State 3 goes red; state 1 does not.
  const L = { label: 'Fridge ferment' };

  it('1. never asked — no date, no precision', () => {
    expect(validateBatchCreate({ ...L })).toBeNull();
    expect(validateBatchCreate({ ...L, started_at: null, start_precision: null })).toBeNull();
  });
  it("2. asked, and he does not know — no date, precision 'unknown'", () => {
    expect(validateBatchCreate({ ...L, start_precision: 'unknown' })).toBeNull();
    expect(validateBatchCreate({ ...L, started_at: null, start_precision: 'unknown' })).toBeNull();
  });
  it('3. a date with a real grade', () => {
    for (const p of ['exact', 'hour', 'day', 'week', 'month']) {
      expect(validateBatchCreate({ ...L, started_at: '2026-08-20T14:00:00Z', start_precision: p }), p)
        .toBeNull();
    }
  });
  it('4. NOTHING ELSE — a date without a grade is refused', () => {
    expect(validateBatchCreate({ ...L, started_at: '2026-08-20T14:00:00Z' }))
      .toContain('a start date needs a start_precision');
  });
  it("4b. a date graded 'unknown' is refused — the two are mutually exclusive", () => {
    expect(validateBatchCreate({ ...L, started_at: '2026-08-20T14:00:00Z', start_precision: 'unknown' }))
      .toContain('a start date needs a start_precision');
  });
  it('4c. a real grade without a date is refused', () => {
    expect(validateBatchCreate({ ...L, start_precision: 'week' }))
      .toContain("start_precision 'week' needs a started_at");
  });
  it('rejects a precision the CHECK does not know', () => {
    expect(validateBatchCreate({ ...L, started_at: '2026-08-20T14:00:00Z', start_precision: 'ish' }))
      .toContain('start_precision must be one of');
  });
});

describe('the start anchor is one-directional on purpose', () => {
  const L = { label: 'Mash' };
  const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  it("accepts 'memory' with no id — that is the whole reason the pairing is one-way", () => {
    expect(validateBatchCreate({ ...L, start_anchor_kind: 'memory' })).toBeNull();
  });
  it('refuses an id with no kind', () => {
    // Mutation: delete the `id != null && kind == null` branch. An anchor id pointing at a photo would
    // then be stored with nothing saying it is a photo, and the row can never be read back.
    expect(validateBatchCreate({ ...L, start_anchor_id: ID }))
      .toBe('start_anchor_id needs a start_anchor_kind');
  });
  it('refuses an anchor kind the CHECK does not know', () => {
    expect(validateBatchCreate({ ...L, start_anchor_kind: 'guess' }))
      .toContain('start_anchor_kind must be one of');
  });
  it('refuses a non-uuid anchor id', () => {
    expect(validateBatchCreate({ ...L, start_anchor_kind: 'photo', start_anchor_id: 'photo-3' }))
      .toBe('start_anchor_id must be a uuid');
  });

  it('accepts an id only for the two kinds that name a resolvable row', () => {
    // start_anchor_id has NO database FK — it is a polymorphic uuid. 'purchase' and 'manual' name no
    // table in this schema and 'memory' is DEFINED as having no id, so an id under those kinds is one
    // nothing can dereference and no ownership gate could check. Narrower than the DDL on purpose,
    // and it is what lets kitchenRoutes.js gate the two remaining cases exhaustively.
    // Mutation: delete the VERIFIABLE_ANCHOR_KINDS branch in anchorError.
    expect(VERIFIABLE_ANCHOR_KINDS).toEqual(['harvest', 'photo']);
    for (const k of VERIFIABLE_ANCHOR_KINDS) {
      expect(validateBatchCreate({ ...L, start_anchor_kind: k, start_anchor_id: ID }), k).toBeNull();
    }
    for (const k of ['purchase', 'memory', 'manual']) {
      expect(validateBatchCreate({ ...L, start_anchor_kind: k, start_anchor_id: ID }), k)
        .toBe('start_anchor_id is only meaningful for a harvest or photo anchor');
    }
  });

  it('still accepts those three kinds WITHOUT an id', () => {
    // The narrowing is about the id, not the kind. 'manual' — the user typed a date — is a real and
    // common anchor and must not become unrecordable.
    for (const k of ['purchase', 'memory', 'manual']) {
      expect(validateBatchCreate({ ...L, start_anchor_kind: k }), k).toBeNull();
    }
  });
});

describe('expected duration is a RANGE, and both ends move together', () => {
  const L = { label: 'Mash' };
  it('accepts a well-formed range and an absent one', () => {
    expect(validateBatchCreate({ ...L, expected_days_min: 21, expected_days_max: 42 })).toBeNull();
    expect(validateBatchCreate({ ...L })).toBeNull();
    expect(validateBatchCreate({ ...L, expected_days_min: 0, expected_days_max: 0 })).toBeNull();
  });
  it('refuses a half range in BOTH directions', () => {
    // One side only would survive a mutation that dropped the other arm of the biconditional.
    expect(validateBatchCreate({ ...L, expected_days_min: 21 })).toContain('both be set');
    expect(validateBatchCreate({ ...L, expected_days_max: 42 })).toContain('both be set');
  });
  it('refuses an inverted range and a negative floor', () => {
    // Mutation: `max < min` -> `max <= min`. Then the equal-bounds case above reds and this passes,
    // which is why both are asserted.
    expect(validateBatchCreate({ ...L, expected_days_min: 42, expected_days_max: 21 }))
      .toBe('expected_days_max must be at least expected_days_min');
    expect(validateBatchCreate({ ...L, expected_days_min: -1, expected_days_max: 5 }))
      .toBe('expected_days_min must be 0 or more');
  });
  it('refuses a fractional day count', () => {
    expect(validateBatchCreate({ ...L, expected_days_min: 1.5, expected_days_max: 5 }))
      .toContain('whole numbers of days');
  });
});

describe("kind owns the pair, matching source_kind's contract over source_label", () => {
  const L = { label: 'Mash' };
  it("requires kind_other when kind is 'other'", () => {
    expect(validateBatchCreate({ ...L, kind: 'other' })).toContain('kind_other is required');
    expect(validateBatchCreate({ ...L, kind: 'other', kind_other: '  ' })).toContain('kind_other is required');
    expect(validateBatchCreate({ ...L, kind: 'other', kind_other: 'koji' })).toBeNull();
  });
  it('accepts every kind the CHECK allows and refuses one it does not', () => {
    for (const k of KITCHEN_BATCH_KINDS.filter((k) => k !== 'other')) {
      expect(validateBatchCreate({ ...L, kind: k }), k).toBeNull();
    }
    expect(validateBatchCreate({ ...L, kind: 'pickling' })).toContain('kind must be one of');
  });
  it('clears kind_other when the PUT names a kind that is not other', () => {
    // Mutation: delete the `present.kind && value.kind !== 'other'` line in batchUpdatePatch. Switching
    // a batch from 'other' to 'candy' would then strand "koji" on the row forever, where nothing reads
    // it and every surface that shows kind_other for an 'other' batch would show it for a candy one.
    const { present, value } = batchUpdatePatch({ kind: 'candy' });
    expect(present.kind_other).toBe(true);
    expect(value.kind_other).toBeNull();
  });
  it('leaves kind_other alone when the PUT does not name a kind', () => {
    const { present } = batchUpdatePatch({ notes: 'skimmed it' });
    expect(present.kind).toBe(false);
    expect(present.kind_other).toBe(false);
  });
});

describe('validateBatchUpdate — an explicit allowlist, not a full replace', () => {
  it('accepts exactly the thirteen editable columns', () => {
    expect(KITCHEN_BATCH_EDITABLE_COLUMNS).toEqual([
      'label', 'kind', 'kind_other', 'started_at', 'start_precision', 'start_anchor_kind',
      'start_anchor_id', 'expected_days_min', 'expected_days_max', 'brine_note', 'cover_photo_id',
      'notes', 'suspended_at',
    ]);
  });

  it('refuses every server-owned column BY NAME, not merely as an unknown field', () => {
    // FULL LITERAL, and that is what makes this non-vacuous. TWO guards refuse a server-owned column
    // here — the explicit KITCHEN_BATCH_SERVER_OWNED_COLUMNS filter, and the unknown-field filter
    // behind it, since no server-owned column is in the editable set either. A `toContain(col)`
    // assertion is satisfied by BOTH, so deleting the first guard left the suite green: measured, and
    // it is the redundant-suppression trap. Asserting the exact message neutralises the second guard
    // for this case, so the mutation "delete the SERVER_OWNED filter" now reds.
    for (const col of KITCHEN_BATCH_SERVER_OWNED_COLUMNS) {
      expect(validateBatchUpdate({ [col]: 'v' }), col)
        .toBe(`these fields cannot be edited here: ${col}`);
    }
  });

  it('refuses closed_at and outcome specifically, since closing has its own route', () => {
    expect(validateBatchUpdate({ closed_at: '2026-09-01T00:00:00Z' }))
      .toBe('these fields cannot be edited here: closed_at');
    expect(validateBatchUpdate({ outcome: 'put_up' }))
      .toBe('these fields cannot be edited here: outcome');
    expect(validateBatchUpdate({ outcome_note: 'went mouldy' }))
      .toBe('these fields cannot be edited here: outcome_note');
  });

  it('names the server-owned column even when an unknown field rides along', () => {
    // Order matters: the specific message has to win, or a client editing a batch gets told its
    // problem is an unknown field when the real problem is that closing has its own route.
    expect(validateBatchUpdate({ closed_at: 'x', ph: 4.8 }))
      .toBe('these fields cannot be edited here: closed_at');
  });

  it('refuses a field it has never heard of rather than ignoring it', () => {
    // Silently dropping an unknown key is how a client ships a field the server never stores and
    // nobody notices for a season.
    expect(validateBatchUpdate({ label: 'x', ph: 4.8 })).toBe('unknown field(s): ph');
  });

  it('refuses an empty body', () => {
    expect(validateBatchUpdate({})).toBe('nothing to update');
  });

  it('lets a label change but never be emptied', () => {
    expect(validateBatchUpdate({ label: 'Pepper mash — Aug 2026' })).toBeNull();
    expect(validateBatchUpdate({ label: '' })).toBe('label cannot be empty');
    expect(validateBatchUpdate({ label: null })).toBe('label cannot be empty');
  });

  it('accepts suspending and un-suspending', () => {
    expect(validateBatchUpdate({ suspended_at: '2026-09-01T12:00:00Z' })).toBeNull();
    expect(validateBatchUpdate({ suspended_at: null })).toBeNull();
  });

  it('makes the start pair move together, because a merge cannot see the stored half', () => {
    // Mutation: pass requirePair:false from validateBatchUpdate. A PUT carrying started_at alone would
    // then reach the DB and raise chk_kitchen_batch_start_pairing as a bare 23514 — or, worse, pass:
    // clearing started_at while leaving a real grade behind is a row asserting a grade for no date.
    expect(validateBatchUpdate({ started_at: '2026-08-20T14:00:00Z' }))
      .toBe('started_at and start_precision must be sent together — a date always carries its grade');
    expect(validateBatchUpdate({ start_precision: 'day' }))
      .toBe('started_at and start_precision must be sent together — a date always carries its grade');
    expect(validateBatchUpdate({ started_at: '2026-08-20T14:00:00Z', start_precision: 'day' }))
      .toBeNull();
    expect(validateBatchUpdate({ started_at: null, start_precision: 'unknown' })).toBeNull();
  });

  it('makes the expected-days pair move together too', () => {
    expect(validateBatchUpdate({ expected_days_min: 21 })).toContain('must be sent together');
    expect(validateBatchUpdate({ expected_days_min: 21, expected_days_max: 42 })).toBeNull();
    expect(validateBatchUpdate({ expected_days_min: null, expected_days_max: null })).toBeNull();
  });
});

describe('batchUpdatePatch — an absent key and an explicit null are different requests', () => {
  // THE DEFECT THIS EXISTS TO PREVENT. `body.brine_note ?? null` collapses "did not mention it" and
  // "clear it" into one value, and under a full-replace write a service-worker-cached bundle that has
  // never heard of brine_note would erase it on an unrelated tap and return 200 — the same class as
  // the source_kind COALESCE deviation in index.js. Mutation: make `present[col]` always true.
  it('reports absent for a key the request never mentioned', () => {
    const { present, value } = batchUpdatePatch({ notes: 'skimmed' });
    expect(present.brine_note).toBe(false);
    expect(value.brine_note).toBeNull();
    expect(present.notes).toBe(true);
    expect(value.notes).toBe('skimmed');
  });

  it('reports present for a key explicitly set to null, so it can be CLEARED', () => {
    const { present, value } = batchUpdatePatch({ brine_note: null });
    expect(present.brine_note).toBe(true);
    expect(value.brine_note).toBeNull();
  });

  it('trims text to null rather than storing whitespace', () => {
    const { present, value } = batchUpdatePatch({ brine_note: '   ' });
    expect(present.brine_note).toBe(true);
    expect(value.brine_note).toBeNull();
  });

  it('coerces the day counts to numbers and leaves null alone', () => {
    const a = batchUpdatePatch({ expected_days_min: '21', expected_days_max: '42' });
    expect(a.value.expected_days_min).toBe(21);
    expect(a.value.expected_days_max).toBe(42);
    const b = batchUpdatePatch({ expected_days_min: null, expected_days_max: null });
    expect(b.value.expected_days_min).toBeNull();
  });

  it('reports a flag for every editable column and no others', () => {
    const { present } = batchUpdatePatch({ label: 'x' });
    expect(Object.keys(present).sort()).toEqual([...KITCHEN_BATCH_EDITABLE_COLUMNS].sort());
  });
});

describe('validateStage — append-only, and order is NOT monotonic', () => {
  it('accepts every stage kind', () => {
    for (const k of KITCHEN_STAGE_KINDS) {
      const body = k === 'moved'
        ? { stage_kind: k, storage_location_id: '11111111-1111-1111-1111-111111111111' }
        : { stage_kind: k };
      expect(validateStage(body), k).toBeNull();
    }
  });

  it("accepts a 'tended' row with no reference to what came before it", () => {
    // Three of six documented candy recoveries RE-ENTER the sequence — "return briefly to warm syrup",
    // "re-melt", "rinse, re-dry, re-dust" — so a tended row legitimately arrives after a finished one.
    // Mutation: add any ordering precondition to validateStage. This reds, and nothing else does.
    expect(validateStage({ stage_kind: 'tended', label: 'syrup rung 2', amount: 150, amount_unit: 'g' }))
      .toBeNull();
  });

  it("refuses a 'moved' row with nowhere to have moved to", () => {
    // chk_ksl_moved_needs_location. Placement is a rate input: moving a ferment to the fridge does not
    // advance it, it approximately STOPS it. A moved row with no destination records that something
    // changed while destroying the only thing that changed.
    expect(validateStage({ stage_kind: 'moved' })).toContain('needs a storage_location_id');
    expect(validateStage({ stage_kind: 'moved', storage_location_id: 'shelf-2' }))
      .toContain('needs a storage_location_id');
  });

  it('refuses a stage kind the CHECK does not know', () => {
    expect(validateStage({ stage_kind: 'bottled' })).toContain('stage_kind must be one of');
    expect(validateStage({})).toContain('stage_kind must be one of');
  });

  it('pairs amount with amount_unit in both directions', () => {
    expect(validateStage({ stage_kind: 'tended', amount: 150 })).toContain('both be set');
    expect(validateStage({ stage_kind: 'tended', amount_unit: 'g' })).toContain('both be set');
    expect(validateStage({ stage_kind: 'tended', amount: 150, amount_unit: 'g' })).toBeNull();
    expect(validateStage({ stage_kind: 'tended' })).toBeNull();
  });

  it('refuses a zero or negative amount', () => {
    expect(validateStage({ stage_kind: 'tended', amount: 0, amount_unit: 'g' }))
      .toBe('amount must be greater than 0');
    expect(validateStage({ stage_kind: 'tended', amount: -5, amount_unit: 'g' }))
      .toBe('amount must be greater than 0');
  });

  it('holds the stage amount to the same unit vocabulary the input table has a CHECK for', () => {
    // kitchen_stage_log.amount_unit has NO DB CHECK. preservation_log.quantity_unit is the one unit
    // column in this family without one and it has ALREADY drifted — 'quarts' beside harvest_log's
    // 'qt' (BUG-PRESERVUNITNOCHECK-001). An app-layer belt is the only place to stop that here.
    expect(validateStage({ stage_kind: 'tended', amount: 2, amount_unit: 'cups' }))
      .toContain('amount_unit must be one of');
    expect(validateStage({ stage_kind: 'tended', amount: 2, amount_unit: 'cup' })).toBeNull();
  });

  it('refuses a blank label rather than storing one', () => {
    expect(validateStage({ stage_kind: 'tended', label: '   ' })).toBe('label cannot be blank');
    expect(validateStage({ stage_kind: 'tended', label: null })).toBeNull();
  });
});

describe('validateInputPayload — two forms, and exactly one per request', () => {
  const HARVEST = '11111111-1111-1111-1111-111111111111';

  it('refuses both forms at once and neither form at all', () => {
    // Mutation: `if (hasList === hasPredicate)` -> `if (!hasList && !hasPredicate)`. A request with
    // both would then run the predicate and silently discard the explicit list.
    expect(validateInputPayload({ inputs: [], predicate: {} }))
      .toBe('send either inputs or predicate, not both and not neither');
    expect(validateInputPayload({}))
      .toBe('send either inputs or predicate, not both and not neither');
  });

  it('accepts a harvest input and a non-harvest input side by side', () => {
    // ONE table, discriminated — not two. "What went into this batch" must be answerable with one
    // join, or the UI shows the peppers and silently omits the salt.
    expect(validateInputPayload({
      inputs: [
        { input_kind: 'harvest', harvest_log_id: HARVEST, qty: 1.2, qty_unit: 'kg' },
        { input_kind: 'pantry', label: 'Kosher salt', qty: 3, qty_unit: 'tbsp' },
      ],
    })).toBeNull();
  });

  it('enforces the harvest biconditional in BOTH directions', () => {
    // chk_kbi_harvest_pairing. One direction only would survive a mutation that dropped the other.
    expect(validateInputPayload({ inputs: [{ input_kind: 'harvest' }] }))
      .toBe("an input of kind 'harvest' needs a harvest_log_id");
    expect(validateInputPayload({
      inputs: [{ input_kind: 'purchased', label: 'Fresnos', harvest_log_id: HARVEST }],
    })).toBe("an input of kind 'purchased' must not carry a harvest_log_id");
  });

  it('requires a label on every non-harvest input', () => {
    for (const k of ['purchased', 'pantry', 'other']) {
      expect(validateInputPayload({ inputs: [{ input_kind: k }] }), k).toContain('needs a label');
    }
  });

  it('lets only a harvest be a byproduct', () => {
    // Rind is a byproduct of fruit you already counted; weighing it as a second harvest double-counts
    // every ripe melon. The flag only means anything against a harvest.
    expect(validateInputPayload({
      inputs: [{ input_kind: 'harvest', harvest_log_id: HARVEST, is_byproduct: true }],
    })).toBeNull();
    expect(validateInputPayload({
      inputs: [{ input_kind: 'pantry', label: 'Sugar', is_byproduct: true }],
    })).toBe('is_byproduct only applies to a harvest input');
  });

  it('pairs qty with qty_unit and holds the unit to the CHECK vocabulary', () => {
    expect(validateInputPayload({ inputs: [{ input_kind: 'pantry', label: 'Salt', qty: 3 }] }))
      .toContain('both be set');
    expect(validateInputPayload({
      inputs: [{ input_kind: 'pantry', label: 'Salt', qty: 3, qty_unit: 'quarts' }],
    })).toContain('qty_unit must be one of');
    // A NULL pair means "unrecorded, assume the whole thing" — the chk_harvest_log_weight_pairing
    // house idiom. It never means zero, so an explicit zero is refused.
    expect(validateInputPayload({ inputs: [{ input_kind: 'pantry', label: 'Salt' }] })).toBeNull();
    expect(validateInputPayload({
      inputs: [{ input_kind: 'pantry', label: 'Salt', qty: 0, qty_unit: 'tbsp' }],
    })).toBe('qty must be greater than 0');
  });

  it('refuses an empty list', () => {
    expect(validateInputPayload({ inputs: [] })).toBe('inputs must be a non-empty array');
  });
});

describe('the predicate window — fixed zoneless local date literals, both bounds', () => {
  const ok = (p) => validateInputPayload({ predicate: p });

  it('accepts a five-week window, which is the measured pepper-mash case', () => {
    expect(ok({ crop_type_slug: 'pepper', from: '2026-08-01', to: '2026-09-04' })).toBeNull();
  });

  it('accepts a single-day window', () => {
    // Mutation: `to < from` -> `to <= from`. This reds and the five-week case does not, which is why a
    // degenerate window is asserted separately.
    expect(ok({ from: '2026-08-01', to: '2026-08-01' })).toBeNull();
  });

  it('refuses an inverted window', () => {
    expect(ok({ from: '2026-09-04', to: '2026-08-01' }))
      .toBe('predicate.to must be on or after predicate.from');
  });

  it('requires both bounds, and requires them as calendar days', () => {
    // Mutation: drop the DATE_RE test on `to`. An ISO instant would then be compared as a string
    // against a date, and '2026-08-01T00:00:00Z' > '2026-08-01' silently shifts the window by a day.
    expect(ok({ from: '2026-08-01' })).toBe('predicate.to must be a YYYY-MM-DD date');
    expect(ok({ to: '2026-09-04' })).toBe('predicate.from must be a YYYY-MM-DD date');
    expect(ok({ from: '2026-08-01T00:00:00Z', to: '2026-09-04' }))
      .toBe('predicate.from must be a YYYY-MM-DD date');
    expect(ok({ from: '08/01/2026', to: '09/04/2026' }))
      .toBe('predicate.from must be a YYYY-MM-DD date');
  });

  it('accepts an unfiltered window — all three selectors are optional by contract', () => {
    expect(ok({ from: '2026-08-01', to: '2026-09-04' })).toBeNull();
  });

  it('refuses a malformed selector rather than letting it reach a 22P02', () => {
    expect(ok({ from: '2026-08-01', to: '2026-09-04', variety_id: 'jalapeno' }))
      .toBe('predicate.variety_id must be a uuid');
    expect(ok({ from: '2026-08-01', to: '2026-09-04', plant_id: '42' }))
      .toBe('predicate.plant_id must be a uuid');
    expect(ok({ from: '2026-08-01', to: '2026-09-04', crop_type_slug: '  ' }))
      .toBe('predicate.crop_type_slug cannot be blank');
  });
});

// ⚠ THE SPAN CAP. Not a performance bound — a 1,212-row INSERT..SELECT is nothing to Postgres. It is
// a REPAIRABILITY bound: the undo is DELETE per row, and the predicate form discards its RETURNING
// ids so even a targeted undo needs a full before/after GET diff over the whole payload.
describe('the predicate span cap — both bounds, never one', () => {
  const ok = (p) => validateInputPayload({ predicate: p });

  it('counts an inclusive calendar span, so from == to is one day', () => {
    // Mutation (K7 variant): drop the `+ 1`. Every cap assertion below shifts by a day and the
    // single-day case reports 0, which no window can be.
    expect(predicateSpanDays({ from: '2026-08-01', to: '2026-08-01' })).toBe(1);
    expect(predicateSpanDays({ from: '2026-08-01', to: '2026-08-02' })).toBe(2);
    // Across a DST transition in ET and across a leap day — both parsed as UTC midnights, so neither
    // can lose or gain an hour and round to the wrong day.
    expect(predicateSpanDays({ from: '2026-03-07', to: '2026-03-09' })).toBe(3);
    expect(predicateSpanDays({ from: '2024-02-28', to: '2024-03-01' })).toBe(3);
  });

  it('accepts a window exactly at the cap and refuses the next day', () => {
    // A single-value test here is vacuous — "366 days is rejected" is satisfied by a cap of 1. The
    // PAIR is what pins the boundary to the number the constant names.
    // Mutation (K7): raise KITCHEN_PREDICATE_MAX_SPAN_DAYS by one — the second arm reds. Lower it by
    // one — the first arm reds.
    expect(predicateSpanDays({ from: '2026-01-01', to: '2027-01-01' }))
      .toBe(KITCHEN_PREDICATE_MAX_SPAN_DAYS);
    expect(ok({ from: '2026-01-01', to: '2027-01-01' })).toBeNull();
    expect(ok({ from: '2026-01-01', to: '2027-01-02' }))
      .toBe('that window covers 367 days — a bulk add takes at most 366, so narrow it or add the picks in two passes');
  });

  it('leaves a full grow season inside the cap — the one window control the client ships', () => {
    // HarvestTimeframeChips' season chip spans a Nov-Oct grow year. A cap that rejected it would
    // break the only window selector the design ships, so the number is not free to be tightened
    // without replacing that control.
    expect(ok({ from: '2025-11-01', to: '2026-10-31' })).toBeNull();
  });

  it('refuses the unbounded window that inserts every household harvest in one tap', () => {
    // MEASURED against live prod 2026-09-04: 1,212 rows, one tap, and no bulk-remove route exists.
    expect(ok({ from: '2000-01-01', to: '2099-12-31' })).toContain('a bulk add takes at most 366');
  });

  it('checks the SHAPE before the span, so a malformed date reports the malformed date', () => {
    // Mutation: move the span check above the DATE_RE tests. NaN > cap is false, so a garbage `to`
    // would sail past the cap and then report a date error anyway — but a garbage `from` with a real
    // `to` would report the cap message, naming the wrong problem.
    expect(ok({ from: 'yesterday', to: '2099-12-31' })).toBe('predicate.from must be a YYYY-MM-DD date');
  });
});

describe('the preview flag belongs to the predicate form and is a strict boolean', () => {
  const W = { from: '2026-08-01', to: '2026-09-04' };

  it('accepts true and false on the predicate form', () => {
    expect(validateInputPayload({ predicate: W, preview: true })).toBeNull();
    expect(validateInputPayload({ predicate: W, preview: false })).toBeNull();
    // The control: an absent flag is still valid, so the assertions below are about the VALUE.
    expect(validateInputPayload({ predicate: W })).toBeNull();
  });

  it('refuses a preview on the explicit form, which has nothing to resolve', () => {
    expect(validateInputPayload({
      inputs: [{ input_kind: 'pantry', label: 'Salt' }], preview: true,
    })).toBe('preview only applies to the predicate form');
  });

  it('refuses a truthy non-boolean rather than dry-running a write that commits', () => {
    // The is_byproduct lesson one field over — "true" must never read as true. Here the failure
    // direction is worse: a client believes it previewed, and 139 rows landed.
    // Mutation: relax to `Boolean(body.preview)`. Both arms below go green and the route commits on
    // a body that asked for a dry run.
    for (const v of ['true', 1, 'yes', {}]) {
      expect(validateInputPayload({ predicate: W, preview: v }), String(v))
        .toBe('preview must be true or false');
    }
  });
});

describe('validateOutputsPayload — linking jars without closing the batch', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';

  it('accepts a non-empty list of uuids', () => {
    expect(validateOutputsPayload({ preservation_log_ids: [A, B] })).toBeNull();
  });

  it('refuses a body with nothing to link', () => {
    // An empty array is legal on CLOSE (a close that links nothing is the abandoned case) and is
    // meaningless here: this route exists only to link. Distinct messages so the client can tell a
    // missing key from an empty selection.
    expect(validateOutputsPayload({})).toBe('preservation_log_ids must be an array');
    expect(validateOutputsPayload({ preservation_log_ids: [] }))
      .toBe('preservation_log_ids must be a non-empty array');
    expect(validateOutputsPayload({ preservation_log_ids: 'abc' }))
      .toBe('preservation_log_ids must be an array');
    expect(validateOutputsPayload({ preservation_log_ids: [A, 'jar-2'] }))
      .toBe('preservation_log_ids must all be uuids');
    expect(validateOutputsPayload(null)).toBe('body required');
    expect(validateOutputsPayload([A])).toBe('body required');
  });

  it('dedupes, matching outputIdsIn — one jar named twice asked for one link', () => {
    expect(outputLogIdsIn({ preservation_log_ids: [A, A, B] })).toEqual([A, B]);
    expect(outputLogIdsIn({})).toEqual([]);
  });
});

// ⚠ THE REVERSIBILITY CONTRACT, at the constant. The statement-level half — close writes exactly this
// set, reopen NULLs exactly this set — lives in kitchenRoutes.test.js, which is where the SQL is.
describe('KITCHEN_BATCH_CLOSE_COLUMNS', () => {
  it('is exactly the three columns a close records', () => {
    expect(KITCHEN_BATCH_CLOSE_COLUMNS).toEqual(['closed_at', 'outcome', 'outcome_note']);
  });

  it('is a strict subset of the server-owned set, so no client can write one', () => {
    // If a close column ever became client-writable the PUT would be a second, ungated closer.
    for (const c of KITCHEN_BATCH_CLOSE_COLUMNS) {
      expect(KITCHEN_BATCH_SERVER_OWNED_COLUMNS, c).toContain(c);
      expect(KITCHEN_BATCH_EDITABLE_COLUMNS, c).not.toContain(c);
    }
  });

  it('does NOT contain suspended_at, which close writes and reopen deliberately does not restore', () => {
    // The positive control: suspended_at IS editable, so the pause is re-settable with one PUT —
    // which is the reason losing it through a close is acceptable rather than merely unavoidable.
    expect(KITCHEN_BATCH_CLOSE_COLUMNS).not.toContain('suspended_at');
    expect(KITCHEN_BATCH_EDITABLE_COLUMNS).toContain('suspended_at');
  });
});

describe('normalizeInputRows — a re-run of the same request is a no-op, honestly reported', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';

  it('dedupes a harvest named twice in one request', () => {
    // uq_kbi_batch_harvest makes the DB side a no-op either way; this is so `inserted` does not report
    // two rows when one lands. Mutation: delete the seenHarvest guard.
    const rows = normalizeInputRows([
      { input_kind: 'harvest', harvest_log_id: A },
      { input_kind: 'harvest', harvest_log_id: A },
      { input_kind: 'harvest', harvest_log_id: B },
    ]);
    expect(rows).toHaveLength(2);
    expect(harvestIdsIn(rows)).toEqual([A, B]);
  });

  it('never dedupes two unlabelled non-harvest inputs, which are legitimately distinct', () => {
    // Two pinches of salt into the same batch are two rows. Deduping on a null harvest id would
    // collapse them, and the second one would vanish with no error.
    const rows = normalizeInputRows([
      { input_kind: 'pantry', label: 'Kosher salt' },
      { input_kind: 'pantry', label: 'Kosher salt' },
    ]);
    expect(rows).toHaveLength(2);
    expect(harvestIdsIn(rows)).toEqual([]);
  });

  it('normalizes blanks to null and coerces qty to a number', () => {
    const [row] = normalizeInputRows([
      { input_kind: 'pantry', label: 'Salt', qty: '3', qty_unit: 'tbsp', note: '  ' },
    ]);
    expect(row).toEqual({
      input_kind: 'pantry', harvest_log_id: null, label: 'Salt',
      qty: 3, qty_unit: 'tbsp', is_byproduct: false, note: null,
    });
  });

  it('defaults is_byproduct to false rather than undefined', () => {
    // The column is NOT NULL DEFAULT false; binding undefined into a ::boolean[] is a driver error,
    // not a default.
    const [row] = normalizeInputRows([{ input_kind: 'harvest', harvest_log_id: A }]);
    expect(row.is_byproduct).toBe(false);
  });
});

describe('validateClose — closed_at and outcome are inseparable', () => {
  it('accepts each of the six outcomes', () => {
    for (const o of KITCHEN_OUTCOMES) expect(validateClose({ outcome: o }), o).toBeNull();
  });
  it('requires an outcome, because chk_kitchen_batch_close_pairing makes the pair mandatory', () => {
    expect(validateClose({})).toContain('outcome must be one of');
    expect(validateClose({ outcome: 'done' })).toContain('outcome must be one of');
  });
  it('accepts an outcome note and a list of outputs', () => {
    expect(validateClose({
      outcome: 'put_up_different', outcome_note: 'chewy confection now',
      output_preservation_log_ids: ['11111111-1111-1111-1111-111111111111'],
    })).toBeNull();
  });
  it('refuses a malformed output list rather than letting it reach a 22P02', () => {
    expect(validateClose({ outcome: 'put_up', output_preservation_log_ids: 'abc' }))
      .toBe('output_preservation_log_ids must be an array');
    expect(validateClose({ outcome: 'put_up', output_preservation_log_ids: ['jar-1'] }))
      .toBe('output_preservation_log_ids must all be uuids');
  });
  it('dedupes the output list and defaults it to empty', () => {
    const A = '11111111-1111-1111-1111-111111111111';
    expect(outputIdsIn({ output_preservation_log_ids: [A, A] })).toEqual([A]);
    expect(outputIdsIn({})).toEqual([]);
  });

  // cue_observed rides on the close body and is NOT validated, deliberately: free text, never a
  // picklist, never range-checked, never read back into a decision. Validating it — a length cap, a
  // vocabulary, anything — is the first step to it becoming an assessment rather than a record.
  it('accepts any cue_observed, including none, and never rejects one', () => {
    expect(validateClose({ outcome: 'put_up', cue_observed: 'snapped clean' })).toBeNull();
    expect(validateClose({ outcome: 'put_up', cue_observed: '   ' })).toBeNull();
    expect(validateClose({ outcome: 'put_up', cue_observed: 'x'.repeat(5000) })).toBeNull();
    expect(validateClose({ outcome: 'put_up' })).toBeNull();
  });
});

describe('normalizeText', () => {
  it('is meaningful-string-or-null, mirroring the btrim CHECKs', () => {
    expect(normalizeText('  Pepper mash  ')).toBe('Pepper mash');
    expect(normalizeText('   ')).toBeNull();
    expect(normalizeText('')).toBeNull();
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(undefined)).toBeNull();
  });
});
