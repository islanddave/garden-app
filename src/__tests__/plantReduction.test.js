// V4-LOSSUI-001 — the pure client half of the plant-reduction contract.
//
// These are unit assertions on lib/plantReduction.js. They are NOT the proof that the panel works —
// that is EventNew.reduction.test.jsx, which mounts the real form and reads the body that actually
// reached POST /api/events. Both exist because they fail differently: this file catches a broken
// rule, that one catches a rule nobody wired up.
import { describe, it, expect } from 'vitest';
import {
  validateReductionInput,
  buildReductionMetadata,
  reductionReasonsFor,
  REDUCTION_QTY_ERROR,
} from '../lib/plantReduction.js';
import {
  LOSS_REASONS, GIVEAWAY_REASONS, PLANT_REDUCTION_EVENT_TYPES,
  REDUCTION_QTY_KEY, LOSS_REASON_KEY, GIVEAWAY_REASON_KEY,
  REDUCTION_REASON_LABELS, REDUCTION_REASON_HINTS, reductionReasonLabel,
  LOSS_EVENT_TYPE as LOSS, GIVEAWAY_EVENT_TYPE as GIFT, LEGACY_EVENT_TYPE_ALIASES,
} from '../lib/eventTypes.js';

describe('reductionReasonsFor — the chip row reads the SHIPPED vocabulary, never a copy', () => {
  it('a loss gets LOSS_REASONS and a gift gets GIVEAWAY_REASONS, by identity', () => {
    // toBe, not toEqual: a local copy that happened to hold the same seven strings would pass a
    // deep-equality check and then silently drift the first time the canonical list moved. Identity
    // is what makes "never hardcode a copy" a testable claim rather than a comment.
    expect(reductionReasonsFor(LOSS)).toBe(LOSS_REASONS);
    expect(reductionReasonsFor(GIFT)).toBe(GIVEAWAY_REASONS);
  });

  it('every other event type gets an empty list, so the panel cannot render for one', () => {
    for (const t of ['watering', 'harvest', 'observation', 'pest_treatment', '', undefined]) {
      expect(reductionReasonsFor(t), String(t)).toEqual([]);
    }
  });
});

describe('validateReductionInput — quantity is REQUIRED', () => {
  it('refuses empty, whitespace, zero, negative, fractional and non-numeric', () => {
    // Losing one pepper and losing nineteen must stay distinguishable — that is the whole reason
    // the server made this required, and a client that lets a blank through just moves the 400.
    for (const qty of ['', '   ', '0', '-1', '2.5', 'three', 'e', null, undefined]) {
      expect(validateReductionInput(LOSS, { qty, reason: 'pest' }), `qty ${JSON.stringify(qty)}`)
        .toBe(REDUCTION_QTY_ERROR);
    }
  });

  it('accepts 1 and up, and tolerates the surrounding whitespace a paste leaves behind', () => {
    for (const qty of ['1', '3', ' 7 ', '19', '10000']) {
      expect(validateReductionInput(LOSS, { qty, reason: 'pest' }), `qty ${qty}`).toBeNull();
    }
  });
});

describe('validateReductionInput — a reason from the RIGHT vocabulary is REQUIRED', () => {
  it('refuses a missing reason on both types', () => {
    expect(validateReductionInput(LOSS, { qty: '3' })).toBe('Pick what happened to them.');
    expect(validateReductionInput(GIFT, { qty: '3' })).toBe('Pick where they went.');
  });

  it('refuses the OTHER vocabulary — the separation the storage layer enforces, enforced here too', () => {
    // 'friend' is a real value, just not on a loss. Accepting it client-side would produce a body
    // the server 400s on with a message the form cannot place.
    expect(validateReductionInput(LOSS, { qty: '3', reason: 'friend' })).toBeTruthy();
    expect(validateReductionInput(GIFT, { qty: '3', reason: 'pest' })).toBeTruthy();
  });

  it('accepts every value in each type\'s own vocabulary — including the three Dave just approved', () => {
    for (const r of LOSS_REASONS) {
      expect(validateReductionInput(LOSS, { qty: '2', reason: r }), r).toBeNull();
    }
    for (const r of GIVEAWAY_REASONS) {
      expect(validateReductionInput(GIFT, { qty: '2', reason: r }), r).toBeNull();
    }
    for (const r of ['sold', 'traded', 'community']) {
      expect(validateReductionInput(GIFT, { qty: '1', reason: r }), r).toBeNull();
    }
  });

  it('is inert for every non-reduction type — the panel does not exist there to satisfy', () => {
    expect(validateReductionInput('watering', {})).toBeNull();
    expect(validateReductionInput('harvest', { qty: '', reason: '' })).toBeNull();
  });
});

describe('buildReductionMetadata — the wire shape', () => {
  it('writes qty_reduced as a NUMBER, because the server rejects the string "3"', () => {
    const meta = buildReductionMetadata(LOSS, { qty: '3', reason: 'pest' });
    expect(meta[REDUCTION_QTY_KEY]).toBe(3);
    expect(typeof meta[REDUCTION_QTY_KEY]).toBe('number');
    expect(meta[LOSS_REASON_KEY]).toBe('pest');
    // The other vocabulary's key is ABSENT, not null: validateReduction forbids it outright on the
    // wrong type, and `giveaway_reason: undefined` would survive JSON.stringify as absent anyway —
    // but a null would not, and that is the shape that would 400.
    expect(GIVEAWAY_REASON_KEY in meta).toBe(false);
  });

  it('writes giveaway_reason on a gift, and never loss_reason', () => {
    const meta = buildReductionMetadata(GIFT, { qty: '2', reason: 'community' });
    expect(meta).toEqual({ [REDUCTION_QTY_KEY]: 2, [GIVEAWAY_REASON_KEY]: 'community' });
    expect(LOSS_REASON_KEY in meta).toBe(false);
  });

  it('returns {} for every other type, so the caller can spread it unconditionally', () => {
    for (const t of ['watering', 'harvest', 'observation']) {
      expect(buildReductionMetadata(t, { qty: '5', reason: 'pest' }), t).toEqual({});
    }
  });
});

describe('the chip captions', () => {
  it('every value in BOTH vocabularies has a hand-written label', () => {
    // Walks the vocabularies rather than a hand-listed set, so adding a value without a label reds
    // here instead of shipping a chip that reads "transplant shock" in raw snake_case.
    for (const r of [...LOSS_REASONS, ...GIVEAWAY_REASONS]) {
      expect(REDUCTION_REASON_LABELS[r], `no label for ${r}`).toBeTruthy();
      expect(reductionReasonLabel(r)).toBe(REDUCTION_REASON_LABELS[r]);
    }
  });

  it('an unlabelled value still renders legibly rather than blank', () => {
    expect(reductionReasonLabel('some_new_reason')).toBe('some new reason');
  });

  it('both catch-alls carry the expansion neither chip has room for', () => {
    // Dave's ruling: 'community' is the broad non-friend option AND the floor, so it has to say so
    // somewhere. 'unknown' is the loss-side equivalent.
    expect(REDUCTION_REASON_HINTS.community).toBeTruthy();
    expect(REDUCTION_REASON_HINTS.unknown).toBeTruthy();
  });
});

describe('the two reduction types are the ones this module governs', () => {
  it('PLANT_REDUCTION_EVENT_TYPES is exactly reduction_lost + reduction_given_away (V5-LOSSTOKEN-001)', () => {
    expect([...PLANT_REDUCTION_EVENT_TYPES].sort()).toEqual(['reduction_given_away', 'reduction_lost']);
  });
});

// V5-LOSSTOKEN-001 — ADDED, not substituted. Until 2026-09-29 these types were stored as `failed` /
// `given_away`, and an EventNew draft stashed by an older bundle, or a saved ?event_type= link, can
// still hand this module the old spelling. Every function must answer for it exactly as for the new
// token; before the alias, a restored `failed` draft rendered no panel, built {} and 400'd.
describe('the legacy spellings behave exactly like their canonical tokens', () => {
  const input = { qty: '3', reason: 'pest' };
  const gift = { qty: '2', reason: 'friend' };
  it('covers both aliases (non-vacuity)', () => {
    expect(Object.keys(LEGACY_EVENT_TYPE_ALIASES).sort()).toEqual(['failed', 'given_away']);
  });
  for (const [legacy, canonical] of Object.entries(LEGACY_EVENT_TYPE_ALIASES)) {
    it(`${legacy} === ${canonical}`, () => {
      expect(reductionReasonsFor(legacy)).toBe(reductionReasonsFor(canonical));
      expect(reductionReasonsFor(legacy).length).toBeGreaterThan(0);
      const body = canonical === LOSS ? input : gift;
      expect(validateReductionInput(legacy, body)).toBe(validateReductionInput(canonical, body));
      expect(validateReductionInput(legacy, { qty: '3' })).toBe(validateReductionInput(canonical, { qty: '3' }));
      expect(buildReductionMetadata(legacy, body)).toEqual(buildReductionMetadata(canonical, body));
      expect(Object.keys(buildReductionMetadata(legacy, body)).length).toBe(2);
    });
  }
});
