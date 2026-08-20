// BUG-STATUSADVNOPROJ-001 — every planting status-advance UPDATE must scope household ownership
// with the TWO-ARM predicate, never an inner join on container.
//
// The defect this pins: the four fruit_set/flowering UPDATEs (single-event + batch path) shipped as
//   FROM public.container pp WHERE ... p.container_id = pp.id AND pp.created_by = ANY(householdIds)
// which is an INNER join, so a planting with container_id IS NULL never matched and never advanced.
// Prod had 4 such live plantings. Nothing errored — the UPDATE just touched zero rows, which is
// indistinguishable from "already at that status" from the caller's side. Same defect class as
// BUG-ANCHORNOPROJ-001 in lambda/harvests/watch-route.js.
//
// These assertions are per-STATEMENT, not file-global: a global count can be satisfied by the right
// number of predicates sitting on the wrong statements. Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same decomment contract as household-mode.test.js: a construct NAMED IN A COMMENT is not that
// construct, so a comment describing the old join must never satisfy (or trip) a guard here.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Each garden_node UPDATE statement, sliced from its UPDATE keyword to the line that closes the
// tagged template. SQL inside these templates contains no backticks (one would terminate the
// string), so the closing-backtick lookahead is an exact statement boundary.
const STATEMENTS = [...SRC.matchAll(/UPDATE public\.garden_node p\b[\s\S]*?(?=\n\s*`)/g)].map((m) => m[0]);

const EXISTS_ARM = /EXISTS \(SELECT 1 FROM public\.container pp\s+WHERE pp\.id = p\.container_id\s+AND pp\.created_by = ANY\(\$\{householdIds\}\)\)/;
const NULL_ARM = /OR \(p\.container_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)\)/;

// [target status, how many statements set it, the guard each one must keep]
const TRANSITIONS = [
  ["fruiting", 2, /p\.status = ANY\(\$\{FRUITING_SOURCE_STATUSES\}\)/],
  ["flowering", 2, /p\.status = ANY\(\$\{FLOWERING_SOURCE_STATUSES\}\)/],
  ["harvested", 2, /p\.status = ANY\(\$\{HARVESTED_SOURCE_STATUSES\}\)/],
];

describe('planting status-advance UPDATEs — container-less ownership scope', () => {
  it('finds every garden_node UPDATE statement in the file', () => {
    // 6 status advances + 2 germinated_at set-once writes (single + batch) + 2 transplanted_at
    // set-once writes (single + batch, V4-TRANSPLANTANCHOR-001) + 2 V4-LOSSEVENT-001 plant-
    // reduction counter writes (apply on POST + reverse on DELETE). If this drifts, the
    // per-statement assertions below may be inspecting the wrong slices.
    //
    // The reduction pair is the first entry here that is NOT a status advance and NOT a lifecycle
    // date — it moves quantity / qty_current / qty_lost and deliberately never touches `status`.
    // That absence is asserted in lambda/events/plant-reduction.test.js, not here, because this
    // file's per-statement loop is keyed on the transition it expects each statement to make.
    //
    // The two anchor-supersede statements V4-TRANSPLANTANCHOR-001 adds alongside the transplant
    // writes are NOT in this census and must not be: they target public.plant_anchor_derivation,
    // not garden_node. They read garden_node through an EXISTS aliased `gp`, which the anchor in
    // this regex (`UPDATE public.garden_node p`) correctly declines to match.
    //
    // + 1 germination-anchor CORRECTION on the PUT (2026-08-20, BUG-GERMDATEBATCH-001), 12 -> 13.
    // It is the first garden_node write in this file that deliberately does NOT carry a set-once /
    // forward-only predicate: its whole purpose is to move an anchor a previous write already set,
    // guarded instead on the stored value still equalling that event's own pre-edit date. It is
    // therefore also not a transition, so this file's per-status loop below correctly skips it and
    // lambda/events/germination-anchor-correction.test.js owns its predicates.
    expect(STATEMENTS.length).toBe(13);
  });

  for (const [status, count, guard] of TRANSITIONS) {
    const stmts = STATEMENTS.filter((s) => s.includes(`SET status = '${status}'`));

    it(`both ${status} UPDATEs exist (single-event + batch path)`, () => {
      expect(stmts.length).toBe(count);
    });

    it(`both ${status} UPDATEs scope ownership with the two-arm predicate, not a container join`, () => {
      for (const s of stmts) {
        // The inner join is the defect itself: with it, container_id IS NULL never matches. The
        // EXISTS subquery legitimately reads public.container, so it is stripped before the
        // outer statement is checked for a join.
        const outer = s.replace(/EXISTS \(SELECT 1 FROM public\.container[\s\S]*?\)\)/, '');
        expect(outer).not.toMatch(/FROM public\.container/);
        expect(outer).not.toMatch(/p\.container_id = pp\.id/);
        expect(s).toMatch(EXISTS_ARM);
        expect(s).toMatch(NULL_ARM);
      }
    });

    it(`both ${status} UPDATEs keep their forward-only source-status guard`, () => {
      // Widening ownership must not widen the transition: the *_SOURCE_STATUSES guard is what makes
      // these forward-only and idempotent, and it is the predicate a careless rewrite drops.
      for (const s of stmts) {
        expect(s).toMatch(guard);
        expect(s).toMatch(/p\.deleted_at IS NULL/);
        expect(s).toMatch(/\$\{eventType\}::text/);
      }
    });
  }

  it('both arms of every status UPDATE bind the SAME householdIds (visibility, not ownership)', () => {
    // The container-less arm must never fall back to a looser scope (userId, a bare NOT NULL, or
    // no predicate at all). Binding the same householdIds is what makes this fix a VISIBILITY
    // widening — the set of plantings a caller may advance is unchanged.
    const advancing = STATEMENTS.filter((s) => /SET status = '(fruiting|flowering|harvested)'/.test(s));
    expect(advancing.length).toBe(6);
    for (const s of advancing) {
      const binds = s.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
      expect(binds.length).toBe(2);                     // one per arm, both householdIds
      expect(s).not.toMatch(/created_by = \$\{userId\}/);
    }
  });
});
