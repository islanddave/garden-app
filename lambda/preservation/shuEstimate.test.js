// Release F — the golden table (06-ferment-path §5.3), pinned. Every row here is a card of Dave's or the
// plan's worked example; a value that moves means the arithmetic changed, and the §5.4 mutation arms
// ("return a partial sum", "return 0", "drop the chili-word match", "divide by one sitting's Made",
// "convert vinegar ml", "helper default 'peppers'") each turn a named test below red.
import { describe, it, expect } from 'vitest';
import {
  estimateShu, contributions, isHeatLine, lineGrams, halfUp, isStale, DRIED_FACTOR,
} from './shuEstimate.js';
import { saltBase, saltGrams, actualPct, oneDecimal } from './saltMath.js';
import { gramsOf, KITCHEN_SALT_BASES } from './kitchenBatch.js';

let n = 0;
const line = (label, qty, qty_unit, over = {}) => ({ id: `l${++n}`, label, qty, qty_unit, role: null, put_up_stage_id: null, output_id: null, ...over });
const water = (qty, unit = 'ml') => line('Water', qty, unit, { role: 'water' });
const salt = (qty) => line('salt', qty, 'g', { role: 'salt' });
const rated = (low, high) => ({ variety_rating: { low, high } });

// ── Petri Dish ────────────────────────────────────────────────────────────────────────────────────
const petri = () => [
  line('jalapeño', 170, 'g', rated(2500, 8000)), line('garlic', 8, 'g'), line('onion', 20, 'g'), water(250),
];

describe('Petri Dish', () => {
  it('forward: 3.5% of Veg + water → base 448, salt 15.68 stored, "15.7 g"', () => {
    const b = saltBase(petri(), 'all');
    expect(b.grams).toBe(448);
    expect(saltGrams(3.5, b.grams)).toBeCloseTo(15.68, 10);
    expect(oneDecimal(saltGrams(3.5, b.grams))).toBe('15.7');
  });
  it('card: aimed 3.5%, grams edited to 13.5 → "3.0% of 448 g"', () => {
    expect(oneDecimal(actualPct(13.5, 448))).toBe('3.0');
  });
  it('SHU jar-now: 948.7→949 / 3035.7→3036', () => {
    const r = estimateShu({ scope: 'batch', lines: petri() });
    expect(r).toMatchObject({ low: 949, high: 3036, denominator_g: 448, denominator_source: 'lines' });
  });
  it('SHU bottled: Made 256 g, one sitting → 1660 / 5313', () => {
    const r = estimateShu({ scope: 'sitting', lines: petri(), sittings: [{ id: 'S', made_g: 256 }], sitting_id: 'S' });
    expect(r).toMatchObject({ low: 1660, high: 5313, denominator_g: 256, denominator_source: 'made' });
    expect(r).not.toHaveProperty('exact_low');
  });
  it('a typed "About 448 g" is the denominator; an About in cups is ignored', () => {
    expect(estimateShu({ scope: 'batch', lines: petri(), about: { amount: 500, amount_unit: 'g' } }))
      .toMatchObject({ low: halfUp(170 * 2500 / 500), denominator_source: 'about' });
    expect(estimateShu({ scope: 'batch', lines: petri(), about: { amount: 2, amount_unit: 'cup' } }))
      .toMatchObject({ low: 949, denominator_source: 'lines', about_ignored: true });
  });
});

// ── Settlers ──────────────────────────────────────────────────────────────────────────────────────
const settlers = () => [line('Ristra Cayenne', 150, 'g', rated(24200, 34800)), line('sugar', 2, 'g'), salt(4.5)];

describe('Settlers', () => {
  it('salt: Veg only includes the sugar → base 152; 3% → 4.56 g; the card\'s 4.5 g reads 3.0% (2.96)', () => {
    const b = saltBase(settlers(), 'produce');
    expect(b.grams).toBe(152);
    expect(saltGrams(3, 152)).toBeCloseTo(4.56, 10);
    expect(actualPct(4.5, 152)).toBeCloseTo(2.9605, 3);
    expect(oneDecimal(actualPct(4.5, 152))).toBe('3.0');
  });
  it('SHU: Made 227 g → 15,991 / 22,996', () => {
    expect(estimateShu({ scope: 'sitting', lines: settlers(), sittings: [{ id: 'S', made_g: 227 }], sitting_id: 'S' }))
      .toMatchObject({ low: 15991, high: 22996 });
  });
  // Mutation arm: "divide by one sitting's Made" / drop the share.
  it('multi-sitting: mash_in_g 100 / 50 splits the batch 2/3 and 1/3; a missing mash_in_g refuses', () => {
    const sittings = [{ id: 'A', made_g: 227, mash_in_g: 100 }, { id: 'B', made_g: 227, mash_in_g: 50 }];
    const a = estimateShu({ scope: 'sitting', lines: settlers(), sittings, sitting_id: 'A' });
    const b = estimateShu({ scope: 'sitting', lines: settlers(), sittings, sitting_id: 'B' });
    expect(a.low).toBe(halfUp(150 * 24200 * (2 / 3) / 227));
    expect(b.low).toBe(halfUp(150 * 24200 * (1 / 3) / 227));
    expect(a.share).toBeCloseTo(2 / 3, 10);
    expect(estimateShu({ scope: 'sitting', lines: settlers(), sittings: [{ ...sittings[0] }, { id: 'B', made_g: 200, mash_in_g: null }], sitting_id: 'A' }))
      .toEqual({ refusal: 'mash_in_missing' });
  });
});

describe('Kraut', () => {
  it('cabbage 1,000 g, Dry, 2% of Veg only → 20.0 g', () => {
    const b = saltBase([line('cabbage', 1000, 'g')], 'produce');
    expect(oneDecimal(saltGrams(2, b.grams))).toBe('20.0');
  });
});

// ── Kimchi ────────────────────────────────────────────────────────────────────────────────────────
const kimchi = (gochu = {}) => [
  line('napa', 1500, 'g'), line('radish', 300, 'g'), line('gochugaru', 40, 'g', { form: 'dried', ...gochu }),
  line('garlic', 20, 'g'), line('ginger', 10, 'g'), line('fish sauce', 30, 'ml'),
];

describe('Kimchi', () => {
  it('paste 1% of Veg only → base 1,870 → 18.7 g; fish sauce is "no weight"; no water line exists', () => {
    const b = saltBase(kimchi(), 'produce');
    expect(b.grams).toBe(1870);
    expect(b.no_weight).toEqual(['fish sauce']);
    expect(oneDecimal(saltGrams(1, b.grams))).toBe('18.7');
  });
  it('the soak: rinsed 10% of 2,000 g typed → 200 g, and the soak is in no base', () => {
    expect(saltGrams(10, 2000)).toBe(200);
    expect(saltBase(kimchi(), 'all').grams).toBe(1870);
  });
  // Mutation arms: "drop the chili-word match" (gochugaru stops being a heat line → no_heat_lines),
  // "return a partial sum" / "return 0" (a figure appears).
  it('SHU refuses "gochugaru — no listed heat" when it has no rating; never 0', () => {
    const r = estimateShu({ scope: 'batch', lines: kimchi() });
    expect(r.refusal).toBe('cannot_work_it_out');
    expect(r.missing).toEqual([{ line_id: expect.any(String), label: 'gochugaru', why: 'no_rating' }]);
    expect(r).not.toHaveProperty('low');
  });
  it('with a typed rating it is a figure, the typed FRESH rating counted ×7–×10 as dried (Dave 17:1x)', () => {
    const r = estimateShu({ scope: 'batch', lines: kimchi({ shu_rating_low: 4000, shu_rating_high: 8000 }) });
    expect(r.breakdown).toEqual([expect.objectContaining({
      label: 'gochugaru', factor_low: DRIED_FACTOR.low, factor_high: DRIED_FACTOR.high,
      rating_low: 4000, rating_high: 8000, rating_source: 'typed',
    })]);
    expect(r.low).toBe(halfUp(40 * 7 * 4000 / 1870));
    expect(r.high).toBe(halfUp(40 * 10 * 8000 / 1870));
  });
});

// ── Appendix C (F-era) ────────────────────────────────────────────────────────────────────────────
describe('Appendix C', () => {
  const S = 'S1';
  const J1 = 'J1';
  const J2 = 'J2';
  const lines = () => [
    line('megatron', 412, 'g', rated(2500, 8000)), line('serrano', 230, 'g', rated(10000, 23000)),
    line('reaper', 8, 'g', { input_kind: 'put_up', form: 'frozen', ...rated(1400000, 2200000) }),
    line('carrots', 150, 'g', { input_kind: 'put_up', draw: { count_drawn: 1 } }),
    line('onion', null, null), line('garlic', 4, 'count'),
    line('reaper', 5, 'g', { put_up_stage_id: S, output_id: J2, ...rated(1400000, 2200000) }),
    line('vinegar', 72, 'g', { put_up_stage_id: S, output_id: J2 }),
  ];
  it('2.5% Veg only → base 800 → 20.0 g; "no weight: onion, garlic"', () => {
    const b = saltBase(lines(), 'produce');
    expect(b.grams).toBe(800);
    expect(b.no_weight).toEqual(['onion', 'garlic']);
    expect(oneDecimal(saltGrams(2.5, b.grams))).toBe('20.0');
  });
  it('row 1 (no additions) = the sitting figure over Made 910 g', () => {
    const sittings = [{ id: S, made_g: 910 }];
    const sit = estimateShu({ scope: 'sitting', lines: lines(), sittings, sitting_id: S });
    const row = estimateShu({ scope: 'jar', lines: lines(), sittings, jar: { id: J1, put_up_stage_id: S, quantity_value: 16, quantity_unit: 'fl oz' } });
    expect(row.low).toBe(sit.low);
    expect(row.high).toBe(sit.high);
    const c = 412 * 2500 + 230 * 10000 + 8 * 1400000;
    expect(sit.low).toBe(halfUp(c / 910));
  });
  it('row 2 (+ reaper 5 g, vinegar 72 g, 2 × 8 oz woozy) → "can\'t work it out: how much is in these bottles"', () => {
    const r = estimateShu({ scope: 'jar', lines: lines(), sittings: [{ id: S, made_g: 910 }], jar: { id: J2, put_up_stage_id: S, quantity_value: 16, quantity_unit: 'fl oz' } });
    expect(r).toEqual({ refusal: 'row_net_unknown' });
  });
  it('a row with a weight: [conc × (net − added) + added contributions] ÷ net', () => {
    const r = estimateShu({ scope: 'jar', lines: lines(), sittings: [{ id: S, made_g: 910 }], jar: { id: J2, put_up_stage_id: S, quantity_value: 500, quantity_unit: 'g' } });
    const conc = (412 * 2500 + 230 * 10000 + 8 * 1400000) / 910;
    expect(r.low).toBe(halfUp((conc * (500 - 77) + 5 * 1400000) / 500));
    expect(r.denominator_source).toBe('row');
  });
  it('the counted carrot draw with no qty takes its grams from the bag size, and is not a heat line', () => {
    expect(lineGrams(line('carrots', null, null, { draw: { count_drawn: 1, jar_quantity_value: 600, jar_quantity_unit: 'g', jar_package_count: 4 } })))
      .toEqual({ grams: 150, derived: true });
    expect(isHeatLine(line('carrots', 150, 'g'))).toBe(false);
  });
});

describe('Units', () => {
  it('mash typed 2 cups is ignored; vinegar 30 ml is "no weight"; reaper 0.5 oz = 14.17 g', () => {
    expect(gramsOf(30, 'ml')).toBeNull();                            // mutation arm: convert vinegar ml
    expect(gramsOf(30, 'ml', { water: true })).toBe(30);
    expect(gramsOf(0.5, 'oz')).toBeCloseTo(14.17, 2);
    expect(saltBase([line('vinegar', 30, 'ml'), line('cabbage', 100, 'g')], 'all')).toMatchObject({ grams: 100, no_weight: ['vinegar'] });
  });
});

describe('the refusals', () => {
  it('nothing with a listed heat → no_heat_lines (never 0 SHU from absence)', () => {
    expect(estimateShu({ scope: 'batch', lines: [line('cabbage', 1000, 'g'), salt(20)] }).refusal).toBe('no_heat_lines');
  });
  it('a heat line with no weight → cannot_work_it_out naming it', () => {
    const r = estimateShu({ scope: 'batch', lines: [line('jalapeño', null, null, rated(2500, 8000)), line('onion', 20, 'g')] });
    expect(r.missing).toEqual([{ line_id: expect.any(String), label: 'jalapeño', why: 'no_weight' }]);
  });
  it('a line typed 0 counts as 0 — a sweet pepper is a rating, not an absence', () => {
    const r = estimateShu({ scope: 'batch', lines: [line('sweet pepper', 100, 'g', { shu_rating_low: 0 }), line('onion', 100, 'g')] });
    expect(r).toMatchObject({ low: 0, high: 0 });
  });
  it('a heat line lacking both is named twice (rating and weight)', () => {
    const c = contributions([line('dried chili', null, null)]);
    expect(c.missing.map((m) => m.why)).toEqual(['no_rating', 'no_weight']);
  });
  it('a typed label matching a household pepper variety is a heat line', () => {
    expect(isHeatLine(line('Megatron', 100, 'g'), { pepperNames: ['megatron'] })).toBe(true);
    expect(isHeatLine(line('Megatron', 100, 'g'))).toBe(false);
  });
  it('salt and water lines are never heat lines', () => {
    expect(isHeatLine({ ...salt(5), shu_rating_low: 100 })).toBe(false);
    expect(isHeatLine(water(100))).toBe(false);
  });
});

describe('staleness (§2.6.4)', () => {
  it('a computed estimate that no longer matches is flagged; typed never', () => {
    expect(isStale({ shu_est_basis: 'computed', shu_est_low: 949, shu_est_high: 3036 }, { low: 949, high: 3036 })).toBe(false);
    expect(isStale({ shu_est_basis: 'computed', shu_est_low: 949, shu_est_high: 3036 }, { low: 900, high: 3036 })).toBe(true);
    expect(isStale({ shu_est_basis: 'computed', shu_est_low: 949, shu_est_high: 3036 }, { refusal: 'no_heat_lines' })).toBe(true);
    expect(isStale({ shu_est_basis: 'typed', shu_est_low: 1, shu_est_high: 2 }, { low: 900, high: 3036 })).toBe(false);
  });
});

describe('no F writer writes "peppers" (06 §5.4)', () => {
  it('the salt bases a writer may send exclude it', () => {
    expect(KITCHEN_SALT_BASES).toEqual(['produce', 'water', 'all']);
  });
});
