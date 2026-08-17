// V4-OVERWINTER-001 — the ENGINE wiring, on the real generatePlan path.
//
// Real-path: engine.generatePlan with the engine's own bundled cadence + fert model, no mocked engine
// internals (same posture as nocalwater.test.js). Every assertion names the source mutation that turns
// it red — the guards in this file must be able to fail, and each comment says how.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { generatePlan } = engine;

// A researched, cadence-BEARING profile: resolveCadence adopts it (cadence_scopes non-empty), so the
// overwintering key arrives via `c`.
const KALE = {
  _seeded: true, crop: 'kale', water_interval_days_container: 3, water_interval_days_inground: 4,
  water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'medium',
  fertilize_interval_days: 14,
};

const P = (o) => withCoverFlags({
  assignee_user_id: 'dave', project: 'Winter Bed', project_id: 'pw', project_status: 'active',
  variety: null, genus: null, container_type: 'raised_bed', container_size: null,
  substrate_start: '2025-01-01', transplant_at: null, last_fert: null, covered: true,
  cadence_scopes: ['leaf'], ...o,
});

// Midwinter. 60 days since the last watering — far past every regime's interval, so the check is due
// and the PRE-change engine would have put this row in water_due.
const WINTER = '2027-01-15';
const planFor = (plantings, today = WINTER) => generatePlan({
  plantings, cadence: cad, fertModel: fm, today,
  weather: { tonightLow: 22, highToday: 34, unit: 'F' },
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave',
}).users.dave;

const inAnyWaterList = (u, id) =>
  [...u.tasks.water_due, ...u.tasks.no_history, ...u.tasks.rain_skipped].some((r) => r.id === id);
// The two overwintering keys are spread CONDITIONALLY (absent, not zero, when nothing overwinters), so
// these two readers normalise "absent" to the empty answer. Every assertion that cares about the
// difference between absent and zero states it explicitly instead of going through these.
const owRows = (u) => u.tasks.overwintering || [];
const owHeld = (u) => u.counts.overwinter_held || 0;

const owned = (kale) => P({ id: 'k1', name: 'Winterbor Kale', status: 'vegetative', last_water: '2026-11-16', db_cadence: { ...KALE, overwintering: kale } });

describe('overwintering holds a planting out of the summer cadence', () => {
  // THE HEADLINE BEHAVIOUR. Mutation: delete the `else if(_ow && _ow.active)` branch from engine.js and
  // the kale reappears in water_due on a 3-day cadence in January — red on the first two assertions.
  it('replaces the water item with a reduced-cadence soil check', () => {
    const u = planFor([owned({ regime: 'protected_productive' })]);
    expect(inAnyWaterList(u, 'k1')).toBe(false);
    expect(u.tasks.overwintering.map((r) => r.id)).toEqual(['k1']);
    expect(u.counts.overwinter_held).toBe(1);
    const it0 = u.tasks.overwintering[0];
    expect(it0.regime).toBe('protected_productive');
    expect(it0.interval).toBe(14);              // max(3 summer, 14 regime)
    expect(it0.exit_due).toBe(false);
  });

  // NOT A SKIP — the distinction from dormant, and the reason this row exists at all. A dry freeze kills
  // more overwintered plants than cold does. Mutation: route overwintering into tasks.dormant (i.e.
  // reuse dormant_skip) and this goes red: the dormant bucket carries no interval and no due state.
  it('is not a skip — the row is still actionable and carries a real interval', () => {
    const u = planFor([owned(true)]);
    expect(u.tasks.dormant.map((r) => r.id)).not.toContain('k1');
    expect(u.tasks.overwintering[0].interval).toBeGreaterThan(0);
    expect(u.tasks.overwintering[0].days_since).toBe(60);
    expect(u.tasks.overwintering[0].reason).toMatch(/water only if dry/i);
  });

  // The cadence is REDUCED, never increased. Mutation: change checkIntervalFor to ignore the base
  // interval and the second assertion goes red.
  it('lengthens the interval and never shortens it', () => {
    const slow = { ...KALE, water_interval_days_inground: 45, overwintering: { regime: 'protected_productive' } };
    const u = planFor([P({ id: 'k2', name: 'Slow', status: 'vegetative', last_water: '2026-11-16', db_cadence: slow })]);
    expect(u.tasks.overwintering[0].interval).toBe(45);
  });

  // Feeding is off for every regime. Mutation: drop the `(_ow && _ow.active) ? null :` guard on the
  // fertilizeRec call and this goes red (the kale is well past its 14-day feed window).
  it('suppresses fertilizing', () => {
    const u = planFor([owned({ regime: 'protected_productive' })]);
    expect(u.tasks.fertilize.map((r) => r.id)).not.toContain('k1');
    const control = planFor([owned({ regime: 'protected_productive' })], '2026-07-15');  // window closed
    expect(control.tasks.fertilize.length).toBeGreaterThan(0);   // ...and the fert path DOES fire otherwise
  });

  // A held planting that was checked recently is NOT carded — otherwise the reduced cadence is a nightly
  // nag with extra words. Mutation: make _dueOw always true and this goes red.
  it('goes quiet between checks, while staying held', () => {
    const recent = P({ id: 'k3', name: 'Checked Kale', status: 'vegetative', last_water: '2026-11-16',
      last_moisture_check: '2027-01-12', db_cadence: { ...KALE, overwintering: true } });
    const u = planFor([recent]);
    expect(owRows(u)).toHaveLength(0);
    expect(u.counts.overwinter_held).toBe(1);       // held, not forgotten — the two counts differ on purpose
    expect(inAnyWaterList(u, 'k3')).toBe(false);
  });

  // A moisture_check satisfies the clock. Mutation: drop last_moisture_check from lastTouch and this
  // goes red — the "still damp" answer would never clear the card.
  it('accepts a soil check, not only a watering, as the reset', () => {
    const checked = P({ id: 'k4', name: 'Kale', status: 'vegetative', last_water: null,
      last_moisture_check: '2027-01-10', db_cadence: { ...KALE, overwintering: true } });
    expect(owRows(planFor([checked]))).toHaveLength(0);
    const stale = P({ ...checked, id: 'k5', last_moisture_check: '2026-12-01' });
    expect(owRows(planFor([stale]))).toHaveLength(1);
  });

  // Never touched at all => DUE. "No history" is not evidence of a damp medium.
  it('cards a planting that has never been watered or checked', () => {
    const u = planFor([P({ id: 'k6', name: 'Kale', status: 'vegetative', last_water: null, db_cadence: { ...KALE, overwintering: true } })]);
    expect(u.tasks.overwintering[0].never).toBe(true);
    expect(inAnyWaterList(u, 'k6')).toBe(false);
  });
});

describe('precedence and inertness', () => {
  // waterSuppression WINS. A Lithops-class profile must not be handed an interval-driven prompt at a
  // longer period — that is the same prompt that killed the plant, just slower. Mutation: swap the
  // `if(_wsup)` and `else if(_ow && _ow.active)` BRANCHES in engine.js and this goes red. (Deleting the
  // `_wsup ?` short-circuit on the `const _ow =` line does NOT turn it red, and correctly so — that
  // expression is an optimisation; the if-chain is what enforces the precedence. Verified by mutation.)
  it('yields to no_calendar_water suppression', () => {
    const lithops = P({ id: 'li1', name: 'Lithops', status: 'vegetative', last_water: '2026-06-24',
      db_cadence: { _seeded: true, crop: 'succulent', no_calendar_water: true, water_interval_days_container: 30, overwintering: { regime: 'tender_indoors' } } });
    const u = planFor([lithops]);
    expect(u.counts.dormancy_suppressed).toBe(1);
    expect(owRows(u)).toHaveLength(0);
    expect(owHeld(u)).toBe(0);
  });

  // dormant still wins over everything — an existing branch that continues before this one is reached.
  it('yields to a dormant status', () => {
    const u = planFor([P({ id: 'd1', name: 'Fig', status: 'dormant', last_water: '2026-06-24', db_cadence: { ...KALE, overwintering: true } })]);
    expect(u.tasks.dormant.map((r) => r.id)).toEqual(['d1']);
    expect(owRows(u)).toHaveLength(0);
  });

  // INERTNESS — why parity stays green with no regenerated goldens: zero leaf-scope care_profile rows
  // exist on prod, so no live planting carries the key. Mutation: default the attribute to present
  // instead of absent and this goes red for every planting in the garden.
  it('is completely inert for a planting with no attribute, in any season', () => {
    // last_water predates every probe date below, so "still in a water list" is a live assertion on
    // all three rather than an artifact of a future-dated fixture.
    const plain = P({ id: 'n1', name: 'Plain Kale', status: 'vegetative', last_water: '2026-06-01', db_cadence: KALE });
    for (const day of ['2027-01-15', '2026-07-04', '2026-11-30']) {
      const u = planFor([plain], day);
      expect(u.tasks.overwintering, day).toBeUndefined();
      expect(u.counts.overwinter_held, day).toBeUndefined();
      expect(inAnyWaterList(u, 'n1'), day).toBe(true);
    }
  });

  // BYTE-IDENTICAL PAYLOAD when nothing overwinters — the property that lets tests/parity stay green
  // with no regenerated goldens, and a stronger inertness proof than a present-and-zero count would be.
  // Mutation: emit the two keys unconditionally and this goes red (and 14 parity goldens go red with it).
  it('adds NO key to the plan payload when nothing in the run overwinters', () => {
    const u = planFor([P({ id: 'n2', name: 'Plain', status: 'vegetative', last_water: '2026-06-01', db_cadence: KALE })]);
    expect(Object.keys(u.counts)).not.toContain('overwintering');
    expect(Object.keys(u.counts)).not.toContain('overwinter_held');
    expect(Object.keys(u.tasks)).not.toContain('overwintering');
  });

  // ...and both keys DO appear together the moment one planting carries the attribute, so the pair is
  // never half-emitted. Mutation: gate the two spreads on different conditions -> red.
  it('emits both keys together as soon as one planting overwinters', () => {
    const u = planFor([owned(true), P({ id: 'n3', name: 'Plain', status: 'vegetative', last_water: '2026-06-01', db_cadence: KALE })]);
    expect(u.counts.overwintering).toBe(1);
    expect(u.counts.overwinter_held).toBe(1);
    expect(Array.isArray(u.tasks.overwintering)).toBe(true);
  });
});

describe('the exit', () => {
  // The window closing IS the exit — no writer, no status, no scheduled job. Mutation: make the engine
  // hold whenever the attribute is present (ignoring the window) and BOTH assertions go red; that
  // mutation is precisely the `dormant` one-way trap this design exists to avoid.
  it('returns the planting to normal care by itself when the light comes back', () => {
    const kale = owned({ regime: 'protected_productive' });
    const held = planFor([kale], '2027-02-02');
    expect(held.counts.overwinter_held).toBe(1);
    const out = planFor([kale], '2027-02-03');
    expect(owHeld(out)).toBe(0);
    expect(inAnyWaterList(out, 'k1')).toBe(true);         // back on the normal cadence, automatically
    expect(owRows(out)).toHaveLength(0);      // and no lingering reminder for an auto regime
  });

  // The manual regimes hold longer and then get a BOUNDED reminder, because Dave has to physically move
  // the pot. Mutation: remove the EXIT_NOTICE_DAYS bound and the final assertion goes red.
  it('reminds once the manual regimes are out, and then stops', () => {
    const fig = P({ id: 'f1', name: 'Garage Fig', status: 'vegetative', last_water: '2026-11-16',
      db_cadence: { ...KALE, overwintering: { regime: 'protected_quiescent' } } });
    expect(planFor([fig], '2027-02-10').counts.overwinter_held).toBe(1);   // still held past the light return
    const notice = planFor([fig], '2027-03-05');
    expect(notice.tasks.overwintering.map((r) => r.exit_due)).toEqual([true]);
    expect(owHeld(notice)).toBe(0);
    expect(inAnyWaterList(notice, 'f1')).toBe(true);       // normal care has ALREADY resumed
    expect(owRows(planFor([fig], '2027-04-01'))).toHaveLength(0);  // and the reminder is bounded
  });
});

// ── the handler seam ──────────────────────────────────────────────────────────────────────────────
// handler.js imports @neondatabase/serverless + @aws-sdk/*, none of which CI installs per-Lambda, so
// no test can import it and every guard on it is source-text — the same constraint doneEvents.js
// documents. Source-text is weak, so this asserts the SHAPE of the subquery, not merely the name:
// a guard that only grepped 'last_moisture_check' would pass on a column aliased from the wrong
// event_type, which is the failure that would matter.
describe('handler supplies last_moisture_check', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'handler.js'), 'utf8');

  // Mutation: rename the alias, or point the subquery at a different event_type, and this goes red.
  // Live consequence of it being absent: engine.overwinter.lastTouch sees only last_water, so a "felt
  // it, still damp" answer never clears the card and the check re-fires every night.
  it('selects the latest non-deleted moisture_check as last_moisture_check', () => {
    const m = src.match(/max\(e\.event_date\)[^)]*?e\.event_type\s*=\s*'moisture_check'[\s\S]{0,120}?as last_moisture_check/);
    expect(m, 'handler.js must alias a max(event_date) over event_type=moisture_check to last_moisture_check').toBeTruthy();
    expect(m[0]).toMatch(/deleted_at is null/);   // soft-deleted checks must not count
  });

  // The engine reads it as a plain 'YYYY-MM-DD' string (lastTouch does a lexicographic compare), so the
  // to_char/UTC shape is load-bearing: the neon driver hands a raw timestamptz back as a JS Date, which
  // crashes daysBetween's iso.slice(0,10). Mutation: drop the to_char and this goes red.
  it('returns it as a YYYY-MM-DD UTC string, matching last_water', () => {
    const line = src.split('\n').find((l) => l.includes('as last_moisture_check'));
    expect(line).toMatch(/to_char\(/);
    expect(line).toMatch(/time zone 'UTC','YYYY-MM-DD'/);
  });
});
