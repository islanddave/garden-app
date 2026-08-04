// V4-EVENTSOURCE-001 — event_log.source provenance column, and the XP daily cap constant.
// Batch-B decision packet items 3 and 10 (Option B).
//
// Static-source (L-072), DB-free. The migration files are asserted here too: the whole value of a
// provenance column is that it is TRUE, and the two ways to make it lie are (a) a writer that
// forgets to set it and (b) a backfill that guesses. Both are pinned below.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const MIG = resolve(__dirname, '..', '..', 'migrations', 'v4-eventsource-001');
const DDL = readFileSync(resolve(MIG, '0a-additive-ddl.sql'), 'utf8');
const BACKFILL = readFileSync(resolve(MIG, '0b-backfill-source.sql'), 'utf8');
const XPIDEM = readFileSync(resolve(MIG, '0c-xp-idempotency-index.sql'), 'utf8');

describe('event_log.source — every write path this Lambda owns sets it', () => {
  it('declares only values the migration CHECK admits', () => {
    // The column carries a NOT VALID CHECK, so a value the constraint does not know 23514s at
    // write time. Keeping the JS constants and the SQL value set in step is the point.
    const declared = [...SRC.matchAll(/const EVENT_SOURCE_\w+\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(['app', 'app_batch']);
    for (const v of declared) expect(DDL).toContain(`'${v}'`);
  });

  it('the single-event POST names source in both the column list and the RETURNING list', () => {
    expect(SRC).toMatch(/logged_by, created_by, metadata, source,/);
    expect(SRC).toMatch(/\$\{EVENT_SOURCE_SINGLE\}/);
    // RETURNING it means the client and any read path see provenance without a second query.
    expect(SRC).toMatch(/flagged_as_issue, severity, resolved_at, resolved_by, source,/);
  });

  it('the batch INSERT sets app_batch — the case the timestamp heuristic got 98.5% wrong', () => {
    // The heuristic misfired precisely BECAUSE one INSERT..SELECT gives up to 500 rows the same
    // created_at. Setting the column at that same statement is the fix.
    expect(SRC).toMatch(/jsonb_build_object\('batch_id'[\s\S]{0,200}\$\{EVENT_SOURCE_BATCH\}/);
  });
});

describe('migration v4-eventsource-001 — additive and non-guessing', () => {
  it('the column is nullable with no default, so the deployed old Lambda keeps working', () => {
    expect(DDL).toMatch(/ADD COLUMN IF NOT EXISTS source text;/);
    expect(DDL).not.toMatch(/source text[^;]*NOT NULL/);
    expect(DDL).not.toMatch(/source text[^;]*DEFAULT/);
  });

  it('the CHECK admits NULL and is created NOT VALID — arming it would be a deploy, not a migration', () => {
    expect(DDL).toMatch(/CHECK \(source IS NULL OR source = ANY/);
    expect(DDL).toMatch(/NOT VALID/);
    expect(DDL).not.toMatch(/VALIDATE CONSTRAINT/);
  });

  it("the backfill NEVER assigns 'direct' — absence of telemetry is not proof of a direct write", () => {
    // lambda/events wraps its app_events INSERT in a non-fatal try/catch, so "no telemetry row" and
    // "written straight to the DB" are indistinguishable from the data. Labelling those rows would
    // manufacture a fact; NULL means UNKNOWN and that is the true value.
    expect(BACKFILL).not.toMatch(/SET source = 'direct'/);
    expect(BACKFILL).toMatch(/UPDATE public\.event_log[\s\S]*SET source = 'app_batch'/);
    expect(BACKFILL).toMatch(/SET source = 'app_status'/);
  });

  it('every backfill UPDATE is guarded on source IS NULL, so re-running is safe', () => {
    const updates = BACKFILL.split(/UPDATE public\.event_log/).slice(1);
    expect(updates.length).toBe(3);
    for (const u of updates) expect(u).toMatch(/WHERE e\.source IS NULL/);
  });

  it('status_change rows are keyed on the frozen metadata contract, not the event_type string alone', () => {
    expect(BACKFILL).toMatch(/metadata ->> 'schema' = 'status_change\.v1'/);
  });

  it('0c adds the xp_events uniqueness the batch XP grant relies on', () => {
    expect(XPIDEM).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_xp_events_user_reason_source/);
    expect(XPIDEM).toMatch(/\(user_id, reason, source_id\)/);
    expect(XPIDEM).toMatch(/WHERE source_id IS NOT NULL/);
  });
});

describe('daily flat-XP cap (packet item 3)', () => {
  it('is 300, chosen so the median logging day finishes uncapped', () => {
    // Measured prod 2026-08-04: logging ACTIONS per active day p50=20, p75=52, p90=81, max=258.
    // 300 XP = 30 actions. At the old 30 the median day capped after 3 of 18 actions.
    expect(SRC).toMatch(/^const DAILY_FLAT_XP_CAP = 300;$/m);
    expect(SRC).toMatch(/^const FLAT_XP_PER_EVENT = 10;$/m);
  });

  it('still applies ONLY to event_logged grants — achievement XP stays uncapped (F16)', () => {
    const capUses = [...SRC.matchAll(/DAILY_FLAT_XP_CAP/g)].length;
    expect(capUses).toBeGreaterThan(0);
    // The achievement CTE must not consult the cap.
    //
    // ⚠ THIS ASSERTION WAS VACUOUS AND PASSED ON AN EMPTY STRING (found while reordering these two
    // blocks for BUG-XPPROGRESSION-001). It sliced from the first `WITH today_in_tz AS` (the POST
    // evaluator, ~char 108,670) to the first `AS newly_earned` — but the PATCH-resolve evaluator
    // also ends in `AS newly_earned` and sits ~50,000 chars EARLIER in the file, so start > end and
    // String.slice returned ''. `''.not.toContain(…)` is trivially true, so the F16 guarantee has
    // never actually been checked. Anchoring forward from the evaluator's own start fixes it, and
    // the length assertion below stops it silently emptying out again.
    const achStart = SRC.indexOf('WITH today_in_tz AS');
    expect(achStart).toBeGreaterThan(-1);
    const achEnd = SRC.indexOf('AS newly_earned', achStart);
    expect(achEnd).toBeGreaterThan(achStart);
    const achBlock = SRC.slice(achStart, achEnd);
    expect(achBlock.length).toBeGreaterThan(500);
    expect(achBlock).toContain('achievements a');   // we really are inside the evaluator
    expect(achBlock).not.toContain('DAILY_FLAT_XP_CAP');
  });

  it('the batch path receives the cap by parameter rather than re-declaring a second constant', () => {
    // Two copies of a reward constant is how they diverge. One declaration, passed in.
    expect(SRC).toMatch(/dailyXpCap: DAILY_FLAT_XP_CAP/);
    expect(SRC).toMatch(/flatXpPerAction: FLAT_XP_PER_EVENT/);
    const fx = readFileSync(resolve(__dirname, 'batchSideEffects.js'), 'utf8');
    expect(fx).not.toMatch(/const\s+DAILY_FLAT_XP_CAP/);
  });
});
