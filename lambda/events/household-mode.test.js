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

  it('exactly 17 event-entity sites widened to pp.created_by = ANY(${householdIds})', () => {
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
    const matches = SRC.match(/pp\.created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length).toBe(17);
    // The moved gate still exists — assert it at its new home so this count can never drop silently.
    const localAuthz = decomment(readFileSync(resolve(__dirname, 'authz-parents.js'), 'utf8'));
    expect(localAuthz).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
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

