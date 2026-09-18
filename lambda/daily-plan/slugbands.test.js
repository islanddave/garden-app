// OPS-SLUGUNIVERSESTALE-001 — the 19 crop types minted after slugUniverseConsistency's 2026-08-17 pin,
// each with the frost decision this lane made, and the five of them that carry a live planting pinned in
// BOTH cold channels (the frostband.test.js shape):
//
//   EMAIL  — frostClass.summarize with handler.js's cadenceTenderFor, plus one frostEval night end to end.
//   CARD   — engine.generatePlan -> tasks.cold, the real call site of coldFor.
//
// Fixtures are the planting shape handler.js selects, with the values read on prod 2026-09-18 (owner DSN,
// read-only transaction; handler.js WHERE clause). cadence_scopes is ['cultivar'] on all five, as on prod,
// so the engine adopts each DB profile; only Penstemon's carries a `cold` key. The unit suite mocks SQL:
// nothing here proves the rows exist, and a planting moved or re-typed on prod changes the real answer.
//
// What moves for Dave: Goldenrod, Lamb's Ear and Summer Pastels Yarrow leave the frost email, where each
// was counted as "unclassified"; Penstemon stays named as "penstemons" (its care profile's cold.tender,
// through the cadence promotion); Hoya Obovata is in the heated House and gets neither channel, before
// or after. Replay of all 209 live plantings: 15 unclassified before, 12 after, no card added or lost.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import fc from './frostClass.js';
import fe from './frostEval.js';

const { generatePlan, resolveCadence } = engine;
const { summarize, frostClassForSlug, BAND_BY_SLUG, BAND_THRESHOLDS, UNCERTAIN_SLUGS, NON_PLANT_FOOD_SLUGS,
  cropLabel, coldProfileForSlug } = fc;
const { frostEval } = fe;

// ── the decision for every one of the 19 ────────────────────────────────────────────────────────────────
const DECIDED = [
  // live plantings on prod 2026-09-18
  ['goldenrod', 'hardy'], ['lamb_s_ear', 'hardy'], ['yarrow', 'hardy'], ['hoya', 'tropical'],
  ['penstemon', 'uncertain'],
  // crop types with no planting yet
  ['blanketflower', 'hardy'], ['dianthus', 'hardy'], ['snapdragon', 'hardy'], ['chamomile', 'light_frost_tolerant'],
  ['corn', 'tender'], ['cosmos', 'tender'], ['summer_savory', 'tender'],
  // category non_plant_food — not plants
  ...['bread', 'butter', 'cheese', 'fish', 'meat', 'milk', 'yogurt'].map((s) => [s, 'not_a_plant']),
];
const decisionOf = (slug) => BAND_BY_SLUG[slug]
  || (UNCERTAIN_SLUGS.includes(slug) ? 'uncertain' : null)
  || (NON_PLANT_FOOD_SLUGS.includes(slug) ? 'not_a_plant' : null);

describe('OPS-SLUGUNIVERSESTALE-001 — the decision for each crop type minted since the 08-17 pin', () => {
  it.each(DECIDED)('%s -> %s', (slug, want) => {
    expect(decisionOf(slug)).toBe(want);
  });

  it('covers all 19, and no slug holds two decisions', () => {
    expect(DECIDED).toHaveLength(19);
    for (const [slug] of DECIDED) {
      const n = (BAND_BY_SLUG[slug] ? 1 : 0) + (UNCERTAIN_SLUGS.includes(slug) ? 1 : 0) + (NON_PLANT_FOOD_SLUGS.includes(slug) ? 1 : 0);
      expect(n, `${slug} holds ${n} decisions`).toBe(1);
    }
  });

  it('the tropical newcomer carries the cold profile its band requires, sourced at 50F', () => {
    expect(coldProfileForSlug('hoya')).toEqual({ tender: true, protect_below_F: 50 });
  });

  it('no new cold profile anywhere else: the channel stays tropical-only', () => {
    for (const [slug] of DECIDED.filter(([s]) => s !== 'hoya')) expect(coldProfileForSlug(slug), slug).toBeNull();
  });

  it('the new alerting crop types read as English in the email', () => {
    expect(['corn', 'cosmos', 'summer_savory', 'chamomile', 'hoya', 'penstemon'].map(cropLabel))
      .toEqual(['corn', 'cosmos', 'summer savory', 'chamomile', 'hoyas', 'penstemons']);
  });
});

// ── the five live plantings, as prod held them 2026-09-18 ───────────────────────────────────────────────
const OUTDOORS = { frost_covered_resolved: false, heated_resolved: false };   // Trough, Drive
const HOUSE = { frost_covered_resolved: true, heated_resolved: true };        // covered AND heated

const plant = (id, name, variety, genus, slug, container, status, where, db) => ({
  id, name, variety, genus, crop_type_slug: slug, container_type: container, status,
  ...where, db_cadence: db, cadence_scopes: ['cultivar'], last_brought_inside: null, last_brought_outside: null,
});
const GOLDENROD = plant('14696365-c660-4976-b71d-9a9fc7571cbd', 'Goldenrod', 'Canada', null, 'goldenrod',
  'plastic_pot', 'vegetative', OUTDOORS, { crop: 'goldenrod', water_interval_days_container: 7, no_calendar_feed: true });
const LAMBS_EAR = plant('6f73af20-2096-45e2-abe0-01cacb9a8229', "Lamb's Ear", "Lamb's Ear", 'Stachys', 'lamb_s_ear',
  'plastic_pot', 'vegetative', OUTDOORS, { crop: "lamb's ear (Stachys byzantina)", water_interval_days_container: 5, no_calendar_feed: true });
const YARROW = plant('2cf226fd-7f6c-4f9a-a222-59620776d0f3', 'Summer Pastels Yarrow', 'Summer Pastels', null, 'yarrow',
  null, 'flowering', OUTDOORS, { crop: 'yarrow', water_interval_days_container: 7, no_calendar_feed: true });
const PENSTEMON = plant('5014c2cf-9194-43b9-a0fc-c1ee9e4392d8', 'Penstemon', 'Penstemon', 'Penstemon', 'penstemon',
  'plastic_pot', 'flowering', OUTDOORS, { crop: 'penstemon', cold: { tender: true, protect_below_F: 35 },
    water_interval_days_container: 3, water_method: 'soak_then_dry', fertilize_interval_days: 365 });
const HOYA = plant('2505f634-51e3-4567-9942-95e58397eecc', 'Hoya Obovata', 'Hoya', null, 'hoya',
  'hanging_basket', 'vegetative', HOUSE, { crop: 'hoya', water_interval_days_container: 14, fertilize_interval_days: 28 });
const FIVE = [GOLDENROD, LAMBS_EAR, YARROW, PENSTEMON, HOYA];
// The same hoya if it summers outdoors again: not heated, so both channels must see it.
const HOYA_OUTSIDE = { ...HOYA, ...OUTDOORS };

// handler.js's own promotion input, reproduced verbatim (frostForSpace).
const cadenceTenderFor = (p) => { const c = resolveCadence(p, cad); return !!(c && c.cold && c.cold.tender); };
const exposureOf = (rows) => summarize(rows, { cadenceTenderFor });
const named = (p) => exposureOf([p]).atRisk === 1;

const planFor = (ps, low) => generatePlan({
  plantings: ps.map((p) => ({ project: 'Garden', project_id: 'pg', substrate_start: '2026-05-01',
    last_water: '2026-09-17', last_fert: null, ...p })),
  cadence: cad, fertModel: fm, today: '2026-09-18', weather: { unit: 'F', tonightLow: low, highToday: low + 20 },
  ownerFallback: 'dave', frostAlertEnabled: true,
});
const card = (p, low) => Object.values(planFor([p], low).users).flatMap((u) => u.tasks.cold)
  .find((r) => r.name === p.name) || null;
const LOWS = [60, 55, 51, 50, 45, 40, 38, 36, 35, 33, 32, 28, 20, 10];
const carded = (p) => LOWS.filter((low) => card(p, low));

describe('EMAIL — which of the five the frost alert names', () => {
  it.each([
    ['Goldenrod', GOLDENROD, { named: false, class: 'hardy', band: 'hardy' }],
    ["Lamb's Ear", LAMBS_EAR, { named: false, class: 'hardy', band: 'hardy' }],
    ['Summer Pastels Yarrow', YARROW, { named: false, class: 'hardy', band: 'hardy' }],
    // Unmapped by decision: class stays honest ('unknown'); the email names it through its profile.
    ['Penstemon', PENSTEMON, { named: true, class: 'unknown', band: 'tender' }],
    // Tropical, but in the heated House: excluded from the alert, and reported as excluded.
    ['Hoya Obovata', HOYA, { named: false, class: 'tender', band: 'tropical' }],
  ])('%s', (_n, p, want) => {
    const r = frostClassForSlug(p.crop_type_slug);
    expect({ named: named(p), class: r.class, band: r.band }).toEqual(want);
  });

  it('as one exposure: only Penstemon is named, by name, and nothing is "unclassified"', () => {
    const s = exposureOf(FIVE);
    expect({ atRisk: s.atRisk, tender: s.tender, unknown: s.unknown, hardy: s.hardy, excluded: s.coveredExcluded })
      .toEqual({ atRisk: 1, tender: 1, unknown: 0, hardy: 3, excluded: 1 });
    expect(s.byCropType.map((g) => [g.label, g.count, g.band])).toEqual([['penstemons', 1, 'tender']]);
    expect(s.byCropType[0].thresholds).toEqual(BAND_THRESHOLDS.tender);
    expect(s.coveredExcludedSlugs).toEqual(['hoya']);
    expect(s.unknownSlugs).toEqual([]);
  });

  it('Penstemon is named only through its care profile: without the cold block it would read "unclassified"', () => {
    // The belt the UNCERTAIN decision leans on, pinned so removing it is a visible act.
    const bare = { ...PENSTEMON, db_cadence: { ...PENSTEMON.db_cadence, cold: undefined } };
    const s = exposureOf([bare]);
    expect(s.byCropType.map((g) => g.label)).toEqual(['unclassified']);
  });

  it('the same hoya outdoors is named at the tropical band, which is the tender baseline by decision', () => {
    const s = exposureOf([HOYA_OUTSIDE]);
    expect(s.byCropType.map((g) => [g.label, g.band])).toEqual([['hoyas', 'tropical']]);
    expect(s.byCropType[0].thresholds).toEqual(BAND_THRESHOLDS.tender);
  });

  it('a 36F night end to end: the message names penstemons and counts nothing as unclassified', () => {
    const d = frostEval({ tonightLow: 36, exposure: exposureOf(FIVE) }, {});
    expect(d.alert).toBe(true);
    expect(d.message).toContain('penstemons (1)');
    expect(d.message).not.toMatch(/unclassified|goldenrod|yarrow|lamb|hoya/i);
  });

  it('a 36F night with only the three hardy perennials sends nothing', () => {
    expect(frostEval({ tonightLow: 36, exposure: exposureOf([GOLDENROD, LAMBS_EAR, YARROW]) }, {}).alert).toBe(false);
  });
});

describe('CARD — the bring-in card for each of the five, 60F down to 10F', () => {
  it('Hoya in the heated House: no card at any temperature', () => {
    expect(carded(HOYA)).toEqual([]);
  });

  it('Hoya outdoors: a protect card at 50F and below, none above (the new crop-type cold profile)', () => {
    expect(carded(HOYA_OUTSIDE)).toEqual([50, 45, 40, 38, 36, 35, 33, 32, 28, 20, 10]);
    expect(card(HOYA_OUTSIDE, 50)).toMatchObject({ level: 'protect' });
  });

  it('Hoya outdoors, logged as brought inside: no card', () => {
    expect(carded({ ...HOYA_OUTSIDE, last_brought_inside: '2026-09-18' })).toEqual([]);
  });

  it('Penstemon: its own profile cards it at 35F and below, unchanged by this lane', () => {
    expect(carded(PENSTEMON)).toEqual([35, 33, 32, 28, 20, 10]);
  });

  it.each([GOLDENROD, LAMBS_EAR, YARROW].map((p) => [p.name, p]))('%s: never carded (hardy, no cold profile)', (_n, p) => {
    expect(carded(p)).toEqual([]);
  });

  it('instrument check: each "never carded" fixture DOES reach coldFor — a 40F tender profile cards it', () => {
    for (const p of [GOLDENROD, LAMBS_EAR, YARROW]) {
      const probe = { ...p, db_cadence: { ...p.db_cadence, cold: { tender: true, protect_below_F: 40 } } };
      expect(carded(probe), p.name).toEqual([40, 38, 36, 35, 33, 32, 28, 20, 10]);
    }
  });
});

describe('the two channels agree for all five, and for the hoya outdoors', () => {
  // A channel "calls it hardy" when the email leaves it out for being hardy, or when the profile the card
  // path adopts says tender:false. The House is the one legitimate silence on both.
  const cardSaysHardy = (p) => { const c = resolveCadence(p, cad); return !!(c && c.cold && c.cold.tender === false); };
  it.each([...FIVE, HOYA_OUTSIDE].map((p) => [`${p.name}${p.heated_resolved ? ' (House)' : ''}`, p]))('%s', (_n, p) => {
    if (named(p)) expect(cardSaysHardy(p), 'named by the email, but the card path says hardy').toBe(false);
    else expect(carded(p), 'left out of the email, but carded').toEqual([]);
  });
});
