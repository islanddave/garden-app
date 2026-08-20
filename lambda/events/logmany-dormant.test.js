// BUG-DORMANTLISTS-001 + BUG-LOGMANYSTATUS-001 — the Log Many batch scope SELECT must exclude the
// LIVE-planting triple ('failed','ended','dormant'), and nothing wider.
//
// Round one (BUG-DORMANTLISTS-001), Dave 2026-08-20: "I STILL see cavendish strawberries, christmas
// cactus there even though they are utterly dormant and not in need of water." The scope resolver
// filtered deleted_at, archived_at and ownership and NOTHING else, so all 5 live dormant plantings
// resolved into a scope the UI labels "all active plantings". That fix added `dormant` alone and
// argued in a comment for keeping `ended`/`failed`.
//
// Round two (BUG-LOGMANYSTATUS-001) measured that argument against live prod and it did not hold:
// Strawberries, marked `ended` on 2026-06-25, went on to collect 31 further batch events across 23
// distinct watering runs through 08-19, and Emerald Green took a bulk watering the day after it was
// marked `failed`. The claimed offsetting workflow (a deliberate cleanup batch on an ended bed) has
// zero instances in the data. So the predicate widened to the triple. `rooting` did NOT join it —
// a cutting striking roots is the least drought-tolerant state there is. See the block comment on
// the resolver in index.js for the full measurement.
//
// Static-source (L-072), DB-free — the house pattern for asserting SQL shape in a Lambda with no
// DB harness (mirrors batch-order.test.js / hs2-plant-filter.test.js). It is deliberately the
// WEAKER half of the coverage: what a real ended/failed/dormant row does against a real
// `garden_node` view is proved in tests/integration/logmany-dormant.int.test.js. What this file
// buys is a guard that runs on every push — it catches deletion of the predicate, relocation into a
// different statement, narrowing back to dormant-only, and widening past the triple, none of which
// the integration suite would flag until CI's DB job runs.
//
// Each claim fails to a DIFFERENT mutation:
//   1. presence   → deleting the line
//   2. position   → moving it to a neighbouring query. The harvest-readiness SELECT below now
//                   carries a BYTE-IDENTICAL predicate, so a presence-only test against the whole
//                   file would stay green with the batch resolver unfiltered. Everything here runs
//                   against a slice of the scope SELECT alone.
//   3. null-safety→ dropping the `IS NULL OR` arm
//   4. narrowing  → reverting to `<> 'dormant'` (the round-one shape)
//   5. widening   → adding 'rooting', which would drop a cutting that needs water most out of the
//                   only bulk path that waters it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the commentary above this fix mentions
// both `dormant` and the ('failed','ended','dormant') triple by name, so every assertion below
// would find its own prose and pass. Assertions run against decommented source.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The batch scope SELECT, delimited by two constructs unique to it: its FROM clause and the
// ORDER BY that BUG-BATCHORDER-001 pinned. Slicing first is what makes claim 2 real.
const FROM = 'FROM public.garden_node p JOIN public.container pp ON pp.id = p.container_id';
const ORDER = 'ORDER BY p.display_name, p.id';
const fromIdx = SRC.indexOf(FROM);
const orderIdx = SRC.indexOf(ORDER, fromIdx);
const SCOPE_SELECT = fromIdx > -1 && orderIdx > fromIdx ? SRC.slice(fromIdx, orderIdx) : '';

describe('events Lambda — Log Many scope excludes the live-planting triple', () => {
  it('the batch scope SELECT is still locatable (the slice these assertions depend on)', () => {
    expect(fromIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(fromIdx);
    expect(SCOPE_SELECT).toMatch(/AND NOT \(p\.id = ANY\(\$\{excludeIds\}\)\)/);
  });

  it('carries a status exclusion INSIDE that SELECT, not merely somewhere in the file', () => {
    expect(SCOPE_SELECT).toMatch(/p\.status[^\n]*NOT IN/);
  });

  it('is NULL-safe — a NULL status must not be swallowed by three-valued logic', () => {
    // `p.status NOT IN (...)` alone evaluates to NULL for a NULL status, which SQL treats as false:
    // every status-less planting would silently vanish from Log Many. `status` is nullable and
    // every other care query in the codebase guards it the same way.
    expect(SCOPE_SELECT).toMatch(/p\.status IS NULL OR p\.status NOT IN/);
  });

  it("excludes all three of 'failed', 'ended' and 'dormant' — not dormant alone", () => {
    // BUG-LOGMANYSTATUS-001. Reverting to the round-one `p.status <> 'dormant'` fails here and
    // nowhere else in this file, which is what makes this the guard for the widening decision.
    expect(SCOPE_SELECT).toMatch(/p\.status NOT IN \('failed', 'ended', 'dormant'\)/);
  });

  it("does NOT exclude 'rooting' — a cutting striking roots is the thirstiest state there is", () => {
    // The over-application pin, and the explicit ruling on the one status the two existing
    // vocabularies disagree about. dashboard/handlers.js and findings/index.js exclude `rooting`
    // from CARE RECOMMENDATIONS; daily-plan, harvest-readiness, the harvest watch band and this
    // resolver all keep it, because a rooting cutting is alive and has no root system to buffer a
    // missed watering. Live prod: the single `rooting` row (Geranium Cutting) took 14 waterings in
    // 90 days, 4 of them through this very batch path. Widening here would take those away.
    expect(SCOPE_SELECT).not.toMatch(/'rooting'/);
  });

  it('leaves the soft-delete and archive predicates alone (orthogonal axes, not folded together)', () => {
    // A status exclusion must not become a general aliveness rewrite: deleted_at and archived_at
    // are separate columns with separate surfaces (RecentlyDeleted, the archive lens) and folding
    // them would hide or unhide rows this fix has no business touching.
    expect(SCOPE_SELECT).toMatch(/p\.deleted_at IS NULL/);
    expect(SCOPE_SELECT).toMatch(/pp\.deleted_at IS NULL/);
    expect(SCOPE_SELECT).toMatch(/p\.archived_at IS NULL/);
  });

  it('the harvest-readiness SELECT still carries its own copy of the same predicate', () => {
    // These two are now byte-identical by intent, not by accident — see
    // lambda/live-planting-predicate-sync.test.js, which pins all four copies fleet-wide. This
    // assertion stays because it is the local half: it catches a "consolidation" that deletes the
    // harvest-readiness copy on the theory that the scope SELECT above already covers it.
    const HR = SRC.slice(SRC.indexOf('/api/events/harvest-ready'));
    expect(HR).toMatch(/AND \(p\.status IS NULL OR p\.status NOT IN \('failed', 'ended', 'dormant'\)\)/);
  });
});
