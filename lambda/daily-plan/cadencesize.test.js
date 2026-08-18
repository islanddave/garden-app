// cadencesize.test.js — BUG-CADENCESIZE-001: the vessel floor under the watering interval.
//
// WHAT IS BEING PINNED. The interval derivation reads one `_container` number per cultivar and, before
// this change, applied it to every vessel — a 5-gal fabric bag, a 6x2 ft trough and a 15-gal whiskey
// barrel all took the same `1`. `dailyFloorFor` raises a floor of 2 for vessels whose reservoir makes a
// 24h cycle indefensible. Two failure modes matter and each has its own block below: the floor firing
// where it must not (the fabric-bag exclusion, the fail-safe unknowns), and the floor NOT firing where
// it must (trough/barrel/large-rigid).
//
// EVIDENCE. Every `container_type`/`container_size` pair used here is a real prod string. The full
// distinct set of `container_size` values in `plants` was pulled from live prod (owner DSN, SELECT only)
// on 2026-08-18 and is 17 non-null strings plus NULL: '5 gal'(65) '10 gal'(31) '4 in'(13) '6 in'(12)
// '6x2 ft'(8) '3 in'(7) '1 gal'(6) '2 in'(6) '7 gal'(5) '20 gal'(4) '8 in'(4) '2 gal'(2) '15 gall'(2)
// '3 gal'(1) '15 gal'(1) '10 in'(1) '20 oz'(1) NULL(142). All 17 are exercised in the parse-corpus test.
//
// WHY FABRIC BAGS ARE EXCLUDED AT EVERY SIZE, and why that is asserted rather than merely commented:
// their live profile notes are authored for the bag the planting is in and still prescribe daily
// ("10+ gal bags heavy daily"; "1-1.5 gal daily in 10-15 gal bag June"; the 20-gal Jet Star's
// "1-2 gal am+pm in 85F+ ... check twice daily 85F+", all read from v_resolved_care on 2026-08-18).
// A plain gallon threshold would override 18 researched notes with an unresearched constant. The
// exclusion is the whole reason this fix is narrower than a gallon cutoff, so it gets a guard that
// fails loudly if anyone "completes" the rule later.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import ledger from './ledger.js';
import LP from './ledgerParams.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const {
  generatePlanForUser, dailyFloorFor, DAILY_FLOOR_DAYS,
  RESERVOIR_VESSEL_TYPES, RIGID_POT_TYPES, HOT_F,
} = engine;

const v = (container_type, container_size) => ({ container_type, container_size });

// A cadence table that hands every planting wi=1 on the container arm — the state the 82 live wi=1
// plantings are in. `_inground` is deliberately 4 so any accidental switch to the in-ground ARM (the
// alternative design this change rejected) shows up as 4 rather than hiding inside the floor's 2.
const CAD_DAILY = {
  default: { water_interval_days_container: 1, water_interval_days_inground: 4, crop: 'generic' },
  by_variety: {}, by_genus_fallback: {},
};
const WX_MILD = { tonightLow: 60, highToday: 75, code: 0, short: '', unit: 'F' };
const WX_HOT = { tonightLow: 70, highToday: HOT_F, code: 0, short: '', unit: 'F' };
// No rain anywhere in the window, so nothing is rain-credited or saturation-suppressed and the row
// lands in water_due where its `interval` is readable.
const HY_DRY = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: null };

// Returns the water_due row for a single planting, driven through the whole composed plan path rather
// than through the pure helper — a floor that works in isolation and is never reached is not a fix.
function planRow(vessel, { cad = CAD_DAILY, wx = WX_MILD, drought = null, lastWater = '2026-08-01' } = {}) {
  const c = { ...cad, default: { ...cad.default, ...(drought ? { drought_tolerance: drought } : {}) } };
  const p = withCoverFlags({
    id: 'p1', name: 'Test', project: 'P', project_id: 'pr1', workspace_id: 'w1', genus: 'generic',
    status: 'growing', covered: false, last_water: lastWater, transplant_at: null, rain_exposed: null,
    ...vessel,
  });
  const plan = generatePlanForUser([p], c, {}, '2026-08-18', wx, HY_DRY, false, false, false);
  return (plan.tasks.water_due || []).find(r => r.id === 'p1') || null;
}

describe('BUG-CADENCESIZE-001 — the floor fires on reservoir vessels', () => {
  // The clearest live mis-assignment: 7 prod plantings sit in a `trough 6x2 ft` (four of them peppers at
  // wi=1) whose profile notes are written about BAGS — "bags dry fast ... 7-10 gal", "~1 gal/5-gal bag
  // summer". 12 sq ft of soil is not a 5-gal bag. Three other tables in this codebase already class
  // trough with the beds (LARGE_VESSEL_TYPES, RAIN_VESSEL_TIER's intermediate row, ledger's SIZE_IMPLIED);
  // the interval derivation was the only one that did not.
  it('a 6x2 ft trough moves off the daily cadence', () => {
    expect(dailyFloorFor(v('trough', '6x2 ft'))).toBe(2);
    expect(planRow(v('trough', '6x2 ft')).interval).toBe(2);
  });

  // The floor is keyed on the TYPE for reservoir vessels, so the one live `trough` with a NULL size is
  // covered too. This is not a fail-safe violation: nothing is being inferred from an unknown, because
  // the type itself carries the reservoir (exactly as ledger's SIZE_IMPLIED treats it).
  it('a trough with NO recorded size still qualifies — the type carries it', () => {
    expect(dailyFloorFor(v('trough', null))).toBe(2);
    expect(planRow(v('trough', null)).interval).toBe(2);
  });

  // '15 gall' is a live typo in prod (2 rows, one of them the Habanero barrel). It must parse, and the
  // barrel must qualify regardless — its own profile note argues against daily in its own words:
  // "Water until drainage; slight dry-down between" / "Forgives short dry spells better than most Capsicum".
  it('a whiskey barrel qualifies, including through the live "15 gall" typo', () => {
    expect(dailyFloorFor(v('whiskey_barrel', '15 gall'))).toBe(2);
    expect(dailyFloorFor(v('whiskey_barrel', '20 gal'))).toBe(2);
    expect(planRow(v('whiskey_barrel', '15 gall')).interval).toBe(2);
  });

  // A 15-gal glazed ceramic pot resolving through `genus:Coleus`, whose note is written for a 5-gal
  // FABRIC bag. Rigid pots hold their water instead of wicking it out the walls, so a genuinely large
  // one earns the floor — but on PARSED VOLUME, never on the type, because most rigid pots are small.
  it('a large rigid pot qualifies on parsed volume', () => {
    expect(dailyFloorFor(v('ceramic', '15 gal'))).toBe(2);
    expect(planRow(v('ceramic', '15 gal')).interval).toBe(2);
  });

  // in_ground/raised_bed normally take the `_inground` arm and never reach this floor. They are in the
  // set so the rule is COMPLETE rather than arbitrary, which also closes the documented fallthrough: a
  // genus stub with no `_inground` key hands an in-ground BED its 1-day container number. Zero live rows
  // take that path today, so this guard is forward-looking by construction — assert it on the shape that
  // creates it (a cadence entry with the in-ground key absent), not on a live row.
  it('an in-ground bed can never inherit a 1-day container cadence', () => {
    const stub = { default: { water_interval_days_container: 1, crop: 'generic' }, by_variety: {}, by_genus_fallback: {} };
    expect(planRow(v('in_ground', null), { cad: stub }).interval).toBe(2);
    expect(planRow(v('raised_bed', null), { cad: stub }).interval).toBe(2);
  });
});

describe('BUG-CADENCESIZE-001 — fabric bags are excluded at every size, deliberately', () => {
  // THE GUARD THAT DEFENDS THE DESIGN DECISION. If someone later "finishes the job" by applying the
  // gallon threshold to bags, this fails and points them at the notes.
  it('no fabric bag earns the floor, 20 gal included', () => {
    for (const size of ['3 in', '5 gal', '7 gal', '10 gal', '20 gal', null]) {
      expect(dailyFloorFor(v('fabric_bag', size)), `fabric_bag ${size} must stay daily`).toBe(null);
    }
    expect(planRow(v('fabric_bag', '10 gal')).interval).toBe(1);
    expect(planRow(v('fabric_bag', '20 gal')).interval).toBe(1);
  });

  // The exclusion is a property of the fabric CLASS, not of the sizes that happen to be in prod today:
  // a bag bigger than any rigid pot would qualify still stays daily.
  it('a bag larger than the rigid-pot threshold is still daily', () => {
    const big = String(LP.SIZE_BUCKETS.largeMinGal * 10) + ' gal';
    expect(ledger.parseContainerGal(big)).toBeGreaterThanOrEqual(LP.SIZE_BUCKETS.largeMinGal);
    expect(dailyFloorFor(v('fabric_bag', big))).toBe(null);
  });
});

describe('BUG-CADENCESIZE-001 — fail-safe on unknown and unparseable vessels', () => {
  // The load-bearing hazard: parseContainerGal now influences watering behaviour on FREE-TEXT input.
  // Every one of these must leave the interval exactly where today's engine puts it — 1 — so the
  // planting keeps prompting daily. That is the same err-toward-watering direction isSmallVessel and
  // rainTierFor already take on an unknown vessel.
  it('a NULL container_type never earns the floor', () => {
    expect(dailyFloorFor(v(null, null))).toBe(null);
    expect(dailyFloorFor(v(null, '20 gal'))).toBe(null);   // size without a type is not enough
    expect(dailyFloorFor(undefined)).toBe(null);
    expect(dailyFloorFor({})).toBe(null);
    expect(planRow(v(null, null)).interval).toBe(1);
  });

  // A rigid pot whose size cannot be read stays daily. Unparseable is NOT treated as large.
  it('an unparseable or missing size on a rigid pot leaves the interval untouched', () => {
    for (const size of [null, undefined, '', '   ', 'big', 'large', 'huge pot', '5-gal', 'five gal', '0 gal', 42, {}]) {
      expect(dailyFloorFor(v('plastic_pot', size)), `plastic_pot ${JSON.stringify(size)} must stay daily`).toBe(null);
    }
    expect(planRow(v('plastic_pot', 'big')).interval).toBe(1);
    expect(planRow(v('ceramic', null)).interval).toBe(1);
  });

  // Small rigid pots are the majority of the rigid population (prod: '3 in' x7, '4 in' x13, '6 in' x12,
  // '1 gal' x6, '2 in' x6, '8 in' x4). None may be lengthened — Jen's 1-gal Arugula is correct at 1 and
  // its note says so ("Shallow roots; small frequent applications").
  it('small rigid pots keep their daily cadence', () => {
    for (const size of ['2 in', '3 in', '4 in', '6 in', '8 in', '10 in', '1 gal', '2 gal', '3 gal', '20 oz']) {
      expect(dailyFloorFor(v('plastic_pot', size)), `plastic_pot ${size} must stay daily`).toBe(null);
    }
    expect(planRow(v('plastic_pot', '1 gal')).interval).toBe(1);
  });

  // Tray class must never be lengthened: a plug cell dries top-to-bottom in hours. 5 live wi=1 rows.
  it('the tray class is never floored', () => {
    for (const t of ['tray_cell', 'soil_block', 'solo_cup']) expect(dailyFloorFor(v(t, null))).toBe(null);
    expect(dailyFloorFor(v('solo_cup', '20 oz'))).toBe(null);
    expect(planRow(v('tray_cell', null)).interval).toBe(1);
  });

  // hanging_basket and window_box are in LARGE_VESSEL_TYPES — but that set answers "is this a fresh small
  // root ball?" for the transplant carve-out, NOT "does this hold water". Both are fast-drying and
  // RAIN_VESSEL_TIER already calls hanging_basket small_fast. Reusing LARGE_VESSEL_TYPES here would have
  // been a silent bug; this pins that it was not reused.
  it('hanging baskets and window boxes are NOT treated as reservoirs', () => {
    expect(dailyFloorFor(v('hanging_basket', '2 gal'))).toBe(null);
    expect(dailyFloorFor(v('hanging_basket', '8 in'))).toBe(null);
    expect(dailyFloorFor(v('window_box', '1 gal'))).toBe(null);
    expect(RESERVOIR_VESSEL_TYPES.has('hanging_basket')).toBe(false);
    expect(RESERVOIR_VESSEL_TYPES.has('window_box')).toBe(false);
  });

  // THE PARSE CORPUS. Every distinct container_size string in live prod, run through the parser the floor
  // now depends on. The assertion is not "the parser is correct" but the property the floor needs: no
  // live string may be silently misread as >= largeMinGal when it is small. A string that fails to parse
  // is fine (it fails safe); a small string that parses LARGE is the one outcome that could delay water.
  it('no live container_size string is misread as large', () => {
    const PROD = ['5 gal', '10 gal', '4 in', '6 in', '6x2 ft', '3 in', '1 gal', '2 in', '7 gal',
      '20 gal', '8 in', '2 gal', '15 gall', '3 gal', '15 gal', '10 in', '20 oz'];
    const LARGE = new Set(['6x2 ft', '20 gal', '15 gall', '15 gal']);   // the only ones that MAY read large
    for (const s of PROD) {
      const gal = ledger.parseContainerGal(s);
      const isLarge = gal != null && gal >= LP.SIZE_BUCKETS.largeMinGal;
      expect(isLarge, `"${s}" classified large=${isLarge}`).toBe(LARGE.has(s));
    }
    // ...and every one of them parses at all, so no live row reaches the floor through the unknown path
    // by accident. A future unparseable string is handled by the fail-safe tests above.
    for (const s of PROD) expect(ledger.parseContainerGal(s), `"${s}" failed to parse`).not.toBe(null);
  });
});

describe('BUG-CADENCESIZE-001 — the floor is bounded, and nothing else moves', () => {
  // A FLOOR, not a multiplier and not the in-ground arm. It may only ever raise 1 -> 2. If it could
  // reach the `_inground` values (3-5 for the live trough peppers) this fails at 4.
  it('never lengthens an interval that is already at or above the floor', () => {
    for (const wi of [2, 3, 5, 7, 14]) {
      const cad = { default: { water_interval_days_container: wi, water_interval_days_inground: 4, crop: 'generic' }, by_variety: {}, by_genus_fallback: {} };
      expect(planRow(v('trough', '6x2 ft'), { cad, lastWater: '2026-07-01' }).interval, `wi=${wi} was moved`).toBe(wi);
      expect(planRow(v('whiskey_barrel', '15 gall'), { cad, lastWater: '2026-07-01' }).interval).toBe(wi);
    }
  });

  // The whole-mechanism bound, asserted as a property over every vessel type x every starting interval:
  // this may only ever raise 1 -> 2. It may not shorten anything, and it may not reach 3.
  //
  // The ABSOLUTE literal 2 is deliberate. An earlier draft of this test bounded the result by
  // DAILY_FLOOR_DAYS instead, which made it a tautology — retuning the constant moved both sides and the
  // test stayed green through every mutation in the matrix. A cap that cannot fail is not a cap.
  it('may only ever raise 1 -> 2 — never shortens, never reaches 3', () => {
    expect(DAILY_FLOOR_DAYS).toBe(2);
    const TYPES = [...RESERVOIR_VESSEL_TYPES, ...RIGID_POT_TYPES, 'fabric_bag', 'tray_cell', 'soil_block',
      'solo_cup', 'hanging_basket', 'window_box', null];
    const INGROUND_GAL = 4;   // the `_inground` value in the cadence built below
    for (const t of TYPES) {
      for (const size of ['6x2 ft', '20 gal', '5 gal', '3 in', null]) {
        for (const wi of [1, 2, 3, 5, 7]) {
          const cad = { default: { water_interval_days_container: wi, water_interval_days_inground: INGROUND_GAL, crop: 'generic' }, by_variety: {}, by_genus_fallback: {} };
          // The pre-floor baseline is ARM-DEPENDENT: likelyInGround sends in_ground/raised_bed to the
          // `_inground` key and everything else to `_container`. Bounding against `wi` alone asserted
          // in_ground was capped at 2 when the untouched engine already returns 4 there — the first
          // version of this test failed for exactly that reason, which is the property being restated
          // correctly rather than the guard being weakened.
          const base = (t === 'in_ground' || t === 'raised_bed') ? INGROUND_GAL : wi;
          const got = planRow(v(t, size), { cad, lastWater: '2026-07-01' }).interval;
          const label = `${t}/${size} base=${base} -> ${got}`;
          expect(got, `${label} (shortened)`).toBeGreaterThanOrEqual(base);
          expect(got, `${label} (overshot the +1 bound)`).toBeLessThanOrEqual(Math.max(base, 2));
        }
      }
    }
  });

  // ORDERING. The floor sits BEFORE the >=88F heat gate, so a hot day still walks a low-drought-tolerance
  // planting back to 1 — heat is exactly when a trough pepper wants daily water. This makes the change a
  // no-op on hot days and +1 only on ordinary ones, which is the conservative half of the design and the
  // reason the honest payoff claim is "quiet on a NORMAL day".
  it('a >=88F day still returns a low-drought-tolerance trough to daily', () => {
    expect(planRow(v('trough', '6x2 ft'), { wx: WX_MILD, drought: 'low' }).interval).toBe(2);
    expect(planRow(v('trough', '6x2 ft'), { wx: WX_HOT, drought: 'low' }).interval).toBe(1);
    // ...and a medium-tolerance planting is unaffected by the heat gate, so it holds at 2 either way.
    expect(planRow(v('trough', '6x2 ft'), { wx: WX_HOT, drought: 'medium' }).interval).toBe(2);
  });

  // The floor must not leak into the F2 ledger, which models vessel size CONTINUOUSLY (vesselProfile
  // sizeFactor + the fabric heat ramp). Layering a coarse floor on top would double-count the same
  // signal. Proven behaviourally: with the ledger flag ON the published wi_eff is the PRE-floor 1.
  it('the ledger fold consumes the pre-floor interval (F2 is unaffected)', () => {
    const p = withCoverFlags({
      id: 'p1', name: 'Test', project: 'P', project_id: 'pr1', workspace_id: 'w1', genus: 'generic',
      status: 'growing', covered: false, last_water: '2026-08-01', transplant_at: null, rain_exposed: null,
      ...v('trough', '6x2 ft'),
    });
    const lo = ledger.buildLedgerOpts({ weatherDaily: [], eventsByPlant: { p1: [] }, today: '2026-08-18' });
    const plan = generatePlanForUser([p], CAD_DAILY, {}, '2026-08-18', WX_MILD, HY_DRY, false, false, false, lo);
    const row = (plan.tasks.water_due || []).find(r => r.id === 'p1');
    expect(row.ledger, 'ledger did not run').toBeTruthy();
    expect(row.ledger.wi_eff).toBe(1);
    // ...while the legacy path on the identical planting takes the floor. Same fixture, two flag states.
    expect(planRow(v('trough', '6x2 ft')).interval).toBe(2);
  });

  // Never-watered rows publish the same interval they would be judged against, so the floor has to be
  // visible there too or the UI would show a number the engine does not use.
  it('a never-watered planting publishes the floored interval', () => {
    const row = planRow(v('trough', '6x2 ft'), { lastWater: null });
    expect(row).toBe(null);                                     // never-watered rows are not in water_due
    const p = withCoverFlags({
      id: 'p1', name: 'Test', project: 'P', project_id: 'pr1', workspace_id: 'w1', genus: 'generic',
      status: 'growing', covered: false, last_water: null, transplant_at: null, rain_exposed: null,
      ...v('trough', '6x2 ft'),
    });
    const plan = generatePlanForUser([p], CAD_DAILY, {}, '2026-08-18', WX_MILD, HY_DRY, false, false, false);
    expect(plan.tasks.no_history.find(r => r.id === 'p1').interval).toBe(2);
  });
});
