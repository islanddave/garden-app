// BUG-DEFERNOSTRESSOVERRIDE-001 — Dave, 2026-10-09: "Never wait". A bed seeded in the last three weeks, a
// new transplant, and a pot on a hot day keep their watering card whatever the rain FORECAST says.
//
// Before this the young-bed exemption lived in the arming expression of one forecast kind
// ('incoming_dry', engine _bedDefer), keyed on a transplant date only. So a bed sown four days ago was
// held as an established one, a five-day bed transplant was held by the live 'today' kind, the off
// flag CARE_RAIN_DEFER_DRY_ENABLED would have overridden even that, and the 85F carve-out reached fabric
// bags and no other pot. The plantings below are the design probe's five, all 9 days since water so all
// are due, with nothing fallen (project-state/_nextbites-20261009/design-dryoverride.md, section 1).
//
// WHAT MUST NOT MOVE: rain that actually fell. 'soak', 'incoming' and the measured rain credit are not
// forecast kinds, and they suppress a young bed and a hot pot exactly as they did. The last three
// describes hold that side.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';
import h from './handler.js';
import lf from './ledger-fixtures.js';
import THRESHOLDS from './wateringThresholds.json';

const { generatePlan, satReason, FORECAST_SAT_KINDS, BAG_HEAT_GATE_F, TRANSPLANT_CARVEOUT_DAYS } = engine;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const cadence = JSON.parse(readFileSync(here('./cadence-data-v2.json'), 'utf8'));
const fertModel = JSON.parse(readFileSync(here('./fertilization-model.json'), 'utf8'));

const TODAY = '2026-07-15';
const d = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const base = {
  project: 'P', project_id: 'proj', project_status: 'active', status: 'vegetative', rain_exposed_resolved: true,
  assignee_user_id: 'dave', substrate_start: d(90), cadence_scopes: [], db_cadence: null, last_water: d(9),
  transplant_at: null, sow_at: null,
};
const A = { ...base, id: 'A', name: 'Established bed tomato', genus: 'Solanum', crop_type_slug: 'tomato', container_type: 'in_ground', transplant_at: d(60) };
const B = { ...base, id: 'B', name: 'Direct-sown carrot row', genus: 'Daucus', crop_type_slug: 'carrot', status: 'seedling', container_type: 'in_ground', sow_at: d(4), substrate_start: d(4) };
const C = { ...base, id: 'C', name: 'Bed transplant, 5 d', genus: 'Solanum', crop_type_slug: 'tomato', container_type: 'in_ground', transplant_at: d(5) };
const D = { ...base, id: 'D', name: '5 gal fabric bag pepper', genus: 'Capsicum', crop_type_slug: 'pepper', container_type: 'fabric_bag', container_size: '5 gal', transplant_at: d(60) };
const E = { ...base, id: 'E', name: '2 gal plastic pot basil', genus: 'Ocimum', crop_type_slug: 'basil', container_type: 'plastic_pot', container_size: '2 gal', transplant_at: d(60) };
const FIVE = [A, B, C, D, E];

// The prod flag set: scripts/lambda-config-expected.json, plus the hardcoded bed hold (handler.js
// deferDryBedsEnabled). CARE_RAIN_DEFER_DRY_ENABLED and CARE_RAIN_SOON_ENABLED are off there.
const PROD = {
  rainCreditEnabled: true, rainMaxDaysEnabled: false, todayAwareEnabled: true, measuredCreditEnabled: true,
  deferDryEnabled: false, soonAwareEnabled: false, deferDryBedsEnabled: true,
};
const dry = { recent_precip_in: 0, today_precip_in: 0, today_observed_in: 0, today_remaining_in: 0, today_pop: 10, tomorrow_precip_in: 0, tomorrow_pop: 10 };
const TOMORROW = { ...dry, tomorrow_precip_in: 0.8, tomorrow_pop: 80 };                                  // -> 'incoming_dry'
const LATER_TODAY = { ...dry, today_precip_in: 0.6, today_remaining_in: 0.6, today_pop: 70 };            // -> 'today'
const NEXT_HOURS = { ...dry, today_precip_in: 0.3, today_remaining_in: 0.3, today_next_in: 0.3, today_pop: 70 };  // -> 'soon'
const COOL = 78, HOT = 92;

const tasks = (plantings, hydrology, high, flags = {}) => generatePlan({
  plantings, cadence, fertModel, today: TODAY, weather: { tonightLow: 58, highToday: high }, hydrology,
  ownerFallback: 'dave', ...PROD, ...flags,
}).users.dave.tasks;
// id -> 'due' | 'held:<sat_kind>' | 'credited' (rain that fell counted as the watering)
function verdicts(plantings, hydrology, high, flags) {
  const t = tasks(plantings, hydrology, high, flags);
  const out = {};
  for (const r of t.water_due) out[r.id] = 'due';
  for (const r of t.rain_skipped) out[r.id] = r.sat_kind ? `held:${r.sat_kind}` : 'credited';
  return out;
}
const verdict = (p, hydrology, high, flags) => verdicts([p], hydrology, high, flags)[p.id];

describe('the design probe, after the change', () => {
  it('1. tomorrow 0.80" at 80%, 78F: the established bed waits; the seedbed, the new transplant and both pots are due', () => {
    expect(verdicts(FIVE, TOMORROW, COOL)).toEqual({ A: 'held:incoming_dry', B: 'due', C: 'due', D: 'due', E: 'due' });
  });

  it('3. 0.60" still expected today at 70%, 78F: the seedbed and the new transplant are due; A, D and E wait', () => {
    expect(verdicts(FIVE, LATER_TODAY, COOL)).toEqual({ A: 'held:today', B: 'due', C: 'due', D: 'held:today', E: 'held:today' });
  });

  it('3b. the same at 92F: only the established bed waits (the rigid pot is no longer held in heat)', () => {
    expect(verdicts(FIVE, LATER_TODAY, HOT)).toEqual({ A: 'held:today', B: 'due', C: 'due', D: 'due', E: 'due' });
  });

  it('5. CARE_RAIN_DEFER_DRY_ENABLED on, 78F: the flag holds the pots and cannot hold the seedbed or the new transplant', () => {
    expect(verdicts(FIVE, TOMORROW, COOL, { deferDryEnabled: true }))
      .toEqual({ A: 'held:incoming_dry', B: 'due', C: 'due', D: 'held:incoming_dry', E: 'held:incoming_dry' });
  });

  it('5b. the same at 92F: the bag and the rigid pot are due as well', () => {
    expect(verdicts(FIVE, TOMORROW, HOT, { deferDryEnabled: true }))
      .toEqual({ A: 'held:incoming_dry', B: 'due', C: 'due', D: 'due', E: 'due' });
  });

  it("the third forecast kind, 'soon' (CARE_RAIN_SOON_ENABLED on): same exemptions", () => {
    expect(verdicts(FIVE, NEXT_HOURS, COOL, { soonAwareEnabled: true }))
      .toEqual({ A: 'held:soon', B: 'due', C: 'due', D: 'held:soon', E: 'held:soon' });
    expect(verdicts(FIVE, NEXT_HOURS, HOT, { soonAwareEnabled: true }))
      .toEqual({ A: 'held:soon', B: 'due', C: 'due', D: 'due', E: 'due' });
  });

  it('every forecast kind was exercised above, and there are exactly three', () => {
    expect([...FORECAST_SAT_KINDS].sort()).toEqual(['incoming_dry', 'soon', 'today']);
  });
});

describe('young bed: 21 days from the transplant, else from the sow date', () => {
  const bed = (o) => ({ ...A, id: 'x', transplant_at: null, sow_at: null, ...o });
  const KINDS = [['today', LATER_TODAY, {}], ['incoming_dry', TOMORROW, {}], ['soon', NEXT_HOURS, { soonAwareEnabled: true }]];

  it('the window is the engine constant, and it is 21 days', () => {
    expect(TRANSPLANT_CARVEOUT_DAYS).toBe(21);
  });

  for (const [kind, hy, flags] of KINDS) {
    it(`${kind}: a bed sown 21 days ago is due, 22 days ago waits`, () => {
      expect(verdict(bed({ sow_at: d(21) }), hy, COOL, flags)).toBe('due');
      expect(verdict(bed({ sow_at: d(22) }), hy, COOL, flags)).toBe(`held:${kind}`);
    });
    it(`${kind}: a bed transplanted 21 days ago is due, 22 days ago waits`, () => {
      expect(verdict(bed({ transplant_at: d(21) }), hy, COOL, flags)).toBe('due');
      expect(verdict(bed({ transplant_at: d(22) }), hy, COOL, flags)).toBe(`held:${kind}`);
    });
  }

  it('a bed with neither date is established: it waits', () => {
    expect(verdict(bed({}), LATER_TODAY, COOL)).toBe('held:today');
  });

  it('started indoors, set out 5 days ago: young by its transplant, whatever its sow date', () => {
    expect(verdict(bed({ sow_at: d(50), transplant_at: d(5) }), LATER_TODAY, COOL)).toBe('due');
  });

  it('a transplant date is the planting\'s age: a later sow date does not make a 40-day transplant young', () => {
    expect(verdict(bed({ sow_at: d(10), transplant_at: d(40) }), LATER_TODAY, COOL)).toBe('held:today');
    expect(verdict(bed({ sow_at: d(10), transplant_at: d(40) }), TOMORROW, COOL)).toBe('held:incoming_dry');
  });

  it('a raised bed is a bed', () => {
    expect(verdict(bed({ container_type: 'raised_bed', sow_at: d(4) }), LATER_TODAY, COOL)).toBe('due');
    expect(verdict(bed({ container_type: 'raised_bed' }), LATER_TODAY, COOL)).toBe('held:today');
  });

  it('the sow date ages BEDS only: a 5 gal bag sown 4 days ago still waits below 85F', () => {
    // Sown in place in a vessel is the small-vessel rule's to cover or nobody's. A TRANSPLANT into
    // that bag is the next describe.
    expect(verdict({ ...D, sow_at: d(4), transplant_at: null }, LATER_TODAY, COOL)).toBe('held:today');
    expect(verdict({ ...D, sow_at: d(4), transplant_at: d(60) }, LATER_TODAY, COOL)).toBe('held:today');
  });

  it('the old small-vessel rule is untouched: a sow date alone does not make a cell tray a fresh transplant', () => {
    // freshTransplant reads transplant_at and nothing else. 0.4" fell: enough to credit an
    // established tray, and a fresh transplant is refused that credit.
    const tray = { ...E, id: 't', container_type: 'tray_cell', container_size: null, last_water: d(1) };
    const fell = { ...dry, recent_precip_in: 0.4 };
    const established = tasks([{ ...tray, transplant_at: d(60) }], fell, COOL);
    expect(established.rain_skipped.map((r) => r.credited_days != null)).toEqual([true]);
    const sownOnly = tasks([{ ...tray, transplant_at: null, sow_at: d(4) }], fell, COOL);
    expect(sownOnly).toEqual(established);
    const fresh = tasks([{ ...tray, transplant_at: d(4) }], fell, COOL);
    expect(fresh.water_due.map((r) => r.rain_note)).toEqual(['Water — fresh transplant (no rain credit; small root ball dries fast)']);
  });
});

// Dave, 2026-10-09: "new transplants … keep their watering card whatever the forecast" — said of no
// vessel in particular. A planting transplanted or potted up in the last 21 days is exempt from the
// forecast kinds in a large bag, pot, trough, barrel or basket too, below 85F.
// Owner ruling (review I2): a bed seeded in place in the last three weeks never waits for forecast rain,
// and a planting with NO vessel type recorded is not known to be out of the ground. likelyInGround
// guesses from the crop when container_type is NULL and calls only cucurbits and leeks beds, so before
// this a carrot or lettuce row sown four days ago with no type recorded was held.
describe('young bed, vessel not recorded: sown in place within 21 days never waits on a forecast', () => {
  const CARROT = { ...B, id: 'carrot', container_type: null, container_size: null };
  const LETTUCE = { ...B, id: 'lettuce', name: 'Direct-sown lettuce row', genus: 'Lactuca', crop_type_slug: 'lettuce', container_type: null, container_size: null };
  // 'incoming_dry' reaches a planting the heuristic calls a vessel only with the container flag on.
  const KINDS = [['today', LATER_TODAY, {}], ['incoming_dry', TOMORROW, { deferDryEnabled: true }]];

  for (const [name, row] of [['carrot', CARROT], ['lettuce', LETTUCE]]) {
    for (const [kind, hy, flags] of KINDS) {
      it(`${kind}, 78F: a ${name} row with no vessel type, sown 4 days ago, is due; sown 22 days ago it waits`, () => {
        expect(verdict({ ...row, sow_at: d(4) }, hy, COOL, flags)).toBe('due');
        expect(verdict({ ...row, sow_at: d(21) }, hy, COOL, flags)).toBe('due');
        expect(verdict({ ...row, sow_at: d(22) }, hy, COOL, flags)).toBe(`held:${kind}`);
      });
    }
    it(`${name}: with no sow date and no vessel type it waits as before`, () => {
      expect(verdict({ ...row, sow_at: null }, LATER_TODAY, COOL)).toBe('held:today');
    });
  }

  it('an empty vessel type is unrecorded as well', () => {
    expect(verdict({ ...CARROT, container_type: '', sow_at: d(4) }, LATER_TODAY, COOL)).toBe('due');
  });

  it('a DECLARED vessel is unchanged: a 5 gal bag, and a vessel typed "other", sown 4 days ago still wait', () => {
    for (const [kind, hy, flags] of KINDS) {
      expect(verdict({ ...D, sow_at: d(4), transplant_at: null }, hy, COOL, flags), kind).toBe(`held:${kind}`);
      expect(verdict({ ...CARROT, container_type: 'other', sow_at: d(4) }, hy, COOL, flags), kind).toBe(`held:${kind}`);
    }
  });

  it('rain that FELL still suppresses it: soak, wet media with more coming, and the measured credit', () => {
    const SOAKED = { ...dry, recent_precip_in: THRESHOLDS.SOAK_CAP_IN + 0.2 };
    const WET_AND_MORE = { ...dry, recent_precip_in: THRESHOLDS.SOAK_WET_FLOOR_IN + 0.1, tomorrow_precip_in: 0.8, tomorrow_pop: 80 };
    for (const row of [CARROT, LETTUCE]) {
      expect(verdict({ ...row, sow_at: d(4) }, SOAKED, COOL), row.id).toBe('held:soak');
      expect(verdict({ ...row, sow_at: d(4) }, WET_AND_MORE, COOL), row.id).toBe('held:incoming');
    }
    // The carrot row 2 days from water: 0.6" that fell is one day's credit for it, young or not.
    const fell = { ...dry, recent_precip_in: 0.6 };
    const twin = (o) => ({ ...CARROT, id: 'x', status: 'vegetative', substrate_start: d(90), last_water: d(2), ...o });
    const established = tasks([twin({ sow_at: d(60) })], fell, COOL);
    expect(established.rain_skipped.map((r) => r.credited_days)).toEqual([1]);
    expect(tasks([twin({ sow_at: d(4) })], fell, COOL)).toEqual(established);
  });
});

describe('new transplant: 21 days from the transplant, in any vessel', () => {
  const BAG = { ...D, id: 'bag' };
  const TROUGH = { ...E, id: 'trough', container_type: 'trough', container_size: '6x2 ft' };
  const KINDS = [['today', LATER_TODAY, {}], ['incoming_dry', TOMORROW, { deferDryEnabled: true }], ['soon', NEXT_HOURS, { soonAwareEnabled: true }]];

  for (const [name, vessel] of [['a 5 gal fabric bag', BAG], ['a trough', TROUGH]]) {
    for (const [kind, hy, flags] of KINDS) {
      it(`${kind}, 78F: ${name} transplanted 5 days ago is due; its established twin waits`, () => {
        expect(verdict({ ...vessel, transplant_at: d(5) }, hy, COOL, flags)).toBe('due');
        expect(verdict({ ...vessel, transplant_at: d(60) }, hy, COOL, flags)).toBe(`held:${kind}`);
      });
      it(`${kind}, 78F: ${name} transplanted 21 days ago is due, 22 days ago waits`, () => {
        expect(verdict({ ...vessel, transplant_at: d(21) }, hy, COOL, flags)).toBe('due');
        expect(verdict({ ...vessel, transplant_at: d(22) }, hy, COOL, flags)).toBe(`held:${kind}`);
      });
    }
  }

  it('whiskey barrel and hanging basket: the same', () => {
    for (const container_type of ['whiskey_barrel', 'hanging_basket']) {
      expect(verdict({ ...BAG, container_type, transplant_at: d(5) }, LATER_TODAY, COOL), container_type).toBe('due');
      expect(verdict({ ...BAG, container_type, transplant_at: d(22) }, LATER_TODAY, COOL), container_type).toBe('held:today');
    }
  });

  it('rain that FELL still suppresses it: soak, and wet media with more coming', () => {
    const SOAKED = { ...dry, recent_precip_in: THRESHOLDS.SOAK_CAP_IN + 0.2 };
    const WET_AND_MORE = { ...dry, recent_precip_in: THRESHOLDS.SOAK_WET_FLOOR_IN + 0.1, tomorrow_precip_in: 0.8, tomorrow_pop: 80 };
    for (const vessel of [BAG, TROUGH]) {
      expect(verdict({ ...vessel, transplant_at: d(5) }, SOAKED, COOL), vessel.id).toBe('held:soak');
      expect(verdict({ ...vessel, transplant_at: d(5) }, WET_AND_MORE, COOL), vessel.id).toBe('held:incoming');
    }
  });

  it('rain credit: a large vessel transplanted 5 days ago is credited exactly as its established twin is', () => {
    // Refusing measured credit is freshTransplant's, and that is small vessels only.
    const fell = { ...dry, recent_precip_in: 0.7 };
    for (const vessel of [BAG, TROUGH]) {
      const twin = (o) => ({ ...vessel, id: 'x', last_water: d(3), ...o });
      const established = tasks([twin({ transplant_at: d(60) })], fell, COOL);
      expect(established.rain_skipped.map((r) => r.credited_days != null), vessel.id).toEqual([true]);
      expect(tasks([twin({ transplant_at: d(5) })], fell, COOL), vessel.id).toEqual(established);
    }
  });
});

describe('heat: at 85F every vessel that is not in the ground keeps its card', () => {
  // chk_plants_container_type (migrations/v3-container-type-expand) minus the two beds, in_ground and raised_bed.
  const VESSELS = ['fabric_bag', 'plastic_pot', 'terracotta', 'ceramic', 'hanging_basket', 'window_box', 'trough',
    'whiskey_barrel', 'tray_cell', 'soil_block', 'solo_cup', 'other'];
  const pot = (container_type) => ({ ...E, id: 'v', container_type, container_size: '5 gal' });

  it('the gate is the bag gate, and it is 85F', () => {
    expect(BAG_HEAT_GATE_F).toBe(85);
  });

  for (const ct of VESSELS) {
    it(`${ct}: held at 84F, due at 85F, under a same-day forecast`, () => {
      expect(verdict(pot(ct), LATER_TODAY, BAG_HEAT_GATE_F - 1)).toBe('held:today');
      expect(verdict(pot(ct), LATER_TODAY, BAG_HEAT_GATE_F)).toBe('due');
    });
  }

  it('tomorrow\'s forecast with the container flag on: the rigid pot is held at 84F and due at 85F', () => {
    expect(verdict(E, TOMORROW, 84, { deferDryEnabled: true })).toBe('held:incoming_dry');
    expect(verdict(E, TOMORROW, 85, { deferDryEnabled: true })).toBe('due');
  });

  it('an unknown vessel is not known to be in the ground: it keeps its card in heat', () => {
    expect(verdict({ ...E, container_type: null, container_size: null }, LATER_TODAY, HOT)).toBe('due');
  });

  it('heat does not exempt a bed: in_ground and raised_bed still wait at 92F', () => {
    expect(verdict(A, LATER_TODAY, HOT)).toBe('held:today');
    expect(verdict({ ...A, container_type: 'raised_bed' }, LATER_TODAY, HOT)).toBe('held:today');
    expect(verdict(A, TOMORROW, HOT)).toBe('held:incoming_dry');
  });

  it('no temperature reading is not heat', () => {
    const t = generatePlan({ plantings: [E], cadence, fertModel, today: TODAY, weather: null, hydrology: LATER_TODAY, ownerFallback: 'dave', ...PROD }).users.dave.tasks;
    expect(t.rain_skipped.map((r) => r.sat_kind)).toEqual(['today']);
  });
});

describe('rain that FELL is unchanged: it still suppresses a young bed and a hot pot', () => {
  const SOAKED = { ...dry, recent_precip_in: THRESHOLDS.SOAK_CAP_IN + 0.2 };
  const WET_AND_MORE = { ...dry, recent_precip_in: THRESHOLDS.SOAK_WET_FLOOR_IN + 0.1, tomorrow_precip_in: 0.8, tomorrow_pop: 80 };

  it("'soak' (measured): all five are skipped at 78F and at 92F, seedbed and new transplant included", () => {
    const all = { A: 'held:soak', B: 'held:soak', C: 'held:soak', D: 'held:soak', E: 'held:soak' };
    expect(verdicts(FIVE, SOAKED, COOL)).toEqual(all);
    expect(verdicts(FIVE, SOAKED, HOT)).toEqual(all);
  });

  it("'incoming' (wet media, more coming): the seedbed, the new transplant and the hot pots are skipped", () => {
    const all = { A: 'held:incoming', B: 'held:incoming', C: 'held:incoming', D: 'held:incoming', E: 'held:incoming' };
    expect(verdicts(FIVE, WET_AND_MORE, COOL)).toEqual(all);
    expect(verdicts(FIVE, WET_AND_MORE, HOT)).toEqual(all);
  });

  it('measured soak outranks a forecast for a young bed even when both are present', () => {
    expect(verdict(B, { ...SOAKED, today_precip_in: 0.6, today_remaining_in: 0.6, today_pop: 70 }, COOL)).toBe('held:soak');
  });

  it('rain credit: a young bed is credited exactly as its established twin is', () => {
    const fell = { ...dry, recent_precip_in: 0.6 };
    const twin = (o) => ({ ...A, id: 'x', last_water: d(3), ...o });
    const established = tasks([twin({ transplant_at: d(60) })], fell, COOL);
    expect(established.rain_skipped.map((r) => r.credited_days != null)).toEqual([true]);
    expect(tasks([twin({ transplant_at: d(5) })], fell, COOL)).toEqual(established);
    expect(tasks([twin({ transplant_at: null, sow_at: d(4) })], fell, COOL)).toEqual(established);
  });

  it('rain credit: a trough keeps its 2-day credit at 86F as at 84F (the wider heat rule is forecast-only)', () => {
    // Only a fabric bag has its measured credit cut in heat (bagHeatDemoteCredit). A 2-day credit is
    // the smallest that cut would shorten, so a trough 3 days from water is the case that would move.
    const fell = { ...dry, recent_precip_in: 0.7 };
    const trough = { ...E, container_type: 'trough', container_size: '6x2 ft', last_water: d(3) };
    const at84 = tasks([trough], fell, 84);
    expect(at84.rain_skipped.map((r) => r.credited_days)).toEqual([2]);
    expect(tasks([trough], fell, 86)).toEqual(at84);
  });
});

describe('the item a held planting produces, and the one a kept card produces, keep their shape', () => {
  it('rain_skipped: same keys, sat_kind, and the satReason sentence', () => {
    const t = tasks(FIVE, TOMORROW, COOL);
    expect(t.rain_skipped).toHaveLength(1);
    const a = t.rain_skipped[0];
    expect(Object.keys(a).sort()).toEqual(['crop', 'days_since', 'id', 'in_ground', 'interval', 'name', 'project', 'project_id',
      'reason', 'sat_kind', 'sat_wp', 'saturated', 'today_in', 'today_pop']);
    expect(a).toMatchObject({ id: 'A', name: A.name, in_ground: true, saturated: true, sat_kind: 'incoming_dry', days_since: 9 });
    expect(a.reason).toBe(satReason({ kind: 'incoming_dry', fq: 0.8, pop: 80 }));
  });

  it('water_due: a card kept by the new rule has the keys of any other card, and no rain note', () => {
    const t = tasks(FIVE, TOMORROW, COOL);
    const keys = (id) => Object.keys(t.water_due.find((r) => r.id === id)).sort();
    expect(keys('B')).toEqual(keys('D'));
    expect(keys('C')).toEqual(keys('D'));
    expect(keys('D')).toEqual(['crop', 'days_since', 'id', 'in_ground', 'interval', 'method', 'moisture', 'name', 'never',
      'overdue_by', 'project', 'project_id', 'rain_note']);
    expect(t.water_due.find((r) => r.id === 'B').rain_note).toBeNull();
  });
});

describe('the water-ledger leg reads the same rule (CARE_WATER_LEDGER_ENABLED, off in prod)', () => {
  const hy = { ...lf.HY, today_precip_in: 0.6, today_remaining_in: 0.6, today_pop: 70 };
  const bed = (id, o) => lf.P({ id, container_type: 'in_ground', container_size: null, last_water: lf.ago(9), ...o });
  const plan = (high) => generatePlan({
    today: lf.TODAY, nowMs: lf.NOW, weather: { ...lf.WX, highToday: high }, hydrology: hy, ownerFallback: 'dave',
    weatherDaily: lf.weatherDaily({}),
    eventsByPlant: Object.fromEntries(['old', 'sown', 'set', 'pot', 'potset'].map((id, i) => [id, [lf.w(lf.ago(9), 12, null, `e${i}`)]])),
    plantings: [
      bed('old', {}),
      bed('sown', { transplant_at: null, sow_at: lf.ago(4) }),
      bed('set', { transplant_at: lf.ago(5) }),
      lf.P({ id: 'pot', container_type: 'plastic_pot', container_size: '2 gal', last_water: lf.ago(9) }),
      lf.P({ id: 'potset', container_type: 'plastic_pot', container_size: '2 gal', last_water: lf.ago(9), transplant_at: lf.ago(5) }),
    ],
    cadence, fertModel, ...PROD, waterLedgerEnabled: true,
  });
  const v = (p) => {
    const t = Object.values(p.users).flatMap((u) => [
      ...u.tasks.water_due.map((r) => [r.id, r.ledger ? 'due' : 'due:legacy']),
      ...u.tasks.rain_skipped.map((r) => [r.id, r.ledger ? `held:${r.sat_kind}` : 'held:legacy'])]);
    return Object.fromEntries(t);
  };

  it('78F: the established bed and the pot wait; the seedbed and both new transplants are due', () => {
    expect(v(plan(78))).toEqual({ old: 'held:today', sown: 'due', set: 'due', pot: 'held:today', potset: 'due' });
  });
  it('92F: the pot is due as well', () => {
    expect(v(plan(92))).toEqual({ old: 'held:today', sown: 'due', set: 'due', pot: 'due', potset: 'due' });
  });
});

describe('handler: the plantings query supplies sow_at, separate from transplant_at', () => {
  async function plantingsSql() {
    let sql = null;
    const pg = { query: async (q) => { if (sql === null) { sql = q; throw new Error('__captured__'); } return { rows: [] }; } };
    try { await h.run({ pg, today: '2026-10-09', dryRun: true }); } catch (e) { if (e.message !== '__captured__') throw e; }
    if (sql === null) throw new Error('no statement captured');
    return sql.split('\n').map((l) => l.replace(/(^|\s)--(\s.*)?$/, '$1')).join('\n').replace(/\s+/g, ' ');
  }
  const SOWING_EVENT = "(select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='sowing' and e.deleted_at is null)";
  const POTTING_EVENT = "(select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='potting_up' and e.deleted_at is null)";

  it("sow_at = the latest live 'sowing' event, else plants.sown_at, else the legacy planted_at, as a UTC day", async () => {
    expect(await plantingsSql()).toContain(`to_char(coalesce( ${SOWING_EVENT}, p.sown_at, p.planted_at) at time zone 'UTC','YYYY-MM-DD') as sow_at`);
  });

  it('transplant_at is still potting_up | transplanted_at | planted_out_at, with no sow date in it', async () => {
    expect(await plantingsSql()).toContain(`to_char(coalesce( ${POTTING_EVENT}, p.transplanted_at, p.planted_out_at) at time zone 'UTC','YYYY-MM-DD') as transplant_at,`);
  });

  it('neither date falls back to the row-creation time (DRG-WATERCREDIT-002)', async () => {
    const sql = await plantingsSql();
    for (const alias of ['transplant_at', 'sow_at']) {
      const expr = sql.slice(0, sql.indexOf(` as ${alias}`)).split('to_char(coalesce(').pop();
      expect(expr, alias).not.toMatch(/created_at/);
    }
  });

  it('a row from that query reaches the engine with its sow date: the handler drops no field', async () => {
    const rows = [
      { ...B, workspace_id: 'sp1', variety: 'carrot', project: 'Garden', covered: false, loc_cover_state: false },
      { ...A, workspace_id: 'sp1', variety: 'tomato', project: 'Garden', covered: false, loc_cover_state: false },
    ];
    const writes = [];
    const pg = { query: async (sql, params) => {
      if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
      if (/from plants/.test(sql)) return { rows };
      if (/from spaces/.test(sql)) return { rows: [{ id: 'sp1', postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      return { rows: [] };
    } };
    await h.run({
      pg, today: TODAY, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => ({ tonightLow: 58, highToday: 78, code: 3, unit: 'F', short: 'Cloudy' }),
      fetchPrecip: async () => ({
        forecast_lows: [58, 57, 56], forecast_dates: [d(-1), d(-2), d(-3)],
        recent_precip_in: 0, today_precip_in: 0, today_pop: 5, upcoming_precip_in: 0.8, upcoming_pop: 80,
        tomorrow_precip_in: 0.8, tomorrow_pop: 80, day2_precip_in: 0, day2_pop: 10, day2_date: d(-2), yesterday_precip_actual_in: 0,
      }),
      fetchStation: async () => null, publishAlert: async () => ({ messageId: 'm' }), etHour: 9, event: {},
    });
    const plan = writes.find((w) => w && w.hydrology) || writes[0];
    expect(plan.water_due.map((r) => r.id)).toEqual(['B']);
    expect(plan.rain_skipped.map((r) => [r.id, r.sat_kind])).toEqual([['A', 'incoming_dry']]);
  });
});
