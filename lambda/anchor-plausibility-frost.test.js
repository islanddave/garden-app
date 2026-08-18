// BUG-ANCHORSQLFROST-001 — the FOURTH consumer of FROST_ANCHORS.firstFallFrost, and the one the
// BUG-FROSTANCHORWRONG-001 identifier sweep could not see, because it is SQL.
//
// THE DEFECT. migrations/v4-anchorbase-001/0b-backfill.sql stamped
// plant_anchor_derivation.plausibility = 'post_frost_impossible' on any anchor whose earliest
// catalogue maturity landed past `DATE '2026-09-28'`. That constant is FROST_ANCHORS.firstFallFrost,
// a CONSERVATIVE SOWING-SAFETY MARGIN — not a frost date. It had already mislabelled 7 live prod
// rows, and the label is not cosmetic: watch-route.js's `derived` CTE drops every non-NULL
// plausibility, and daily-plan/handler.js's nightly re-derivation sweep excludes marked rows on
// purpose, so a wrong stamp removes a planting from the watch band PERMANENTLY.
//
// Two things are pinned here, and the second is the one that actually recurs:
//   1. the VALUES, against src/lib/sowEngine.js — the same lockstep anchorDerive.test.js keeps for
//      watch.js's copies, extended to the SQL that no JS import can reach; and
//   2. the SHAPE — that the file holds no hardcoded calendar date at all. A value pin alone would
//      have passed on the original file the day it was written and gone stale by January.
//
// Static-source (L-072), DB-free: asserts the text of the migration, not a database.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROST_ANCHORS, OBSERVED_FIRST_FALL_FROST } from '../src/lib/sowEngine.js';

// Same decommenter the other static-source guards use. Load-bearing here beyond the usual reason:
// this file's own header quotes both '09-28' and the measured dates while explaining them, so a
// raw-text assertion would find the prose and pass on a reverted CASE.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKFILL = decomment(
  readFileSync(resolve(__dirname, '..', 'migrations', 'v4-anchorbase-001', '0b-backfill.sql'), 'utf8'),
);

const mmdd = (name) => (BACKFILL.match(new RegExp(`'(\\d{2}-\\d{2})'::text\\s+AS\\s+${name}`)) ?? [])[1];

// The plausibility ladder's FIRST arm, and ONLY that arm. Anchored at `dtm_min IS NOT NULL` (the
// arm's own opening predicate, and the file's only occurrence of it) rather than at `CASE WHEN`,
// which is not this CASE's — the `derived` CTE opens four earlier ones, so a `CASE WHEN`-anchored
// lazy match swallows the whole frosted CTE and reads its `AS observed_first_fall_frost` alias as
// though the arm consumed it. Verified: that formulation passed a mutation that reverted the arm to
// the hardcoded literal.
const PFI_ARM = (BACKFILL.match(/dtm_min IS NOT NULL[\s\S]*?THEN 'post_frost_impossible'/) ?? [''])[0];
const FROSTED_CTE = (BACKFILL.match(/frosted AS \([\s\S]*?\n\)/) ?? [''])[0];

const toMs = (md) => Date.parse(`2026-${md}T00:00:00Z`);

describe('BUG-ANCHORSQLFROST-001 — 0b-backfill.sql frost anchor', () => {
  it('names BOTH anchors, in lockstep with src/lib/sowEngine.js', () => {
    // The SQL cannot import sowEngine.js at any point in its life, so these are copies. A TEST can
    // import both, and this is the only thing standing between the duplication and a silent
    // divergence the day either anchor is retuned.
    // MUTATION: change either literal in the params CTE and the matching line goes red.
    expect(mmdd('sowing_safety_margin_mmdd')).toBe(FROST_ANCHORS.firstFallFrost);
    expect(mmdd('observed_first_fall_frost_mmdd')).toBe(OBSERVED_FIRST_FALL_FROST.latestMonthDay);
    // The two anchors must stay two. MUTATION: collapse them (point either at the other's value) and
    // this reds — without it the pins above would pass on a one-anchor world, which is the world the
    // bug shipped in.
    expect(toMs(mmdd('sowing_safety_margin_mmdd')))
      .toBeLessThan(toMs(mmdd('observed_first_fall_frost_mmdd')));
  });

  it('takes the TAIL BOUND of the measured distribution, not its median', () => {
    // The second decision, and it is not a restatement of the first. `post_frost_impossible` is an
    // assertion of IMPOSSIBILITY that permanently removes a row from the watch band and from the
    // nightly re-derive sweep, while the false NEGATIVE it trades against is already caught at read
    // time by watch.js condition 3. Frost arrived later than the median in 5 of the 11 measured
    // years, so the median makes "impossible" a coin flip.
    // MUTATION: point the params constant at OBSERVED_FIRST_FALL_FROST.medianMonthDay ('10-29') —
    // the obvious "simplification" — and this reds. On live prod today that mutation re-escalates
    // one row (San Marzano rescue, maturity 2026-10-30) from rescue_suspect to a permanent
    // post_frost_impossible.
    expect(mmdd('observed_first_fall_frost_mmdd')).toBe(OBSERVED_FIRST_FALL_FROST.latestMonthDay);
    expect(toMs(OBSERVED_FIRST_FALL_FROST.medianMonthDay))
      .toBeLessThan(toMs(mmdd('observed_first_fall_frost_mmdd')));
  });

  it('stamps post_frost_impossible off the MEASURED anchor and never the margin', () => {
    // THE RULE, from sowEngine.js: "is it too late to START something frost will kill?" takes the
    // margin; "when will frost actually happen?" takes the measurement. This file asks the second.
    // MUTATION: swap the arm back to prm.sowing_safety_margin_mmdd and both lines go red.
    expect(PFI_ARM).toContain('observed_first_fall_frost');
    expect(PFI_ARM).not.toMatch(/margin/i);
    // ...and the arm compares against a COLUMN, never a literal of any shape.
    expect(PFI_ARM).not.toMatch(/DATE\s*'|::date/i);
    // The margin is carried for documentation and must stay unread. Exactly one occurrence — its own
    // declaration. MUTATION: consume it anywhere and the count goes to 2.
    expect(BACKFILL.match(/sowing_safety_margin_mmdd/g)).toHaveLength(1);
  });

  it('carries no hardcoded calendar date anywhere in its executable text', () => {
    // THE REGRESSION ITSELF, and the assertion that would have caught it. A month-day is fine (it is
    // half of an anchor); a full YYYY-MM-DD is a frozen year in a statement whose own header calls it
    // idempotent and re-runnable.
    // MUTATION: restore `DATE '2026-09-28'` in the CASE arm and this reds naming the match.
    expect(BACKFILL.match(/\d{4}-\d{2}-\d{2}/g) ?? []).toEqual([]);
  });

  it('resolves the anchor into the GROW YEAR the derived anchor sits in', () => {
    // Grow year runs Nov 1 - Oct 31, so from November the NEXT first fall frost belongs to the
    // following calendar year — the same roll watch.js firstFallFrostFor() applies, and the reason a
    // fixed calendar date could not have been merely "moved later".
    // MUTATION: drop the November branch (compare against extract(year) alone) and the >= 11 line
    // reds; resolve against `today` instead of `anchor_date` and the anchor_date lines red.
    expect(FROSTED_CTE).toContain('make_date(');
    expect(FROSTED_CTE).toMatch(/extract\(month FROM c\.anchor_date\) >= 11/);
    expect(FROSTED_CTE).toMatch(/extract\(year FROM c\.anchor_date\)::int \+ 1/);
    expect(FROSTED_CTE).toContain("split_part(prm.observed_first_fall_frost_mmdd, '-', 1)::int");
    expect(FROSTED_CTE).toContain("split_part(prm.observed_first_fall_frost_mmdd, '-', 2)::int");
  });
});
