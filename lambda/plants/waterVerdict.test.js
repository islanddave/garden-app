// DRG-WXWATER-002 — unit tests for the single-planting plan-verdict reconciliation.
// Pure-function tests (the plants Lambda has no handler split; index.js imports @neondatabase/
// serverless + @clerk/backend + @aws-sdk/* at module load, so only pure modules are unit-testable).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileNextWaterAt, PLAN_SCHEMA_VERSION } from './waterVerdict.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-07-08T18:00:00Z');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const PID = 'plant-abc';
const planRow = (water_due, sv = PLAN_SCHEMA_VERSION) => ({ sv, water_due });

describe('reconcileNextWaterAt — trusted plan', () => {
  it('T1 due (in water_due, not satisfied) -> plan, forces schedule from overdue_by', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: iso(NOW - 2 * DAY), plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [planRow([{ id: PID, overdue_by: 3 }])],
    });
    expect(r.water_due_source).toBe('plan');
    expect(Date.parse(r.next_water_at)).toBe(NOW - 3 * DAY); // still past -> band shows
  });

  it('T2 satisfied-by-rain (absent from water_due) + stale PAST em -> CALM (null)', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: iso(NOW - 2 * DAY), plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [planRow([{ id: 'other', overdue_by: 1 }])], // this plant NOT listed => plan says not due
    });
    expect(r).toEqual({ next_water_at: null, water_due_source: 'plan' });
  });

  it('T3 dormant (absent from water_due) -> CALM null regardless of stale em', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: iso(NOW - 10 * DAY), plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [planRow([])],
    });
    expect(r).toEqual({ next_water_at: null, water_due_source: 'plan' });
  });

  it('T6 in water_due but a watering/rain event logged today -> drops out (CALM null)', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: iso(NOW - 2 * DAY), plantId: PID, satisfiedToday: true, now: NOW,
      planRows: [planRow([{ id: PID, overdue_by: 3 }])],
    });
    expect(r).toEqual({ next_water_at: null, water_due_source: 'plan' });
  });

  it('CALM but FUTURE schedule -> preserved (no divergence, keeps "Next watering" preview)', () => {
    const future = iso(NOW + 3 * DAY);
    const r = reconcileNextWaterAt({
      nextWaterAt: future, plantId: PID, satisfiedToday: false, now: NOW, planRows: [planRow([])],
    });
    expect(r).toEqual({ next_water_at: future, water_due_source: 'plan' });
  });

  it('due with null overdue_by (never-watered plant) -> due now', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: null, plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [planRow([{ id: PID, overdue_by: null, never: true }])],
    });
    expect(r.water_due_source).toBe('plan');
    expect(Date.parse(r.next_water_at)).toBe(NOW);
  });

  it('T8 caretaker != viewer: plant found in a DIFFERENT household plan row', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: iso(NOW - 5 * DAY), plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [planRow([{ id: 'x' }]), planRow([{ id: PID, overdue_by: 2 }])], // 2nd row = other caretaker
    });
    expect(r.water_due_source).toBe('plan');
    expect(Date.parse(r.next_water_at)).toBe(NOW - 2 * DAY);
  });

  it('malformed water_due (non-array) is tolerated -> CALM null for a stale schedule', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: iso(NOW - 2 * DAY), plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [{ sv: PLAN_SCHEMA_VERSION, water_due: null }],
    });
    expect(r).toEqual({ next_water_at: null, water_due_source: 'plan' });
  });
});

describe('reconcileNextWaterAt — fallback (behavior-preserving)', () => {
  it('T4 no plan row for today -> legacy, em.next_water_at byte-identical', () => {
    const em = iso(NOW - 2 * DAY);
    expect(reconcileNextWaterAt({ nextWaterAt: em, plantId: PID, satisfiedToday: false, now: NOW, planRows: null }))
      .toEqual({ next_water_at: em, water_due_source: 'legacy' });
    expect(reconcileNextWaterAt({ nextWaterAt: em, plantId: PID, satisfiedToday: false, now: NOW, planRows: [] }))
      .toEqual({ next_water_at: em, water_due_source: 'legacy' });
  });

  it('T5 schema_mismatch (present but different version) -> legacy fallback, NOT trusted', () => {
    const em = iso(NOW - 2 * DAY);
    const r = reconcileNextWaterAt({
      nextWaterAt: em, plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [planRow([{ id: PID, overdue_by: 3 }], PLAN_SCHEMA_VERSION + 1)],
    });
    expect(r).toEqual({ next_water_at: em, water_due_source: 'schema_mismatch' });
  });

  it('sv NULL (pre-stamp legacy row) IS trusted (shape == current)', () => {
    const r = reconcileNextWaterAt({
      nextWaterAt: iso(NOW - 2 * DAY), plantId: PID, satisfiedToday: false, now: NOW,
      planRows: [planRow([], null)],
    });
    expect(r.water_due_source).toBe('plan'); // trusted -> CALM
    expect(r.next_water_at).toBeNull();
  });
});

describe('anti-drift', () => {
  it('PLAN_SCHEMA_VERSION is pinned to lambda/daily-plan/engine.js', () => {
    const engineSrc = readFileSync(resolve(__dirname, '../daily-plan/engine.js'), 'utf8');
    const m = engineSrc.match(/const\s+PLAN_SCHEMA_VERSION\s*=\s*(\d+)/);
    expect(m, 'PLAN_SCHEMA_VERSION literal not found in engine.js').not.toBeNull();
    expect(Number(m[1])).toBe(PLAN_SCHEMA_VERSION);
  });
});
