// BUG-BATCHORDER-001: the batch scope SELECT must ORDER BY before its LIMIT 501.
//
// Without an ORDER BY, row order is whatever the planner returns — the review list came back in
// arbitrary order, and the `LIMIT 501` + `.slice(0, 500)` pair was nondeterministic across calls.
// SCOPE OF THE BUG (do not overstate it — an earlier version of this header did): the
// `if (capped) return resp(400)` guard at index.js:228 fires BEFORE any write, so a >500 scope can
// never write the "wrong" plantings and dry-run/write cannot diverge. This is a preview-determinism
// and review-order fix — cosmetic, as Dave originally filed it. The client-side sort in
// ScopeChecklist is presentation only and does not substitute for ordering the cap.
//
// Static-source (L-072), DB-free — mirrors hs2-plant-filter.test.js, the house pattern for
// asserting SQL shape in a Lambda with no DB harness. Ordering relative to LIMIT is the whole
// point of the fix, so position (not mere presence) is what's asserted.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

describe('events Lambda — BUG-BATCHORDER-001 deterministic batch scope', () => {
  it('the scope SELECT carries an ORDER BY', () => {
    expect(SRC).toMatch(/ORDER BY p\.display_name, p\.id/);
  });

  it('orders by a UNIQUE tiebreaker so duplicate display_names cannot reorder between calls', () => {
    // display_name alone is not unique (e.g. two "Sun Gold" plantings) — without p.id the cap stays
    // nondeterministic for the tied rows, which is the exact bug in a smaller costume.
    expect(SRC).toMatch(/ORDER BY p\.display_name, p\.id\b/);
  });

  it('the ORDER BY precedes the LIMIT 501 (ordering the cap is the fix; ordering after it is not)', () => {
    const orderIdx = SRC.indexOf('ORDER BY p.display_name, p.id');
    expect(orderIdx).toBeGreaterThan(-1);
    const limitIdx = SRC.indexOf('LIMIT 501', orderIdx);
    expect(limitIdx).toBeGreaterThan(orderIdx);
    // and nothing re-caps between them
    expect(SRC.slice(orderIdx, limitIdx)).not.toMatch(/LIMIT/);
  });

  it('the ORDER BY lives in the same statement as the excludeIds predicate (the scope SELECT, not another query)', () => {
    const excludeIdx = SRC.indexOf('AND NOT (p.id = ANY(${excludeIds}))');
    const orderIdx = SRC.indexOf('ORDER BY p.display_name, p.id');
    expect(excludeIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(excludeIdx);
    // No other query opens between the predicate and the ORDER BY — i.e. they belong to the same
    // statement. `--` comment lines are stripped first: prose about the fix mentions SELECT and
    // would otherwise match (it did, on the first run).
    const between = SRC.slice(excludeIdx, orderIdx).replace(/--[^\n]*/g, '');
    expect(between).not.toMatch(/\bSELECT\b/);
  });
});
