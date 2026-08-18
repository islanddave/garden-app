// DRG-BACKBONE-001 P0 / G-PARITY — parity gate + harness self-tests.
//
// Two jobs:
//   (1) REGRESSION GATE — replay every frozen fixture through the current daily-plan engine, canonicalize,
//       and assert it matches the committed golden. In P0 (engine unchanged) this pins current behavior; at
//       the system-of-record cutover the SAME goldens catch any divergence introduced by routing the nightly
//       generator through shared engine code (§13 G-PARITY exit gate).
//   (2) HARNESS SELF-TESTS — prove the comparator/canonicalizer/allowlist/divergence-detector actually WORK,
//       including FAULT INJECTION (a deliberately mutated plan MUST produce a blocking divergence). A green
//       parity gate is only meaningful if the harness can fail on a real diff (L-146 falsifiability).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scenarios, planFor } from './fixtures.mjs';
import { canonicalize, canonicalJSON } from './canonicalize.mjs';
import { compare } from './compare.mjs';
import { detectDivergence } from './shadow-divergence.mjs';
import { isBenignPath, matchGlob } from './allowlist.mjs';

// Resolve from cwd (repo root) — robust under vitest's module transform AND in CI (npm test runs at root).
const goldenPath = (name) => resolve(process.cwd(), 'tests/parity/daily-plan/golden', `${name}.json`);
const loadGolden = (name) => JSON.parse(readFileSync(goldenPath(name), 'utf8'));

describe('G-PARITY regression gate — engine output matches committed goldens', () => {
  it('has at least the documented branch-coverage scenarios', () => {
    const names = scenarios.map((s) => s.name);
    for (const required of ['rain-credit-skip', 'fresh-transplant-no-credit', 'fabric-bag-heat-gate',
      'harvested-keep-water', 'planning-excluded', 'wx-freeze-coldprotect', 'wx-heat-and-rain-status', 'baseline-mixed',
      // BUG-TODAYWATER-001: today-qualifying inputs — without these the gate is blind to the today branch.
      'today-moderate-flagoff', 'today-moderate-flagon', 'today-heavy-flagoff', 'today-heavy-flagon',
      // DRG-NOCALWATER-001: profile-declared watering suppression (incl. the live unseeded-profile shape).
      'dormancy-suppressed',
      // BUG-PARITYFLAGBLIND-001: rain-credit flag pairs — without the -flagon halves nothing in this gate
      // reaches RAIN_TIER_IA / RAIN_TIER_HOLD / rainTierFor, which is the configuration prod runs.
      'rain-tier-knife-flagoff', 'rain-tier-knife-flagon',
      'rain-tier-vessels-flagoff', 'rain-tier-vessels-flagon',
      // BUG-RAINCREDITLIVEPATH-001: KNIFE and VESSELS reach the tier path but only its small_fast/in_ground
      // rows, so the size-gated fabric_ground row added by that fix was still unreachable from this gate.
      'rain-tier-fabric-flagoff', 'rain-tier-fabric-flagon',
      // BUG-CADENCESIZE-001: the vessel floor. Without this the gate carries no trough, no whiskey_barrel
      // and no rigid pot >= largeMinGal, so dailyFloorFor could be deleted without moving a golden.
      // NOT a flag pair, deliberately — see the divergence loop below.
      'vessel-floor']) {
      expect(names).toContain(required);
    }
  });

  // BUG-PARITYFLAGBLIND-001 — the gate stayed 30/30 green through six mutations of the tier tables because
  // planFor never passed rainCreditEnabled, so every scenario silently took the flag's `=false` default while
  // prod ran it true. These two tests make the omission loud instead of silent: the first forbids relying on
  // the default, the second proves the flag-ON goldens actually pin a DIFFERENT plan (a flag that changes
  // nothing observable is coverage on paper only).
  it('every scenario declares rainCreditEnabled explicitly (no silent default)', () => {
    for (const s of scenarios) {
      expect(typeof s.input.rainCreditEnabled, `${s.name} must declare rainCreditEnabled`).toBe('boolean');
    }
    expect(scenarios.filter((s) => s.input.rainCreditEnabled === true).length).toBeGreaterThanOrEqual(2);
  });

  // BUG-CADENCESIZE-001: `vessel-floor` is deliberately NOT in this loop. It is a single scenario, not a
  // flag pair: it carries zero rain in the window precisely so that nothing but the vessel floor separates
  // its seven plantings, which means rainCreditEnabled changes no verdict in it and a paired golden would
  // be byte-identical. Adding it here would fail; adding rain to make it pass would destroy the isolation
  // that lets it pin the floor at all. Its non-vacuity is proven the other way — by mutation of
  // dailyFloorFor, recorded in cadencesize-IMPL.md — not by a flag delta.
  it('each rain-tier flag pair diverges — the flag-ON goldens are non-vacuous', () => {
    for (const base of ['rain-tier-knife', 'rain-tier-vessels', 'rain-tier-fabric']) {
      const off = canonicalJSON(canonicalize(planFor(`${base}-flagoff`)));
      const on = canonicalJSON(canonicalize(planFor(`${base}-flagon`)));
      expect(on, `${base}: flag ON produced the flag-OFF plan`).not.toBe(off);
    }
  });

  for (const s of scenarios) {
    it(`parity: ${s.name}`, () => {
      const fresh = canonicalize(planFor(s));
      const golden = loadGolden(s.name);
      const { equal, blocking } = compare(golden, fresh, { canon: false }); // golden already canonical on disk
      if (!equal) console.error(`Non-allowlisted diffs for ${s.name}:\n` + JSON.stringify(blocking, null, 2));
      expect(blocking).toEqual([]);
      expect(equal).toBe(true);
    });
  }

  it('committed goldens are byte-stable under recapture (no uncommitted golden drift)', () => {
    for (const s of scenarios) {
      const regenerated = JSON.stringify(canonicalize(planFor(s)), null, 2) + '\n';
      const onDisk = readFileSync(goldenPath(s.name), 'utf8');
      expect(regenerated).toBe(onDisk);
    }
  });
});

describe('canonicalize — stable + idempotent', () => {
  it('is idempotent', () => {
    const plan = planFor('baseline-mixed');
    const once = canonicalize(plan);
    const twice = canonicalize(once);
    expect(twice).toEqual(once);
  });
  it('sorts array rows by id so presentation order does not affect equality', () => {
    const a = { tasks: [{ id: 'b', v: 1 }, { id: 'a', v: 2 }] };
    const b = { tasks: [{ id: 'a', v: 2 }, { id: 'b', v: 1 }] };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
  it('rounds floats to kill aggregation drift', () => {
    expect(canonicalize(0.1 + 0.2)).toBe(0.3);
  });
  it('truncates ISO timestamps to day granularity', () => {
    expect(canonicalize('2026-06-29T21:54:13.123Z')).toBe('2026-06-29');
  });
});

describe('compare — tolerance + allowlist', () => {
  it('reports a semantic value diff as blocking', () => {
    const g = { users: { dave: { counts: { water_due: 1 } } } };
    const c = { users: { dave: { counts: { water_due: 2 } } } };
    const r = compare(g, c);
    expect(r.equal).toBe(false);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].path).toBe('users.dave.counts.water_due');
  });
  it('treats an allowlisted timestamp diff as benign, not blocking', () => {
    const g = { date: '2026-06-20', generated_at: '2026-06-20T02:00:00Z' };
    const c = { date: '2026-06-20', generated_at: '2026-06-20T02:05:00Z' }; // same day after truncation -> no diff at all
    const r = compare(g, c);
    expect(r.equal).toBe(true);
  });
  it('a same-day-different-time timestamp produces zero diff after canonicalization', () => {
    const g = { created_at: '2026-06-20T02:00:00Z' };
    const c = { created_at: '2026-06-21T02:00:00Z' }; // different DAY -> would diff, but path is allowlisted
    const r = compare(g, c);
    expect(r.blocking).toHaveLength(0);
    expect(r.benign).toHaveLength(1);
  });
  it('honors a numeric tolerance band', () => {
    const r = compare({ x: 1.0 }, { x: 1.0000004 }, { tolerance: 1e-3, canon: false });
    expect(r.equal).toBe(true);
  });
  it('detects added / removed array rows by id', () => {
    const g = { t: [{ id: 'a' }] };
    const c = { t: [{ id: 'a' }, { id: 'b' }] };
    const r = compare(g, c);
    expect(r.blocking.some((d) => d.type === 'added' && d.path === 't#b')).toBe(true);
  });
});

describe('allowlist glob', () => {
  it('** matches at any depth', () => {
    expect(matchGlob('**.created_at', 'users.dave.created_at')).toBe(true);
    expect(isBenignPath('a.b.c.updated_at')).toBe(true);
  });
  it('does not over-match semantic fields', () => {
    expect(isBenignPath('users.dave.counts.water_due')).toBe(false);
    expect(isBenignPath('users.dave.tasks.water_due#w1.interval')).toBe(false);
  });
});

describe('shadow-divergence detector — FALSIFIABILITY (must fail on a real diff)', () => {
  it('identical live vs shadow -> not blocking', () => {
    const plan = planFor('baseline-mixed');
    const d = detectDivergence(plan, structuredClone(plan));
    expect(d.blocking).toBe(false);
    expect(d.counts.blocking).toBe(0);
    expect(d.report).toContain('PARITY OK');
  });
  it('FAULT INJECTION: a mutated water-due count is caught as blocking + paged', () => {
    const live = planFor('baseline-mixed');
    const shadow = structuredClone(live);
    shadow.users.dave.counts.water_due = 999;                 // inject a regression
    const d = detectDivergence(live, shadow);
    expect(d.blocking).toBe(true);
    expect(d.counts.blocking).toBeGreaterThan(0);
    expect(d.report).toContain('PARITY BLOCKED');
  });
  it('FAULT INJECTION: a changed rain-credit reason string is caught', () => {
    const live = planFor('rain-credit-skip');
    const shadow = structuredClone(live);
    shadow.users.dave.tasks.rain_skipped[0].reason = 'tampered reason';
    const d = detectDivergence(live, shadow);
    expect(d.blocking).toBe(true);
  });
  it('a benign-only divergence (timestamp) does NOT block', () => {
    const live = { date: '2026-06-20', generated_at: '2026-06-20T02:00:00Z', users: {} };
    const shadow = { date: '2026-06-20', generated_at: '2026-06-21T09:30:00Z', users: {} };
    const d = detectDivergence(live, shadow);
    expect(d.blocking).toBe(false);
    expect(d.counts.benign).toBe(1);
  });
});
