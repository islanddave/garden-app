// V5-COLDCARDREACHABLE-001 — a cold card fires only for a plant Dave can act on.
//
// Two narrowings of engine.coldFor, both Dave-approved 2026-09-17 ("leave it - fix the in-ground
// problem properly instead"). Evidence: _bdreview_20260917/coldthreshold-recommendation.md §6.8 — of 61
// `protect` cards 09-01..09-17, 29 named plants already in the heated House and 18 named in-ground plants.
//
//   HEATED  — heated_resolved (locations.heated via handler.js) drops every level of the card. NOT
//             `covered`: the Stable is covered and unheated and holds more plantings than the House.
//   IN-GROUND — likelyInGround drops the two BRING-IN levels, but only for plantings the frost ALERT
//             names (frostClass.summarize: not hardy by slug, not in a HEATED location — `covered` until
//             BUG-FROSTALERTSTABLE-001, 2026-09-18), so no planting ends up with no cold message on either
//             channel. `optional` ("protect flowering plant") survives.
//
// Every fixture here is fed through generatePlan, the real call site (engine.js -> tasks.cold), not
// coldFor alone. The `*_resolved` keys are what handler.js selects; the unit suite mocks SQL, so the
// column's existence and its resolution are NOT proven here — handler-heated.test.js pins the SELECT.
//
// MUTATION LOG — 2026-09-18, lane-coldcardreachable-20260918. Each applied to engine.js alone, this file
// run, RED observed, file restored byte-for-byte:
//   * in-ground suppression removed (`_inGroundAlerted=false`)        -> 4 RED (potato, watermelon, five, invariant)
//   * frostAlertNames covered clause dropped                          -> 2 RED (under cover keeps card, invariant)
//   * frostAlertNames hardy clause dropped                            -> 2 RED (hardy slug keeps card, invariant)
//   * heated check removed                                            -> 3 RED (House pepper, Fittonia, House optional)
//   * heated check keyed on frost_covered_resolved instead            -> 5 RED (incl. both Stable cases)
//   * heated check `!==false` (absent/NULL treated as heated)         -> 1 RED (fails toward a card)
//   * in-ground as an early return (drops `optional` too)             -> 1 RED (optional survives)
//   * broughtInside check removed                                     -> 1 RED (brought_inside toggle)
//   * bring_in / protect level no longer suppressed in-ground         -> 2 RED each
//   * in-ground predicate ignores container_type                      -> 5 RED (incl. the outdoor lantana control)
//   * frostAlertNames without resolvedBands                           -> 1 RED (invalid FROST override)
// Re-run 2026-09-18, lane-froststable-20260918 (BUG-FROSTALERTSTABLE-001 moved frostAlertNames' second
// clause from covered to heated, mirroring summarize):
//   * frostAlertNames clause back on frost_covered_resolved           -> 1 RED (Stable bed is named, card drops)
//   * frostAlertNames heated clause dropped (`return true`)           -> 0 RED, and CANNOT go red here: the
//     HEATED narrowing returns null before the in-ground branch, so a heated planting never reaches it. The
//     clause keeps the mirror faithful to summarize; the INVARIANT test is what binds the two channels.
import { describe, it, expect, vi } from 'vitest';
import engine from './engine.js';
import h from './handler.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import fc from './frostClass.js';

const { generatePlan } = engine;

// frostAlertEnabled: prod's live value (FROST_ALERT_ENABLED="true", scripts/lambda-config-expected.json).
// BUG-INGROUNDOFFSEASONSILENT-001 made the in-ground drop conditional on it; with it off the card stays,
// which ingroundoffseason.test.js pins through the real run().
// frostCoverage (BUG-INGROUND39FSLIVER-001) is built the way run() builds it: handler.frostForSpace, i.e. the
// frost email's own decision over these plantings and this forecast. No Open-Meteo lows here, so only the
// imminent tier (NWS <= 38) can name a crop; the forecast matrix further down drives run() itself.
const planFor = (ps, weather) => {
  const plantings = ps.map((p, i) => ({
    id: 'cr-' + i, project: 'Garden', project_id: 'pg', status: 'vegetative',
    substrate_start: '2026-05-01', last_water: '2026-09-17', last_fert: null, db_cadence: null, ...p,
  }));
  const w = { unit: 'F', ...weather };
  const { coverage } = h.frostForSpace({ rows: plantings, weather: w, hydrology: null, spaceId: 'sp1',
    today: '2026-09-18', frostSeason: true });
  return generatePlan({ plantings, cadence: cad, fertModel: fm, today: '2026-09-18', weather: w,
    ownerFallback: 'dave', frostAlertEnabled: true, frostCoverage: coverage });
};
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
  // message anywhere. frostClass.summarize excludes hardy slugs and plantings in a HEATED location from
  // the alert, so an in-ground planting in either class keeps today's card.
  it('in-ground in the unheated Stable is NAMED by the frost alert, so its bring-in card drops', () => {
    // Until BUG-FROSTALERTSTABLE-001 (Dave 2026-09-18) summarize dropped every `covered` planting, so a
    // raised bed in the Stable was invisible to the alert and kept this card. The alert now keys on
    // heat: the Stable is unheated, so the bed is named there and follows the ordinary in-ground rule.
    const shed = cucurbit('Zephyr Squash', 'Cucurbita', 'squash', { container_type: 'raised_bed', ...STABLE });
    expect(fc.summarize([shed]).atRisk).toBe(1);
    expect(card(shed, 48)).toBeNull();
  });

  it('in-ground with a HARDY slug but a tender profile (Jaune du Poitou before its 09-17 fix) keeps its card', () => {
    const leek = { name: 'Jaune du Poitou', variety: 'Jaune du Poitou', genus: 'Allium', crop_type_slug: 'leek',
      container_type: 'in_ground', cadence_scopes: ['cultivar'], ...OUTDOORS,
      db_cadence: { crop: 'pepper (sweet)', cold: { tender: true, protect_below_F: 50 }, water_interval_days_inground: 7 } };
    expect(card(leek, 48)).toMatchObject({ level: 'protect' });
  });

  it('INVARIANT (class): every tender in-ground fixture is carded OR inside the frost alert\'s exposure', () => {
    // Read through summarize itself, the function handler.js hands the alert's exposure to, rather
    // than a restatement of its rules. atRisk counts the plantings the alert CAN name. That it actually
    // names them on a given night is the forecast-matrix INVARIANT below (BUG-INGROUND39FSLIVER-001):
    // this one only proves the class dimension, i.e. a planting the alert can never name keeps its card.
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

  it('an invalid FROST_BAND_THRESHOLDS_JSON cannot break the cold pass; with no coverage the bed KEEPS its card', () => {
    // frostClass's threshold resolution THROWS on an unknown band. That throw belongs to the 14-17 ET frost
    // runs; reaching it from coldFor would take down every run's plan. Since BUG-INGROUND39FSLIVER-001 coldFor
    // does not classify through frostClass at all: it reads the coverage the handler built from the email's
    // own decision, and under this override there is none (summarize throws in the handler; the evaluating
    // run fails loud and sends nothing, a non-evaluating one keeps every card — ingroundsliver.test.js).
    // CHANGED 2026-09-18: this used to assert the in-ground card was still DROPPED here, i.e. a card
    // withheld for an email that could not be evaluated. The card is now the message left standing.
    vi.stubEnv('FROST_BAND_THRESHOLDS_JSON', JSON.stringify({ not_a_band: { ADVISORY_LOW_F: 1 } }));
    try {
      expect(() => fc.resolveBandThresholds()).toThrow(/unknown band/);   // the override IS invalid
      const plan = () => generatePlan({
        plantings: [{ id: 'w1', project: 'Garden', project_id: 'pg', status: 'vegetative', substrate_start: '2026-05-01',
          last_water: '2026-09-17', last_fert: null, ...WATERMELON }],
        cadence: cad, fertModel: fm, today: '2026-09-18', weather: { unit: 'F', tonightLow: 48, highToday: 68 },
        ownerFallback: 'dave', frostAlertEnabled: true, frostCoverage: null });
      expect(plan).not.toThrow();
      expect(Object.values(plan().users).flatMap((u) => u.tasks.cold)).toMatchObject([{ name: WATERMELON.name, level: 'protect' }]);
    } finally { vi.unstubAllEnvs(); }
  });
});

// BUG-INGROUND39FSLIVER-001 — the INVARIANT, extended from "the alert CAN name it" to "the email DID name it",
// across the forecast shapes where the two sources disagree. Drives the REAL run() (the evaluating 15 ET run,
// 2026-10-05, in frost season), so the email side is what publishAlert actually received, not a restatement.
// Each in-ground bed has a potted twin in the same Space: "suppressed" = the twin is carded and the bed is not.
// No hourly block (no radiative signal): the radiative trip is ingroundsliver.test.js's.
describe('BUG-INGROUND39FSLIVER-001 — INVARIANT through run(): an in-ground card is suppressed only when the email names it', () => {
  const SPACE = 'sp1';
  const TODAY = '2026-10-05';
  const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const row = (id, p) => ({
    id, project_id: 'pj1', status: 'vegetative', container_size: null, rain_exposed: null, project: 'Garden',
    project_status: 'active', workspace_id: SPACE, assignee_user_id: 'user_dave', db_cadence: null, cadence_scopes: null,
    last_water: null, last_fert: null, substrate_start: '2026-05-01', transplant_at: null, rain_exposed_resolved: true,
    ...OUTDOORS, ...p,
  });
  // Band path (solanaceous, carded below 40F) and profile path (the live watermelon shape, carded at <= 50F).
  const BEDS = [
    { bed: row('potato-bed', { ...POTATO, name: 'Potato bed' }), twin: row('potato-bag', { ...potted(POTATO), name: 'Potato bag' }), crop: /potato/i },
    { bed: row('melon-bed', { ...WATERMELON, name: 'Melon bed' }), twin: row('melon-bag', { ...potted(WATERMELON), name: 'Melon bag' }), crop: /watermelon/i },
  ];
  async function drive({ nws, om, flag }) {
    vi.stubEnv('FROST_ALERT_ENABLED', flag ? 'true' : undefined);
    const publishAlert = vi.fn(async () => ({ messageId: 'mid' }));
    const rows = BEDS.flatMap((b) => [b.bed, b.twin]);
    const pg = { query: async (sql) => {
      if (/from plants/.test(sql)) return { rows };
      if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      return { rows: [] };
    } };
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await h.run({
        pg, today: TODAY, dryRun: false, etHour: 15, event: {}, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
        // null NWS = the shipped fetcher's guarded failure (index.js returns null); null OM = a hydrology whose
        // temperature_2m_min came back empty (the 2026-09-02 error-body shape).
        fetchNWS: async () => (nws == null ? null : { tonightLow: nws, highToday: nws + 20, code: 1, unit: 'F', short: 'Clear' }),
        fetchPrecip: async () => ({ forecast_lows: om == null ? [null, null, null] : [om, om + 8, om + 12],
          forecast_dates: [1, 2, 3].map((n) => addDays(TODAY, n)), recent_precip_in: 0, today_precip_in: 0, today_pop: 0,
          upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, hourly_frost: null }),
        fetchStation: async () => null, publishAlert,
      });
      const cards = res.plans.flatMap((pl) => pl.plan.tasks.cold);
      const frost = publishAlert.mock.calls.map(([m]) => m).filter((m) => m.topic === 'frost');
      return { carded: (p) => cards.some((c) => c.name === p.name), names: (re) => frost.some((m) => re.test(m.message)) };
    } finally { quiet.mockRestore(); vi.unstubAllEnvs(); }
  }

  it('NWS vs Open-Meteo matrix, flag on and off: suppressed => the published email names the crop', async () => {
    const MATRIX = [
      { nws: 39, om: 42, flag: true },    // the ledger row: neither tier trips, so neither bed may go quiet
      { nws: 41, om: 39, flag: true },    // advisory on Open-Meteo names both; the potato has no band card at 41
      { nws: 38, om: 45, flag: true },    // imminent on NWS names both
      { nws: 40, om: 40, flag: true },    // advisory at its own boundary
      { nws: null, om: 42, flag: true },  // no tonight low: no card for anyone, nothing to suppress
      { nws: null, om: 39, flag: true },
      { nws: 39, om: null, flag: true },  // no advisory possible; 39 trips nothing
      { nws: 38, om: null, flag: true },
      { nws: 38, om: 45, flag: false },   // kill switch: nothing sent, every card kept
      { nws: 39, om: 42, flag: false },
    ];
    let suppressed = 0, keptUnnamed = 0, keptFlagOff = 0;
    for (const c of MATRIX) {
      const r = await drive(c);
      for (const { bed, twin, crop } of BEDS) {
        const wouldCard = r.carded(twin);
        const isSuppressed = wouldCard && !r.carded(bed);
        const tag = `NWS ${c.nws} / OM ${c.om} / flag ${c.flag ? 'on' : 'off'} — ${bed.name}`;
        if (isSuppressed) expect(r.names(crop), `${tag}: card suppressed but the email does not name it`).toBe(true);
        if (isSuppressed) suppressed++;
        if (wouldCard && r.carded(bed) && c.flag) { expect(r.names(crop), `${tag}: kept although named`).toBe(false); keptUnnamed++; }
        if (wouldCard && r.carded(bed) && !c.flag) keptFlagOff++;
      }
    }
    // non-vacuity, every direction: the suppression really fired where the email named the bed (41/39 melon,
    // 38/45 x2, 40/40 melon, 38/null x2), the fix really kept a card where the email was silent (39/42 x2,
    // 39/null x2), and the kill switch still keeps both beds (x2 rows).
    expect(suppressed).toBe(6);
    expect(keptUnnamed).toBe(4);
    expect(keptFlagOff).toBe(4);
  });

  it('UNCHANGED — Dave\'s accepted gap starts ABOVE the frost band: 41F drops the melon card, 40F keeps it', async () => {
    // The boundary pair, both with no email. 41F is above the watermelon band's advisory point (40), where
    // the alert is silent by design (frostClass.js "THE ACCEPTED COST"; card ruling 2026-09-17): no card.
    // 40F is inside it, so the email's silence is a gap and the bed keeps its card.
    const above = await drive({ nws: 41, om: 42, flag: true });
    expect(above.names(/watermelon/i)).toBe(false);
    expect(above.carded(BEDS[1].twin)).toBe(true);
    expect(above.carded(BEDS[1].bed)).toBe(false);
    const inside = await drive({ nws: 40, om: 42, flag: true });
    expect(inside.names(/watermelon/i)).toBe(false);
    expect(inside.carded(BEDS[1].bed)).toBe(true);
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
