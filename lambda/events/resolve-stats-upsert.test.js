// PATCH /api/events/:id resolve path — user_stats row-safety guard (data-audit P1-code, 2026-07-28).
// ROOT CAUSE (evidence W0.2-r1 user-stats-write-sites): the resolve path's stats_xp CTE was a
// plain UPDATE user_stats — when the user had NO user_stats row, achievement XP landed in the
// xp_events ledger but user_stats silently no-oped (live drift: 1 user, 275 ledger XP, no row).
// Fix: stats_xp is now an INSERT..ON CONFLICT (user_id) DO UPDATE upsert (same self-healing
// shape as the POST path's Step-3a streak upsert), explicitly initializing every NOT-NULL
// user_stats column without a usable default (user_id, xp, level, current_streak,
// longest_streak, total_events; created_at/updated_at carry now() defaults, last_active_date
// is nullable and owned by the POST-path upsert). NOT-NULL set verified against live Neon
// information_schema 2026-07-28.
//
// Static-source per L-072 house style. Handler-invocation tests are NOT feasible in this
// suite: the lambda runtime deps (@neondatabase/serverless, @clerk/backend, @aws-sdk/*) are
// intentionally absent from the root install — main ci.yml never installs them (only
// integration-test.yml adds them --no-save), so any test importing lambda index.js fails
// import-resolution in CI.
// WHAT THIS PROVES: the resolve-path achievement CTE (uniquely anchored by its
// trigger_type = 'issue_resolve_count' predicate) sends a row-creating upsert with the exact
// live-Neon-verified NOT-NULL column set, and no row-presuming bare UPDATE remains on the
// PATCH path. WHAT IT DOES NOT PROVE: that Postgres executes the upsert correctly —
// DB-semantics coverage stays with the integration backlog (tests/integration/).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The SQL predicate below appears ONLY in the PATCH-resolve achievement evaluator (the POST
// Step-3b CASE covers streak_days/event_type_count/time_of_day/multi_per_day, never
// issue_resolve_count — "resolve-path-only by design").
const anchor = SRC.indexOf("a.trigger_type = 'issue_resolve_count'");
const resolveCte = SRC.slice(anchor, anchor + 3000);

describe('PATCH /api/events/:id resolve — user_stats upsert (row-safe when no row exists)', () => {
  it('anchor: the resolve-path achievement CTE exists exactly once', () => {
    expect(anchor).toBeGreaterThan(-1);
    expect(SRC.indexOf("a.trigger_type = 'issue_resolve_count'", anchor + 1)).toBe(-1);
  });

  it('resolve-path stats_xp is an INSERT..ON CONFLICT upsert initializing all NOT-NULL columns', () => {
    // Row-creating upsert with the live-Neon-verified NOT-NULL column set:
    expect(resolveCte).toMatch(/INSERT INTO user_stats\s*\(user_id, xp, level, current_streak, longest_streak, total_events, updated_at\)/);
    expect(resolveCte).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    // Existing rows accumulate the granted XP exactly as the old UPDATE did:
    expect(resolveCte).toMatch(/xp = user_stats\.xp \+ EXCLUDED\.xp/);
    // Only touches user_stats when XP was actually granted (preserves old guard semantics):
    expect(resolveCte).toMatch(/WHERE EXISTS \(SELECT 1 FROM xp_grants\)/);
  });

  it('THE BUG is gone: no row-presuming bare UPDATE user_stats on the resolve path', () => {
    expect(resolveCte).not.toMatch(/UPDATE user_stats/);
  });

  it('bare "UPDATE user_stats" survives ONLY at the 2 POST-path sites', () => {
    // POST path: Step-3b achievement eval (gated on Step-3a upsert success -> row exists) and
    // Step-4 flat XP (row exists unless Step-3a's upsert itself threw — degraded-DB mode,
    // self-healing on next POST + P1-data backfill). PATCH path must have zero.
    const bareUpdates = (SRC.match(/UPDATE user_stats/g) || []).length;
    expect(bareUpdates).toBe(2);
  });
});
