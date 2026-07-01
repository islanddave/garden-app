// V3-FRUITSET-001 — forward-only fruit_set -> fruiting transition guard.
// Pure unit tests over the single source of truth. The authoritative enforcement is the
// DB UPDATE in index.js (status = ANY(FRUITING_SOURCE_STATUSES) + explicit household scope);
// a Neon copy-on-write runtime dry-run proves that path separately (mock-sql blindspot, L-104).
import { describe, it, expect } from 'vitest';
import { FRUITING_SOURCE_STATUSES, advancesToFruiting, FLOWERING_SOURCE_STATUSES, advancesToFlowering } from './statusTransitions.js';

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
