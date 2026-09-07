// DRG-WXWATER-001 coarse-v1 — 3-substrate-tier rain model tests (flag-gated: CARE_RAIN_CREDIT_ENABLED).
//
// TWO jobs, mirroring the parity harness philosophy:
//   (1) STANDING FLAG-OFF GUARD (spec §8 "Standing regression guard"): prove generatePlan(flag:off) is
//       byte-identical to the current engine across ALL 8 committed parity goldens. Combined with parity.test.js
//       (goldens are the pre-change engine output and are NOT regenerated), this pins that the new flag path
//       cannot move the DRG-BACKBONE shadow-parity signal. Also re-asserts the B2 byte-identity anchors.
//   (2) FLAG-ON COVERAGE: the intended tier behavior is a SEPARATE set (spec B3 "flag-ON gets a separate golden
//       set") — pinned here as deterministic assertions rather than regenerated goldens, plus a FALSIFIABILITY
//       check that the flag actually changes at least one golden scenario (L-146).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';
import { scenarios } from '../../tests/parity/daily-plan/fixtures.mjs';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;  // BUG-NOLOCOUTDOOR-001 fixture bridge

const {
  generatePlan, generatePlanForUser, RAIN_IA, RAIN_TIER_IA, RAIN_TIER_HOLD, RAIN_VESSEL_TIER,
  rainTierFor, rainStageFor, rainMaxDays, rainCreditDaysTiered,
} = engine;

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const cadence = JSON.parse(readFileSync(here('./cadence-data-v2.json'), 'utf8'));
const fertModel = JSON.parse(readFileSync(here('./fertilization-model.json'), 'utf8'));

const TODAY = '2026-06-21';
const ago = (d) => { const t = new Date('2026-06-21T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const cad = { default: { crop: 'tomato', water_interval_days_inground: 5, water_interval_days_container: 3, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
const wx = { tonightLow: 60, highToday: 75 };
// seeded cadence with an explicit inground interval so container_type drives inGround selection deterministically.
const SEED = (o) => ({ _seeded: true, crop: 'tomato', water_interval_days_container: 3, water_interval_days_inground: 5, water_method: 'soak', soil_moisture_target: 'moist', drought_tolerance: 'medium', ...o });

// Run one planting through the engine at a given flag state; return DUE|SKIP|NOHIST|NONE + the plan.
// DRG-WXFLAGSPLIT-001 F1: the max-days ceiling moved to its OWN flag (5th param), default OFF. Everything in
// this file except the two explicitly ceiling-dependent cases below characterizes the tiered CREDIT alone —
// which is exactly the state F2 will flip prod into (credit ON, ceiling still OFF). Independence of the two
// flags is proven in watercredit-flagsplit.test.js.
function bucket(ov, hy, flag, weather = wx, maxdays = false) {
  const p = withCoverFlags({ id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp',
    container_type: null, container_size: null, covered: false, last_water: null, substrate_start: ago(81),
    transplant_at: ago(400), db_cadence: SEED({}), ...ov });
  const out = generatePlanForUser([p], cad, fm, TODAY, weather, hy, flag, maxdays);
  const b = out.tasks.water_due.some((w) => w.id === 't') ? 'DUE'
    : out.tasks.rain_skipped.some((w) => w.id === 't') ? 'SKIP'
    : out.tasks.no_history.some((w) => w.id === 't') ? 'NOHIST' : 'NONE';
  return { b, out };
}

// Hydrology fixtures keyed by window precip (recent + today).
const H = (recent) => ({ recent_precip_in: recent, today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 });

describe('WXWATER byte-identity anchors (B2) — untouched legacy symbols', () => {
  it('RAIN_IA.outdoor still 0.25; RAIN_IA.in_ground still undefined (watercredit.test.js:36-37 unbroken)', () => {
    expect(RAIN_IA.outdoor).toBe(0.25);
    expect(RAIN_IA.in_ground).toBeUndefined();
  });
});

describe('WXWATER STANDING FLAG-OFF GUARD — generatePlan(flag:off) == default across all 8 parity goldens', () => {
  for (const s of scenarios) {
    it(`flag:false deep-equals default for "${s.name}"`, () => {
      // BUG-PARITYFLAGBLIND-001: parity scenarios now DECLARE rainCreditEnabled (the -flagon ones declare
      // true), so the flag has to be stripped before the `def` call — left in, "default" would inherit the
      // scenario's own flag and this guard would stop asserting anything about the default at all.
      const { rainCreditEnabled: _declared, ...base } = s.input;
      const off = generatePlan({ ...base, cadence, fertModel, rainCreditEnabled: false });
      const def = generatePlan({ ...base, cadence, fertModel });
      expect(off).toEqual(def);
    });
  }
});

describe('WXWATER FALSIFIABILITY — the flag actually changes behavior on >=1 golden scenario', () => {
  it('at least one parity scenario diverges flag-ON vs flag-OFF (else the flag is a no-op)', () => {
    const diverged = scenarios.some((s) => {
      const off = JSON.stringify(generatePlan({ ...s.input, cadence, fertModel, rainCreditEnabled: false }));
      const on = JSON.stringify(generatePlan({ ...s.input, cadence, fertModel, rainCreditEnabled: true }));
      return off !== on;
    });
    expect(diverged).toBe(true);
  });
});

describe('WXWATER tier lookup — every DB container_type maps; unknown fails safe to small_fast', () => {
  it('vessel -> tier assignment (14 DB values + generic pot)', () => {
    expect(rainTierFor('in_ground')).toBe('in_ground');
    for (const t of ['raised_bed', 'trough', 'whiskey_barrel', 'window_box']) expect(rainTierFor(t)).toBe('intermediate');
    for (const t of ['fabric_bag', 'hanging_basket', 'tray_cell', 'soil_block', 'solo_cup', 'plastic_pot', 'terracotta', 'ceramic', 'pot', 'other']) expect(rainTierFor(t)).toBe('small_fast');
  });
  // BUG-RAINTIERFALLBACK-001 (2026-09-06): the fallback row was renamed from the 'small_fast' ALIAS to a derived
  // 'unknown'. The CONTRACT this test exists to hold — least credit, err toward watering — is unchanged and is
  // now structural rather than coincidental, so it is asserted here as a property instead of a string.
  it('null / unknown container_type -> unknown (least credit, err toward watering)', () => {
    expect(rainTierFor(null)).toBe('unknown');
    expect(rainTierFor(undefined)).toBe('unknown');
    expect(rainTierFor('mystery_pot')).toBe('unknown');
    // the part that actually matters: whatever it is called, it must clear the highest bar and hold the shortest
    for (const t of Object.keys(RAIN_TIER_IA)) {
      expect(RAIN_TIER_IA[rainTierFor(null)], `IA vs ${t}`).toBeGreaterThanOrEqual(RAIN_TIER_IA[t]);
      expect(RAIN_TIER_HOLD[rainTierFor(null)], `hold vs ${t}`).toBeLessThanOrEqual(RAIN_TIER_HOLD[t]);
    }
  });
  // BUG-RAINCREDITLIVEPATH-001. The one-arg assertions above pass because sizeGal is undefined -> strict row,
  // which is the DESIGNED default but is a reason those tests do not state. Pin the size gate explicitly so a
  // green above can never again be mistaken for "fabric_bag is unconditionally small_fast".
  it('fabric_bag size gate: >= FABRIC_GROUND_MIN_GAL -> fabric_ground, below/unsized -> small_fast', () => {
    expect(rainTierFor('fabric_bag', 5)).toBe('fabric_ground');       // Dave's modal 5 gal bag
    expect(rainTierFor('fabric_bag', 0.06)).toBe('small_fast');       // the live "3 in" bag
    expect(rainTierFor('fabric_bag')).toBe('small_fast');             // omitted -> pre-existing verdict
    expect(rainTierFor('fabric_bag', 3)).toBe('fabric_ground');       // boundary is inclusive
    expect(rainTierFor('fabric_bag', 2.99)).toBe('small_fast');
    expect(rainTierFor('fabric_bag', null)).toBe('small_fast');       // unparseable size fails safe
    expect(rainTierFor('fabric_bag', NaN)).toBe('small_fast');
    // sizeGal is contracted as a parsed NUMBER of gallons. null/undefined/NaN are handled by the bare
    // comparison alone, so these two are what actually pin the Number.isFinite guard: without it a string
    // or Infinity coerces past the gate. A caller handing over a raw container_size must fail SAFE.
    expect(rainTierFor('fabric_bag', '5')).toBe('small_fast');
    expect(rainTierFor('fabric_bag', Infinity)).toBe('small_fast');
    // the gate is fabric-only: a big rigid pot does NOT get promoted, and no fallback can reach fabric_ground.
    // BUG-RAINTIERFALLBACK-001: an unrecognised/NULL type now lands on 'unknown' rather than aliasing to
    // small_fast — a SIZE can never rescue a vessel whose TYPE the engine does not recognise.
    expect(rainTierFor('plastic_pot', 20)).toBe('small_fast');
    expect(rainTierFor('mystery_pot', 20)).toBe('unknown');
    expect(rainTierFor(null, 20)).toBe('unknown');
  });
  it('tier constants are the coarse-v1 values (IA spreads around the legacy 0.25; holds 3/2/1)', () => {
    // fabric_ground added by BUG-RAINCREDITLIVEPATH-001 at the in_ground values (0.20 / 3).
    // BUG-RAINTIERFALLBACK-001 (2026-09-06): small_fast retuned 0.35 -> 0.17 (Dave — a plain quarter inch must
    // credit a rigid pot), and a DERIVED 'unknown' row added so the fail-safe no longer rides on which named tier
    // happens to be strictest. The exported tables therefore carry five rows, not four.
    expect(RAIN_TIER_IA).toEqual({ in_ground: 0.20, intermediate: 0.25, small_fast: 0.17, fabric_ground: 0.20, unknown: 0.25 });
    expect(RAIN_TIER_HOLD).toEqual({ in_ground: 3, intermediate: 2, small_fast: 1, fabric_ground: 3, unknown: 1 });
    // the fail-safe invariant as a property of the TABLE, not of the literals above — now carried by 'unknown',
    // which is DERIVED from the named rows, so this loop can no longer be broken by retuning any single tier.
    for (const t of Object.keys(RAIN_TIER_IA)) {
      if (t === 'unknown') continue;
      expect(RAIN_TIER_IA.unknown, `IA ${t}`).toBeGreaterThanOrEqual(RAIN_TIER_IA[t]);
      expect(RAIN_TIER_HOLD.unknown, `hold ${t}`).toBeLessThanOrEqual(RAIN_TIER_HOLD[t]);
    }
    // ...and the fallback actually REACHES that row. The old code left this coupling to a comment asking the next
    // editor to re-check by hand, which is exactly what failed: nothing would have caught small_fast dropping
    // below in_ground while unknown vessels still aliased to it.
    expect(rainTierFor(null)).toBe('unknown');
    expect(rainTierFor('no_such_vessel')).toBe('unknown');
    expect(rainTierFor('plastic_pot')).toBe('small_fast');   // a recognised vessel is unaffected
  });
});

describe('WXWATER rainStageFor + rainMaxDays (ceiling matrix + crop modifier + floor)', () => {
  it('status -> stage mapping', () => {
    expect(rainStageFor('vegetative')).toBe('vegetative');
    expect(rainStageFor('flowering')).toBe('flowering');
    expect(rainStageFor('fruiting')).toBe('fruiting');
    expect(rainStageFor('fruit_set')).toBe('fruiting');
    expect(rainStageFor('active')).toBe('mature');   // unknown -> loosest, still capped
    expect(rainStageFor(null)).toBe('mature');
  });
  it('base ceilings per tier x stage', () => {
    expect(rainMaxDays('in_ground', 'mature', 'radish')).toBe(5);
    expect(rainMaxDays('intermediate', 'vegetative', 'radish')).toBe(3);
    expect(rainMaxDays('small_fast', 'fruiting', 'radish')).toBe(1);
  });
  it('crop modifier: +1 for Mediterranean herbs, -1 for leafy/Solanaceae at flowering/fruiting, floor 1', () => {
    expect(rainMaxDays('in_ground', 'mature', 'rosemary')).toBe(6);        // 5 +1
    expect(rainMaxDays('intermediate', 'fruiting', 'tomato')).toBe(1);     // 2 -1
    expect(rainMaxDays('small_fast', 'fruiting', 'pepper')).toBe(1);       // 1 -1 -> floor 1
    expect(rainMaxDays('intermediate', 'flowering', 'lettuce')).toBe(2);   // 3 -1
    expect(rainMaxDays('in_ground', 'vegetative', 'lettuce')).toBe(4);     // no mod (not flower/fruit)
  });
});

describe('WXWATER rainCreditDaysTiered — per-tier IA threshold + hold cap', () => {
  it('in_ground clears a lighter rain (IA 0.20) and holds up to 3 days', () => {
    expect(rainCreditDaysTiered('in_ground', 5, H(0.22))).not.toBeNull();  // 0.22 > 0.20
    expect(rainCreditDaysTiered('in_ground', 5, H(0.22)).credit_days).toBe(3);
    expect(rainCreditDaysTiered('in_ground', 2, H(0.5)).credit_days).toBe(2); // capped at wi
  });
  // BUG-RAINTIERFALLBACK-001: IA 0.35 -> 0.17, so small_fast is now the LOWEST bar in the table rather than the
  // highest — a rigid pot is credited by a rain that leaves a raised bed on the list. Deliberate (Dave-observed:
  // a plain quarter inch satisfies his pots); the reservoir ordering lives in HOLD, which is unchanged at 1 day.
  it('small_fast clears a light rain (IA 0.17) but still holds only 1 day', () => {
    expect(rainCreditDaysTiered('small_fast', 5, H(0.15))).toBeNull();     // 0.15 < 0.17
    expect(rainCreditDaysTiered('small_fast', 5, H(0.20)).credit_days).toBe(1);
    // the point of the retune, asserted directly: a quarter inch banks a rigid pot its day
    expect(rainCreditDaysTiered('small_fast', 5, H(0.25)).credit_days).toBe(1);
    // ...and hold, not IA, is what still separates it from a bag: same rain, three times the credit
    expect(rainCreditDaysTiered('fabric_ground', 5, H(0.25)).credit_days).toBe(3);
  });
  it('missing precip -> null', () => {
    expect(rainCreditDaysTiered('in_ground', 5, { recent_precip_in: null, today_precip_in: null })).toBeNull();
  });
});

describe('WXWATER flag-ON behavior — directional divergence from flag-OFF', () => {
  it('in_ground light rain (0.22"): flag-OFF waters (under 0.25), flag-ON credits it (in_ground IA 0.20, 3d hold) -> SKIP', () => {
    const ov = { container_type: 'in_ground', status: 'vegetative', last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ov, H(0.22), false).b).toBe('DUE');
    expect(bucket(ov, H(0.22), true).b).toBe('SKIP');
  });
  it('small_fast fruiting pepper, moderate rain: flag-ON is stricter (IA 0.35 + ceiling 1) -> DUE where flag-OFF SKIPs', () => {
    // BUG-RAINCREDITLIVEPATH-001 retargeted this fixture from a '5 gal' fabric_bag to a rigid pot. The size-gated
    // fabric_ground tier means a 5 gal bag is no longer a small_fast planting, so the old fixture stopped
    // exercising the tier its own title names. The rigid pot is still small_fast at any size, so the assertions
    // below are the ORIGINAL ones, unweakened. The fabric_bag arm of the same scenario is pinned in the next test.
    const ov = { container_type: 'plastic_pot', container_size: '5 gal', status: 'fruiting', last_water: ago(3), db_cadence: SEED({ crop: 'pepper' }) };
    // flag-OFF: outdoor IA 0.25, 0.5" clears, dW==wi(3) -> SKIP
    expect(bucket(ov, H(0.5), false, wx).b).toBe('SKIP');
    // credit ON, ceiling OFF (the F2 target state): IA rises to 0.35 but 0.5" still clears it, small_fast hold=1
    // credits 1 day against wi=3 -> effDays 2 < 3 -> still SKIP. The IA alone is NOT what flips this case.
    expect(bucket(ov, H(0.5), true, wx, false).b).toBe('SKIP');
    // both ON: small_fast ceiling for fruiting Solanaceae = 1 -> wi clamps to 1, dW=3 -> DUE. The CEILING is the
    // operative half of "stricter" here, which is precisely why F1 split it onto its own flag.
    expect(bucket(ov, H(0.5), true, wx, true).b).toBe('DUE');
  });
  // BUG-RAINCREDITLIVEPATH-001 — the end-to-end delta, through generatePlan on the LIVE flag configuration
  // (credit ON, ceiling OFF), which no test previously covered (recon gap 6).
  it('fabric_ground: a >=3 gal bag is credited where the same bag under small_fast is watered', () => {
    // BUG-RAINTIERFALLBACK-001 REWROTE THIS FIXTURE, and the reason is the finding. It used to separate the tiers
    // by IA — 0.21" sat above fabric_ground's 0.20 and below small_fast's 0.35, so one credited and the other did
    // not. small_fast is now 0.17, BELOW fabric_ground, so no rain depth exists that credits a big bag and not a
    // rigid pot; an IA-based contrast here is unprovable, not merely retuned. The size gate still diverges, but
    // now through HOLD (3 days vs 1), so the fixture separates them by how OVERDUE the planting is instead.
    // 5 days since water on a 3-day cadence: 1 day of credit leaves it due (5 > 4), 3 days covers it (5 <= 6).
    const base = { status: 'vegetative', last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    const big   = { ...base, container_type: 'fabric_bag', container_size: '5 gal' };
    const tiny  = { ...base, container_type: 'fabric_bag', container_size: '3 in' };   // 0.06 gal, the live outlier
    const nosz  = { ...base, container_type: 'fabric_bag', container_size: null };
    const rigid = { ...base, container_type: 'plastic_pot', container_size: '5 gal' };
    expect(bucket(big,   H(0.25), true, wx, false).b).toBe('SKIP');   // hold 3 covers the 5-day gap
    expect(bucket(tiny,  H(0.25), true, wx, false).b).toBe('DUE');    // below the gate -> hold 1, still short
    expect(bucket(nosz,  H(0.25), true, wx, false).b).toBe('DUE');    // unparseable -> unchanged, errs to watering
    expect(bucket(rigid, H(0.25), true, wx, false).b).toBe('DUE');    // not a bag -> hold 1, still short
    // the tiny bag and the rigid pot ARE credited now (0.25 > 0.17) — they just aren't credited ENOUGH. Pin that,
    // so a future regression that stops crediting them entirely cannot hide behind the same DUE verdict.
    const tinyW = bucket(tiny, H(0.25), true, wx, false).out.tasks.water_due.find((x) => x.id === 't');
    expect(tinyW).toBeTruthy();
    // credited-but-short reads "didn't cover the gap"; uncredited reads "under the N" soak-in threshold". Pinning
    // the distinction is what stops this from passing for the wrong reason — a regression that stopped crediting
    // small_fast entirely would leave the planting in water_due exactly as it is here.
    expect(tinyW.rain_note).toContain("didn't cover the gap");
    expect(tinyW.rain_note).not.toContain('soak-in threshold');
    // and it is the rain CREDIT that moved the big bag, not the saturation-cap branch (which sets saturated:true)
    const w = bucket(big, H(0.25), true, wx, false).out.tasks.rain_skipped.find((x) => x.id === 't');
    expect(w.credited_days).toBe(3);                    // hold 3, capped at wi=3
    expect(w.saturated).toBeUndefined();
    expect(w.reason).toBe('Skip — 0.25" rain over the last few days counts as watering');
    // flag-OFF is untouched by all of this (outdoor IA 0.25, and eff must be > 0 -> 0.25 exactly does not credit)
    expect(bucket(big, H(0.25), false, wx).b).toBe('DUE');
  });
  it('max-days ceiling clamps a long cadence so the plant re-surfaces (anti suppression-inversion)', () => {
    // in_ground, mature, cadence 5, big rain: flag-OFF holds 1 day (SKIP at dW==5). ceiling(mature in_ground)=5,
    // hold 3 -> still credits, but a plant last watered 9d ago (> ceiling+hold) is DUE. Needs the ceiling flag.
    const ov = { container_type: 'in_ground', status: 'active', last_water: ago(9), db_cadence: SEED({ crop: 'kale' }) };
    expect(bucket(ov, H(0.8), true, wx, true).b).toBe('DUE');
  });
});

describe('WXWATER rain_exposed override (flag-ON only)', () => {
  it('covered planting with rain_exposed=true IS credited under flag-ON (override wins)', () => {
    const ov = { container_type: 'in_ground', status: 'vegetative', covered: true, rain_exposed: true, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ov, H(0.5), false).b).toBe('DUE');   // flag-OFF: covered -> never credited
    expect(bucket(ov, H(0.5), true).b).toBe('SKIP');   // flag-ON: explicit exposure override credits it
  });
  it('outdoor planting with rain_exposed=false is DENIED credit under flag-ON', () => {
    const ov = { container_type: 'in_ground', status: 'vegetative', covered: false, rain_exposed: false, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ov, H(0.5), true).b).toBe('DUE');    // override says sheltered -> no credit -> water
  });
  it('rain_exposed NULL falls back to !covered under flag-ON', () => {
    const ovOutdoor = { container_type: 'in_ground', status: 'vegetative', covered: false, rain_exposed: null, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    const ovCovered = { container_type: 'in_ground', status: 'vegetative', covered: true, rain_exposed: null, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ovOutdoor, H(0.5), true).b).toBe('SKIP'); // derived exposed
    expect(bucket(ovCovered, H(0.5), true).b).toBe('DUE');  // derived sheltered
  });
});
