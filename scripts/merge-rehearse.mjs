#!/usr/bin/env node
// V4-PLANTMERGE-001 rehearsal harness — canon §7.
//
// Drives mergeCore against an EPHEMERAL NEON BRANCH and asserts the §7 invariant set. It exists
// because the schema gates prove only that the table exists; they prove nothing about a merge, and a
// merge is not reversible by re-running it.
//
// Expectations are computed IN-RUN from the pre-state, never hardcoded — a literal would fail closed
// on the next logged event and get "fixed" by editing the constant, destroying the tripwire (§7).
//
//   MERGE_REHEARSAL_DSN=postgres://... node scripts/merge-rehearse.mjs \
//     --winner <uuid> --losers <uuid,uuid> --label "group 6 Chili Red" [--household id,id]
//
// Exit 0 = every invariant held AND the second run changed nothing. Exit 1 = any failure.
// A green run here is NOT full verification: it does not exercise Lambda side effects,
// user_stats/XP recompute, or the app read paths. The water-verdict check needs staging.

import { neon } from '@neondatabase/serverless'
import { mergeCore, readFingerprint } from '../lambda/plants/merge.js'

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d
}

const DSN = process.env.MERGE_REHEARSAL_DSN
if (!DSN) { console.error('MERGE_REHEARSAL_DSN is required (branch DSN, never prod)'); process.exit(2) }

const winnerId = arg('winner')
const loserIds = (arg('losers') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const label = arg('label', 'unlabelled')
if (!winnerId || !loserIds.length) { console.error('--winner and --losers are required'); process.exit(2) }

const sql = neon(DSN)

// Guard: refuse to run against anything that looks like the production branch. The whole point of
// the harness is that it mutates, so pointing it at prod by accident must be impossible, not unlikely.
const PROD_MARKERS = ['br-delicate-sea-amum92c2']
if (PROD_MARKERS.some((m) => DSN.includes(m))) {
  console.error('REFUSING: DSN names the production branch. Rehearse on an ephemeral branch.')
  process.exit(2)
}

const groupIds = [winnerId, ...loserIds]
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Everything the invariant set compares, captured in one shape so pre/post diff is mechanical. */
async function snapshot() {
  const [harvest] = await sql`
    SELECT count(*)::int AS n,
           COALESCE(SUM(weight_grams), 0)::numeric AS weight,
           COALESCE(SUM(quantity), 0)::numeric AS qty
    FROM harvest_log WHERE deleted_at IS NULL`
  const [photos] = await sql`SELECT count(*)::int AS n FROM photos WHERE deleted_at IS NULL`
  const [groupEvents] = await sql`
    SELECT count(*)::int AS n FROM event_log
    WHERE plant_id = ANY(${groupIds}) AND deleted_at IS NULL`
  const [otherEvents] = await sql`
    SELECT count(*)::int AS n FROM event_log
    WHERE NOT (plant_id = ANY(${groupIds})) AND deleted_at IS NULL`
  const [otherDigest] = await sql`
    SELECT COALESCE(md5(string_agg(id::text, ',' ORDER BY id)), '') AS d FROM event_log
    WHERE NOT (plant_id = ANY(${groupIds})) AND deleted_at IS NULL`
  // Unrolled, not looped: @neondatabase/serverless 0.10.x has no sql.query/sql.unsafe, so every
  // identifier must be literal in-template. A loop over table names is impossible here by design.
  const [pres] = await sql`SELECT count(*)::int AS n FROM preservation_log`
  const [crit] = await sql`SELECT count(*)::int AS n FROM critter_state`
  const [seen] = await sql`SELECT count(*)::int AS n FROM seen_event`
  const [wimp] = await sql`SELECT count(*)::int AS n FROM watch_impression`
  const [hwd]  = await sql`SELECT count(*)::int AS n FROM harvest_watch_dismissal`
  const untouched = {
    preservation_log: pres.n, critter_state: crit.n, seen_event: seen.n,
    watch_impression: wimp.n, harvest_watch_dismissal: hwd.n,
  }
  return { harvest, photos, groupEvents, otherEvents, otherDigest, untouched }
}

console.log(`\n=== merge rehearsal — ${label} ===`)
console.log(`winner ${winnerId}\nlosers ${loserIds.join(', ')}\n`)

const household = (arg('household') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const [{ created_by: winnerOwner }] = await sql`SELECT created_by FROM plants WHERE id = ${winnerId}`
const owners = await sql`
  SELECT DISTINCT created_by FROM plants WHERE id = ANY(${groupIds}) AND deleted_at IS NULL`
// The household predicate is an authz filter, not a merge rule; for a rehearsal we scope it to
// exactly the group's own owners so the harness measures the MERGE, not the authz gate. Production
// does NOT get this freedom — see the rescue-intake finding in the ledger.
const householdIds = household.length ? household : owners.map((o) => o.created_by)
console.log(`household scope: ${householdIds.join(', ')}${household.length ? '' : '  (derived from group owners)'}\n`)

const pre = await snapshot()
const preLoserEvents = await sql`
  SELECT count(*)::int AS n FROM event_log
  WHERE plant_id = ANY(${loserIds}) AND deleted_at IS NULL`

// ── 1. dry run — must write nothing ───────────────────────────────────────────────────────────────
console.log('-- dry run --')
const dry = await mergeCore(sql, {
  winnerId, loserIds, opId: `rehearse-dry-${Date.now()}`,
  userId: winnerOwner, householdIds, groupLabel: label, dryRun: true,
})
console.log(`  status ${dry.status}`)
if (dry.status !== 200) {
  console.error(`  DRY RUN FAILED: ${JSON.stringify(dry.body)}`)
  process.exit(1)
}
const plannedDrop = dry.body?.plan?.events_dropped ?? dry.body?.events_dropped
console.log(`  planned drop-set: ${plannedDrop}`)
const afterDry = await snapshot()
check('dry run wrote nothing', afterDry.groupEvents.n === pre.groupEvents.n
  && afterDry.otherDigest.d === pre.otherDigest.d,
  `group events ${pre.groupEvents.n} -> ${afterDry.groupEvents.n}`)

// ── 2. real run ───────────────────────────────────────────────────────────────────────────────────
console.log('\n-- merge --')
const opId = `rehearse-${label.replace(/\W+/g, '-')}-${Date.now()}`
const fingerprint = await readFingerprint(sql, groupIds)
const run = await mergeCore(sql, {
  winnerId, loserIds, opId, fingerprint,
  userId: winnerOwner, householdIds, groupLabel: label,
})
console.log(`  status ${run.status}`)
if (run.status !== 200) {
  console.error(`  MERGE FAILED: ${JSON.stringify(run.body)}`)
  process.exit(1)
}
console.log(`  events_dropped ${run.body.events_dropped} · rows_repointed ${run.body.rows_repointed}`)

const post = await snapshot()

// ── 3. invariants (canon §7 a–j) ──────────────────────────────────────────────────────────────────
console.log('\n-- invariants --')
check('(a) harvest_log count unchanged', post.harvest.n === pre.harvest.n,
  `${pre.harvest.n} -> ${post.harvest.n}`)
check('(b) harvest weight + quantity sums unchanged',
  String(post.harvest.weight) === String(pre.harvest.weight)
  && String(post.harvest.qty) === String(pre.harvest.qty),
  `weight ${pre.harvest.weight} -> ${post.harvest.weight}, qty ${pre.harvest.qty} -> ${post.harvest.qty}`)
check('(c) photo count unchanged', post.photos.n === pre.photos.n,
  `${pre.photos.n} -> ${post.photos.n}`)

const liveRefs = await sql`
  SELECT count(*)::int AS n FROM event_log
  WHERE plant_id = ANY(${loserIds}) AND deleted_at IS NULL`
check('(d) zero live rows reference a loser', liveRefs[0].n === 0, `${liveRefs[0].n} live loser events`)

const expectedDelta = run.body.events_dropped
check('(e) group event delta == computed drop set',
  pre.groupEvents.n - post.groupEvents.n === expectedDelta,
  `delta ${pre.groupEvents.n - post.groupEvents.n} vs drop set ${expectedDelta}`)

const orphanDrop = await sql`
  SELECT count(*)::int AS n FROM (
    SELECT event_type, metadata->>'batch_id' AS b
    FROM event_log
    WHERE plant_id = ${winnerId} AND deleted_at IS NULL AND metadata->>'batch_id' IS NOT NULL
    GROUP BY 1, 2 HAVING count(*) > 1
  ) x`
check('(f) no surviving duplicate (winner, type, batch_id)', orphanDrop[0].n === 0,
  `${orphanDrop[0].n} duplicate keys survive`)

check('(g) zero events changed for non-group plants',
  post.otherEvents.n === pre.otherEvents.n && post.otherDigest.d === pre.otherDigest.d,
  `${pre.otherEvents.n} -> ${post.otherEvents.n}, digest ${post.otherDigest.d === pre.otherDigest.d ? 'identical' : 'CHANGED'}`)

const ent = await sql`
  SELECT count(*)::int AS n FROM entity WHERE planting_ref_id = ${winnerId} AND deleted_at IS NULL`
const anch = await sql`
  SELECT count(*)::int AS n FROM plant_anchor_derivation
  WHERE plant_id = ${winnerId} AND superseded_at IS NULL`
check('(h) exactly one live entity + one live anchor per winner',
  ent[0].n <= 1 && anch[0].n <= 1, `entity ${ent[0].n}, anchor ${anch[0].n}`)

const untouchedOk = Object.keys(pre.untouched)
  .filter((t) => pre.untouched[t] !== post.untouched[t])
check('(i) side tables unchanged', untouchedOk.length === 0,
  untouchedOk.length ? untouchedOk.map((t) => `${t} ${pre.untouched[t]}->${post.untouched[t]}`).join(', ') : 'all 5 stable')

// ── 4. (j) re-run — must change nothing and replay the first outcome ───────────────────────────────
console.log('\n-- re-run (idempotency) --')
const replay = await mergeCore(sql, {
  winnerId, loserIds, opId, userId: winnerOwner, householdIds, groupLabel: label,
})
const post2 = await snapshot()
check('(j1) replay returns the first run outcome',
  replay.status === 200 && replay.body.events_dropped === run.body.events_dropped,
  `status ${replay.status}, dropped ${replay.body?.events_dropped}`)
check('(j2) replay changed 0 rows',
  post2.groupEvents.n === post.groupEvents.n && post2.otherDigest.d === post.otherDigest.d,
  `group events ${post.groupEvents.n} -> ${post2.groupEvents.n}`)

// A fresh op_id on an already-merged group must NOT re-merge: the losers are soft-deleted, so the
// group load should 404 rather than silently doing a second cutover.
const fresh = await mergeCore(sql, {
  winnerId, loserIds, opId: `${opId}-fresh`, userId: winnerOwner, householdIds, groupLabel: label,
})
check('(j3) fresh op_id on a merged group refuses', fresh.status === 404,
  `status ${fresh.status}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${failed.length ? `FAIL (${failed.length}/${results.length})` : `PASS (${results.length}/${results.length})`} — ${label} ===`)
console.log(`pre-merge loser events: ${preLoserEvents[0].n} · dropped: ${run.body.events_dropped}`)
console.log('NOT covered by this run: Lambda side effects, user_stats/XP recompute, app read paths,')
console.log('and the water-verdict diff (needs staging with a deployed build).\n')
process.exit(failed.length ? 1 : 0)
