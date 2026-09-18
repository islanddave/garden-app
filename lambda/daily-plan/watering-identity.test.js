// BUG-WATERIDENTITYFREETEXT-001 — "is this a nightshade?" must have ONE answer across the engine.
//
// The max-days ceiling's steady-moisture arm (rainMaxDays, -1 at flowering/fruiting) used to answer it with a
// pepper/tomato regex over the care-profile crop STRING, while coldFor's band answers it with isSolanaceous(p):
// genus when stated, else the controlled crop_type_slug, never free text. Two predicates for one fact disagree
// silently — a leek and a watermelon whose crop strings read "pepper (sweet)" matched the regex, and a Capsicum
// known only by genus did not. The arm now calls isSolanaceous itself.
//
// isSolanaceous is not exported, and this lane must not touch it (a sibling lane depends on it), so the
// agreement test below uses coldFor's band as the oracle — which is the better oracle anyway: it asserts the two
// CONSUMERS agree, so it also fails if coldFor ever moves to a different predicate without this arm following.
// The band is recognisable by level 'bring_in' (only the band emits it, engine.js coldFor) on a container that is
// not in the ground and not brought inside.
//
// INERT IN PROD: the arm only runs with CARE_RAIN_MAXDAYS_ENABLED, which is absent from the live Lambda. The last
// describe pins that inertness so this change can never be mistaken for a live behaviour change.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;  // BUG-NOLOCOUTDOOR-001 fixture bridge
const { rainMaxDays, generatePlanForUser } = engine;

// intermediate x flowering = 3 and intermediate x fruiting = 2 (RAIN_MAX_DAYS). Both sit above the floor of 1, so
// a -1 is observable: 3 -> 2 at flowering.
const TIER = 'intermediate';

describe('BUG-WATERIDENTITYFREETEXT-001 — rainMaxDays reads planting identity, not the crop string', () => {
  it('a Capsicum known by genus alone gets the steady-moisture -1 at flowering (it did not, before)', () => {
    const genusOnly = { genus: 'Capsicum', crop_type_slug: null };
    expect(rainMaxDays(TIER, 'flowering', 'ornamental', genusOnly)).toBe(2);   // 3 -1
    expect(rainMaxDays(TIER, 'flowering', null, genusOnly)).toBe(2);           // no crop string at all
    // stage-gated, not identity-gated: the same plant at vegetative gets the plain ceiling
    expect(rainMaxDays(TIER, 'vegetative', 'ornamental', genusOnly)).toBe(3);
  });

  it('a free-text crop string reading "pepper" does NOT give an Allium the pepper modifier', () => {
    // Live prod shape before 2026-09-17: Jaune du Poitou, genus Allium, slug leek, crop "pepper (sweet)".
    const leek = { genus: 'Allium', crop_type_slug: 'leek' };
    expect(rainMaxDays(TIER, 'flowering', 'pepper (sweet)', leek)).toBe(3);
    // CONTROL: the identical crop string on a real Capsicum still gets it, so the 3 above is the identity
    // talking and not a dead arm.
    expect(rainMaxDays(TIER, 'flowering', 'pepper (sweet)', { genus: 'Capsicum', crop_type_slug: 'pepper' })).toBe(2);
  });

  it('the slug carries identity when genus is NULL — a tomato slug alone gets the modifier', () => {
    const slugOnly = { genus: null, crop_type_slug: 'tomato' };
    expect(rainMaxDays(TIER, 'flowering', 'unknown', slugOnly)).toBe(2);       // 3 -1
    expect(rainMaxDays(TIER, 'fruiting', 'unknown', slugOnly)).toBe(1);        // 2 -1
  });

  it('a stated out-of-set genus is a REFUSAL — a pepper slug and a pepper crop string cannot override it', () => {
    // Peppermint, mis-slugged: every text surface says pepper, the stated genus says Mentha. Genus is decisive.
    const misSlugged = { genus: 'Mentha', crop_type_slug: 'pepper' };
    expect(rainMaxDays(TIER, 'flowering', 'pepper', misSlugged)).toBe(3);
    expect(rainMaxDays(TIER, 'fruiting', 'pepper', misSlugged)).toBe(2);
  });

  it('potato (Solanum) GAINS the arm at flowering — a deliberate population change, not an accident', () => {
    // The old regex never matched a crop string reading "potato". Even moisture from tuber initiation (about
    // first flowers) through bulking is what prevents growth cracks and hollow heart, so this is wanted.
    // Zero live potato plantings on 2026-09-18. If that call is ever reversed, THIS is the line to change.
    expect(rainMaxDays(TIER, 'flowering', 'potato', { genus: 'Solanum', crop_type_slug: 'potato' })).toBe(2);
  });

  it('no planting passed means no Solanaceae identity — the crop string alone confers nothing', () => {
    expect(rainMaxDays(TIER, 'flowering', 'tomato')).toBe(3);
    expect(rainMaxDays(TIER, 'flowering', 'hot pepper (C. chinense)')).toBe(3);
    // ...and the free-text leafy arm, deliberately left as it was, still fires on text alone
    expect(rainMaxDays(TIER, 'flowering', 'lettuce')).toBe(2);
  });
});

describe('BUG-WATERIDENTITYFREETEXT-001 — the watering arm and the cold band cannot silently disagree', () => {
  const cad = { default: { crop: 'unknown', water_interval_days_inground: 5, water_interval_days_container: 5, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
  const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
  const TODAY = '2026-07-15';
  // 38F is inside the band's bring-in rule (< 40F); 60F keeps the >=88F heat gate out of the interval.
  const WX = { tonightLow: 38, highToday: 60 };

  const GENERA = ['Capsicum', 'Solanum', 'Physalis', 'Allium', 'Citrullus', 'Mentha', 'Ocimum', null];
  const SLUGS = ['pepper', 'tomato', 'eggplant', 'tomatillo', 'potato', 'leek', 'watermelon', 'mint', null];
  // Every string here is one the old regex would or would not match on its own. None is a med-herb or leafy
  // string: those two arms are separate, still free text, and out of this bug's scope.
  const CROPS = ['pepper (sweet)', 'hot pepper (C. chinense)', 'chili', 'tomato', 'solanum', 'Capsicum annuum',
    'eggplant', 'tomatillo', 'leek (Allium)', 'watermelon', 'potato', 'ornamental', '', null];

  // Trough: 'intermediate' rain tier (flowering ceiling 3), NOT in the ground (so coldFor stays reachable
  // whatever an in-ground rule does), cadence 5 so the ceiling is always the binding clamp, and last watered
  // 10 days ago so every planting lands on water_due with its clamped interval visible.
  const plantingsFor = () => {
    const out = [];
    for (const genus of GENERA) for (const slug of SLUGS) for (const crop of CROPS) {
      out.push(withCoverFlags({
        id: `wid-${out.length}`, name: `WID ${out.length}`, variety: `WID ${out.length}`, genus, crop_type_slug: slug,
        status: 'flowering', project: 'P', project_id: 'pp', container_type: 'trough', container_size: null,
        covered: false, last_water: '2026-07-05', substrate_start: '2026-05-01', transplant_at: null,
        cadence_scopes: ['cultivar'],
        db_cadence: { crop, water_interval_days_container: 5, water_method: 'soak', soil_moisture_target: 'moist' },
      }));
    }
    return out;
  };
  const verdicts = (maxDays) => {
    const ps = plantingsFor();
    const out = generatePlanForUser(ps, cad, fm, TODAY, WX, null, false, maxDays);
    const waterById = new Map(out.tasks.water_due.map((w) => [w.id, w]));
    const coldById = new Map(out.tasks.cold.map((r) => [r.id, r]));
    return ps.map((p) => ({
      p, crop: p.db_cadence.crop, water: waterById.get(p.id), cold: coldById.get(p.id),
    }));
  };

  it('for every genus x slug x crop-string combination, the -1 fires exactly where the band says bring in', () => {
    const rows = verdicts(true);
    const disagreements = [];
    for (const r of rows) {
      expect(r.water, `${r.p.id} missing from water_due`).toBeTruthy();
      const wateringSaysSolanaceous = r.water.interval === 2;                  // 3 -1
      const bandSaysSolanaceous = !!r.cold && r.cold.level === 'bring_in';
      expect([2, 3], `${r.p.id} interval`).toContain(r.water.interval);
      if (wateringSaysSolanaceous !== bandSaysSolanaceous) {
        disagreements.push(`genus=${r.p.genus} slug=${r.p.crop_type_slug} crop=${JSON.stringify(r.crop)} ` +
          `water=${r.water.interval} cold=${r.cold ? r.cold.level : 'none'}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('NON-VACUITY: the matrix holds both answers, and the cases where text and identity point opposite ways', () => {
    // Without this, an edit that made every fixture solanaceous (or none) would leave the agreement test green
    // while proving nothing, and so would one that dropped the crop strings the old regex disagreed on.
    const rows = verdicts(true);
    const oldRegex = /pepper|tomato|eggplant|tomatillo|chile|chili|capsicum|solanum/i;   // the retired predicate
    const band = (r) => !!r.cold && r.cold.level === 'bring_in';
    expect(rows.filter(band).length).toBeGreaterThan(0);
    expect(rows.filter((r) => !band(r)).length).toBeGreaterThan(0);
    // text says nightshade, identity says no (the leek/watermelon class) ...
    expect(rows.filter((r) => oldRegex.test(r.crop || '') && !band(r)).length).toBeGreaterThan(0);
    // ... and identity says nightshade, text says nothing (the genus-only Capsicum class)
    expect(rows.filter((r) => !oldRegex.test(r.crop || '') && band(r)).length).toBeGreaterThan(0);
  });

  it('flag OFF (the live prod state): identity changes no interval at all', () => {
    // CARE_RAIN_MAXDAYS_ENABLED is absent from garden-daily-plan, so today every one of these waters on its raw
    // cadence — which is why this fix moves no live plan.
    const rows = verdicts(false);
    expect(new Set(rows.map((r) => r.water && r.water.interval))).toEqual(new Set([5]));
  });
});
