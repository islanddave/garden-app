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
