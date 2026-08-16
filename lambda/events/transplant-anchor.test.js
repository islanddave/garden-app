// V4-TRANSPLANTANCHOR-001 (BD-023) — a `transplant` event must establish garden_node.transplanted_at.
//
// THE DEFECT THIS PINS: nothing linked the two. transplanted_at had exactly ONE mutating writer in
// lambda/** (the plants PUT, fed by the opt-in TransplantDatePrompt nudge), so the 100% agreement
// live prod shows — 107 live plantings with a transplant event, 0 NULL anchors, 104 equal to their
// FIRST event date — was Dave's logging HABIT, not an enforced invariant. A dismissed nudge left a
// planting holding a transplant event and no anchor, which costs it the from-transplant maturity
// window and demotes it to a derived guess in the harvest watch list.
//
// Static-source (L-072), DB-free, in the same style as household-mode.test.js and
// status-advance-scope.test.js — plus one genuinely functional block at the bottom over
// normalizeEventDate, because the event_date binding's timezone safety is a property of a real
// function and not of the source text.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEventDate } from './validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same decomment contract as the sibling guards: a construct NAMED IN A COMMENT is not that
// construct. This file's own source comments describe created_at and the container join at length,
// so without this every "must not contain" assertion below would trip on prose.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Statement slices, same boundary contract as status-advance-scope.test.js: SQL inside these
// templates contains no backticks (one would terminate the template), so the closing-backtick
// lookahead is exact.
const TRANSPLANT_WRITES = [...SRC.matchAll(/UPDATE public\.garden_node p\s+SET transplanted_at[\s\S]*?(?=\n\s*`)/g)].map((m) => m[0]);
const SUPERSEDES = [...SRC.matchAll(/UPDATE public\.plant_anchor_derivation d[\s\S]*?(?=\n\s*`)/g)].map((m) => m[0]);

describe('V4-TRANSPLANTANCHOR-001 — transplant event establishes transplanted_at', () => {
  it('writes transplanted_at on BOTH the single-event and the batch path', () => {
    // Trigger-parity is the whole point: `transplant` is in BATCH_EVENT_TYPES, so a batch-only gap
    // would leave Quick Log able to record a transplant that establishes no anchor — the exact
    // class BUG-BATCHSIDEEFFECTS-001 found across six other effects.
    expect(TRANSPLANT_WRITES.length).toBe(2);
    // The batch copy scopes to the resolved plantIds array, the single copy to the body's plant_id.
    // Asserting one of each stops a copy-paste that duplicates the same path twice.
    expect(TRANSPLANT_WRITES.filter((s) => /p\.id = ANY\(\$\{plantIds\}\)/.test(s)).length).toBe(1);
    expect(TRANSPLANT_WRITES.filter((s) => /p\.id = \$\{body\.plant_id \?\? null\}/.test(s)).length).toBe(1);
  });

  it('binds the EVENT date, never created_at or the wall clock', () => {
    // The ledger row is explicit and prod says why: 37 of 128 transplant events (28.9%) were logged
    // on a LATER calendar day than they happened, the worst by 31 days. created_at or NOW() would
    // move those anchors by up to a month and silently shift every maturity estimate off them.
    for (const s of TRANSPLANT_WRITES) {
      expect(s).toMatch(/SET transplanted_at = \$\{eventDate\}::timestamptz/);
      // NOW() legitimately appears in the same statement's updated_at, so the check is anchored to
      // the transplanted_at assignment itself rather than to the statement as a whole.
      const assignment = s.match(/SET transplanted_at = [^\n]*/)[0];
      expect(assignment).not.toMatch(/created_at/);
      expect(assignment).not.toMatch(/NOW\(\)/);
      expect(assignment).not.toMatch(/now\(\)/);
    }
  });

  it('is SET-ONCE: a second transplant event cannot overwrite an existing date', () => {
    // The decision, recorded: set-once matches germinated_at and, more importantly, can never
    // overwrite a value a HUMAN entered through TransplantDatePrompt or the editor. All 3 prod rows
    // that disagree with their first event date are plantings where Dave named a LATER transplant;
    // an always-latest writer would have re-decided 14 of the 16 two-event plantings for him.
    // Dropping this predicate is what turns the guard into a clobberer, and nothing else would fail.
    for (const s of TRANSPLANT_WRITES) {
      expect(s).toMatch(/AND p\.transplanted_at IS NULL/);
      // Idempotency must not be faked with an upsert-style GREATEST/LEAST on the column either.
      expect(s).not.toMatch(/GREATEST\(/);
      expect(s).not.toMatch(/LEAST\(/);
    }
  });

  it('gates on the transplant event type and skips soft-deleted plantings', () => {
    for (const s of TRANSPLANT_WRITES) {
      expect(s).toMatch(/\$\{eventType\}::text = 'transplant'/);
      expect(s).toMatch(/p\.deleted_at IS NULL/);
      // An event-logged date is captured, not estimated — same claim germinated_at_approx makes,
      // and it keeps the plants-PUT invariant that the flag is never set beside a NULL date.
      expect(s).toMatch(/transplanted_at_approx = false/);
    }
  });

  it('scopes ownership with the two-arm predicate so a container-less planting is not skipped', () => {
    // A planting may have NO container (4 live in prod). The inner-join form matches zero rows for
    // those and reports nothing — BUG-STATUSADVNOPROJ-001 / BUG-ANCHORNOPROJ-001. Prophylactic
    // today (none of the 4 carries a transplant event yet) and invisible if it regresses, which is
    // exactly why it is asserted rather than trusted.
    for (const s of TRANSPLANT_WRITES) {
      expect(s).toMatch(/EXISTS \(SELECT 1 FROM public\.container pp\s+WHERE pp\.id = p\.container_id\s+AND pp\.created_by = ANY\(\$\{householdIds\}\)\)/);
      expect(s).toMatch(/OR \(p\.container_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)\)/);
      // The EXISTS legitimately reads container; strip it before checking the OUTER statement for
      // the join that is the defect itself.
      const outer = s.replace(/EXISTS \(SELECT 1 FROM public\.container[\s\S]*?\)\)/, '');
      expect(outer).not.toMatch(/FROM public\.container/);
      expect(outer).not.toMatch(/p\.container_id = pp\.id/);
      // Both arms must bind the SAME householdIds — the container-less arm falling back to userId
      // or to no predicate would widen ownership rather than visibility.
      expect((s.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? []).length).toBe(2);
      expect(s).not.toMatch(/created_by = \$\{userId\}/);
    }
  });
});

describe('V4-TRANSPLANTANCHOR-001 — the new route retires a derived anchor', () => {
  it('both transplant writes are followed by an anchor-supersede statement', () => {
    // V4-ANCHORSUPERSEDE-001's invariant: a derived anchor (plant_anchor_derivation, 60 live rows in
    // prod) and an observed one may never coexist, or watch-route.js keeps citing a guess the data
    // has disproved. That maintainer was installed on the plants PUT and the merge cutover; writing
    // transplanted_at from an event opens a THIRD route that reaches neither, so it must fire here
    // too. Ordering is load-bearing — inside one sql.transaction the supersede only sees the new
    // date if it runs AFTER the write.
    expect(SUPERSEDES.length).toBe(2);
    const tIdx = [...SRC.matchAll(/UPDATE public\.garden_node p\s+SET transplanted_at/g)].map((m) => m.index);
    const sIdx = [...SRC.matchAll(/UPDATE public\.plant_anchor_derivation d/g)].map((m) => m.index);
    expect(tIdx.length).toBe(2);
    expect(sIdx.length).toBe(2);
    expect(tIdx[0]).toBeLessThan(sIdx[0]);              // batch path
    expect(sIdx[0]).toBeLessThan(tIdx[1]);              // ...before the single-event pair begins
    expect(tIdx[1]).toBeLessThan(sIdx[1]);              // single-event path
  });

  it('retires rather than deletes, and re-runs are no-ops', () => {
    // Retire, never delete: the (guess, later truth) pair is the only accuracy measurement the
    // add-date baseline tier will ever produce. superseded_at IS NULL is both the idempotence guard
    // and the reason a re-run cannot rewrite an earlier retirement's timestamp.
    for (const s of SUPERSEDES) {
      expect(s).toMatch(/SET superseded_at = now\(\)/);
      expect(s).toMatch(/superseded_by = 'observed_anchor'/);
      expect(s).toMatch(/AND d\.superseded_at IS NULL/);
      expect(s).not.toMatch(/DELETE/);
    }
  });

  it('retires only when an OBSERVED anchor actually stands beside the derivation', () => {
    // The eventType gate is a cost control; THIS predicate is the correctness one. It tests the row
    // state the transaction just produced, so a transplant that no-opped (set-once, or not owned)
    // cannot retire anything. Alias gp, not p, so the subquery never enters a select-column census
    // as a read block — the same reason the plants PUT uses gp.
    for (const s of SUPERSEDES) {
      expect(s).toMatch(/\$\{eventType\}::text = 'transplant'/);
      expect(s).toMatch(/SELECT 1 FROM public\.garden_node gp/);
      expect(s).toMatch(/gp\.sown_at IS NOT NULL/);
      expect(s).toMatch(/gp\.transplanted_at IS NOT NULL/);
      expect(s).toMatch(/gp\.planted_out_at IS NOT NULL/);
    }
  });
});

describe('V4-TRANSPLANTANCHOR-001 — event_date is timezone-stable into a DATE column', () => {
  // transplanted_at is a DATE column and the write is a bare ${eventDate}::timestamptz, relying on
  // the assignment cast — identical to the germination write beside it. That is only safe because
  // normalizeEventDate anchors a calendar-day event at NOON UTC, which leaves 11 hours of margin
  // either side before any plausible session timezone rounds it to a different day. These assertions
  // pin the property the SQL depends on; if normalizeEventDate ever stopped anchoring at noon, the
  // cast would start silently producing off-by-one anchors with nothing else failing.
  it('anchors a bare calendar date at noon UTC', () => {
    expect(normalizeEventDate('2026-06-16')).toBe('2026-06-16T12:00:00.000Z');
  });

  const dayIn = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

  it('lands on the same calendar day for every offset strictly inside +/-12h', () => {
    const iso = normalizeEventDate('2026-06-16');
    // Spans -11 (Pacific/Midway) through +11 (Pacific/Noumea), covering the Lambda's own session
    // timezone (UTC) and every timezone this household logs from.
    for (const tz of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Midway', 'Pacific/Noumea']) {
      expect(dayIn(iso, tz)).toBe('2026-06-16');
    }
  });

  it('rolls over at exactly +/-12h — the documented limit of the noon anchor', () => {
    // Pinned deliberately rather than left implicit: this assertion FAILED when first written as
    // "every timezone", which is how the real boundary got measured instead of assumed. Noon UTC
    // +12h is midnight the next day, so an offset of +12 or beyond does shift the calendar day.
    // It does not affect this write, because the timestamptz->date assignment cast runs in the
    // LAMBDA's session timezone (UTC), never the client's — but a future reader tempted to move
    // this derivation into a client-supplied zone needs to see the edge exists.
    expect(dayIn(normalizeEventDate('2026-06-16'), 'Pacific/Auckland')).toBe('2026-06-17');
  });

  it('preserves an explicit timestamp instead of re-anchoring it', () => {
    // Only the bare YYYY-MM-DD shape gets the noon anchor; a client that sends a real instant keeps
    // it. Asserted so the noon rule above is understood as a DEFAULT, not a normalization applied
    // to every input.
    expect(normalizeEventDate('2026-06-16T03:30:00Z')).toBe('2026-06-16T03:30:00.000Z');
  });
});
