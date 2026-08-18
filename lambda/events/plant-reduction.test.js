// V4-LOSSEVENT-001 — plant-reduction ledger.
//
// THE REQUIREMENT, in Dave's words: he starts more seeds than he needs, plants out ten lettuce,
// and between seedling and plant-out takes that to five — and he needs to record WHY the count went
// from ten to five. The planting is ALIVE AND HEALTHY, just smaller. So the unit of record is a
// PARTIAL, REPEATABLE quantity reduction on a still-ACTIVE planting: 10 -> 8 (pest) then 8 -> 5
// (culled) must both be recoverable afterwards, each with its own reason, quantity and date.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The events Lambda unit suite is mock-sql + source text; it
// executes no SQL. So the ARITHMETIC is proved elsewhere — against a real Postgres 17.10, with the
// two statements EXTRACTED VERBATIM from index.js rather than retyped (see the lane report). What
// lives here is (a) the pure validator contract, executable, and (b) structural assertions on the
// statements that the arithmetic proof depends on — chiefly that the reduction UPDATE never touches
// `status`, which is the difference between Dave's requirement and the thing he explicitly said
// this is not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateReduction, readReductionPlan, validatePostBody, validateBatchBody,
  LOSS_REASONS, GIVEAWAY_REASONS, PLANT_REDUCTION_EVENT_TYPES,
  REDUCTION_QTY_KEY, LOSS_REASON_KEY, GIVEAWAY_REASON_KEY, MAX_REDUCTION_QTY,
  orderEndStatusOffer,
} from './validators.js';
import {
  EVENT_TYPES, EVENT_TYPE_META, BATCH_EVENT_TYPES, BATCH_EXCLUDED_TYPES,
  PLANTING_REQUIRED_TYPES, isIntentionalReduction, accruesQtyLost, INTENTIONAL_LOSS_REASONS,
} from '../../src/lib/eventTypes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const PLANT_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

// The reduction UPDATE and the delete-reversal UPDATE, sliced out of index.js by their anchor
// comments. Structural assertions run against the REAL statement text, so a rewrite that drops a
// clause reds here instead of shipping.
function statementAfter(anchor) {
  const at = INDEX_SRC.indexOf(anchor);
  expect(at, `anchor not found in index.js: ${anchor}`).toBeGreaterThan(-1);
  const open = INDEX_SRC.indexOf('sql`', at);
  return INDEX_SRC.slice(open + 4, INDEX_SRC.indexOf('`', open + 4));
}
const REDUCE_SQL = statementAfter('V4-LOSSEVENT-001 — the counter half of the plant-reduction ledger');
const UNDO_SQL = statementAfter('qty_lost floors at 0 rather than going negative');

const failedBody = (over = {}) => ({
  event_type: 'failed', plant_id: PLANT_UUID,
  metadata: { [REDUCTION_QTY_KEY]: 3, [LOSS_REASON_KEY]: 'pest' }, ...over,
});
const giftBody = (over = {}) => ({
  event_type: 'given_away', plant_id: PLANT_UUID,
  metadata: { [REDUCTION_QTY_KEY]: 2, [GIVEAWAY_REASON_KEY]: 'friend' }, ...over,
});

describe('the two vocabularies stay apart', () => {
  it('LOSS_REASONS is Dave\'s seven — the five deployed plus animal_damage and culled', () => {
    expect([...LOSS_REASONS].sort()).toEqual([
      'animal_damage', 'culled', 'disease', 'pest', 'transplant_shock', 'unknown', 'weather',
    ]);
  });

  it("GIVEAWAY_REASONS is the three Dave named, and 'sold'/'traded' are NOT in it", () => {
    // Proposed in the lane report, not shipped. An unapproved value in a closed vocabulary is
    // indistinguishable from an approved one once rows carry it.
    expect([...GIVEAWAY_REASONS].sort()).toEqual(['donated', 'friend', 'plant_swap']);
    expect(GIVEAWAY_REASONS).not.toContain('sold');
    expect(GIVEAWAY_REASONS).not.toContain('traded');
  });

  it('no reason means both "lost" and "given away"', () => {
    // Dave's ruling: a plant swap is not a loss. If gifts became loss reasons then "how much did I
    // lose to problems" would overcount by every gift.
    expect(GIVEAWAY_REASONS.filter((r) => LOSS_REASONS.includes(r))).toEqual([]);
  });

  it('deliberate-vs-accidental is decidable from the reason value ALONE (no `intentional` column)', () => {
    expect(INTENTIONAL_LOSS_REASONS).toEqual(['culled']);
    expect(isIntentionalReduction('culled')).toBe(true);
    for (const r of GIVEAWAY_REASONS) expect(isIntentionalReduction(r), r).toBe(true);
    for (const r of ['pest', 'disease', 'weather', 'transplant_shock', 'animal_damage']) {
      expect(isIntentionalReduction(r), r).toBe(false);
    }
    // Disjointness above is what keeps this decidable; a shared token would need the event type.
    expect(isIntentionalReduction('unknown')).toBe(false);
  });

  it('only a LOSS accrues into plants.qty_lost', () => {
    expect(accruesQtyLost('failed')).toBe(true);
    expect(accruesQtyLost('given_away')).toBe(false);
    expect(accruesQtyLost('harvest')).toBe(false);
  });
});

describe('vocabulary membership + batch exclusion', () => {
  it('both types are first-class EVENT_TYPES values with complete META', () => {
    for (const t of PLANT_REDUCTION_EVENT_TYPES) {
      expect(EVENT_TYPES, `${t} missing from EVENT_TYPES`).toContain(t);
      for (const f of ['label', 'emoji', 'category']) {
        expect(EVENT_TYPE_META[t]?.[f], `${t}.${f}`).toBeTruthy();
      }
    }
  });

  it('neither is batch-loggable', () => {
    // Each carries a PER-PLANTING quantity, the same disqualifier harvest has — and worse here,
    // because the batch write has an invisible side effect: one "lost 3" across a 500-planting
    // scope would decrement 500 plantings and accrue 1500 to qty_lost.
    for (const t of PLANT_REDUCTION_EVENT_TYPES) {
      expect(BATCH_EXCLUDED_TYPES, `${t} must be batch-excluded`).toContain(t);
      expect(BATCH_EVENT_TYPES, `${t} leaked into the batch allowlist`).not.toContain(t);
    }
  });

  it('both REQUIRE a planting — there is no count to reduce without one', () => {
    for (const t of PLANT_REDUCTION_EVENT_TYPES) {
      expect([...PLANTING_REQUIRED_TYPES], t).toContain(t);
    }
  });
});

describe('validateReduction — the wire contract', () => {
  it('accepts a well-formed loss and a well-formed give-away', () => {
    expect(validateReduction(failedBody())).toBeNull();
    expect(validateReduction(giftBody())).toBeNull();
  });

  it('REQUIRES a quantity on every reduction', () => {
    // Without it, losing one pepper is indistinguishable from losing nineteen, and the only
    // aggregate that answers "how many did I lose to pests" degrades to count(*), which in this
    // schema measures batches rather than plants.
    const err = validateReduction(failedBody({ metadata: { [LOSS_REASON_KEY]: 'pest' } }));
    expect(err?.status).toBe(400);
    expect(err.error).toMatch(/qty_reduced/);
  });

  it('rejects a non-integer, zero, negative or coerced quantity — no silent coercion', () => {
    for (const q of ['3', 3.5, 0, -1, true, null]) {
      const err = validateReduction(failedBody({
        metadata: { [REDUCTION_QTY_KEY]: q, [LOSS_REASON_KEY]: 'pest' },
      }));
      expect(err?.status, `qty ${JSON.stringify(q)} should be rejected`).toBe(400);
    }
    expect(validateReduction(failedBody({
      metadata: { [REDUCTION_QTY_KEY]: MAX_REDUCTION_QTY + 1, [LOSS_REASON_KEY]: 'pest' },
    }))?.status).toBe(400);
  });

  it('REQUIRES the reason, and rejects one outside its own vocabulary', () => {
    expect(validateReduction(failedBody({
      metadata: { [REDUCTION_QTY_KEY]: 3 },
    }))?.status).toBe(400);
    expect(validateReduction(failedBody({
      metadata: { [REDUCTION_QTY_KEY]: 3, [LOSS_REASON_KEY]: 'sabotage' },
    }))?.status).toBe(400);
    expect(validateReduction(giftBody({
      metadata: { [REDUCTION_QTY_KEY]: 2, [GIVEAWAY_REASON_KEY]: 'sold' },
    }))?.status).toBe(400);
  });

  it('refuses a give-away reason on a loss, and vice versa', () => {
    // The cross-vocabulary case the separation exists for. 'friend' is a real value — just not on
    // this row — so a set-membership check alone would not catch it if the keys were shared.
    expect(validateReduction(failedBody({
      metadata: { [REDUCTION_QTY_KEY]: 3, [LOSS_REASON_KEY]: 'friend' },
    }))?.status).toBe(400);
    expect(validateReduction(failedBody({
      metadata: { [REDUCTION_QTY_KEY]: 3, [LOSS_REASON_KEY]: 'pest', [GIVEAWAY_REASON_KEY]: 'friend' },
    }))?.error).toMatch(/giveaway_reason is not valid/);
    expect(validateReduction(giftBody({
      metadata: { [REDUCTION_QTY_KEY]: 2, [GIVEAWAY_REASON_KEY]: 'friend', [LOSS_REASON_KEY]: 'pest' },
    }))?.error).toMatch(/loss_reason is not valid/);
  });

  it('FORBIDS all three keys on every other event type', () => {
    // Unlike water_depth, which is an annotation and is deliberately tolerated everywhere, these
    // are ledger entries an aggregate sums. A loss_reason riding on a watering row is a loss
    // nobody recorded, decrementing nothing while still being counted.
    for (const [k, v] of [[REDUCTION_QTY_KEY, 3], [LOSS_REASON_KEY, 'pest'], [GIVEAWAY_REASON_KEY, 'friend']]) {
      const err = validateReduction({ event_type: 'watering', plant_id: PLANT_UUID, metadata: { [k]: v } });
      expect(err?.status, `${k} should be forbidden on watering`).toBe(400);
      expect(err.error).toMatch(new RegExp(`${k} is not valid on event_type=watering`));
    }
  });

  it('requires plant_id specifically, not merely "a parent"', () => {
    // validatePostBody's general rule is project_id OR plant_id. A project-scoped reduction would
    // insert an event and silently decrement nothing, behind a 201.
    const err = validateReduction({
      event_type: 'failed', project_id: PLANT_UUID,
      metadata: { [REDUCTION_QTY_KEY]: 3, [LOSS_REASON_KEY]: 'pest' },
    });
    expect(err?.status).toBe(400);
    expect(err.error).toMatch(/plant_id is required/);
  });

  it('is reached by validatePostBody, not merely exported', () => {
    // A validator nothing calls is the vacuity class this repo keeps paying for.
    expect(validatePostBody(failedBody())).toBeNull();
    expect(validatePostBody(failedBody({ metadata: { [LOSS_REASON_KEY]: 'pest' } }))?.status).toBe(400);
    expect(validatePostBody({
      event_type: 'watering', plant_id: PLANT_UUID, metadata: { [LOSS_REASON_KEY]: 'pest' },
    })?.status).toBe(400);
  });

  it('is reached by validateBatchBody on both the batch-level and per-plant metadata', () => {
    const scope = { type: 'all' };
    const base = { idempotency_key: 'k', event_type: 'watering', scope };
    expect(validateBatchBody(base)).toBeNull();
    expect(validateBatchBody({ ...base, metadata: { [LOSS_REASON_KEY]: 'pest' } })?.status).toBe(400);
    expect(validateBatchBody({
      ...base, plant_metadata: { [PLANT_UUID]: { [REDUCTION_QTY_KEY]: 3 } },
    })?.status).toBe(400);
    // And the types themselves are refused by the allowlist, one layer earlier.
    for (const t of PLANT_REDUCTION_EVENT_TYPES) {
      expect(validateBatchBody({ ...base, event_type: t })?.status, t).toBe(400);
    }
  });
});

describe('orderEndStatusOffer — the ending is RANKED, never assumed (Dave 2026-08-18)', () => {
  it('never returns fewer or other than the three real end statuses', () => {
    // All three are members of chk_plants_status; the offer must never propose a status the
    // plants PUT would 23514 on.
    for (const c of [{ harvested: 5 }, { lost: 5 }, { given_away: 5 }, {}]) {
      expect([...orderEndStatusOffer(c)].sort()).toEqual(['ended', 'failed', 'harvested']);
    }
  });

  it('mostly harvested → a good ending is offered first, NOT failed', () => {
    // The error this exists to prevent: a planting that completed its arc and was harvested out
    // reaches zero exactly like one that died, and calling that a failure mislabels a good season.
    expect(orderEndStatusOffer({ harvested: 8, lost: 1, given_away: 1 })[0]).toBe('harvested');
  });

  it('mostly failed → failed first', () => {
    expect(orderEndStatusOffer({ harvested: 1, lost: 8, given_away: 1 })[0]).toBe('failed');
  });

  it('mostly given away → ended first, and failed last', () => {
    const o = orderEndStatusOffer({ harvested: 1, lost: 1, given_away: 8 });
    expect(o[0]).toBe('ended');
    expect(o[2]).toBe('failed');
  });

  it('a MIX still ranks by composition rather than by which event hit zero', () => {
    // Dave's own example: harvested 5, pest took 3, gave away 2 — the reduction that emptied it
    // was a give-away, and the offer still leads with the harvest.
    expect(orderEndStatusOffer({ harvested: 5, lost: 3, given_away: 2 })[0]).toBe('harvested');
  });

  it('TIES never promote failed', () => {
    // A wrong "failed" is the costly error; a wrong "harvested" is a shrug and one tap.
    expect(orderEndStatusOffer({ harvested: 4, lost: 4, given_away: 0 })[0]).toBe('harvested');
    expect(orderEndStatusOffer({ harvested: 0, lost: 4, given_away: 4 })[0]).toBe('ended');
    expect(orderEndStatusOffer({ harvested: 0, lost: 0, given_away: 0 })[0]).toBe('harvested');
  });

  it('tolerates missing/NULL totals without inventing a failure', () => {
    expect(orderEndStatusOffer(undefined)[0]).toBe('harvested');
    expect(orderEndStatusOffer({ harvested: null, lost: null, given_away: null })[0]).toBe('harvested');
  });
});

describe('readReductionPlan — what index.js binds', () => {
  it('splits the quantity from the qty_lost accrual', () => {
    expect(readReductionPlan(failedBody())).toEqual({ qty: 3, lostAccrual: 3, reason: 'pest' });
    expect(readReductionPlan(giftBody())).toEqual({ qty: 2, lostAccrual: 0, reason: 'friend' });
  });

  it('returns null for every non-reduction type, so the SQL stays no-op-by-predicate', () => {
    expect(readReductionPlan({ event_type: 'watering', metadata: { [REDUCTION_QTY_KEY]: 9 } })).toBeNull();
    expect(readReductionPlan({ event_type: 'harvest' })).toBeNull();
  });
});

describe('the shipped statements — structure the arithmetic proof depends on', () => {
  it('THE REDUCTION UPDATE NEVER TOUCHES status', () => {
    // Dave, explicitly: this is NOT a state change setting the planting to failed. The planting is
    // alive and healthy, just smaller. Every OTHER plant-mutating statement in this transaction is
    // a status advance, so an author copying the nearest neighbour would add one.
    expect(REDUCE_SQL).not.toMatch(/\bstatus\b/);
    expect(UNDO_SQL).not.toMatch(/\bstatus\b/);
  });

  it('moves quantity, qty_current and qty_lost, and nothing else', () => {
    const assigned = [...REDUCE_SQL.matchAll(/^\s*(?:SET\s+)?([a-z_]+)\s*=/gm)].map((m) => m[1]);
    expect([...new Set(assigned)].sort()).toEqual(['qty_current', 'qty_lost', 'quantity', 'updated_at']);
  });

  it('accrues qty_lost from a SEPARATE bind from the quantity decrement', () => {
    // The whole give-away/loss distinction lives in that second bind. One shared bind would make
    // every gift a loss at the counter even though the ledger row said otherwise.
    expect(REDUCE_SQL).toMatch(/quantity\s*=\s*GREATEST\(p\.quantity - \$\{reductionQty\}/);
    expect(REDUCE_SQL).toMatch(/qty_lost\s*=\s*COALESCE\(p\.qty_lost, 0\) \+ \$\{reductionLost\}/);
  });

  it('is gated on the reduction event types, so it no-ops for the other 49', () => {
    expect(REDUCE_SQL).toMatch(/\$\{eventType\}::text = ANY\(\$\{PLANT_REDUCTION_EVENT_TYPES\}\)/);
  });

  it('scopes ownership with the TWO-ARM predicate (container-less plantings included)', () => {
    // garden_node has no RLS (L-087), and an inner join silently drops the 4 live container-less
    // plantings — BUG-STATUSADVNOPROJ-001, already paid for once by the three status advances.
    for (const sql of [REDUCE_SQL, UNDO_SQL]) {
      expect(sql).toMatch(/EXISTS \(SELECT 1 FROM public\.container pp/);
      expect(sql).toMatch(/p\.container_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)/);
      expect(sql).toMatch(/p\.deleted_at IS NULL/);
    }
  });

  it('the DELETE arm reverses the counter, keyed off the STORED row', () => {
    // A delete carries no body; the event row is the only record of what was applied. Without
    // this, deleting a "lost 3" leaves the planting three short with nothing saying why — silent,
    // permanent loss, and this is the schema's first accumulating writer so there was no
    // precedent to inherit.
    expect(INDEX_SRC).toMatch(/readReductionPlan\(\{\s*\n?\s*event_type: owned\[0\]\.event_type, metadata: owned\[0\]\.metadata,/);
    expect(UNDO_SQL).toMatch(/quantity\s*=\s*p\.quantity \+ \$\{undoQty\}/);
    expect(UNDO_SQL).toMatch(/qty_lost\s*=\s*GREATEST\(COALESCE\(p\.qty_lost, 0\) - \$\{undoLost\}/);
    expect(UNDO_SQL).toMatch(/WHERE \$\{undoQty\}::int > 0/);
  });

  it('the DELETE pre-read actually selects metadata (the reversal is unreadable without it)', () => {
    const owned = INDEX_SRC.slice(INDEX_SRC.indexOf("SELECT el.id, el.project_id, el.event_type, el.plant_id"));
    expect(owned.slice(0, 400)).toMatch(/el\.metadata/);
  });

  it('refuses an OVER-reduction (more than remain) rather than clamping it', () => {
    // "I lost 6" against 5 remaining is not a smaller loss. A clamp would satisfy the arithmetic
    // while discarding the claim, and the row it wrote would be indistinguishable from a correct
    // one afterwards.
    expect(INDEX_SRC).toMatch(/code: 'REDUCTION_EXCEEDS_REMAINING'/);
    expect(INDEX_SRC).toMatch(/if \(reduction\.qty > available\) \{/);
  });

  it('a to-zero reduction is RECORDED and only OFFERS an ending — it never applies one', () => {
    // Dave's ruling 2026-08-18. Refusing instead would lose the record of WHY the last plants
    // went, which is the whole requirement. So the ledger row is always written, the response
    // carries a RANKED offer, and no code path here writes status (asserted above against the
    // shipped SQL).
    expect(INDEX_SRC).toMatch(/plant_reduction: reductionOffer,/);
    expect(INDEX_SRC).toMatch(/offer_end_status: orderEndStatusOffer\(composition\)/);
    expect(INDEX_SRC).toMatch(/if \(reduction\.qty === available\) \{/);
    // The offer is composed from real totals, not from the fact that zero was reached.
    expect(INDEX_SRC).toMatch(/COALESCE\(qty_harvested, 0\)::int AS harvested/);
    expect(INDEX_SRC).toMatch(/el\.event_type = 'given_away'/);
  });

  it('qty_current may reach 0 while quantity floors at 1 — the schema forces the divergence', () => {
    // chk_plants_quantity (quantity >= 1) is VALIDATED on live prod, so `quantity` physically
    // cannot express an empty planting; qty_current has no CHECK and can. The pair
    // `quantity = 1 AND qty_current = 0` IS the empty signal until the offered ending is applied.
    expect(REDUCE_SQL).toMatch(/quantity\s*=\s*GREATEST\(p\.quantity - \$\{reductionQty\}::int, 1\)/);
    expect(REDUCE_SQL).toMatch(/qty_current\s*=\s*GREATEST\(p\.quantity::int - \$\{reductionQty\}::int, 0\)/);
  });

  it('the PUT refuses to edit a reduction event rather than desynchronise the counter', () => {
    expect(INDEX_SRC).toMatch(/code: 'REDUCTION_EVENT_IMMUTABLE'/);
    expect(INDEX_SRC).toMatch(/const wasReduction = PLANT_REDUCTION_EVENT_TYPES\.includes\(existing\.event_type\)/);
    expect(INDEX_SRC).toMatch(/const willBeReduction = PLANT_REDUCTION_EVENT_TYPES\.includes\(body\.event_type\)/);
  });
});
