// BUG-DORMANTLISTS-001 — the Log Many batch scope SELECT must exclude dormant plantings.
//
// Dave, 2026-08-20: "I STILL see cavendish strawberries, christmas cactus there even though they
// are utterly dormant and not in need of water." The scope resolver filtered deleted_at,
// archived_at and ownership and NOTHING else, so all 5 live dormant plantings resolved into a
// scope the UI labels "all active plantings".
//
// Static-source (L-072), DB-free — the house pattern for asserting SQL shape in a Lambda with no
// DB harness (mirrors batch-order.test.js / hs2-plant-filter.test.js). It is deliberately the
// WEAKER half of the coverage: what a real dormant row does against a real `garden_node` view is
// proved in tests/integration/logmany-dormant.int.test.js. What this file buys is a guard that runs
// on every push — it catches deletion of the predicate, relocation into a different statement, and
// widening past `dormant`, none of which the integration suite would flag until CI's DB job runs.
//
// The three claims are chosen so each fails to a DIFFERENT mutation:
//   1. presence   → deleting the line
//   2. position   → moving it to a neighbouring query (e.g. the harvest-readiness SELECT, which
//                   legitimately carries a NOT IN ('failed','ended','dormant') of its own — so a
//                   naive presence-only test would stay green with the batch resolver unfiltered)
//   3. narrowness → widening to the care-query triple, which would drop the deliberately-unmanaged
//                   legacy perennials (all `ended`) out of a bulk path Dave still uses.

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

describe('events Lambda — BUG-DORMANTLISTS-001 Log Many excludes dormant', () => {
  it('the batch scope SELECT is still locatable (the slice these assertions depend on)', () => {
    expect(fromIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(fromIdx);
    expect(SCOPE_SELECT).toMatch(/AND NOT \(p\.id = ANY\(\$\{excludeIds\}\)\)/);
  });

  it('carries a dormant exclusion INSIDE that SELECT, not merely somewhere in the file', () => {
    expect(SCOPE_SELECT).toMatch(/p\.status[^\n]*dormant/);
  });

  it('is NULL-safe — a NULL status must not be swallowed by three-valued logic', () => {
    // `p.status <> 'dormant'` alone evaluates to NULL for a NULL status, which SQL treats as false:
    // every status-less planting would silently vanish from Log Many. `status` is nullable and
    // every other care query in the codebase guards it the same way.
    expect(SCOPE_SELECT).toMatch(/p\.status IS NULL OR p\.status <> 'dormant'/);
  });

  it("excludes DORMANT ONLY — not the ('failed','ended','dormant') triple the care queries use", () => {
    expect(SCOPE_SELECT).not.toMatch(/'ended'/);
    expect(SCOPE_SELECT).not.toMatch(/'failed'/);
  });

  it('leaves the soft-delete and archive predicates alone (orthogonal axes, not folded together)', () => {
    // A "dormant" exclusion must not become a general aliveness rewrite: deleted_at and archived_at
    // are separate columns with separate surfaces (RecentlyDeleted, the archive lens) and folding
    // them would hide or unhide rows this fix has no business touching.
    expect(SCOPE_SELECT).toMatch(/p\.deleted_at IS NULL/);
    expect(SCOPE_SELECT).toMatch(/pp\.deleted_at IS NULL/);
    expect(SCOPE_SELECT).toMatch(/p\.archived_at IS NULL/);
  });

  it('the harvest-readiness SELECT keeps its own, wider status filter (no cross-contamination)', () => {
    // Guards the reverse mutation: "consolidating" the two predicates into one shared clause would
    // either widen Log Many or narrow harvest readiness. They are deliberately different.
    expect(SRC).toMatch(/AND \(p\.status IS NULL OR p\.status NOT IN \('failed', 'ended', 'dormant'\)\)/);
  });
});
