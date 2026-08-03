// V4-HARVDUAL-001 Slice A — optional measured weight alongside the count. DB-free, pure.
// Exercised through validateHarvestFields (shared by create AND edit, per BUG-HARVESTEDIT-001) so a
// rule can never apply to only one write path.
import { describe, it, expect } from 'vitest';
import {
  validateHarvestFields, validatePostBody, toGrams,
  WEIGHT_UNITS, WEIGHT_UNIT_GRAMS, MAX_PLAUSIBLE_WEIGHT_G,
} from './validators.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const h = (over = {}) => ({ quantity: 5, unit: 'count', ...over });
const ok = (over) => expect(validateHarvestFields(h(over))).toBeNull();
const bad = (over, re) => {
  const r = validateHarvestFields(h(over));
  expect(r).not.toBeNull();
  expect(r.status).toBe(400);
  if (re) expect(r.error).toMatch(re);
};

describe('toGrams', () => {
  it('defaults to grams when no unit is given', () => expect(toGrams(337)).toBe(337));
  it('converts each supported scale unit', () => {
    expect(toGrams(1, 'g')).toBe(1);
    expect(toGrams(1, 'kg')).toBe(1000);
    expect(toGrams(1, 'lb')).toBeCloseTo(453.592, 3);
    expect(toGrams(1, 'oz')).toBeCloseTo(28.3495, 4);
  });
  it('has a factor for every advertised weight unit', () => {
    for (const u of WEIGHT_UNITS) expect(WEIGHT_UNIT_GRAMS[u]).toBeGreaterThan(0);
  });
});

describe('validateHarvestFields — weight is optional and additive', () => {
  it('still accepts a count-only harvest (the fast path is unchanged)', () => ok());
  it('accepts count plus a weight', () => ok({ weight: 337 }));
  it('accepts count plus a weight in scale units', () => {
    ok({ weight: 11.9, weight_unit: 'oz' });
    ok({ weight: 0.75, weight_unit: 'lb' });
  });
  it('accepts an explicit null weight (the user clearing their measurement)', () => ok({ weight: null }));
});

describe('validateHarvestFields — weight rejections', () => {
  it('rejects a non-positive or non-finite weight', () => {
    bad({ weight: 0 }, /positive finite/);
    bad({ weight: -5 }, /positive finite/);
    bad({ weight: Number.NaN }, /positive finite/);
    bad({ weight: Number.POSITIVE_INFINITY }, /positive finite/);
    bad({ weight: '337' }, /positive finite/);
  });
  it('rejects a weight unit outside the scale vocabulary', () => {
    bad({ weight: 337, weight_unit: 'count' }, /g, kg, lb, or oz/);
    bad({ weight: 337, weight_unit: 'cup' }, /g, kg, lb, or oz/);
    bad({ weight: 337, weight_unit: 'stone' }, /g, kg, lb, or oz/);
  });
  it('validates the weight unit even when no weight accompanies it', () => {
    bad({ weight_unit: 'cup' }, /g, kg, lb, or oz/);
  });
  it('rejects an implausible weight, after unit conversion', () => {
    bad({ weight: MAX_PLAUSIBLE_WEIGHT_G + 1 }, /exceeds max/);
    // 200 lb = 90 718 g — over the cap only once converted, which is the point of converting first
    bad({ weight: 200, weight_unit: 'lb' }, /exceeds max/);
    ok({ weight: 100, weight_unit: 'lb' }); // 45 359 g, just under
  });
  it('keeps the weight cap independent of the quantity cap', () => {
    // a harvest LOGGED in grams may legitimately be large (MAX_PLAUSIBLE.g = 500000); a hand-weighed
    // bowl may not. The two caps govern different things and must not be conflated.
    expect(MAX_PLAUSIBLE_WEIGHT_G).toBeLessThan(500000);
  });
});

describe('validatePostBody — weight flows through the create path', () => {
  const base = (harvest) => ({ event_type: 'harvest', project_id: UUID, harvest });
  it('accepts a dual count+weight harvest', () => {
    expect(validatePostBody(base(h({ weight: 337 })))).toBeNull();
  });
  it('rejects a bad weight on the create path too', () => {
    const r = validatePostBody(base(h({ weight: -1 })));
    expect(r?.status).toBe(400);
  });
  it('still forbids harvest fields on a non-harvest event', () => {
    const r = validatePostBody({ event_type: 'watering', project_id: UUID, harvest: h({ weight: 337 }) });
    expect(r?.status).toBe(400);
    expect(r.error).toMatch(/only valid on event_type=harvest/);
  });
});

describe('client/server constant parity', () => {
  it('src/lib/harvest-constants.js mirrors the server weight vocabulary', async () => {
    // the client mirror carries an explicit "update both in the same commit" contract; drift here
    // means the UI would accept a weight the API rejects
    const client = await import('../../src/lib/harvest-constants.js');
    expect(client.WEIGHT_UNITS).toEqual(WEIGHT_UNITS);
    expect(client.WEIGHT_UNIT_GRAMS).toEqual(WEIGHT_UNIT_GRAMS);
    expect(client.MAX_PLAUSIBLE_WEIGHT_G).toBe(MAX_PLAUSIBLE_WEIGHT_G);
    expect(client.toGrams(1, 'lb')).toBe(toGrams(1, 'lb'));
  });
});
