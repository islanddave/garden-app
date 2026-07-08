// DRG-WXWATER-002 — plan-verdict reconciliation for the plants by-id GET.
//
// The plants by-id GET historically returned em.next_water_at straight from entity_memory (the
// naive per-planting cadence). That diverges from the AUTHORITATIVE daily-plan water verdict that
// the Today page + alert bar consume (queryWaterDueFromPlan): the plan already accounts for
// rain-credit, dormant/harvested skips and fresh-transplant carve-outs. So a planting the plan
// says is satisfied-by-rain still lit an "Overdue" CareStatus band on its detail page — the exact
// bug this closes.
//
// This is the SINGLE-PLANTING mirror of dashboard/handlers.js queryWaterDueFromPlan. It is pure
// (no imports, no I/O) so the static-source-only plants test harness can unit-test it directly.
// The SQL that feeds it (household plans for today + a satisfied-today flag) lives in index.js.
//
// CARETAKER-AGNOSTIC by design (regression finding B1): the daily_plan is keyed per CARETAKER
// user_id, but the by-id GET is household-scoped (viewer may not be the caretaker). Rather than
// re-derive the caretaker (SYSTEM_SUBS + space-owner fallback — drift-prone), we search ALL of the
// household's trusted plans for the plant_id. A plant appears in exactly one caretaker's plan, so a
// hit is unambiguous, and coverage is all-or-nothing per nightly run.
//
// Trust + fallback mirror the bar EXACTLY (DRG-WATERRECON-002): a plan is trusted when its stamped
// schema_version is NULL (pre-stamp legacy row, shape == current) or === PLAN_SCHEMA_VERSION. A
// present-but-different version, or no plan row at all, falls back to the naive em.next_water_at so
// the band NEVER blanks on an engine-skip window — flagged via water_due_source so the otherwise-
// silent divergence is observable.
//
// Kept in lockstep with lambda/daily-plan/engine.js by waterVerdict.test.js (anti-drift pin).
export const PLAN_SCHEMA_VERSION = 1;

// Reconcile a single planting's care-band schedule against the stored plan verdict.
// Only the DIVERGENCE is corrected: a stale past schedule the plan says is NOT due is suppressed
// (-> null -> CareStatus renders nothing), and a plant the plan says IS due is forced to a past
// timestamp so the band shows. A genuinely-future schedule is left untouched (no divergence, and
// PlantingDetail's "Next watering" date cell keeps its preview). Legacy/mismatch -> unchanged.
//
//   nextWaterAt    string|null  em.next_water_at (ISO)
//   planRows       array|null   [{ sv:int|null, water_due:array }] household daily_plan rows for today (ET)
//   satisfiedToday boolean      a watering/rain event_log row for this plant today (ET)
//   plantId        string       garden_node id
//   now            number       ms epoch (injectable for tests)
// -> { next_water_at, water_due_source }  water_due_source in {'plan','legacy','schema_mismatch'}
export function reconcileNextWaterAt({ nextWaterAt, planRows, satisfiedToday, plantId, now = Date.now() }) {
  const rows = Array.isArray(planRows) ? planRows : [];
  if (rows.length === 0) return { next_water_at: nextWaterAt, water_due_source: 'legacy' };

  const trusted = rows.filter((r) => r && (r.sv == null || r.sv === PLAN_SCHEMA_VERSION));
  if (trusted.length === 0) return { next_water_at: nextWaterAt, water_due_source: 'schema_mismatch' };

  let elem = null;
  for (const r of trusted) {
    const wd = Array.isArray(r.water_due) ? r.water_due : [];
    const hit = wd.find((e) => e && String(e.id) === String(plantId));
    if (hit) { elem = hit; break; }
  }

  const due = elem != null && !satisfiedToday;
  if (due) {
    const ob = Number(elem.overdue_by);
    const nwa = Number.isFinite(ob)
      ? new Date(now - ob * 86400000).toISOString()   // now - overdue_by days (== the scheduled date by construction)
      : new Date(now).toISOString();                  // never/no-interval plant: due now
    return { next_water_at: nwa, water_due_source: 'plan' };
  }

  // CALM per the trusted plan (not due, dormant/rain-satisfied, or watered today):
  // suppress ONLY a stale PAST schedule; preserve a future one.
  const past = nextWaterAt != null && new Date(nextWaterAt).getTime() <= now;
  return { next_water_at: past ? null : nextWaterAt, water_due_source: 'plan' };
}
