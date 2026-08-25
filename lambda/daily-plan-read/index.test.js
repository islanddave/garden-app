// Static-source regression guard for the daily-plan read-model handler (DRG-TODAY-002).
// Static (not import): index.js imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module
// load, which the jsdom unit run cannot resolve (same constraint as findings/index.test.js). Guards the
// load-bearing read-path invariants: GET-only, Clerk-authed, PER-USER, soft-delete-filtered, READ-ONLY,
// server-computed plan_date.
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

describe('daily-plan-read Lambda — static read-path invariants', () => {
  const stmts = SRC.match(/sql`[\s\S]*?`/g) || [];

  it('authenticates with Clerk verifyToken against CLERK_SECRET_KEY', () => {
    expect(SRC).toMatch(/verifyToken\(/);
    expect(SRC).toMatch(/secretKey:\s*secrets\.CLERK_SECRET_KEY/);
  });

  it('is READ-ONLY — four SELECTs (plan read + V3-TODAYDONE-001 done-derivation + V4-ASSIGNLENS household read + BUG-BACKDATEDFEED-001 feed-cadence read), no write verbs', () => {
    expect(stmts.length).toBe(4);
    for (const s of stmts) expect(s).toMatch(/SELECT/);
    for (const s of stmts) expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i);
  });

  it('V3-TODAYDONE-001: 2nd SELECT derives per-item done from today\'s events (event_log, ET)', () => {
    expect(stmts[1]).toMatch(/event_log/);
    expect(stmts[1]).toMatch(/America\/New_York/);
    expect(SRC).toMatch(/annotateDone/);
  });

  // The vocabulary moved to ./doneEvents.js (dependency-free, so doneEvents.test.js can EXECUTE the
  // fold instead of regex-asserting it). This guard follows it rather than being deleted: the claim
  // "rain counts as watering" is still worth pinning, and index.js must still route through the fold.
  it('V3-RAINDONE: a logged rain event checks off Water (rain counts as watering, 2026-06-22)', () => {
    const DONE_SRC = decomment(readFileSync(resolve(__dirname, 'doneEvents.js'), 'utf8'));
    expect(DONE_SRC).toMatch(/water_due:\s*\[[^\]]*'rain'[^\]]*\]/);
    expect(DONE_SRC).toMatch(/no_history:\s*\[[^\]]*'rain'[^\]]*\]/);
    // annotateDone must actually apply the shared fold, not a local reimplementation of it.
    expect(SRC).toMatch(/from '\.\/doneEvents\.js'/);
    expect(SRC).toMatch(/return applyDone\(plan, sat\b/);
  });

  // BUG-BACKDATEDFEED-001 — a feeding recorded today but DATED an earlier day must still retire the
  // feed card. The day-scoped done query (stmts[1]) structurally cannot see it, so the feed bucket
  // gets a second, cadence-scoped signal. Pinned positionally: the new query is appended LAST so the
  // three existing stmts[] guards above keep pointing at the queries they were written for.
  it('BUG-BACKDATEDFEED-001: the 4th SELECT reads each planting\'s newest fertilizing date in ET', () => {
    expect(stmts[3]).toMatch(/event_log/);
    expect(stmts[3]).toMatch(/e\.event_type = 'fertilizing'/);
    expect(stmts[3]).toMatch(/e\.deleted_at IS NULL/);
    expect(stmts[3]).toMatch(/max\(\(e\.event_date AT TIME ZONE 'America\/New_York'\)::date\)/);
    // today's ET date rides the SAME round trip, so the comparison cannot straddle two clocks.
    expect(stmts[3]).toMatch(/\(now\(\) AT TIME ZONE 'America\/New_York'\)::date/);
    // and it must be WIRED — an unreferenced helper is the vacuous-guard failure this pins against.
    expect(SRC).toMatch(/await lastFertByPlant\(sql, fertIds\)/);
    expect(SRC).toMatch(/applyDone\(plan, sat, ctx\)/);
  });

  // The widening is FEED-ONLY. Letting a back-dated watering retire today's water card would check
  // off a task nobody performed — the day predicate on stmts[1] is load-bearing for water and must
  // not acquire a cadence escape hatch alongside it.
  it('BUG-BACKDATEDFEED-001: the cadence widening is scoped to fertilizing, never watering', () => {
    expect(stmts[3]).not.toMatch(/'watering'|'rain'|'moisture_check'/);
    expect(SRC).toMatch(/Array\.isArray\(plan\?\.fertilize\)/);
  });

  // V4-WATERMATH-001 F0 — the interim pre-F2 snooze window. A moisture_check must ALSO satisfy on a
  // rolling now()-24h basis; ET-day-only means a morning snooze dies at midnight and the planting
  // re-nags at the next run, which is the affordance-extinction the design forbids.
  it('V4-WATERMATH-001: the done query gives moisture_check a rolling 24h window', () => {
    expect(stmts[1]).toMatch(/e\.event_type = 'moisture_check'/);
    expect(stmts[1]).toMatch(/e\.event_date > now\(\) - INTERVAL '24 hours'/);
    // watering/rain are NOT widened — they keep the ET calendar-day rule.
    expect(stmts[1]).toMatch(/AT TIME ZONE 'America\/New_York'\)::date\s*\n?\s*=/);
  });

  it('DEFAULT is PER-USER (dp.user_id = ${userId}); household widening is OPT-IN only', () => {
    // The primary plan read is still keyed strictly to the authenticated subject.
    expect(stmts[0]).toMatch(/dp\.user_id = \$\{userId\}/);
    // householdScope is used ONLY inside the ?include=household opt-in branch — never by default.
    expect(SRC).toMatch(/const includeHousehold = \(event\.queryStringParameters\?\.include\) === 'household'/);
    expect(SRC).toMatch(/if \(includeHousehold\) \{\s*\n\s*const otherIds = householdScope\(userId\)/);
    // household_plans is added to the response body ONLY under the opt-in (default envelope unchanged).
    expect(SRC).toMatch(/if \(includeHousehold\) body\.household_plans = householdPlans;/);
  });

  it('V4-ASSIGNLENS: the household read (3rd SELECT) reuses the schema_version guard + newest-wins dedup', () => {
    expect(stmts[2]).toMatch(/FROM daily_plan dp/);
    expect(stmts[2]).toMatch(/dp\.user_id = ANY\(\$\{ids\}\)/);
    expect(SRC).toMatch(/storedV !== PLAN_SCHEMA_VERSION\) \{ plan = null; \}/);
    expect(SRC).toMatch(/if \(seen\.has\(r\.user_id\)\) continue;/);
  });

  it('filters soft-deleted plans', () => {
    expect(stmts[0]).toMatch(/dp\.deleted_at IS NULL/);
  });

  it('computes plan_date server-side in America/New_York (client clock cannot shift the day)', () => {
    expect(stmts[0]).toMatch(/America\/New_York/);
    expect(stmts[0]).toMatch(/plan_date/);
  });

  it('is GET-only and rejects other methods/paths with 405', () => {
    expect(SRC).toMatch(/method !== 'GET'/);
    expect(SRC).toMatch(/rawPath !== '\/api\/daily-plan'/);
    expect(SRC).toMatch(/405/);
  });

  it('returns the contract envelope (schema_version + has_plan + plan)', () => {
    expect(SRC).toMatch(/schema_version:\s*SCHEMA_VERSION/);
    expect(SRC).toMatch(/has_plan:/);
    expect(SRC).toMatch(/plan:\s*plan\b/);
  });

  it('returns 401 on auth failure and 500 on query error', () => {
    expect(SRC).toMatch(/return resp\(401/);
    expect(SRC).toMatch(/return resp\(500/);
  });
});

describe('DRG-WATERRECON-002 — stored-plan schema_version guard (fail loud)', () => {
  it('pins PLAN_SCHEMA_VERSION and validates the stored plan against it', () => {
    expect(SRC).toMatch(/const PLAN_SCHEMA_VERSION\s*=\s*\d+/);
    expect(SRC).toMatch(/plan\.schema_version/);
    expect(SRC).toMatch(/storedV !== PLAN_SCHEMA_VERSION/);
    expect(SRC).toMatch(/storedV !== null/); // pre-stamp legacy rows tolerated (no ship-day false alarm)
  });
  it('fails loud + serves an honest empty state on mismatch (never garbage)', () => {
    expect(SRC).toMatch(/console\.error\([\s\S]*?schema_version mismatch/);
    expect(SRC).toMatch(/schemaStale = true/);
    expect(SRC).toMatch(/plan = null/);
    expect(SRC).toMatch(/schema_stale:\s*schemaStale/);
    expect(SRC).toMatch(/has_plan:\s*row\.items != null && !schemaStale/);
  });
});
