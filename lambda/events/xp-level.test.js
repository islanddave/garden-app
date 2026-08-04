// xp-level.test.js — BUG-XPPROGRESSION-001, static-source guards (L-072 house pattern).
//
// The behavioural half of this change is pinned in batch-side-effects.test.js against the recording
// sql mock. What CANNOT be pinned that way is the shape of the single-event path: importing
// lambda/events/index.js is not feasible in this suite (its runtime deps — @neondatabase/serverless,
// @clerk/backend, @aws-sdk/* — are deliberately absent from the root install; only
// integration-test.yml adds them --no-save). So the single path gets source-shape assertions, the
// same trade resolve-stats-upsert.test.js and hs2-plant-filter.test.js already make.
//
// WHAT THIS PROVES: the level branch exists in BOTH evaluators and is byte-identical; the XP grant
// precedes the evaluation in BOTH paths (so a level achievement cannot fire an action late); no
// Lambda computes a level or emits a retired XP reason.
// WHAT IT DOES NOT PROVE: that the curve is right, or that Postgres evaluates any of it correctly.
// Those live in migrations/v4-xpprogression-001/gates.yml and tests/integration/xp-level.int.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const FX  = readFileSync(resolve(__dirname, 'batchSideEffects.js'), 'utf8');
const RECONCILE = readFileSync(resolve(__dirname, '../xp-reconcile/index.js'), 'utf8');
const DASH = readFileSync(resolve(__dirname, '../dashboard/handlers.js'), 'utf8');

const LEVEL_BRANCH = "WHEN 'level'";

describe('the level branch exists in every evaluator that can grant an achievement', () => {
  it('the single path (POST) evaluator carries it', () => {
    expect(SRC).toContain(LEVEL_BRANCH);
    expect(SRC).toMatch(/WHEN 'level'\s+THEN \$\{levelVal\}::int\s+>= \(a\.trigger_value->>'level'\)::int/);
  });

  it('the batch path evaluator carries it', () => {
    expect(FX).toContain(LEVEL_BRANCH);
    expect(FX).toMatch(/WHEN 'level'\s+THEN \$\{levelVal\}::int\s+>= \(a\.trigger_value->>'level'\)::int/);
  });

  it('the two copies are byte-identical — divergence between them is the recurring defect', () => {
    const pick = (s) => s.match(/WHEN 'level'\s+THEN[^\n]*\n/)[0].trim();
    expect(pick(SRC)).toBe(pick(FX));
  });

  it('reads trigger_value->>\'level\', the key the live level_5/level_9 rows actually use', () => {
    // Live prod: level_5 {"level": 5}, level_9 {"level": 9}. src/pages/Achievements.jsx has been
    // rendering `Reach level ${tv.level}` against this same key the whole time.
    for (const s of [SRC, FX]) expect(s).toContain("(a.trigger_value->>'level')::int");
  });

  it('does not disturb the five trigger types that already worked', () => {
    for (const s of [SRC, FX]) {
      for (const t of ['streak', 'event_count', 'event_type_count', 'time_of_day', 'multi_per_day']) {
        expect(s).toContain(`WHEN '${t}'`);
      }
      expect(s).toContain('ELSE false');
    }
  });
});

describe('ORDERING: XP moves before the evaluator judges it', () => {
  // This is the difference between level_5 firing on the action that earns it and firing one
  // logging action later — which, for a user who logs on 8 days out of 120, can mean never.
  it('single path: the flat XP grant block precedes the achievement evaluation block', () => {
    const flat = SRC.indexOf('Step 3b: flat XP grant');
    const ach  = SRC.indexOf('Step 3c: inline achievement evaluation');
    expect(flat).toBeGreaterThan(-1);
    expect(ach).toBeGreaterThan(-1);
    expect(flat).toBeLessThan(ach);
  });

  it('batch path: same order', () => {
    const flat = FX.indexOf('Step 3: flat XP grant');
    const ach  = FX.indexOf('Step 4: achievement evaluation');
    expect(flat).toBeGreaterThan(-1);
    expect(ach).toBeGreaterThan(-1);
    expect(flat).toBeLessThan(ach);
  });

  it('the interpolated levelVal is assigned before the evaluator SQL that consumes it', () => {
    // Anchored on the CASE branch itself, not on the bare string — index.js's Step-3b header
    // discusses "WHEN 'level'" in prose that appears earlier in the file, and matching that
    // instead is exactly the false negative this comment exists to prevent.
    const BRANCH_SQL = /WHEN 'level'\s+THEN \$\{levelVal\}::int/;
    for (const s of [SRC, FX]) {
      const assign = s.indexOf('const levelVal');
      const use = s.search(BRANCH_SQL);
      expect(assign).toBeGreaterThan(-1);
      expect(use).toBeGreaterThan(-1);
      expect(assign).toBeLessThan(use);
    }
  });
});

describe('level is DERIVED by the database, never computed in a Lambda', () => {
  const LAMBDA_DIR = resolve(__dirname, '..');

  function jsFiles(dir, acc = []) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) jsFiles(p, acc);
      else if (name.endsWith('.js') && !name.endsWith('.test.js')) acc.push(p);
    }
    return acc;
  }

  it('no Lambda contains a level threshold table or a level formula', () => {
    // The historical ladder lived in src/lib/garden-ops.js as a LEVEL_THRESHOLDS array before
    // DB-MIGRATE-2 gutted that file. Re-introducing one anywhere server-side would put the curve
    // in two places again — which is the entire defect class this ticket closed.
    for (const f of jsFiles(LAMBDA_DIR)) {
      const s = readFileSync(f, 'utf8');
      expect(s, `${f} declares a level threshold table`).not.toMatch(/LEVEL_THRESHOLDS/);
      expect(s, `${f} defines its own xpToLevel`).not.toMatch(/function\s+xpToLevel|xpToLevel\s*=/);
    }
  });

  it('no Lambda writes user_stats.level — the trigger owns that column', () => {
    for (const f of jsFiles(LAMBDA_DIR)) {
      const s = readFileSync(f, 'utf8');
      expect(s, `${f} assigns user_stats.level`).not.toMatch(/SET\s+level\s*=/i);
      expect(s, `${f} sets level in an ON CONFLICT clause`).not.toMatch(/DO UPDATE SET[^`]*\blevel\s*=/i);
    }
  });

  it('both paths READ level back from a RETURNING clause instead', () => {
    expect(SRC).toMatch(/RETURNING current_streak, total_events, level/);
    expect(FX).toMatch(/RETURNING current_streak, total_events, level/);
    expect(SRC).toMatch(/RETURNING xp, level/);
    expect(FX).toMatch(/RETURNING xp, level/);
  });

  it('the reconciler still heals xp only, and lets the trigger re-derive level', () => {
    // Adding `level =` to this UPDATE would be a second copy of the curve in the one place that
    // rewrites xp outside the request path.
    expect(RECONCILE).toMatch(/SET xp = COALESCE\(\(SELECT SUM\(amount\)::int/);
    expect(RECONCILE).not.toMatch(/SET[^`]*\blevel\s*=/i);
    expect(RECONCILE).toMatch(/RETURNING user_id, xp, level/);
  });

  it('the dashboard derives its progress fields from the canonical SQL functions', () => {
    expect(DASH).toMatch(/public\.xp_level_floor\(level\)/);
    expect(DASH).toMatch(/public\.xp_level_floor\(level \+ 1\)/);
    expect(DASH).toMatch(/\blevel,/);
  });
});

describe('both response contracts expose the level (an invisible level is still dead content)', () => {
  it('the single-event POST returns level and leveled_up', () => {
    const respBlock = SRC.slice(SRC.indexOf('daily_xp_remaining: flatXpResult.daily_xp_remaining'));
    expect(respBlock).toMatch(/level: levelAfter/);
    expect(respBlock).toMatch(/leveled_up:/);
  });

  it('the batch path returns the same two keys', () => {
    expect(FX).toMatch(/out\.level = levelAfter/);
    expect(FX).toMatch(/out\.leveled_up =/);
  });

  it('leveled_up compares two readings and is false when either is unknown', () => {
    // A null level must never render as a level-0 demotion, and a missing reading must never be
    // treated as "levelled up from nothing". The two paths name the "before" reading differently
    // (achievementResult.level_before vs levelBefore), so assert the guard's shape, not its
    // identifiers: both operands null-checked, then a strict >.
    for (const s of [SRC, FX]) {
      expect(s).toMatch(/levelAfter != null/);
      expect(s).toMatch(/level_?[Bb]efore != null/);
      expect(s).toMatch(/levelAfter > (achievementResult\.level_before|levelBefore)/);
    }
  });
});

describe('photo_bonus is RETIRED — no third dead XP reason is left behind', () => {
  const LAMBDA_DIR = resolve(__dirname, '..');
  const SRC_DIR = resolve(__dirname, '../../src');

  function jsFiles(dir, acc = []) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) jsFiles(p, acc);
      else if (/\.(js|jsx)$/.test(name) && !/\.test\.jsx?$/.test(name)) acc.push(p);
    }
    return acc;
  }

  it('no Lambda and no client file emits the retired reason', () => {
    // Measured live prod 2026-08-04: 10 rows, 50 XP, all 2026-04-23..26, all belonging to a third
    // user_id that has no user_stats row. Zero rows in the last 90 days. The decision (recorded in
    // migrations/v4-xpprogression-001/0a) is RETIRE the concept, KEEP the rows — wiring it would
    // need the grant to live in lambda/photos and would award per-photo XP, which is the per-EVENT
    // grain that "one logging action = one shot at the reward" forbids.
    for (const f of [...jsFiles(LAMBDA_DIR), ...jsFiles(SRC_DIR)]) {
      expect(readFileSync(f, 'utf8'), `${f} references photo_bonus`).not.toContain('photo_bonus');
    }
  });

  it('the only XP reasons any Lambda writes are the two live ones', () => {
    // Catches a fourth reason being introduced without a decision, which is how the third one got
    // here. Reasons are only ever written as a literal in an INSERT INTO xp_events.
    const found = new Set();
    for (const f of jsFiles(LAMBDA_DIR)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/'(event_logged|achievement_earned|photo_bonus|[a-z_]+)'\s*,\s*\$\{?\w*\}?[^\n]*\n/g)) {
        void m;
      }
      for (const m of s.matchAll(/,\s*'([a-z][a-z_]+)'\s*,\s*\$\{(?:eventId|batchId)\}/g)) found.add(m[1]);
      for (const m of s.matchAll(/,\s*'([a-z][a-z_]+)',\s*i\.achievement_id/g)) found.add(m[1]);
    }
    expect([...found].sort()).toEqual(['achievement_earned', 'event_logged']);
  });

  it('the historical rows are deliberately preserved, and the migration says why', () => {
    const mig = readFileSync(
      resolve(__dirname, '../../migrations/v4-xpprogression-001/0a-level-curve.sql'), 'utf8');
    expect(mig).toContain('photo_bonus');
    expect(mig).toMatch(/RETIRE the concept, KEEP the rows/);
    // Deleting them would make xp-reconcile "heal" a balance that was never wrong.
    expect(mig).not.toMatch(/DELETE FROM (public\.)?xp_events/);
  });
});
