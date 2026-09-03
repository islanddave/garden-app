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

// Same real path, with the weather and hydrology payloads OPENED UP — V4-OVERWINTERCARDNOISE-001 (3)
// gates the field_hardy trigger on both, so a fixed-weather helper cannot exercise it. Defaults match
// planFor exactly (thaw day, bone dry) so a case that overrides neither is the pre-change situation.
const planWith = ({ plantings, today = WINTER, weather, hydrology }) => generatePlan({
  plantings, cadence: cad, fertModel: fm, today,
  weather: { tonightLow: 22, highToday: 34, unit: 'F', ...(weather || {}) },
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, ...(hydrology || {}) },
  ownerFallback: 'dave',
}).users.dave;

const inAnyWaterList = (u, id) =>
  [...u.tasks.water_due, ...u.tasks.no_history, ...u.tasks.rain_skipped].some((r) => r.id === id);
// The two overwintering keys are spread CONDITIONALLY (absent, not zero, when nothing overwinters), so
// these two readers normalise "absent" to the empty answer. Every assertion that cares about the
// difference between absent and zero states it explicitly instead of going through these.
const owRows = (u) => u.tasks.overwintering || [];
const owHeld = (u) => u.counts.overwinter_held || 0;

// PROD COLUMN SHAPE (V4-OVERWINTERCARDNOISE-001): handler selects last_water from
// event_type IN ('watering','rain') and last_hand_water from event_type='watering' alone, so a real
// hand watering lands in BOTH columns and a rain event lands in last_water ONLY. Verified against prod
// 2026-08-20: 698 rain rows, all carrying plant_id. Setting only last_water — as this fixture did
// before — therefore models RAIN, not watering, which is precisely the case the fix now distinguishes.
const owned = (kale) => P({ id: 'k1', name: 'Winterbor Kale', status: 'vegetative',
  last_water: '2026-11-16', last_hand_water: '2026-11-16', db_cadence: { ...KALE, overwintering: kale } });

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

// ── V4-OVERWINTERCARDNOISE-001 — what the cards say, and when they fire ───────────────────────────
// The 0818 boss pass left 14/30/21/7 alone and charged the TRIGGERS and the COPY instead. These are
// the two trigger fixes on the real generatePlan path.

// A garlic bed: field_hardy is the one regime the weather can reach, so it is the only one gated.
const GARLIC = {
  _seeded: true, crop: 'garlic', water_interval_days_container: 3, water_interval_days_inground: 4,
  water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'medium',
  fertilize_interval_days: 14,
};
const garlic = (o) => P({ id: 'g1', name: 'Music Garlic', status: 'vegetative', covered: false,
  container_type: 'raised_bed', db_cadence: { ...GARLIC, overwintering: { regime: 'field_hardy' } }, ...o });

describe('(1) rain does not clear a check under a cover', () => {
  // THE DEFECT, on the real path. handler's last_water is max(event_date) over ('watering','rain'), so
  // a logged rain event used to reset the check clock for a low tunnel — the one structure whose entire
  // job is to keep rain OFF the bed. The two fixtures differ ONLY in which column holds 2027-01-14.
  // Mutation: drop the `_ow` second argument from `ow.lastTouch(p,_ow)` in engine.js and the first
  // assertion goes red (the covered kale silently reads as watered yesterday and no card is emitted).
  it('cards a covered bed whose only recent water was rain', () => {
    const rained = P({ id: 'c1', name: 'Tunnel Kale', status: 'vegetative',
      last_water: '2027-01-14', last_hand_water: null,
      db_cadence: { ...KALE, overwintering: { regime: 'protected_productive' } } });
    const u = planFor([rained]);
    expect(owRows(u).map((r) => r.id)).toEqual(['c1']);
    expect(owRows(u)[0].never).toBe(true);        // rain is not a touch here, so nothing has touched it
  });

  // ...and the gate is not simply "always card": real hand watering still clears it, on the same day.
  // Mutation: make lastTouch ignore last_hand_water entirely and this goes red.
  it('goes quiet when the covered bed was actually hand watered', () => {
    const watered = P({ id: 'c2', name: 'Tunnel Kale', status: 'vegetative',
      last_water: '2027-01-14', last_hand_water: '2027-01-14',
      db_cadence: { ...KALE, overwintering: { regime: 'protected_productive' } } });
    const u = planFor([watered]);
    expect(owRows(u)).toHaveLength(0);
    expect(owHeld(u)).toBe(1);                     // held, just not due
  });

  // REGIME-SCOPED, not blanket. Rain DOES reach open ground, so distrusting it for garlic would be a
  // new defect in the other direction. Mutation: hard-code rain_counts:false for every regime and this
  // goes red — the garlic starts carding one day after a rain that genuinely watered it.
  it('still accepts rain for the one regime rain reaches', () => {
    const u = planFor([garlic({ last_water: '2027-01-14', last_hand_water: null })]);
    expect(owRows(u)).toHaveLength(0);
    expect(owHeld(u)).toBe(1);
  });
});

describe('(3) the field_hardy card only fires on a day it can be acted on', () => {
  // 60 days since anything, so the 21-day check is unambiguously DUE in every case below — the only
  // variable is the weather. Pre-change, all four of these emitted a card.
  const DUE = { last_water: '2026-11-16', last_hand_water: '2026-11-16' };

  // Mutation: delete the `_actOw` branch from engine.js (restoring the unconditional push) and both
  // frozen/wet cases go red. This is the ~109-cards-per-winter alert-fatigue path.
  it('defers on a day that never gets above freezing', () => {
    const u = planWith({ plantings: [garlic(DUE)], weather: { tonightLow: 12, highToday: 28 } });
    expect(owRows(u)).toHaveLength(0);
    expect(u.counts.overwinter_deferred).toBe(1);
    expect(u.counts.overwinter_held).toBe(1);      // still HELD out of the summer cadence, just not carded
    expect(inAnyWaterList(u, 'g1')).toBe(false);
  });

  it('defers when measured rain has already answered the check', () => {
    const u = planWith({ plantings: [garlic(DUE)], weather: { highToday: 46 },
      hydrology: { recent_precip_in: 0.6 } });
    expect(owRows(u)).toHaveLength(0);
    expect(u.counts.overwinter_deferred).toBe(1);
  });

  // THE SLIP PROPERTY — the whole reason a deferral is safe. Nothing is written when a check is
  // deferred, so lastTouch is untouched and the card returns AT FULL OVERDUE on the first workable day.
  // Mutation: reset/advance the touch date on deferral and days_since goes to 0 here — red.
  it('slips the check rather than cancelling it', () => {
    const frozen = planWith({ plantings: [garlic(DUE)], weather: { highToday: 28 } });
    expect(owRows(frozen)).toHaveLength(0);
    const thaw = planWith({ plantings: [garlic(DUE)], weather: { highToday: 40 } });
    expect(owRows(thaw)).toHaveLength(1);
    expect(owRows(thaw)[0].days_since).toBe(60);
    expect(owRows(thaw)[0].overdue_by).toBe(39);   // 60 - 21, i.e. nothing was forgiven by the deferral
    expect(thaw.counts.overwinter_deferred).toBe(0);
  });

  // The gate is field_hardy ONLY. A cold frame is workable on a frozen day (that is what the cover is
  // for) and an indoor pot has no weather at all, so gating them on outdoor temperature would silence
  // the fastest-drying regimes in exactly the conditions that dry them. Mutation: drop the
  // `_ow.regime==='field_hardy'` predicate and both of these go red.
  it('does not gate the protected regimes on outdoor weather', () => {
    const frozen = { tonightLow: 5, highToday: 20 };
    const tunnel = planWith({ weather: frozen, plantings: [P({ id: 'c3', name: 'Tunnel Kale', status: 'vegetative',
      ...DUE, db_cadence: { ...KALE, overwintering: { regime: 'protected_productive' } } })] });
    expect(owRows(tunnel).map((r) => r.id)).toEqual(['c3']);
    const indoors = planWith({ weather: frozen, hydrology: { recent_precip_in: 2.0 },
      plantings: [P({ id: 'c4', name: 'Ginger', status: 'vegetative', ...DUE,
        db_cadence: { ...KALE, overwintering: { regime: 'tender_indoors' } } })] });
    expect(owRows(indoors).map((r) => r.id)).toEqual(['c4']);
  });

  // The new count stays inside the SAME conditional spread as the other two, so the inert payload is
  // still byte-identical for a garden with no overwintering plantings. Mutation: emit
  // overwinter_deferred unconditionally and this goes red (along with 14 parity goldens).
  it('adds no count key when nothing overwinters', () => {
    const u = planFor([P({ id: 'n4', name: 'Plain', status: 'vegetative', last_water: '2026-06-01', db_cadence: KALE })]);
    expect(Object.keys(u.counts)).not.toContain('overwinter_deferred');
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

  // V4-OVERWINTERCARDNOISE-001 (1). The engine cannot distinguish rain from hand watering unless the
  // handler hands it a rain-free column, and lastTouch FAILS OPEN on a missing one — so an absent
  // last_hand_water does not crash, it quietly cards every protected planting nightly. Mutation:
  // rename the alias, or widen the subquery back to IN ('watering','rain'), and this goes red.
  it('selects a rain-free last_hand_water', () => {
    const line = src.split('\n').find((l) => l.includes('as last_hand_water'));
    expect(line, "handler.js must alias a watering-only max(event_date) to last_hand_water").toBeTruthy();
    expect(line).toMatch(/e\.event_type\s*=\s*'watering'/);
    expect(line).not.toMatch(/'rain'/);            // the whole point of the column
    expect(line).toMatch(/deleted_at is null/);
    expect(line).toMatch(/time zone 'UTC','YYYY-MM-DD'/);
  });

  // ...and last_water itself must KEEP the rain arm — field_hardy and every non-overwintering planting
  // still read it, so narrowing it in place would have been a silent behaviour change for the whole
  // garden. Mutation: drop 'rain' from last_water and this goes red.
  it('leaves last_water unioned with rain for everyone else', () => {
    const line = src.split('\n').find((l) => l.includes('as last_water'));
    expect(line).toMatch(/e\.event_type\s+in\s*\('watering',\s*'rain'\)/);
  });
});

// ── V4-DRYDOWNCHANNELLING-001 — the moisture test the card actually states ────────────────────────
// `note` carries the full per-regime guidance, but buildCareNeeded does not copy it onto the row, so
// `reason` is the ONLY overwintering text a user ever reads. It stated one test — the top inch — for
// all four regimes, which is the finger test protected_quiescent was deliberately moved OFF: on a
// leafless pot the top inch is dry long before the core is, and on a peat mix past its wetting agent
// the resulting re-water runs down the shrinkage gap at the wall and out in seconds while the core
// stays dry. The card said "water only if dry below the top inch" and the guidance said "lift the
// pot" — the two rendered surfaces disagreed, and the rendered one was the wrong one.
describe('the card states the regime\'s own moisture test', () => {
  const fig = (o) => P({ id: 'f2', name: 'Garage Fig', status: 'vegetative', last_water: '2026-11-16',
    covered: true, container_type: 'pot',
    db_cadence: { ...KALE, overwintering: { regime: 'protected_quiescent' } }, ...o });

  // Mutation: delete the `_testOw` regime branch in engine.js and the row falls back to the top-inch
  // string for every regime — both assertions go red.
  it('gives a quiescent pot the weight test, never the top inch', () => {
    const r = owRows(planFor([fig()]))[0];
    expect(r.regime).toBe('protected_quiescent');
    expect(r.reason).toMatch(/lift the pot/i);
    expect(r.reason).toMatch(/only until it feels heavier/i);
    expect(r.reason).not.toMatch(/top inch/i);
  });

  // The never-checked variant is a separate string and regressed independently before this.
  // Mutation: revert either arm of the reason ternary and one of these goes red.
  it('states the same test on the never-checked variant', () => {
    const r = owRows(planFor([fig({ last_water: null, last_hand_water: null })]))[0];
    expect(r.never).toBe(true);
    expect(r.reason).toMatch(/lift the pot/i);
    expect(r.reason).not.toMatch(/feel the soil/i);
  });

  // REGIME-SCOPED, not blanket. The top inch is the RIGHT test for a tunnel bed — swapping every regime
  // to the pot-weight test would be a new defect in the other direction, since a raised bed cannot be
  // lifted. Mutation: drop the regime condition from `_testOw` and this goes red.
  it('leaves the in-ground regimes on the soil test', () => {
    const kale = P({ id: 'k9', name: 'Tunnel Kale', status: 'vegetative', last_water: '2026-11-16',
      last_hand_water: '2026-11-16', db_cadence: { ...KALE, overwintering: { regime: 'protected_productive' } } });
    const r = owRows(planFor([kale]))[0];
    expect(r.reason).toMatch(/dry below the top inch/i);
    expect(r.reason).not.toMatch(/lift the pot/i);
  });

  // The rendered card and the canonical guidance must state ONE rule between them — the disagreement
  // above is exactly the failure. Mutation: change either surface alone and this goes red.
  it('agrees with the guidance the same row carries', () => {
    const r = owRows(planFor([fig()]))[0];
    expect(r.note).toMatch(/lift the pot/i);
    expect(r.note).toMatch(/until it feels heavier/i);
    expect(r.reason).toMatch(/until it feels heavier/i);
  });
});
