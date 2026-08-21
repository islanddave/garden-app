// BUG-LOGMANYPROJECTLESS-001 — Log Many must not silently omit a project-less planting.
//
// THE DEFECT. The batch scope resolver and the event_log INSERT both read
//     FROM public.garden_node p JOIN public.container pp ON pp.id = p.container_id
// an INNER join, so a planting with container_id IS NULL matched zero rows in both. Because the
// resolver ran first, the effect was not a partial write — it was total invisibility: the planting
// never entered the dry-run preview, never appeared in the review checklist, and never got an
// event. "All active plantings" quietly meant "all active plantings that sit in a project", and no
// surface anywhere said so.
//
// MEASURED, live prod 2026-08-21 (not inferred): 6 project-less plantings, 5 of them eligible —
// San Marzano rescue, Aloe Vera, Super Sweet 100 Rescue, Hydrangeas, Kousa Dogwood, all created
// 08-07..08-17 — against 221 project-bearing eligible ones. Their 16 events carry source='app_batch'
// ZERO times; every one arrived by hand through the single-event path. That is the fingerprint of a
// structural exclusion rather than a preference. (The BUG-EMPROJGUARD-001 comment in index.js said
// "0 such plantings in prod"; that was true when written and is not any more.)
//
// Static-source (L-072), DB-free — the house pattern for asserting SQL shape in a Lambda with no DB
// seam, and deliberately the WEAKER half. What a real container_id-NULL row does against the real
// `garden_node` view is proved in tests/integration/logmany-projectless.int.test.js. What THIS file
// buys is a guard that runs on every push to dev, catching reintroduction of the inner join,
// removal of the ownership arm, or a "cleanup" that folds the honest-count reconciliation away —
// none of which the integration suite flags until CI's DB job runs.
//
// Each claim fails to a DIFFERENT mutation; see the report for the recorded runs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — the fix's own commentary quotes the old
// inner join verbatim, so every assertion below would find its own epitaph and pass. Same
// decomment contract as logmany-dormant.test.js / status-advance-scope.test.js.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Returns '' when either needle is missing rather than throwing at module scope. Deliberate, and
// the house behaviour (logmany-dormant.test.js / logmany-zone-scope.test.js do the same): a slice
// helper that throws takes the WHOLE FILE down as a suite-level error, so restoring the inner join
// produces one unhelpful "cannot read source" instead of a list of named tests saying which
// invariants broke. An empty slice fails every assertion below individually, and the locatability
// test names the cause.
function slice(startNeedle, endNeedle, from = SRC) {
  const start = from.indexOf(startNeedle);
  if (start < 0) return '';
  const end = from.indexOf(endNeedle, start + startNeedle.length);
  return end > start ? from.slice(start, end) : '';
}

// The whole POST /api/events/batch route, bounded by the next route's rawPath match. Every
// assertion below runs against a slice of THIS, never the 3,000-line file: the single-event path
// has its own container joins and would satisfy a file-global claim while the batch path stayed
// broken.
const BATCH = slice("rawPath === '/api/events/batch' && method === 'POST'",
                    "rawPath === '/api/events/batches'");

const RESOLVER = slice('LEFT JOIN public.container pp ON pp.id = p.container_id AND pp.deleted_at IS NULL',
                       'ORDER BY p.display_name, p.id', BATCH);
const EVENT_INSERT = slice('INSERT INTO event_log', 'INSERT INTO entity_memory', BATCH);
// Bounded by the PLANT-keyed upsert's column list, not by the comment that separates them: a `--`
// needle is stripped by decomment() before indexOf ever sees it.
const EM_PROJECT = slice('INSERT INTO entity_memory', '(plant_id, last_event_at,', BATCH);
const GERMINATION = slice("= 'germination'", 'transplanted_at', BATCH);
// Runs from the reconciliation through the response body it feeds — the divergence keys live
// INSIDE resp(200, {…}), so a slice that stopped at the `return` would miss exactly what it exists
// to pin.
const RECONCILE = slice('const missingPlantIds', '...batchFx,', BATCH);

// The project-less ownership arm. `p` is the only node alias the batch route uses.
const OWN_ARM = /p\.container_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)/;

describe('events Lambda — Log Many admits project-less plantings (BUG-LOGMANYPROJECTLESS-001)', () => {
  it('the batch route slices are still locatable (the foundation these assertions stand on)', () => {
    // A slice that silently went empty is how a suite of source guards turns vacuous. This is the
    // test that names that cause when it happens — and since slice() returns '' rather than
    // throwing, every other test in the file reports independently instead of being swallowed by a
    // suite-level error.
    for (const [name, s] of Object.entries({ RESOLVER, BATCH, EVENT_INSERT, EM_PROJECT, GERMINATION, RECONCILE })) {
      expect(s, `${name} slice went empty — its anchor moved or was deleted`).not.toBe('');
    }
    expect(RESOLVER).toMatch(/AND NOT \(p\.id = ANY\(\$\{excludeIds\}\)\)/);
    expect(EVENT_INSERT).toMatch(/\$\{EVENT_SOURCE_BATCH\}/);
    expect(EM_PROJECT).toMatch(/ON CONFLICT \(project_id\)/);
    expect(RECONCILE).toMatch(/insertedEvents/);
  });

  it('NO statement in the batch transaction inner-joins container — the whole defect class, in one line', () => {
    // The keystone. There were three inner joins on container in this route (resolver, event_log
    // INSERT, germination anchor UPDATE) and each drops project-less rows in a different, silent
    // way: no candidate, no event row, no germinated_at stamp. Asserting the shape once over the
    // whole route is what stops a fourth from being added later.
    expect(BATCH).not.toMatch(/(?<!LEFT )\bJOIN\s+public\.container\b/);
    // The UPDATE ... FROM spelling is the same trap wearing different clothes — it is an inner join
    // by another name, and it is what the germination anchor UPDATE actually used. So container may
    // be named as a row source ONLY inside an existence probe, where it can answer "owned?" without
    // being able to eliminate the planting. Enumerated rather than negated so the rule is stated
    // positively and cannot pass by there being no occurrences at all.
    const containerSources = [...BATCH.matchAll(/(.{0,20})FROM public\.container\b/g)].map((m) => m[1]);
    expect(containerSources.length).toBeGreaterThan(0);
    for (const before of containerSources) expect(before).toMatch(/EXISTS \(SELECT 1 $/);
  });

  it('the scope resolver LEFT JOINs the container and scopes ownership with the two-arm predicate', () => {
    // Both halves are required and neither implies the other: a LEFT JOIN with the old
    // `pp.created_by = ANY(householdIds)` alone still drops every project-less row, because
    // pp.created_by is NULL there and `NULL = ANY(...)` is NULL, not true. That is the mutation
    // most likely to be made by someone "fixing" this from the join alone.
    expect(RESOLVER).toMatch(/LEFT JOIN public\.container pp ON pp\.id = p\.container_id/);
    expect(RESOLVER).toMatch(OWN_ARM);
  });

  it('a planting whose project is missing or soft-deleted still stays OUT', () => {
    // The blast-radius pin, and the one that makes this a fix rather than a widening: under the old
    // INNER JOIN + `WHERE pp.deleted_at IS NULL`, a planting pointing at a deleted project was
    // excluded, and it must stay excluded or Log Many starts watering plantings out of beds Dave
    // deleted.
    //
    // Honest about which term does the work, because it is not the obvious one. The exclusion is
    // carried TWICE: by the ownership arm (which keys on the FK column `p.container_id IS NULL` —
    // false for this row — so it is never adopted) and by the explicit term below. Deleting the
    // explicit term alone changes NO behaviour; the integration suite measured that directly and
    // stayed green. It is kept as defence in depth against one specific rewrite: keying the arm on
    // the JOINED ROW (`pp.id IS NULL`) instead of the FK column, which reads identically, is what
    // "we LEFT JOINed, so test the join" naturally produces, and DOES un-hide these rows.
    expect(RESOLVER).toMatch(/AND \(p\.container_id IS NULL OR pp\.id IS NOT NULL\)/);
    expect(RESOLVER).toMatch(/pp\.deleted_at IS NULL/);
    // The arm must key on the FK column, never on the joined row.
    expect(RESOLVER).not.toMatch(/pp\.id IS NULL AND p\.created_by/);
  });

  it("the 'project' scope arm cannot be satisfied by a project-less planting", () => {
    // Correctness of the widening, not of the join: a project-less planting belongs to no project,
    // so `WHEN 'project' THEN pp.id = ${projectId}` must stay a comparison against the JOINED row
    // (NULL for these, hence excluded) and must NOT be "helpfully" rewritten to something that
    // matches everything ownerless. `WHEN 'all' THEN true` is what admits them.
    expect(RESOLVER).toMatch(/WHEN 'project' THEN pp\.id = \$\{projectId\}/);
    expect(RESOLVER).toMatch(/WHEN 'all'\s+THEN true/);
  });

  it('the event_log INSERT LEFT JOINs, so a resolved planting always produces a row', () => {
    // The second half of the same defect. Even with the resolver fixed, an inner join here takes a
    // planting the user just saw ticked in the review list and writes nothing for it.
    expect(EVENT_INSERT).toMatch(/FROM public\.garden_node p\s*\n\s*LEFT JOIN public\.container pp ON pp\.id = p\.container_id/);
    expect(EVENT_INSERT).toMatch(/WHERE p\.id = ANY\(\$\{plantIds\}\)/);
  });

  it("the written event's project comes from the PLANTING (p.container_id), so NULL flows through", () => {
    // Pins the value, not just the join. event_log.project_id is nullable and event_log_has_anchor
    // is (plant_id IS NOT NULL OR project_id IS NOT NULL) — both read from live prod's
    // information_schema/pg_constraint, not inferred from a cast — so p.id satisfies the anchor on
    // its own and 13 such rows already exist on prod. A "fix" that COALESCEd some fallback project
    // in would re-file these plantings under a project they are not in.
    expect(EVENT_INSERT).toMatch(/SELECT p\.container_id, pp\.location_id, p\.id,/);
    expect(EVENT_INSERT).not.toMatch(/COALESCE\([^)]*container_id/);
  });

  it('the project-keyed entity_memory upsert keeps its own NULL self-guard', () => {
    // THE PARTIAL-COMMIT TRAP, and the reason this assertion is in the project-less file rather
    // than left to BUG-EMPROJGUARD-001's own coverage: until this fix, a project-less planting
    // could not reach this statement at all, so the guard was untested-in-practice dead code. It is
    // now the only thing between these rows and a violation of entity_memory_exactly_one_parent
    // (verified on prod: exactly one of plant_id/project_id/location_id must be non-NULL), which
    // aborts the whole transaction AFTER the event rows above have been staged.
    expect(EM_PROJECT).toMatch(/WHERE p\.id = ANY\(\$\{plantIds\}\) AND p\.container_id IS NOT NULL/);
  });

  it('the germination anchor UPDATE uses the two-arm predicate, not a container join', () => {
    // `germination` IS in BATCH_EVENT_TYPES, so this statement really can be the one that
    // establishes an anchor. It was the last inner-join holdout in the route and was harmless only
    // while the resolver could never hand it a project-less planting. Left alone, the fix would
    // have traded a missing event for a missing germinated_at — indistinguishable, from the
    // caller's side, from "already germinated".
    expect(GERMINATION).toMatch(OWN_ARM);
    expect(GERMINATION).toMatch(/EXISTS \(SELECT 1 FROM public\.container pp/);
  });

  it('the response count is read back from the DB, never assumed from plantIds', () => {
    // The non-silence requirement. `count: plantIds.length` is what the handler MEANT to write;
    // insertedEvents is re-read from event_log and is the only count in this route derived from the
    // database rather than from the code path that just ran. Under the old INSERT it would have
    // been the smaller of the two and nothing compared them — which is exactly how a partial batch
    // reported total success.
    expect(RECONCILE).toMatch(/const missingPlantIds = plantIds\.filter/);
    expect(BATCH).toMatch(/count: insertedEvents\.length/);
    expect(BATCH).not.toMatch(/count: plantIds\.length,\n\s*\.\.\.\(missingPlantIds/);
  });

  it('a divergence is REPORTED to the caller, not just logged server-side', () => {
    // A console.warn nobody reads is not the fix: the user's phone must say so. These keys appear
    // only on a divergence, so no client field changes shape in the normal case.
    expect(RECONCILE).toMatch(/skipped_plant_ids: missingPlantIds/);
    expect(RECONCILE).toMatch(/warning:/);
    expect(RECONCILE).toMatch(/requested_count: plantIds\.length/);
  });
});
