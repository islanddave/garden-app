// V5-COLDCARDREACHABLE-001 — a cold card fires only for a plant Dave can act on.
//
// Two narrowings of engine.coldFor, both Dave-approved 2026-09-17 ("leave it - fix the in-ground
// problem properly instead"). Evidence: _bdreview_20260917/coldthreshold-recommendation.md §6.8 — of 61
// `protect` cards 09-01..09-17, 29 named plants already in the heated House and 18 named in-ground plants.
//
//   HEATED  — heated_resolved (locations.heated via handler.js) drops every level of the card. NOT
//             `covered`: the Stable is covered and unheated and holds more plantings than the House.
//   IN-GROUND — likelyInGround drops the two BRING-IN levels, but only for plantings the frost ALERT
//             names (frostClass.summarize: not hardy by slug, not covered), so no planting ends up with
//             no cold message on either channel. `optional` ("protect flowering plant") survives.
//
// Every fixture here is fed through generatePlan, the real call site (engine.js -> tasks.cold), not
// coldFor alone. The `*_resolved` keys are what handler.js selects; the unit suite mocks SQL, so the
// column's existence and its resolution are NOT proven here — handler-heated.test.js pins the SELECT.
//
// MUTATION LOG — see _mainsync_20260918/coldcardreachable.md for the run-by-run record.
import { describe, it, expect, vi } from 'vitest';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import fc from './frostClass.js';

const { generatePlan } = engine;

const planFor = (ps, weather) => generatePlan({
  plantings: ps.map((p, i) => ({
    id: 'cr-' + i, project: 'Garden', project_id: 'pg', status: 'vegetative',
    substrate_start: '2026-05-01', last_water: '2026-09-17', last_fert: null, db_cadence: null, ...p,
  })),
  cadence: cad, fertModel: fm, today: '2026-09-18', weather: { unit: 'F', ...weather }, ownerFallback: 'dave',
});
const card = (p, low) => Object.values(planFor([p], { tonightLow: low, highToday: low + 20 }).users)
  .flatMap((u) => u.tasks.cold).find((r) => r.name === p.name) || null;

// Where a planting sits, as handler.js resolves it. House = covered + heated; Stable = covered only.
const OUTDOORS = { frost_covered_resolved: false, heated_resolved: false };
const STABLE = { frost_covered_resolved: true, heated_resolved: false };
const HOUSE = { frost_covered_resolved: true, heated_resolved: true };

// A cucurbit carrying a tender cultivar profile, the shape the in-ground rows take on prod
// (cadence_scopes non-empty, so resolveCadence adopts db_cadence). The 50F is illustrative — the
// evidence doc names the plants, not their thresholds; what is pinned is where they sit.
const cucurbit = (name, genus, slug, extra = {}) => ({
  name, variety: name, genus, crop_type_slug: slug, container_type: 'in_ground', cadence_scopes: ['cultivar'],
  db_cadence: { crop: slug, cold: { tender: true, protect_below_F: 50 }, water_interval_days_inground: 4 },
  ...OUTDOORS, ...extra,
});
const potted = (p) => ({ ...p, container_type: 'fabric_bag' });

const POTATO = { name: 'Yukon Gold', variety: 'Yukon Gold', genus: 'Solanum', crop_type_slug: 'potato',
  container_type: 'in_ground', ...OUTDOORS };
// Live prod shape of Tender Sweet Orange (engine.test.js BUG-COLDNAMEMATCHNAG-001), which Dave ruled on.
const WATERMELON = cucurbit('Tender Sweet Orange', 'Citrullus', 'watermelon');
const TOMATO = { name: 'Sungold', variety: 'Sungold', genus: 'Solanum', crop_type_slug: 'tomato',
  container_type: 'plastic_pot' };
const PEPPER = { name: 'Bhut Jolokia', variety: 'Bhut Jolokia', genus: 'Capsicum', crop_type_slug: 'pepper',
  container_type: 'plastic_pot', cadence_scopes: ['cultivar'],
  db_cadence: { crop: 'pepper (hot)', water_interval_days_container: 2 } };
// The single largest House card generator in the evidence (7 of 61), on the PROFILE path, not the band.
const FITTONIA = { name: 'Pink Fittonia', variety: 'Pink Fittonia', genus: 'Fittonia', crop_type_slug: 'fittonia',
  container_type: 'plastic_pot', cadence_scopes: ['cultivar'],
  db_cadence: { crop: 'houseplant', cold: { tender: true, protect_below_F: 60 }, water_interval_days_container: 7 } };
// One of the six genuinely actionable cards in the evidence: a hanging basket, outdoors.
const LANTANA = { name: 'Lantana', variety: 'Lantana', genus: 'Lantana', crop_type_slug: 'lantana',
  container_type: 'hanging_basket', ...OUTDOORS };

describe('V5-COLDCARDREACHABLE-001 — in-ground: no bring-in card for a plant that cannot be carried', () => {
  it('in-ground potato: no bring-inside card below 40F, although the genus key puts it in the band', () => {
    expect(card(POTATO, 38)).toBeNull();
    // CONTROL: the same potato in a grow bag IS carried in, so the band still cards it. Without this the
    // assertion above would pass if potato simply fell out of the band.
    expect(card(potted(POTATO), 38)).toMatchObject({ level: 'bring_in' });
  });

  it('in-ground watermelon (the live Tender Sweet Orange row): no card at its own 50F threshold', () => {
    expect(card(WATERMELON, 48)).toBeNull();
    expect(card(potted(WATERMELON), 48)).toMatchObject({ level: 'protect' });
  });

  it('all five in-ground plants from the 09-01..09-17 readback go quiet; a raised bed counts as in-ground', () => {
    const five = [
      cucurbit('Bitter Melon', 'Momordica', 'bitter_melon'),
      cucurbit('Cantaloupe', 'Cucumis', 'melon'),
      cucurbit('Crimson Sweet', 'Citrullus', 'watermelon'),
      cucurbit('Sugar Baby', 'Citrullus', 'watermelon'),
      cucurbit('Zephyr Squash', 'Cucurbita', 'squash', { container_type: 'raised_bed' }),
    ];
    for (const p of five) {
      expect(card(p, 48), `${p.name} (${p.container_type})`).toBeNull();
      expect(card(potted(p), 48), `${p.name} potted — control`).toMatchObject({ level: 'protect' });
    }
  });

  it('`optional` survives in the ground — "protect flowering plant" can be done to a bed', () => {
    const flowering = { ...POTATO, status: 'flowering' };
    expect(card(flowering, 42)).toMatchObject({ level: 'optional' });
  });
});

describe('V5-COLDCARDREACHABLE-001 — in-ground keeps its card where the frost alert cannot see it', () => {
  // The brief's safety condition: dropping the card must never leave a tender plant with no cold
  // message anywhere. frostClass.summarize excludes covered plantings and hardy slugs from the alert,
  // so an in-ground planting in either class keeps today's card.
  it('in-ground UNDER COVER (a raised bed in the unheated Stable) keeps its card', () => {
    const shed = cucurbit('Zephyr Squash', 'Cucurbita', 'squash', { container_type: 'raised_bed', ...STABLE });
    expect(card(shed, 48)).toMatchObject({ level: 'protect' });
  });

  it('in-ground with a HARDY slug but a tender profile (Jaune du Poitou before its 09-17 fix) keeps its card', () => {
    const leek = { name: 'Jaune du Poitou', variety: 'Jaune du Poitou', genus: 'Allium', crop_type_slug: 'leek',
      container_type: 'in_ground', cadence_scopes: ['cultivar'], ...OUTDOORS,
      db_cadence: { crop: 'pepper (sweet)', cold: { tender: true, protect_below_F: 50 }, water_interval_days_inground: 7 } };
    expect(card(leek, 48)).toMatchObject({ level: 'protect' });
  });

  it('INVARIANT: every tender in-ground fixture is carded OR named by the frost alert — never neither', () => {
    // Read through summarize itself, the function handler.js hands the alert's exposure to, rather
    // than a restatement of its rules. atRisk counts exactly the plantings the alert names.
    const shed = cucurbit('Zephyr Squash', 'Cucurbita', 'squash', { container_type: 'raised_bed', ...STABLE });
    const leek = { name: 'Jaune du Poitou', variety: 'Jaune du Poitou', genus: 'Allium', crop_type_slug: 'leek',
      container_type: 'in_ground', cadence_scopes: ['cultivar'], ...OUTDOORS,
      db_cadence: { crop: 'pepper (sweet)', cold: { tender: true, protect_below_F: 50 } } };
    const cases = [[POTATO, 38], [WATERMELON, 48], [cucurbit('Bitter Melon', 'Momordica', 'bitter_melon'), 48],
      [shed, 48], [leek, 48]];
    for (const [p, low] of cases) {
      const carded = card(p, low) !== null;
      const alerted = fc.summarize([p]).atRisk === 1;
      expect(carded || alerted, `${p.name}: silent on BOTH channels`).toBe(true);
    }
    // non-vacuity: the suppression actually fired on the uncovered ones, so the alert is what carries them
    expect(card(POTATO, 38)).toBeNull();
    expect(fc.summarize([POTATO]).atRisk).toBe(1);
  });

  it('an invalid FROST_BAND_THRESHOLDS_JSON cannot break the cold pass on every run', () => {
    // frostAlertNames classifies through frostClass, whose threshold resolution THROWS on an unknown
    // band. That throw belongs to the 15:30 frost run; reaching it from coldFor would take down every
    // run's plan. resolvedBands is what keeps it out.
    vi.stubEnv('FROST_BAND_THRESHOLDS_JSON', JSON.stringify({ not_a_band: { ADVISORY_LOW_F: 1 } }));
    try {
      expect(() => fc.resolveBandThresholds()).toThrow(/unknown band/);   // the override IS invalid
      expect(card(WATERMELON, 48)).toBeNull();
      expect(card(potted(WATERMELON), 48)).toMatchObject({ level: 'protect' });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('V5-COLDCARDREACHABLE-001 — heated: the House is not the Stable', () => {
  it('container pepper in the heated House: no card', () => {
    expect(card({ ...PEPPER, ...HOUSE }, 38)).toBeNull();
  });

  it('container tomato in the Stable (covered, UNHEATED): still carded', () => {
    // The trap the ledger row names. Keying on `covered` would silence this card.
    expect(card({ ...TOMATO, ...STABLE }, 38)).toMatchObject({ level: 'bring_in' });
  });

  it('the profile path too: Pink Fittonia is quiet in the House and carded in the Stable', () => {
    expect(card({ ...FITTONIA, ...HOUSE }, 55)).toBeNull();
    expect(card({ ...FITTONIA, ...STABLE }, 55)).toMatchObject({ level: 'protect' });
  });

  it('heated drops `optional` as well — a flowering pepper in the House needs nothing', () => {
    expect(card({ ...PEPPER, ...HOUSE, status: 'flowering' }, 42)).toBeNull();
    expect(card({ ...PEPPER, ...OUTDOORS, status: 'flowering' }, 42)).toMatchObject({ level: 'optional' });
  });

  it('fails toward a card: heated_resolved absent or NULL is NOT heated', () => {
    const { heated_resolved: _drop, ...noKey } = { ...PEPPER, ...HOUSE };
    expect(card(noKey, 38)).toMatchObject({ level: 'bring_in' });
    expect(card({ ...PEPPER, ...HOUSE, heated_resolved: null }, 38)).toMatchObject({ level: 'bring_in' });
  });
});

describe('V5-COLDCARDREACHABLE-001 — unchanged: outdoor containers and the brought-inside toggle', () => {
  it('container tender plant outdoors (hanging-basket lantana): carded', () => {
    expect(card(LANTANA, 48)).toMatchObject({ level: 'protect' });
  });

  it('brought_inside still clears the card, and brought_outside restores it', () => {
    const out = { ...TOMATO, ...OUTDOORS };
    expect(card(out, 38)).toMatchObject({ level: 'bring_in' });
    expect(card({ ...out, last_brought_inside: '2026-09-17' }, 38)).toBeNull();
    expect(card({ ...out, last_brought_inside: '2026-09-17', last_brought_outside: '2026-09-18' }, 38))
      .toMatchObject({ level: 'bring_in' });
  });
});
