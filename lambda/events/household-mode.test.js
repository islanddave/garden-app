// HOUSEHOLD-MODE static-source guard (events Lambda) — SURGICAL widening.
// Only event ENTITY reads/writes widen. Achievement / XP / streak queries (per-user)
// MUST stay created_by = ${userId} / user_id = ${userId}. Static-source (L-072), DB-free.

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

describe('events Lambda — Household Mode surgical widening', () => {
  it('imports householdScope + computes householdIds', () => {
    // Named-import LIST, not an exact one-name match: BUG-EVENTSOWN-001 added the write-FK
    // ownership loaders (loadOwnedPlanting / loadOwnedLocation / warnRejectedFk) to this same
    // import. The guarantee this test exists for is that householdScope comes from ./household.js
    // and feeds householdIds — pinning the whole import list made it fail on an unrelated addition.
    expect(SRC).toMatch(/import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('exactly 21 event-entity sites widened to pp.created_by = ANY(${householdIds})', () => {
    // UPDATE event_log guard + 3 event LIST/GET reads + Unit A bulk Quick Log batch
    // plant-resolution (2026-05-24) + HS-2 planting-scoped LIST read (2026-06-04, V3-NAV-001)
    // + DELETE /:id single-event-undo ownership pre-check (2026-06-10, V3-LOGMANY undo fix).
    // + GET /api/events/feed paginated activity feed (2026-06-12, V3-FEED-001).
    // + fruit_set->fruiting planting status-transition WRITE (2026-06-18, V3-FRUITSET-001):
    //   garden_node has no RLS, so the UPDATE scopes ownership via container.created_by; a
    //   household member logging fruit_set on a shared planting may advance it (matches plants PUT).
    // + germination->germinated_at lifecycle-date WRITE, single + batch paths (2026-07-30, CAL-2):
    //   same no-RLS garden_node scope as fruit_set/flowering; a household member logging a
    //   germination on a shared planting may stamp its germinated_at (set-once).
    // + PUT /api/events/:id edit path, TWO sites (2026-08-02, BUG-HARVESTEDIT-001): the ownership
    //   pre-check that also reads whether a harvest_log row exists, and the event_log UPDATE itself.
    //   Both are event-entity ops scoped exactly like the DELETE and GET on the same route, so
    //   household-widening is correct and deliberately identical — this route was ADDED, not
    //   widened: editing any event previously fell through to a 405, so the form's Save had never
    //   worked for any event type. Matching the sibling routes' scope rather than inventing a
    //   looser rule is the point; a bug fix is the wrong place to widen authz.
    // + POST /api/events write-FK ownership gate (2026-08-04, BUG-EVENTSOWN-001): ONE site, the
    //   loadOwnedPlantingRef pre-flight that proves a body-supplied plant_id belongs to the
    //   caller's household before the row is written. This is a NARROWING, not a widening — the
    //   path previously had no ownership predicate at all, so the count moving is the fix landing
    //   rather than scope creeping. loadOwnedProject and loadOwnedLocation do not match this regex
    //   (they scope on the parent table's own created_by, with no pp alias), so only one is added.
    // + GET /api/events?plant_id= WITHOUT project_id, the plant_id-only list arm (2026-08-10,
    //   BUG-UNSCOPEDPLANTLOG-001): ONE site. Like the POST gate above this is a NARROWING — the
    //   shape previously fell through to the unfiltered household feed, so a project-less
    //   planting's log showed the whole garden. Its PRIMARY ownership gate is loadOwnedPlantingRef
    //   (in ./authz-parents.js, so it does not touch this count); the site counted here is the
    //   secondary container predicate on the LEFT-joined rows that do have a project, which keeps
    //   this arm's scope identical to its two sibling branches.
    // Each is an event-entity op, so household-widening is correct per the surgical-widening
    // invariant. Count was 4 pre-Unit-A, 5 post-Unit-A, 6 post-HS-2, 7 post-undo-fix, 8 post-feed, 9 post-fruit_set, 10 post-flowering (V3-FLOWERING-001), 12 post-batch-flowering+fruit_set (V4-EVENTSEL-002: the two batch-path status UPDATEs), 14 post-germination (CAL-2: single + batch germinated_at set-once writes), 16 post-event-edit (BUG-HARVESTEDIT-001: PUT pre-check + UPDATE), 17 post-events-POST-authz (BUG-EVENTSOWN-001), back to 16 once that gate moved out of this file into ./authz-parents.js (step 3, same day — the predicate did not go away, it stopped being inline; authz-parents-copies-sync.test.js guards it there), 17 post-plant-only-list-arm (BUG-UNSCOPEDPLANTLOG-001) (L-099 drift class).
    // + harvest->'harvested' planting status-transition WRITE, single + batch paths (2026-08-14,
    //   V4-HARVSTATUS-001): completes the fruit_set/flowering pattern. TWO sites, and both are
    //   inside an EXISTS rather than a container join — a planting may have NO container, and the
    //   join form drops those rows silently (BUG-ANCHORNOPROJ-001, same defect in the watch
    //   route). The regex matches the predicate wherever it sits, which is why the count moves by
    //   two and not zero. 19 post-harvest-status.
    // + BUG-STATUSADVNOPROJ-001 (2026-08-15): the four fruit_set/flowering status UPDATEs (single +
    //   batch) converted from the container JOIN to the same two-arm predicate. The count STAYS 19
    //   — deliberately, not by omission. Each of those sites had exactly ONE pp.created_by
    //   predicate before (in the join's WHERE) and has exactly ONE after (inside the EXISTS), so
    //   the move is 1:1 and this regex is blind to it. What DID move is the container-less arm
    //   count in the test below, 2 -> 6, which is the assertion that actually pins this fix.
    // + transplant->transplanted_at lifecycle-date WRITE, single + batch paths (2026-08-16,
    //   V4-TRANSPLANTANCHOR-001): TWO sites, 19 -> 21. Same class as the germination write above —
    //   a household member logging a transplant on a shared planting may stamp its transplanted_at
    //   (set-once) — but scoped with the two-arm predicate rather than germination's container
    //   join, so each site contributes exactly one pp.created_by predicate from inside its EXISTS.
    //   The count moves by two and not zero because these UPDATEs are NEW statements, not a
    //   predicate migrating within an existing one (contrast BUG-STATUSADVNOPROJ-001 directly
    //   above, which is why the two entries look inconsistent and are not).
    // + V4-LOSSEVENT-001 plant-reduction counter WRITE and its delete-time reversal (2026-08-18):
    //   TWO sites, 21 -> 23. Same class and same two-arm shape as the transplant anchor above —
    //   two NEW garden_node UPDATEs, each contributing exactly one pp.created_by predicate from
    //   inside its EXISTS. These two are the first statements in this file to change a COUNTER
    //   rather than a status or a date, so the household scope is what stops one member's log from
    //   decrementing another household's planting.
    // + BUG-GERMDATEBATCH-001 germination-anchor CORRECTION on the PUT (2026-08-20): ONE site,
    //   23 -> 24. Same class as the germination forward writes above and scoped the SAME way, by
    //   the container join rather than the two-arm predicate — deliberately, because the join is
    //   the scope of the two writes that create the anchors this statement is entitled to move, so
    //   it contributes exactly one pp.created_by predicate from the join's WHERE. A container-less
    //   planting was never stamped from an event, so its germinated_at can only be a human's, and
    //   declining to touch it is the correct behaviour rather than the BUG-ANCHORNOPROJ-001 blind
    //   spot. That is also why the container-less-arm census below does NOT move.
    const matches = SRC.match(/pp\.created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBe(24);
    // The moved gate still exists — assert it at its new home so this count can never drop silently.
    const localAuthz = decomment(readFileSync(resolve(__dirname, 'authz-parents.js'), 'utf8'));
    expect(localAuthz).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  // V4-HARVSTATUS-001, extended by BUG-STATUSADVNOPROJ-001. Every planting status-advance UPDATE in
  // this file scopes ownership with the two-arm predicate instead of a container join, because a
  // planting may have NO container (prod has 4 live) and the join form drops those rows silently —
  // the transition simply never fires and nothing errors (BUG-ANCHORNOPROJ-001, same defect in the
  // watch route). A refactor that "tidied" any of the six back into a container join would
  // reintroduce exactly that blind spot, and would do it invisibly: the household count above does
  // NOT move when the predicate migrates between a join WHERE and an EXISTS, so this test is the
  // only thing standing between that refactor and prod.
  // V4-TRANSPLANTANCHOR-001 extends the population this guards beyond status advances. The arm count
  // is now 6 status-advance + 2 transplant-anchor writes, and the two groups are asserted separately
  // on purpose: a bare total of 8 would be satisfied by, say, seven status arms and one transplant
  // arm, which is precisely the "right number of predicates on the wrong statements" failure the
  // sibling status-advance-scope.test.js header calls out.
  //
  // BUG-LOGMANYPROJECTLESS-001 adds two more and RETIRES the germinated_at carve-out above, which
  // used to read "those two writes still carry the narrower container join (recorded, not fixed
  // here)". That is now half true and the half matters: the BATCH germination write was converted
  // (it sits in the Log Many transaction, which can now hand it a project-less planting), while the
  // single-event POST copy and the PUT date-correction copy still carry the join and are still live
  // blind spots — logging a germination by hand to a project-less planting stamps no anchor, and
  // there are 5 such plantings on prod today. Censused here at exactly one armed of three, so
  // converting the other two later fails this test loudly instead of drifting past it.
  // The twelfth arm is not a write at all: it is the Log Many scope RESOLVER, the SELECT that
  // decides which plantings exist for the whole batch.
  it("all twelve ownership-scoped garden_node statements keep the container-less arm", () => {
    const harvested = SRC.match(/SET status = 'harvested'/g) ?? [];
    const fruiting  = SRC.match(/SET status = 'fruiting'/g) ?? [];
    const flowering = SRC.match(/SET status = 'flowering'/g) ?? [];
    const transplanted = SRC.match(/SET transplanted_at = /g) ?? [];
    // V4-LOSSEVENT-001: the reduction write and its delete-time reversal. Grouped by their own
    // signature for the same reason the four above are — a bare total of 10 would be satisfied by
    // nine status arms and one reduction arm. Matched on the qty_lost assignment because it is the
    // one line unique to these two statements and absent from every other garden_node write.
    const reduction = SRC.match(/qty_lost {4}= /g) ?? [];
    expect(harvested.length).toBe(2);                   // single-event path + batch path
    expect(fruiting.length).toBe(2);                    // V3-FRUITSET-001 + V4-EVENTSEL-002 batch
    expect(flowering.length).toBe(2);                   // V3-FLOWERING-001 + V4-EVENTSEL-002 batch
    expect(transplanted.length).toBe(2);                // V4-TRANSPLANTANCHOR-001 single + batch
    expect(reduction.length).toBe(2);                   // V4-LOSSEVENT-001 apply + reverse

    // The two BUG-LOGMANYPROJECTLESS-001 additions, grouped by their own signature for the same
    // reason the five above are. Each sql template ends at the next backtick — SQL inside these
    // templates contains none, one would terminate the string — so that is an exact statement
    // boundary and the arm cannot be borrowed from a neighbouring statement.
    const stmtsAfter = (needle) => SRC.split(needle).slice(1).map((s) => s.slice(0, s.indexOf('`')));
    const ARM = /p\.container_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)/;
    // THREE, not two — the carve-out comment this replaced said two and undercounted. They are the
    // Log Many batch write, the single-event POST write, and the PUT germination-date correction.
    const germ = stmtsAfter('SET germinated_at = ');
    expect(germ.length).toBe(3);
    expect(germ.filter((s) => ARM.test(s))).toHaveLength(1); // batch fixed; the other two are NOT

    const resolver = SRC.slice(
      SRC.indexOf('LEFT JOIN public.container pp ON pp.id = p.container_id AND pp.deleted_at IS NULL'),
      SRC.indexOf('ORDER BY p.display_name, p.id'),
    );
    expect(resolver).toMatch(ARM);

    const arms = SRC.match(new RegExp(ARM.source, 'g')) ?? [];
    expect(arms.length).toBe(12);
  });

  it('achievement resolved-set query NOT widened (per-user isolation invariant)', () => {
    // The resolved-set CTE counts THIS user's resolved issues for the achievement
    // evaluator — must remain scoped to the requesting user.
    const resolveDayIdx = SRC.indexOf('AS resolve_day');
    expect(resolveDayIdx).toBeGreaterThan(-1);
    const block = SRC.slice(resolveDayIdx, resolveDayIdx + 400);
    expect(block).toMatch(/pp\.created_by = \$\{userId\}/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('achievement event_counts query NOT widened (per-user isolation invariant)', () => {
    // The COUNT(*) FILTER block feeding type_events/today_events stays per-user.
    const teIdx = SRC.indexOf('AS type_events');
    expect(teIdx).toBeGreaterThan(-1);
    const block = SRC.slice(teIdx, teIdx + 400);
    expect(block).toMatch(/created_by = \$\{userId\} AND deleted_at IS NULL/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('set_config audit-actor stays the real requesting user', () => {
    expect(SRC).toMatch(/set_config\('app\.actor_clerk_sub', \$\{userId\}, true\)/);
  });

  it('per-user surfaces (user_id) untouched', () => {
    // user_stats / xp_events / user_achievements / notification_subscriptions all key on user_id.
    expect(SRC).toMatch(/user_id = \$\{userId\}/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});

