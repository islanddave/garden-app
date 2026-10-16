// BUG-LAMBDAVALIDATION-001 (I25) — days_to_maturity_min/max are non-negative integers or null.
//
// Before this, DTM had only the ordering check, and only when BOTH keys were sent, so -5 or 2.5 went
// straight to the column. VarietyEditor PUTs changed fields only, so a one-sided value is the normal
// case and is the one that matters here. A one-sided min above the STORED max is still not caught:
// the PUT reads the stored row only for breeding patches, so that case is left to a NOT VALID CHECK
// follow-up (the convention for the scoville, weeks and germ pairs), not added as a new read here.
import { describe, it, expect } from 'vitest';
import { validateBody } from './validate.js';

describe('validateBody — days_to_maturity_* (I25)', () => {
  for (const k of ['days_to_maturity_min', 'days_to_maturity_max']) {
    it(`${k}: a negative value alone is refused`, () => {
      expect(validateBody({ [k]: -5 }, { requireName: false })).toBe(`${k} must be a non-negative integer or null`);
    });
    it(`${k}: a fraction alone is refused`, () => {
      expect(validateBody({ [k]: 2.5 }, { requireName: false })).toBe(`${k} must be a non-negative integer or null`);
    });
    it(`${k}: a non-numeric string is refused`, () => {
      expect(validateBody({ [k]: 'soon' }, { requireName: false })).toBe(`${k} must be a non-negative integer or null`);
    });
    it(`${k}: 0, a positive integer, a numeric string and null pass`, () => {
      expect(validateBody({ [k]: 0 }, { requireName: false })).toBeNull();
      expect(validateBody({ [k]: 61 }, { requireName: false })).toBeNull();
      expect(validateBody({ [k]: '83' }, { requireName: false })).toBeNull();
      expect(validateBody({ [k]: null }, { requireName: false })).toBeNull();
    });
  }

  it('the existing both-sent ordering check is unchanged', () => {
    expect(validateBody({ days_to_maturity_min: 90, days_to_maturity_max: 60 }, { requireName: false }))
      .toBe('days_to_maturity_min must be <= days_to_maturity_max');
    expect(validateBody({ days_to_maturity_min: 61, days_to_maturity_max: 83 }, { requireName: false })).toBeNull();
  });
});
