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
// ── BUG-FROSTANCHORERA5-001 (2026-09-03): ONE OF THOSE PINS IS NOW HISTORICAL ────────
// `latestMonthDay` moved '11-08' -> '10-31' when the ERA5 record was replaced with a station
// composite. 0b-backfill.sql still says '11-08' and MUST — it is APPLIED, and the
// `plausibility = 'post_frost_impossible'` stamps it wrote to live prod are PERMANENT (see the note
// above: two separate consumers exclude marked rows on purpose). Editing an applied migration
// changes nothing in the database; it only destroys the record of what was believed when the rows
// were stamped. So the value pin below is re-authored from a LOCKSTEP into a HISTORICAL pin plus a
// direction guard, and it is worth stating what the direction buys:
//
//   the arm stamps when `anchor_date + dtm_min > observed_first_fall_frost`, so a LATER bound stamps
//   FEWER rows. The applied stamps were made against 11-08, the corrected bound is 10-31 — eight days
//   earlier — so every row already stamped would still be stamped today (maturity past 11-08 implies
//   maturity past 10-31). The inconsistency introduced by the correction is entirely one of
//   OMISSION: a row whose earliest maturity falls in (10-31, 11-08] is unstamped and would now
//   qualify. Unstamped is the fail-safe state — the row stays in the watch band and stays eligible
//   for the nightly re-derive — so nothing is silently hidden by leaving this alone.
//
// Whether to run a corrective DML pass over that band is a decision for Dave, not for a test; this
// file's job is to make sure the divergence is deliberate and cannot widen unnoticed.
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

// = OBSERVED_FIRST_FALL_FROST.latestMonthDay AS OF the day 0b-backfill.sql was applied, when the
// measured record was ERA5. Named rather than inlined so a reader cannot mistake it for a live
// constant that has drifted. See the header for why it is frozen.
const APPLIED_LATEST_MONTH_DAY = '11-08';

describe('BUG-ANCHORSQLFROST-001 — 0b-backfill.sql frost anchor', () => {
  it('names BOTH anchors, in lockstep with src/lib/sowEngine.js', () => {
    // The SQL cannot import sowEngine.js at any point in its life, so these are copies. A TEST can
    // import both, and this is the only thing standing between the duplication and a silent
    // divergence the day either anchor is retuned.
    // MUTATION: change either literal in the params CTE and the matching line goes red.
    expect(mmdd('sowing_safety_margin_mmdd')).toBe(FROST_ANCHORS.firstFallFrost);
    // Frozen, NOT lockstepped — see the header. This was `.toBe(OBSERVED_FIRST_FALL_FROST
    // .latestMonthDay)` until BUG-FROSTANCHORERA5-001 moved that constant to '10-31', at which point
    // the only way to keep the equality would have been to edit an applied migration and re-stamp
    // history. The literal is still pinned; it is pinned to the value the stamps were made under.
    expect(mmdd('observed_first_fall_frost_mmdd')).toBe(APPLIED_LATEST_MONTH_DAY);
    // The two anchors must stay two. MUTATION: collapse them (point either at the other's value) and
    // this reds — without it the pins above would pass on a one-anchor world, which is the world the
    // bug shipped in.
    expect(toMs(mmdd('sowing_safety_margin_mmdd')))
      .toBeLessThan(toMs(mmdd('observed_first_fall_frost_mmdd')));
  });

  it('the frozen bound is no EARLIER than the live one, so no applied stamp is now wrong', () => {
    // ADDED by BUG-FROSTANCHORERA5-001, and it is the assertion that makes freezing the literal above
    // safe rather than merely convenient. The arm stamps when maturity > the bound, so a later bound
    // stamps fewer rows. As long as the applied bound is >= the live one, every stamp already written
    // to prod would still be written today and the divergence is pure omission — rows in the
    // (live, applied] band that go unstamped, which leaves them IN the watch band. That is the
    // fail-safe direction and it is why no corrective DML is forced by this change.
    //
    // MUTATION: move OBSERVED_FIRST_FALL_FROST.latestMonthDay later than 11-08 and this reds — which
    // is the case that WOULD force a decision, because then prod carries stamps the live constant no
    // longer justifies. The test names the band so whoever hits it knows what to query.
    expect(toMs(APPLIED_LATEST_MONTH_DAY))
      .toBeGreaterThanOrEqual(toMs(OBSERVED_FIRST_FALL_FROST.latestMonthDay));
  });

  it('takes the TAIL BOUND of the measured distribution, not its median', () => {
    // The second decision, and it is not a restatement of the first. `post_frost_impossible` is an
    // assertion of IMPOSSIBILITY that permanently removes a row from the watch band and from the
    // nightly re-derive sweep, while the false NEGATIVE it trades against is already caught at read
    // time by watch.js condition 3. Frost arrived later than the median in 5 of the 11 measured
    // years, so the median makes "impossible" a coin flip.
    // MUTATION: point the params constant at OBSERVED_FIRST_FALL_FROST.medianMonthDay — the obvious
    // "simplification" — and this reds. When that mutation was measured against live prod it
    // re-escalated one row (San Marzano rescue, maturity 2026-10-30) from rescue_suspect to a
    // permanent post_frost_impossible; the median was '10-29' then and is '10-15' now, so the
    // mutation is strictly worse than when it was priced, not better.
    expect(mmdd('observed_first_fall_frost_mmdd')).toBe(APPLIED_LATEST_MONTH_DAY);
    // The tail-vs-median relation holds against BOTH the frozen bound and the live constant, so this
    // decision survives the correction rather than depending on which record is in force.
    expect(toMs(OBSERVED_FIRST_FALL_FROST.medianMonthDay))
      .toBeLessThan(toMs(mmdd('observed_first_fall_frost_mmdd')));
    expect(toMs(OBSERVED_FIRST_FALL_FROST.medianMonthDay))
      .toBeLessThan(toMs(OBSERVED_FIRST_FALL_FROST.latestMonthDay));
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
