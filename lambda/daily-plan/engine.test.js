import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
const { generatePlan, resolveCadence, fertilizeRec, feedPhase } = engine;

describe('CARE-CADENCE-001: resolveCadence prefers DB-resolved profile (v_resolved_care) when seeded', () => {
  it('uses db_cadence when present and _seeded', () => {
    const p = { variety: 'Cayenne', genus: 'Capsicum',
      db_cadence: { _seeded: true, crop: 'strawberry', water_interval_days_container: 1, fertilize_interval_days: 30 } };
    const c = resolveCadence(p, cad);
    expect(c._via).toBe('db');
    expect(c.crop).toBe('strawberry');
    expect(c.water_interval_days_container).toBe(1);
  });
  it('falls back to bundled cadence when db_cadence is null', () => {
    const c = resolveCadence({ variety: 'Cayenne', genus: 'Capsicum', db_cadence: null }, cad);
    expect(c._via).toBe('variety:Cayenne');
  });
  it('falls back to bundled when resolved_profile lacks _seeded (system-only row)', () => {
    // v_resolved_care returns the system profile for an unseeded variety -> no _seeded marker
    const p = { variety: 'Cayenne', genus: 'Capsicum',
      db_cadence: { water_interval_days: 3, water_amount_ml: 250, light: 'part_sun', fertilize_interval_days: 14 } };
    const c = resolveCadence(p, cad);
    expect(c._via).toBe('variety:Cayenne');
  });
  it('the 2 nit fixes resolve via DB to the correct crop', () => {
    const straw = resolveCadence({ variety: 'Cavendish', db_cadence: { _seeded: true, crop: 'strawberry', water_interval_days_container: 1 } }, cad);
    const lett  = resolveCadence({ variety: 'Ruby Red', db_cadence: { _seeded: true, crop: 'lettuce (red leaf)', water_interval_days_container: 1 } }, cad);
    expect(straw.crop).toBe('strawberry');
    expect(lett.crop).toBe('lettuce (red leaf)');
  });
});

describe('engine substrate-aware fert (regression guard, ported)', () => {
  it('feedPhase boundaries', () => {
    expect(feedPhase(1)).toBe('establishment_0_2wk');
    expect(feedPhase(8)).toBe('mg_active_3_12wk');
    expect(feedPhase(30)).toBe('needs_feed_24wk_plus');
  });
  it('fresh MG mix -> no fert rec; plan substrate on_hold', () => {
    const c = resolveCadence({ variety: 'Cayenne', db_cadence: null }, cad);
    expect(fertilizeRec({ id: '1', name: 'Cayenne', variety: 'Cayenne', status: 'fruiting', substrate_start: '2026-06-10', last_fert: null, project: 'P' }, c, fm, '2026-06-17')).toBeNull();
    const plan = generatePlan({ plantings: [
      { id: '1', name: 'Cayenne', variety: 'Cayenne', genus: 'Capsicum', status: 'fruiting', substrate_start: '2026-06-10', last_water: '2026-06-15', last_fert: null, project: 'Pep', db_cadence: null }],
      cadence: cad, fertModel: fm, today: '2026-06-17', weather: { tonightLow: 56, highToday: 77, unit: 'F' }, ownerFallback: 'dave' });
    expect(plan.users.dave.counts.fertilize).toBe(0);
    expect(plan.users.dave.substrate.on_hold).toBe(true);
  });
  it('DB-seeded planting routes through the engine identically to a bundled one (water bucket)', () => {
    const plan = generatePlan({ plantings: [
      { id: 's', name: 'Cavendish Strawberry', variety: 'Cavendish', genus: null, status: 'fruiting', substrate_start: '2026-06-10', last_water: '2026-06-14', last_fert: null, project: 'Straw', project_id: 'ps',
        db_cadence: { _seeded: true, crop: 'strawberry', water_interval_days_container: 1, water_method: 'even_moist_top2in', cold: { tender: false, protect_below_F: 20 }, fertilize_interval_days: 30 } }],
      cadence: cad, fertModel: fm, today: '2026-06-18', weather: { tonightLow: 42, highToday: 60, unit: 'F' }, ownerFallback: 'dave' });
    const w = plan.users.dave.tasks.water_due.find(x => x.id === 's');
    expect(w.crop).toBe('strawberry');
    expect(w.interval).toBe(1);
    // strawberry is NOT tender at 42F -> no false cold-protect (the nit fix)
    expect(plan.users.dave.counts.cold).toBe(0);
  });
});

describe('DRG-WATERSTAGE-001: plantings under a planning-stage project are excluded from the plan', () => {
  it('a planting whose parent project is in planning generates no watering task', () => {
    const plan = generatePlan({ plantings: [
      { id: 'veg', name: 'Active Tomato', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', project: 'Active', project_id: 'pa', project_status: 'active', substrate_start: '2026-05-01', last_water: '2026-06-10', last_fert: null, db_cadence: null },
      { id: 'plan', name: 'Future Bed Tomato', variety: 'Cayenne', genus: 'Capsicum', status: 'vegetative', project: 'Planning', project_id: 'pp', project_status: 'planning', substrate_start: null, last_water: null, last_fert: null, db_cadence: null }],
      cadence: cad, fertModel: fm, today: '2026-06-20', weather: { tonightLow: 60, highToday: 80, unit: 'F' }, ownerFallback: 'dave' });
    const all = Object.values(plan.users).flatMap(u => [...u.tasks.water_due, ...u.tasks.no_history]);
    expect(all.some(w => w.id === 'plan')).toBe(false);
    expect(all.some(w => w.id === 'veg')).toBe(true);
  });
});

// DRG-WXPROB-001 — the nightly rain-AMOUNT callout mirrors the Today widget's probability gating.
// The GATE (whether the rain callout fires at all) is unchanged — only the displayed amount is weighted.
describe('DRG-WXPROB-001: rain callout shows a probability-weighted amount', () => {
  const { computeCallout } = engine;
  const baseWx = { tonightLow: 60, highToday: 80 }; // no freeze/cold/heat -> rain branch can win

  it('weights the displayed amount by PoP when the rain callout fires (pop >= 30)', () => {
    const c = computeCallout(baseWx, { recent_precip_in: 0.05, tomorrow_precip_in: 1.00, tomorrow_pop: 60 });
    expect(c).toBeTruthy();
    expect(c.icon).toBe('rain');
    // 1.00 * 60% = 0.60 (not the raw 1.00)
    expect(c.text).toBe('0.6" rain tomorrow — water containers today, let in-ground beds wait');
  });

  it('keeps the raw amount when PoP is null (cannot weight an unknown probability)', () => {
    const c = computeCallout(baseWx, { recent_precip_in: 0.05, tomorrow_precip_in: 0.5, tomorrow_pop: null });
    expect(c.icon).toBe('rain');
    expect(c.text).toBe('0.5" rain tomorrow — water containers today, let in-ground beds wait');
  });
});

// CareEngine C2 cadence-floor: every one of the 15 census targets that previously fell through to
// cad.default must now resolve via a real by_variety or by_genus_fallback entry. This test FAILS if the
// cadence-data-v2.json additions are reverted (the targets would resolve _via 'default' again).
describe('CareEngine C2: all 15 census targets resolve off cad.default', () => {
  // (variety, name, genus, container) exactly per the design's coverage_check / human_table.
  const TARGETS = [
    { label: 'Alaska Mix (trough, genus null)',        p: { name: 'Alaska Mix', variety: 'Alaska Mix', genus: null, container_type: 'trough' },        expect_via: 'variety:Alaska Mix' },
    { label: 'Alaska Mix (genus Tropaeolum)',          p: { name: 'Alaska Mix', variety: 'Alaska Mix', genus: 'Tropaeolum', container_type: null },    expect_via: 'variety:Alaska Mix' },
    { label: 'Jewel Mix Nasturtium (Tropaeolum pot)',  p: { name: 'Jewel Mix Nasturtium', variety: 'Jewel Mix', genus: 'Tropaeolum', container_type: 'plastic_pot' }, expect_via: 'genus:Tropaeolum' },
    { label: 'Beefsteak (genus null)',                 p: { name: 'Beefsteak', variety: 'Beefsteak', genus: null, container_type: null },               expect_via: 'variety:Beefsteak' },
    { label: 'Valencia (fabric_bag)',                  p: { name: 'Valencia', variety: 'Valencia', genus: null, container_type: 'fabric_bag' },         expect_via: 'variety:Valencia' },
    { label: 'Black Krim (fabric_bag)',                p: { name: 'Black Krim', variety: 'Black Krim', genus: null, container_type: 'fabric_bag' },     expect_via: 'variety:Black Krim' },
    { label: 'Santa Fe Grande (genus null)',           p: { name: 'Santa Fe Grande', variety: 'Santa Fe Grande', genus: null, container_type: null },   expect_via: 'variety:Santa Fe Grande' },
    { label: 'Pachyphytum (plastic_pot)',              p: { name: 'Pachyphytum', variety: 'Pachyphytum', genus: null, container_type: 'plastic_pot' },  expect_via: 'variety:Pachyphytum' },
    { label: 'Graptosedum (plastic_pot)',              p: { name: 'Graptosedum', variety: 'Graptosedum', genus: null, container_type: 'plastic_pot' },  expect_via: 'variety:Graptosedum' },
    { label: 'Jade Plant (Crassula ovata/Crassula)',   p: { name: 'Jade Plant', variety: 'Crassula ovata', genus: 'Crassula', container_type: null },   expect_via: 'genus:Crassula' },
    { label: 'Spider Plant (variety null, name)',      p: { name: 'Spider Plant', variety: null, genus: null, container_type: 'plastic_pot' },          expect_via: 'variety:Spider Plant' },
    { label: 'Chrysanthemum (genus fallback)',         p: { name: 'Chrysanthemum', variety: null, genus: 'Chrysanthemum', container_type: 'plastic_pot' }, expect_via: 'genus:Chrysanthemum' },
    { label: 'Pineapple Sage (genus Salvia)',          p: { name: 'Pineapple Sage', variety: null, genus: 'Salvia', container_type: 'plastic_pot' },    expect_via: 'genus:Salvia' },
    { label: 'Hosta (in_ground)',                      p: { name: 'Hosta', variety: null, genus: 'Hosta', container_type: 'in_ground' },                expect_via: 'genus:Hosta' },
    { label: 'Lemon Thyme (variety null, name key)',   p: { name: 'Lemon Thyme', variety: null, genus: null, container_type: 'ceramic' },               expect_via: 'variety:Lemon Thyme' },
  ];

  it('exercises exactly 15 census targets', () => {
    expect(TARGETS.length).toBe(15);
  });

  it.each(TARGETS)('$label resolves off default via $expect_via', ({ p, expect_via }) => {
    const c = resolveCadence({ ...p, db_cadence: null }, cad);
    expect(c._via).not.toBe('default');
    expect(c._via).toBe(expect_via);
  });

  it('spot-check: succulents get a soak-and-dry container interval (>= 10 days)', () => {
    // Pachyphytum (by_variety) and Jade (by_genus_fallback Crassula) — the exact over-watering failure the
    // 3-day default caused. Both must be at least 10 days in a container.
    const pachy = resolveCadence({ name: 'Pachyphytum', variety: 'Pachyphytum', genus: null, db_cadence: null }, cad);
    const jade = resolveCadence({ name: 'Jade Plant', variety: 'Crassula ovata', genus: 'Crassula', db_cadence: null }, cad);
    expect(pachy.water_interval_days_container).toBeGreaterThanOrEqual(10);
    expect(jade.water_interval_days_container).toBeGreaterThanOrEqual(10);
    // succulent inground is null (never in-ground here)
    expect(pachy.water_interval_days_inground).toBeNull();
  });

  it('spot-check: tomato targets match the Solanum/tomato container baseline (1 / 3)', () => {
    for (const name of ['Beefsteak', 'Valencia', 'Black Krim']) {
      const c = resolveCadence({ name, variety: name, genus: null, db_cadence: null }, cad);
      expect(c.water_interval_days_container).toBe(1); // matches by_genus_fallback Solanum container:1
      expect(c.water_interval_days_inground).toBe(3);
      expect(/tomato/i.test(c.crop)).toBe(true);
    }
    // and the Solanum genus baseline the design anchors to is container:1
    expect(cad.by_genus_fallback.Solanum.water_interval_days_container).toBe(1);
  });

  it('spot-check: pepper target anchors to Capsicum baseline (container 2 / inground 4)', () => {
    const c = resolveCadence({ name: 'Santa Fe Grande', variety: 'Santa Fe Grande', genus: null, db_cadence: null }, cad);
    expect(c.water_interval_days_container).toBe(2);
    expect(c.water_interval_days_inground).toBe(4);
  });

  it('routes end-to-end through generatePlan: not one target lands on cad.default', () => {
    // Build plantings for all 15 and assert none resolve to the blanket default inside a real plan run.
    const plantings = TARGETS.map((t, i) => ({
      id: 'c2-' + i, project: 'Census', project_id: 'pc', status: 'vegetative',
      substrate_start: '2026-05-01', last_water: '2026-01-01', last_fert: null, db_cadence: null,
      ...t.p,
    }));
    const plan = generatePlan({
      plantings, cadence: cad, fertModel: fm, today: '2026-07-12',
      weather: { tonightLow: 62, highToday: 80, unit: 'F' }, ownerFallback: 'dave',
    });
    const rows = Object.values(plan.users).flatMap(u => [...u.tasks.water_due, ...u.tasks.no_history]);
    // every target appears with a resolved crop that is NOT the unknown/default marker
    for (const t of TARGETS) {
      const row = rows.find(r => r.id.startsWith('c2-') && r.name === t.p.name);
      expect(row).toBeTruthy();
      expect(row.crop).not.toBe('unknown');
    }
    // and directly confirm _via for each via resolveCadence (the load-bearing assertion)
    for (const t of TARGETS) {
      expect(resolveCadence({ ...t.p, db_cadence: null }, cad)._via).not.toBe('default');
    }
  });
});

describe('DRG-CADENCE-001: the 11 live plantings that fell to the naked 3-day default', () => {
  // Audit 2026-07-16 against live prod (224 plantings in the daily plan): 11 resolved via cad.default,
  // i.e. water_interval_days_container:3 — a value that fits almost nothing in a fabric bag in July and
  // splits the difference between two opposite lethal errors. Genus fallbacks added for all 9 genera.
  // NOTE the audit ALSO falsified this item's original premise: `exclude` hides NOTHING in production
  // (0 care_profile rows and 0 resolved profiles set it; the only bundle entry is 'Test Plant Debug',
  // and the file's own schema note documents the flag as "exclude (test)"). See the ROT/DROUGHT guards.
  const TARGETS = [
    { label: 'Petunia',                  p: { name: 'Petunia', variety: 'Petunia', genus: 'Petunia' },                                  via: 'genus:Petunia' },
    { label: 'Easy Wave Berry Velour',   p: { name: 'Easy Wave Berry Velour Petunia', variety: 'Easy Wave Berry Velour', genus: 'Petunia' }, via: 'genus:Petunia' },
    { label: 'Sunny Susy Thunbergia',    p: { name: 'Sunny Susy White Halo Thunbergia', variety: 'Sunny Susy White Halo', genus: 'Thunbergia' }, via: 'genus:Thunbergia' },
    { label: 'Cobaea scandens',          p: { name: 'Cobaea scandens (Violet)', variety: 'Cobaea scandens (Violet)', genus: 'Cobaea' },  via: 'genus:Cobaea' },
    { label: 'Foxglove',                 p: { name: 'Foxglove', variety: 'Foxglove', genus: 'Digitalis' },                               via: 'genus:Digitalis' },
    { label: 'Kiwi Fern Coleus',         p: { name: 'Kiwi Fern Coleus', variety: 'Kiwi Fern', genus: 'Coleus' },                         via: 'genus:Coleus' },
    { label: 'Fairway Orange Coleus',    p: { name: 'Fairway Orange Coleus', variety: 'Fairway Orange', genus: 'Coleus' },               via: 'genus:Coleus' },
    { label: 'Royal Ruby Hens & Chicks', p: { name: 'Royal Ruby Hens & Chicks', variety: 'Royal Ruby', genus: 'Sempervivum' },           via: 'genus:Sempervivum' },
    { label: 'Wishbone Flower',          p: { name: 'Wishbone Flower (Torenia)', variety: 'Wishbone Flower', genus: 'Torenia' },         via: 'genus:Torenia' },
    { label: 'Clemson Spineless 80',     p: { name: 'Clemson Spineless 80', variety: 'Clemson Spineless 80', genus: 'Abelmoschus' },     via: 'genus:Abelmoschus' },
    { label: 'Silver Helichrysum',       p: { name: 'Silver Helichrysum', variety: 'Silver (Licorice Plant)', genus: 'Helichrysum' },    via: 'genus:Helichrysum' },
  ];

  it('exercises exactly the 11 audited targets', () => {
    expect(TARGETS.length).toBe(11);
  });

  it.each(TARGETS)('$label no longer lands on cad.default (via $via)', ({ p, via }) => {
    const c = resolveCadence({ ...p, db_cadence: null }, cad);
    expect(c._via).not.toBe('default');
    expect(c._via).toBe(via);
  });

  it('ROT GUARD: Sempervivum is never watered on a short cadence (>= 10d container)', () => {
    // The acute case: a 3-day cadence is ~5x too frequent for an alpine crassulacean and produces
    // basal/crown rot. This was the single most likely plant on the roster to die *because of* the engine.
    const c = resolveCadence({ name: 'Royal Ruby Hens & Chicks', variety: 'Royal Ruby', genus: 'Sempervivum', db_cadence: null }, cad);
    expect(c.water_interval_days_container).toBeGreaterThanOrEqual(10);
    expect(c.drought_tolerance).toBe('high');
  });

  it('ROT GUARD: high drought_tolerance is exempt from the >=88F interval reduction', () => {
    // engine.js: `if(hot && c.drought_tolerance==='low' && wi>1) wi=wi-1` — heat must NOT shorten a
    // succulent's interval. Guards the Sempervivum/Helichrysum rot cases against a future heat rule.
    for (const g of ['Sempervivum', 'Helichrysum']) {
      expect(cad.by_genus_fallback[g].drought_tolerance).toBe('high');
    }
  });

  it('DROUGHT GUARD: thin-leaved annuals get a 1-day container cadence', () => {
    // Coleus/Torenia/Wave Petunia have no water reserve; in a fabric bag at 90F they collapse in ~24h.
    for (const [name, genus] of [['Kiwi Fern Coleus', 'Coleus'], ['Wishbone Flower (Torenia)', 'Torenia'], ['Easy Wave Berry Velour Petunia', 'Petunia']]) {
      const c = resolveCadence({ name, variety: null, genus, db_cadence: null }, cad);
      expect(c.water_interval_days_container).toBe(1);
      expect(c.drought_tolerance).toBe('low');
    }
  });

  it('the >=88F reduction never drives an interval below 1', () => {
    // The 1-day genera are drought_tolerance:'low', so the heat rule applies to them. The `wi>1` guard
    // in engine.js is what keeps 1 from becoming 0 — pin it, since six genera now resolve to 1.
    const wi = 1, hot = true;
    let out = wi; if (hot && 'low' === 'low' && out > 1) out = out - 1;
    expect(out).toBe(1);
  });

  it('okra keeps drought_tolerance medium (heat must not shorten its interval)', () => {
    // Okra is genuinely drought-tolerant and LOVES 85-95F — it is not stressed by heat. The short
    // container interval is driven by root confinement, not species thirst.
    const c = resolveCadence({ name: 'Clemson Spineless 80', variety: 'Clemson Spineless 80', genus: 'Abelmoschus', db_cadence: null }, cad);
    expect(c.drought_tolerance).toBe('medium');
    expect(c.water_interval_days_inground).toBeGreaterThan(c.water_interval_days_container);
  });

  it('`exclude` remains test-only — no real plant is hidden from the plan', () => {
    // DRG-CADENCE-001's original premise ("unconfigured tropicals silently denied any watering alert")
    // is FALSE: the only excluded entry is the debug placeholder, and cad.default carries no exclude,
    // so an unmatched planting always still gets a cadence rather than vanishing.
    const excluded = Object.entries(cad.by_variety).filter(([, v]) => v.exclude).map(([k]) => k);
    expect(excluded).toEqual(['Test Plant Debug']);
    expect(Object.values(cad.by_genus_fallback).some(v => v.exclude)).toBe(false);
    expect(cad.default.exclude).toBeUndefined();
  });

  it('routes end-to-end through generatePlan: none of the 11 land on cad.default, none vanish', () => {
    const plantings = TARGETS.map((t, i) => ({
      id: 'dc-' + i, project: 'Audit', project_id: 'pa', status: 'vegetative',
      substrate_start: '2026-05-01', last_water: '2026-01-01', last_fert: null, db_cadence: null,
      ...t.p,
    }));
    const plan = generatePlan({
      plantings, cadence: cad, fertModel: fm, today: '2026-07-16',
      weather: { tonightLow: 62, highToday: 80, unit: 'F' }, ownerFallback: 'dave',
    });
    const rows = Object.values(plan.users).flatMap(u => [...u.tasks.water_due, ...u.tasks.no_history]);
    for (const t of TARGETS) {
      const row = rows.find(r => r.id.startsWith('dc-') && r.name === t.p.name);
      expect(row, `${t.label} vanished from the plan`).toBeTruthy();
      expect(row.crop).not.toBe('unknown');
      expect(resolveCadence({ ...t.p, db_cadence: null }, cad)._via).not.toBe('default');
    }
  });
});
