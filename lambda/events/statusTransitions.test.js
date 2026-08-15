// V3-FRUITSET-001 — forward-only fruit_set -> fruiting transition guard.
// Pure unit tests over the single source of truth. The authoritative enforcement is the
// DB UPDATE in index.js (status = ANY(FRUITING_SOURCE_STATUSES) + explicit household scope);
// a Neon copy-on-write runtime dry-run proves that path separately (mock-sql blindspot, L-104).
import { describe, it, expect } from 'vitest';
import {
  FRUITING_SOURCE_STATUSES, advancesToFruiting, FLOWERING_SOURCE_STATUSES, advancesToFlowering,
  HARVESTED_SOURCE_STATUSES, HARVESTED_EVENT_TYPES, advancesToHarvested,
} from './statusTransitions.js';

describe('FRUITING_SOURCE_STATUSES', () => {
  it('includes only pre-fruiting growth stages', () => {
    expect(FRUITING_SOURCE_STATUSES).toEqual(['seed', 'rooting', 'seedling', 'vegetative', 'flowering']);
  });
  it('excludes terminal / past / current states (no backward or re-transition)', () => {
    for (const s of ['fruiting', 'harvested', 'dormant', 'failed', 'ended']) {
      expect(FRUITING_SOURCE_STATUSES.includes(s)).toBe(false);
    }
  });
});

describe('advancesToFruiting', () => {
  it('advances from each pre-fruiting stage on a fruit_set event', () => {
    for (const s of FRUITING_SOURCE_STATUSES) {
      expect(advancesToFruiting('fruit_set', s)).toBe(true);
    }
  });
  it('does not advance on non-fruit_set events', () => {
    expect(advancesToFruiting('watering', 'flowering')).toBe(false);
    expect(advancesToFruiting('harvest', 'vegetative')).toBe(false);
  });
  it('does not advance from terminal/current statuses', () => {
    expect(advancesToFruiting('fruit_set', 'fruiting')).toBe(false);
    expect(advancesToFruiting('fruit_set', 'harvested')).toBe(false);
    expect(advancesToFruiting('fruit_set', null)).toBe(false);
  });
});

describe('FLOWERING_SOURCE_STATUSES', () => {
  it('includes only pre-flowering growth stages', () => {
    expect(FLOWERING_SOURCE_STATUSES).toEqual(['seed', 'rooting', 'seedling', 'vegetative']);
  });
  it('excludes flowering itself and every later/terminal state (forward-only)', () => {
    for (const s of ['flowering', 'fruiting', 'harvested', 'dormant', 'failed', 'ended']) {
      expect(FLOWERING_SOURCE_STATUSES.includes(s)).toBe(false);
    }
  });
});

describe('advancesToFlowering', () => {
  it('advances from each pre-flowering stage on a flowering event', () => {
    for (const s of FLOWERING_SOURCE_STATUSES) {
      expect(advancesToFlowering('flowering', s)).toBe(true);
    }
  });
  it('does not advance on non-flowering events', () => {
    expect(advancesToFlowering('watering', 'vegetative')).toBe(false);
    expect(advancesToFlowering('fruit_set', 'vegetative')).toBe(false);
  });
  it('does not advance from flowering/terminal statuses (no backward or re-transition)', () => {
    expect(advancesToFlowering('flowering', 'flowering')).toBe(false);
    expect(advancesToFlowering('flowering', 'fruiting')).toBe(false);
    expect(advancesToFlowering('flowering', 'harvested')).toBe(false);
    expect(advancesToFlowering('flowering', null)).toBe(false);
  });
});

// ── V4-HARVSTATUS-001 (BD-020) ───────────────────────────────────────────────────────────────────
// The third instance of the forward-only pattern. Dave's ruling, verbatim (2026-08-14): "ended +
// dormant NEVER advance. Sources = seed, rooting, seedling, vegetative, flowering, fruiting."
describe('HARVESTED_SOURCE_STATUSES', () => {
  it('is exactly the six statuses Dave ruled, in order', () => {
    expect(HARVESTED_SOURCE_STATUSES).toEqual([
      'seed', 'rooting', 'seedling', 'vegetative', 'flowering', 'fruiting',
    ]);
  });

  // The named exclusions. `ended` and `dormant` are Dave's explicit ruling; `failed` is absent from
  // his list and excluded for the same reason the two older guards exclude it — a planting recorded
  // as failed is a record, and a stray harvest must not quietly overwrite it. `harvested` is
  // excluded so re-logging is idempotent.
  it('never advances from a terminal state, a failure, or itself', () => {
    for (const s of ['ended', 'dormant', 'failed', 'harvested', null, undefined, '']) {
      expect(HARVESTED_SOURCE_STATUSES.includes(s), `status ${String(s)}`).toBe(false);
    }
  });

  // Unlike the two guards above, this one INCLUDES fruiting — harvested is the state after
  // fruiting, so advancing from there is the entire point rather than an oversight.
  it('includes fruiting, unlike the flowering and fruit_set guards', () => {
    expect(HARVESTED_SOURCE_STATUSES).toContain('fruiting');
    expect(FLOWERING_SOURCE_STATUSES).not.toContain('fruiting');
    expect(FRUITING_SOURCE_STATUSES).not.toContain('fruiting');
  });
});

describe('advancesToHarvested', () => {
  it('advances from every ruled source status, on BOTH harvest event types', () => {
    for (const type of HARVESTED_EVENT_TYPES) {
      for (const s of HARVESTED_SOURCE_STATUSES) {
        expect(advancesToHarvested(type, s), `${type} from ${s}`).toBe(true);
      }
    }
  });

  // first_harvest is a MILESTONE carrying no quantity and never has a harvest_log row, but it is
  // still Dave recording that he picked something — the same pairing entity_memory's
  // last_harvested_at already uses. Omitting it would leave a planting he had demonstrably picked
  // sitting at 'fruiting'.
  it('covers first_harvest, not just harvest', () => {
    expect(HARVESTED_EVENT_TYPES).toEqual(['harvest', 'first_harvest']);
    expect(advancesToHarvested('first_harvest', 'fruiting')).toBe(true);
  });

  it('does not advance on non-harvest events', () => {
    expect(advancesToHarvested('watering', 'fruiting')).toBe(false);
    expect(advancesToHarvested('fruit_set', 'fruiting')).toBe(false);
    expect(advancesToHarvested('flowering', 'vegetative')).toBe(false);
  });

  it('does not advance from harvested/terminal statuses (idempotent, forward-only)', () => {
    expect(advancesToHarvested('harvest', 'harvested')).toBe(false);
    expect(advancesToHarvested('harvest', 'ended')).toBe(false);
    expect(advancesToHarvested('harvest', 'dormant')).toBe(false);
    expect(advancesToHarvested('harvest', 'failed')).toBe(false);
    expect(advancesToHarvested('harvest', null)).toBe(false);
  });
});
