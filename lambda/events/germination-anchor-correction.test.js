// BUG-GERMDATEBATCH-001 — correcting a germination event's date must move garden_node.germinated_at.
//
// THE DEFECT THIS PINS: germinated_at was set-once with NO route back. Both forward writes carry
// `AND p.germinated_at IS NULL`, the DELETE path deliberately leaves the stamp where it is, and the
// PUT re-anchored entity_memory and harvest_log but never the lifecycle date. EventDetail's date
// field has worked on this route since BUG-HARVESTEDIT-001, so a user could already correct the
// event and be shown the new date in the Event log while the Life Story milestone and the
// V4-CAL2GERM-001 calibration input silently kept the old one.
//
// Measured on live prod 2026-08-20 (read-only): all 18 stamped plantings fall on exactly two dates
// across five sow dates, and 5 of the 17 app-logged ones are a calendar day late on top of that
// (tapped 22:55–23:13 EDT on 07-30, stamped 07-31 by the Lambda's UTC clock). Every one of those is
// unreachable without this statement.
//
// Static-source (L-072), DB-free, in the same style as transplant-anchor.test.js and
// status-advance-scope.test.js beside it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same decomment contract as the sibling guards: a construct NAMED IN A COMMENT is not that
// construct. The statement this file guards is preceded by ~45 lines of prose that quote
// `germinated_at IS NULL`, `p.germinated_at`, NOW() and the two-arm predicate verbatim, so without
// this every "must not contain" assertion below would trip on its own documentation.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Statement slices, same boundary contract as the sibling guards: SQL inside these templates
// contains no backticks (one would terminate the template), so the closing-backtick lookahead is an
// exact statement boundary.
const GERM_WRITES = [...SRC.matchAll(/UPDATE public\.garden_node p\s+SET germinated_at[\s\S]*?(?=\n\s*`)/g)].map((m) => m[0]);
const SET_ONCE = GERM_WRITES.filter((s) => /AND p\.germinated_at IS NULL/.test(s));
const CORRECTION = GERM_WRITES.filter((s) => /AND p\.germinated_at = \$\{priorGerminatedAt\}/.test(s));

describe('BUG-GERMDATEBATCH-001 — the germination anchor follows its own event', () => {
  it('adds exactly one correcting write beside the two set-once forward writes', () => {
    // Three total: single-event POST, batch POST, and this PUT. A drift here means the slices the
    // assertions below inspect are not the statements they name.
    expect(GERM_WRITES.length).toBe(3);
    expect(SET_ONCE.length).toBe(2);
    expect(CORRECTION.length).toBe(1);
  });

  it('the correction does NOT carry the set-once predicate — that is the point of it', () => {
    // `germinated_at IS NULL` is the predicate this statement exists to step around. Re-adding it
    // (the obvious "make it consistent with its neighbours" tidy) would make the whole route
    // silently vacuous: every row it is meant to fix has a non-null anchor by definition, so it
    // would match zero rows, throw nothing, and log nothing.
    expect(CORRECTION[0]).not.toMatch(/AND p\.germinated_at IS NULL/);
  });

  it('guards on the anchor still equalling THIS event\'s pre-edit date (anti-clobber)', () => {
    // germinated_at has another author — the plants PUT, which a human drives. Requiring the stored
    // anchor to still equal the date this event put there is the proof that this event is the
    // anchor's source. Drop it and the statement becomes a second writer that can overwrite a
    // human's answer from an unrelated event edit, which is the failure the transplant anchor
    // beside it records at length.
    expect(CORRECTION[0]).toMatch(/AND p\.germinated_at = \$\{priorGerminatedAt\}::timestamptz::date/);
  });

  it('binds the EDITED event date, never NOW() or created_at', () => {
    expect(CORRECTION[0]).toMatch(/SET germinated_at = \$\{eventDate\}::timestamptz/);
    const assignment = CORRECTION[0].match(/SET germinated_at = [^\n]*/)[0];
    expect(assignment).not.toMatch(/created_at/);
    expect(assignment).not.toMatch(/NOW\(\)/i);
    // An event-logged date is captured, not estimated — same claim the forward writes make, and it
    // keeps the plants-PUT invariant that the flag is never set beside a NULL date.
    expect(CORRECTION[0]).toMatch(/germinated_at_approx = false/);
  });

  it('EVERY germination write binds the event date — no wall clock on any path', () => {
    // FOUND BY THIS TICKET'S OWN MUTATION PASS, not by design: a mutation aimed at the correction
    // landed on the FIRST match instead (the batch forward write), rewrote it to
    // `SET germinated_at = NOW()`, and the entire lambda/events suite — 663 tests — stayed green.
    // Nothing anywhere guarded the two forward writes' date bind. transplant-anchor.test.js pins
    // exactly this for the sibling column, and it is the server half of the same defect this ticket
    // fixes on the client: a wall-clock stamp instead of the date the user meant. The loop covers
    // all three writes so a fourth added later inherits the guard.
    for (const s of GERM_WRITES) {
      expect(s).toMatch(/SET germinated_at = \$\{eventDate\}::timestamptz/);
      // NOW() legitimately appears in the same statement's updated_at, so the check is anchored to
      // the germinated_at assignment itself rather than to the statement as a whole.
      const assignment = s.match(/SET germinated_at = [^\n]*/)[0];
      expect(assignment).not.toMatch(/created_at/);
      expect(assignment).not.toMatch(/NOW\(\)/i);
    }
  });

  it('scopes to the household and skips soft-deleted plantings', () => {
    // The container join is deliberate here (it is the scope of the two forward writes, so it is
    // exactly the population that can hold an anchor this statement may move) — but the ownership
    // predicate itself must never loosen to userId or vanish.
    expect(CORRECTION[0]).toMatch(/AND pp\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(CORRECTION[0]).not.toMatch(/created_by = \$\{userId\}/);
    expect(CORRECTION[0]).toMatch(/AND p\.deleted_at IS NULL/);
    expect(CORRECTION[0]).toMatch(/WHERE p\.id = \$\{oldPlantId\}/);
  });

  it('fires only on a DATE change to an event that is a germination on BOTH sides', () => {
    // Scope, asserted rather than trusted. A retype or a plant move is a re-decision, not a
    // correction — the same call the DELETE path makes — and re-deriving on either would let an
    // unrelated edit invent or clear an anchor.
    const gate = SRC.match(/if \(existing\.event_type === 'germination' && body\.event_type === 'germination'\s*\n\s*&& [^)]*\) \{/);
    expect(gate).not.toBeNull();
    expect(gate[0]).toMatch(/dateChanged/);
    expect(gate[0]).toMatch(/!plantChanged/);
    expect(gate[0]).toMatch(/oldPlantId != null/);
  });

  it('normalises the prior date in JS rather than binding the driver value raw', () => {
    // The neon driver hands a timestamptz back as a Date or a string depending on version; the
    // guard must not depend on which.
    expect(SRC).toMatch(/const priorGerminatedAt = new Date\(existing\.event_date\)\.toISOString\(\);/);
  });

  it('leaves the two forward writes set-once', () => {
    // The correction must not be delivered by relaxing the forward writes — that would let a second
    // germination event on the same planting silently re-decide the anchor, which is the property
    // transplant-anchor.test.js pins for the sibling column.
    for (const s of SET_ONCE) {
      expect(s).toMatch(/AND p\.germinated_at IS NULL/);
      expect(s).not.toMatch(/GREATEST\(/);
      expect(s).not.toMatch(/LEAST\(/);
    }
  });

  it('logs greppably if it fails after the event has already committed', () => {
    // Same non-atomicity the care-cache block above documents: event_log commits on its own
    // statement, so a failure here leaves the event corrected and the anchor stale.
    expect(SRC).toMatch(/\[germdate\] germination anchor re-derive FAILED after the event committed/);
  });
});
