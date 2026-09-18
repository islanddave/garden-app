// BUG-INGROUNDOFFSEASONSILENT-001 — an in-ground bring-in card may be dropped only while the frost
// alert can actually SEND.
//
// V5-COLDCARDREACHABLE-001 drops an in-ground planting's bring_in/protect card whenever the frost alert
// would NAME it (since BUG-INGROUND39FSLIVER-001: frostCoverage, the email's own decision for that run, not
// the class-only engine.frostAlertNames it replaced). Naming is not sending: the alert publishes only when
// FROST_ALERT_ENABLED === 'true' (handler.js, the F6 kill switch). With the switch off the card was
// dropped and nothing went out, so a tender bed was silent on both channels. coldFor now takes the
// handler's own flag and drops the card only when it is on.
//
// THE LEDGER ROW'S SEASON PREMISE IS FALSE, and this file pins why. isFrostSeason (Sep 1 – Nov 15)
// gates only the DEGRADED alert (frostEval.js `degradedAlert`) and the station_unbound ops alert
// (handler.js). The frost alert itself publishes all year, so a spring frost on an in-ground potato IS
// emailed and its card stays dropped, exactly as in season. A season gate would put an unactionable
// "bring inside" card for a bed back beside the email Dave ruled it redundant with (2026-09-17).
//
// Everything runs the REAL handler.run(), so the flag is read where prod reads it and has to cross the
// handler -> generatePlan -> coldFor seam. Every drive is the evaluating pm run (resolveFrostRun): that
// run both decides the email and writes the plan the afternoon reader sees, so "carded or emailed" is
// a property of one run there. No Postgres: this proves decisions and the stored plan, not DB behaviour.
//
// NOT CHANGED, pinned so any change is deliberate: the 41-50F gap. A chill-sensitive bed at 48F gets no
// card and no email, in spring as in autumn. Dave accepted that cost for the alert (frostClass.js
// "THE ACCEPTED COST", 2026-08-07) and extended it to the card (2026-09-17).
//
// MUTATION LOG — 2026-09-18, lane-nextfixes-20260918. Each applied alone, this file plus
// coldcardreachable.test.js run, RED observed, file restored byte-for-byte (sha256 checked):
//   * coldFor ignores the flag (the pre-fix line)                   -> 8 RED (kill-switch x4, invariant, defaults x3)
//   * `!!frostAlertEnabled` instead of `=== true`                   -> 1 RED (raw "false" string)
//   * handler stops passing the flag                                -> 6 RED (flag-on x3, invariant count, gap x2)
//   * handler passes `true` whatever the switch says                -> 5 RED (kill-switch x4, invariant)
//   * handler passes `frostAlertEnabled && frostSeason` (the season
//     gate the ledger row proposed)                                 -> 4 RED (spring flag-on, control, invariant, spring gap)
//   * generatePlan / generatePlanForUser / coldFor default -> true  -> 1 RED each (the defaults cases)
//   * generatePlanForUser stops forwarding to coldFor               -> 14 RED (incl. 6 in coldcardreachable.test.js)
//   * generatePlan stops forwarding to generatePlanForUser          -> 13 RED
//   * the 41-50F gap closed (drop only at <= 40F)                   -> 6 RED (both gap pins, 4 in coldcardreachable)
// Re-run 2026-09-18, lane-ingroundsliver-20260918, after the default cases gained a coverage naming the bed
// (without it they passed for the wrong reason): flag default true at coldFor / generatePlanForUser /
// generatePlan and `!!flag` -> 1 RED each; "no coverage also drops" -> 1 RED (the new coverage-default case).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import h from './handler.js';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';

const { run } = h;
const { generatePlan } = engine;

const SPACE = 'sp1';
const USER = 'user_dave';
const SPRING = '2027-05-10';   // outside isFrostSeason
const AUTUMN = '2026-09-18';   // inside it
const WINTER = '2026-12-20';   // outside it, on the other side
const PM_HOUR = 15;             // the evaluating run

const row = (name, extra) => ({
  id: name, name, project_id: 'pj1', status: 'vegetative', container_size: null, rain_exposed: null,
  project: 'Garden', project_status: 'active', workspace_id: SPACE, assignee_user_id: USER,
  db_cadence: null, cadence_scopes: null, last_water: null, last_fert: null, substrate_start: '2026-04-20',
  transplant_at: null, rain_exposed_resolved: true, frost_covered_resolved: false, heated_resolved: false,
  ...extra,
});
const potato = (name, container_type) => row(name, { variety: 'Yukon Gold', genus: 'Solanum',
  crop_type_slug: 'potato', container_type });
const BED = potato('Potato bed', 'in_ground');
// CONTROL: a grow bag is carried in, so the band cards it whatever the flag says. Without it a null for
// BED would also pass if potato simply fell out of the band.
const BAG = potato('Potato bag', 'fabric_bag');
// The live Tender Sweet Orange shape (coldcardreachable.test.js): chill_sensitive band, 50F profile.
const MELON = row('Melon bed', { variety: 'Tender Sweet Orange', genus: 'Citrullus', crop_type_slug: 'watermelon',
  container_type: 'in_ground', cadence_scopes: ['cultivar'],
  db_cadence: { crop: 'watermelon', cold: { tender: true, protect_below_F: 50 }, water_interval_days_inground: 4 } });

const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

async function drive({ today, low, rows }) {
  const publishAlert = vi.fn(async () => ({ messageId: 'mid' }));
  const pg = { query: async (sql) => {
    if (/from plants/.test(sql)) return { rows };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  } };
  const res = await run({
    pg, today, dryRun: false, etHour: PM_HOUR, event: {},
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: low, highToday: low + 25, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({ forecast_lows: [low, low + 10, low + 15], forecast_dates: [1, 2, 3].map((n) => addDays(today, n)),
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0,
      tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: null }),
    fetchStation: async () => null,
    publishAlert,
  });
  const cards = res.plans.flatMap((pl) => pl.plan.tasks.cold);
  return {
    card: (name) => cards.find((c) => c.name === name) || null,
    frost: publishAlert.mock.calls.map(([m]) => m).filter((m) => m.topic === 'frost'),
  };
}
// undefined REMOVES the variable (vi.stubEnv), which is the "never set" state of a fresh Lambda.
const FLAGS = [['on', 'true'], ['unset', undefined], ['"false"', 'false']];

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('BUG-INGROUNDOFFSEASONSILENT-001 — the frost alert publishes all year (the season premise, pinned)', () => {
  for (const today of [SPRING, AUTUMN]) {
    it(`${today}, 35F, flag on: the email names the in-ground potato and its card stays dropped`, async () => {
      vi.stubEnv('FROST_ALERT_ENABLED', 'true');
      const r = await drive({ today, low: 35, rows: [BED] });   // BED alone, so the email is about BED
      expect(r.frost).toHaveLength(1);
      expect(r.frost[0].message).toMatch(/potato/i);
      expect(r.card(BED.name)).toBeNull();
    });
  }

  it('CONTROL: on that spring night the bagged potato IS carded — the bed\'s null is the in-ground rule', async () => {
    vi.stubEnv('FROST_ALERT_ENABLED', 'true');
    const r = await drive({ today: SPRING, low: 35, rows: [BED, BAG] });
    expect(r.card(BAG.name)).toMatchObject({ level: 'bring_in' });
    expect(r.card(BED.name)).toBeNull();
  });
});

describe('BUG-INGROUNDOFFSEASONSILENT-001 — kill switch off: nothing is sent, so the bed keeps its card', () => {
  for (const [label, flag] of FLAGS.slice(1)) {
    for (const today of [SPRING, AUTUMN]) {
      it(`flag ${label}, ${today}, 35F: no frost email, and the in-ground potato keeps bring_in`, async () => {
        vi.stubEnv('FROST_ALERT_ENABLED', flag);
        const r = await drive({ today, low: 35, rows: [BED] });
        expect(r.frost).toHaveLength(0);
        expect(r.card(BED.name)).toMatchObject({ level: 'bring_in' });
      });
    }
  }
});

describe('BUG-INGROUNDOFFSEASONSILENT-001 — INVARIANT through run(): carded OR emailed, never neither', () => {
  it('every season x flag x frost low: the in-ground potato is on at least one channel', async () => {
    let dropped = 0, keptUnsent = 0;
    for (const today of [SPRING, AUTUMN, WINTER]) {
      for (const [label, flag] of FLAGS) {
        for (const low of [30, 35, 38]) {
          vi.stubEnv('FROST_ALERT_ENABLED', flag);
          const r = await drive({ today, low, rows: [BED] });
          const carded = r.card(BED.name) !== null;
          const emailed = r.frost.some((m) => /potato/i.test(m.message));
          expect(carded || emailed, `${today} flag ${label} ${low}F: silent on BOTH channels`).toBe(true);
          if (!carded) dropped++;
          if (carded && !emailed) keptUnsent++;
          vi.unstubAllEnvs();
        }
      }
    }
    // non-vacuity, both directions: the drop really fired (the email carried those), and the flag-off
    // path really kept cards with nothing sent.
    expect(dropped).toBe(9);      // 3 dates x flag on x 3 lows
    expect(keptUnsent).toBe(18);  // 3 dates x 2 off-flags x 3 lows
  });
});

describe('BUG-INGROUNDOFFSEASONSILENT-001 — engine defaults fail toward a card', () => {
  const card = (opts) => Object.values(generatePlan({
    plantings: [BED], cadence: cad, fertModel: fm, today: AUTUMN, ownerFallback: 'dave',
    weather: { unit: 'F', tonightLow: 35, highToday: 60 }, ...opts,
  }).users).flatMap((u) => u.tasks.cold).find((c) => c.name === BED.name) || null;
  // CHANGED 2026-09-18 (BUG-INGROUND39FSLIVER-001): the flag alone no longer drops the card; the email's
  // coverage must also name the bed. Every case below supplies that coverage, so each still isolates the
  // FLAG's default — without it they would pass for the wrong reason (no coverage keeps the card anyway).
  const NAMED = new Map([[BED.id, 'named']]);

  it('frostAlertEnabled absent: the card stays (a caller that forgets the flag gets a card, not silence)', () => {
    expect(card({ frostCoverage: NAMED })).toMatchObject({ level: 'bring_in' });
    expect(card({ frostAlertEnabled: true, frostCoverage: NAMED })).toBeNull();
  });

  it('only a real boolean true drops it: the raw env string "false" is truthy and must not', () => {
    expect(card({ frostAlertEnabled: 'false', frostCoverage: NAMED })).toMatchObject({ level: 'bring_in' });
  });

  it('the same default on both exported layers below generatePlan (coldFor, generatePlanForUser)', () => {
    const p = { ...BED, project: 'Garden' };
    expect(engine.coldFor(p, cad, 35, undefined, NAMED)).toMatchObject({ level: 'bring_in' });
    expect(engine.coldFor(p, cad, 35, true, NAMED)).toBeNull();
    const cold = (...flag) => engine.generatePlanForUser([p], cad, fm, AUTUMN, { unit: 'F', tonightLow: 35, highToday: 60 },
      null, false, false, false, null, false, null, {}, ...flag).tasks.cold;
    expect(cold(undefined, NAMED).map((c) => c.name)).toEqual([BED.name]);
    expect(cold(true, NAMED)).toEqual([]);
  });

  it('BUG-INGROUND39FSLIVER-001 — the coverage defaults to none, and none keeps the card at every layer', () => {
    const p = { ...BED, project: 'Garden' };
    expect(card({ frostAlertEnabled: true })).toMatchObject({ level: 'bring_in' });
    expect(engine.coldFor(p, cad, 35, true)).toMatchObject({ level: 'bring_in' });
    const cold = (...args) => engine.generatePlanForUser([p], cad, fm, AUTUMN, { unit: 'F', tonightLow: 35, highToday: 60 },
      null, false, false, false, null, false, null, {}, ...args).tasks.cold;
    expect(cold(true).map((c) => c.name)).toEqual([BED.name]);
  });
});

describe('UNCHANGED — the accepted 41-50F gap, the same in spring as in autumn', () => {
  for (const today of [SPRING, AUTUMN]) {
    it(`${today}, 48F, flag on: no card for the in-ground melon and no email either`, async () => {
      vi.stubEnv('FROST_ALERT_ENABLED', 'true');
      const r = await drive({ today, low: 48, rows: [MELON] });
      expect(r.frost).toHaveLength(0);
      expect(r.card(MELON.name)).toBeNull();
    });
  }
});
