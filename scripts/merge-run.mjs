#!/usr/bin/env node
// V4-PLANTMERGE-001 runner — executes the frozen group manifest (scripts/merge-groups.json).
//
// Default is DRY RUN. Writing requires --execute AND --i-understand-this-mutates, because the one
// mistake that cannot be undone by re-running is running at all.
//
//   MERGE_DSN=postgres://... node scripts/merge-run.mjs                      # plan only
//   MERGE_DSN=postgres://... node scripts/merge-run.mjs --only 6             # one group
//   MERGE_DSN=postgres://... node scripts/merge-run.mjs --execute --i-understand-this-mutates
//
// Safety properties, each of which exists because of something that actually went wrong:
//  * Winner re-derivation. The manifest's winner is re-computed from LIVE data against plan §4.2
//    (min(event_date), created_at, id). A disagreement aborts unless winner_source is 'dave'. The
//    manifest cannot silently drift from the garden.
//  * `hold: true` groups are skipped and reported. Group 14 is held pending a ruling.
//  * Global pre/post audit across ALL plantings, not just the group — the invariant that matters
//    most is that a merge changed NOTHING outside its own group, and a per-group check cannot see that.
//  * op_id is DETERMINISTIC per group (merge-run-g<N>). Re-running after a crash replays via
//    merge_event rather than performing a second cutover.
//  * Stops on the first failed group. A partially-applied set is recoverable; a blindly-continued
//    one is a forensic exercise.
//
// Post-merge runbook (migrations/v4-plantmerge-001/README.md) is NOT run here — it is deliberately
// a separate, human-sequenced step: rerun-daily-plan, re-baseline integrity-weekly, anchor coverage.

import { neon } from '@neondatabase/serverless'
import { mergeCore, readFingerprint } from '../lambda/plants/merge.js'
import { readFileSync } from 'node:fs'

const argv = process.argv
const has = (f) => argv.includes(`--${f}`)
const val = (f, d = null) => { const i = argv.indexOf(`--${f}`); return i > -1 && argv[i + 1] ? argv[i + 1] : d }

const DSN = process.env.MERGE_DSN
if (!DSN) { console.error('MERGE_DSN is required'); process.exit(2) }
const EXECUTE = has('execute') && has('i-understand-this-mutates')
if (has('execute') && !EXECUTE) {
  console.error('--execute also requires --i-understand-this-mutates'); process.exit(2)
}

const HOUSEHOLD = (val('household') ?? process.env.GARDEN_HOUSEHOLD_IDS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)
if (!HOUSEHOLD.length) {
  console.error('household ids required: --household a,b or GARDEN_HOUSEHOLD_IDS'); process.exit(2)
}

const manifest = JSON.parse(readFileSync(new URL('./merge-groups.json', import.meta.url), 'utf8'))
const only = val('only')
const groups = manifest.groups.filter((g) => (only ? String(g.n) === String(only) : true))
if (!groups.length) { console.error(`no group matches --only ${only}`); process.exit(2) }

const sql = neon(DSN)
const money = (n) => String(n).padStart(5)

/** Global state — deliberately garden-wide, so "we touched only the group" is checkable. */
async function audit(groupIds) {
  const [h] = await sql`SELECT count(*)::int n, COALESCE(SUM(weight_grams),0)::numeric w,
                               COALESCE(SUM(quantity),0)::numeric q
                        FROM harvest_log WHERE deleted_at IS NULL`
  const [p] = await sql`SELECT count(*)::int n FROM photos WHERE deleted_at IS NULL`
  const [pl] = await sql`SELECT count(*)::int n FROM plants WHERE deleted_at IS NULL`
  const [ev] = await sql`SELECT count(*)::int n FROM event_log WHERE deleted_at IS NULL`
  const [outside] = await sql`
    SELECT COALESCE(md5(string_agg(id::text, ',' ORDER BY id)), '') d, count(*)::int n
    FROM event_log WHERE deleted_at IS NULL AND NOT (plant_id = ANY(${groupIds}))`
  return { harvest: h, photos: p.n, plants: pl.n, events: ev.n, outside }
}

/** Plan §4.2 fallback, re-derived from live data rather than trusted from the manifest. */
async function deriveWinner(ids) {
  const rows = await sql`
    SELECT p.id, p.created_at,
           (SELECT min(e.event_date) FROM event_log e
             WHERE e.plant_id = p.id AND e.deleted_at IS NULL) AS first_event
    FROM plants p WHERE p.id = ANY(${ids}) AND p.deleted_at IS NULL`
  if (rows.length !== ids.length) return null
  const key = (r) => [
    r.first_event ? new Date(r.first_event).getTime() : Number.MAX_SAFE_INTEGER,
    new Date(r.created_at).getTime(), r.id,
  ]
  return [...rows].sort((a, b) => {
    const ka = key(a); const kb = key(b)
    for (let i = 0; i < 3; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1 }
    return 0
  })[0].id
}

console.log(`\n=== V4-PLANTMERGE-001 runner — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} ===`)
console.log(`manifest ${manifest.generated} · ${groups.length} group(s) · household ${HOUSEHOLD.join(', ')}\n`)

const allIds = groups.flatMap((g) => [g.winner.id, ...g.losers.map((l) => l.id)])
const before = await audit(allIds)
console.log(`garden before: ${before.plants} plantings · ${before.events} events · ${before.harvest.n} harvests · ${before.photos} photos\n`)

const done = []; const held = []; const failed = []
let plannedTotal = 0; let droppedTotal = 0

for (const g of groups) {
  const ids = [g.winner.id, ...g.losers.map((l) => l.id)]
  const tag = `g${String(g.n).padStart(2)} ${g.label}`

  if (g.hold) {
    held.push(g)
    console.log(`HOLD  ${tag}\n      ${g.hold_reason.split('. ')[0]}.\n`)
    continue
  }

  // ALREADY DONE? This must be checked BEFORE winner re-derivation, not after: once a group is
  // merged its losers are soft-deleted, so deriveWinner reports "member missing" and aborts. Without
  // this branch a run that died at group 7 could not be resumed — it would abort on group 1 forever.
  const [prior] = await sql`
    SELECT events_dropped, rows_repointed FROM merge_event WHERE op_id = ${`merge-run-g${g.n}`}`
  if (prior) {
    done.push({ g, dropped: prior.events_dropped, repointed: prior.rows_repointed, resumed: true })
    droppedTotal += prior.events_dropped
    console.log(`SKIP  ${tag}\n      already merged (${prior.events_dropped} dropped) — resuming past it\n`)
    continue
  }

  // Winner re-derivation — the manifest must still agree with the garden.
  const derived = await deriveWinner(ids)
  if (derived === null) {
    failed.push({ g, why: 'a group member is missing or soft-deleted' })
    console.error(`ABORT ${tag} — a group member is missing or soft-deleted\n`); break
  }
  if (derived !== g.winner.id && g.winner_source !== 'dave') {
    failed.push({ g, why: `rule derives ${derived}, manifest says ${g.winner.id}` })
    console.error(`ABORT ${tag} — winner drift: rule derives ${derived}, manifest says ${g.winner.id}`)
    console.error('      Re-check the manifest against plan §4.2 before proceeding.\n'); break
  }

  const opId = `merge-run-g${g.n}`
  const dry = await mergeCore(sql, {
    winnerId: g.winner.id, loserIds: g.losers.map((l) => l.id), opId: `${opId}-dry`,
    userId: HOUSEHOLD[0], householdIds: HOUSEHOLD, groupLabel: g.label, dryRun: true,
  })
  if (dry.status !== 200) {
    failed.push({ g, why: `dry run ${dry.status}: ${JSON.stringify(dry.body)}` })
    console.error(`ABORT ${tag} — dry run ${dry.status}: ${JSON.stringify(dry.body)}\n`); break
  }
  const planned = dry.body?.plan?.events_dropped ?? dry.body?.events_dropped ?? 0
  plannedTotal += planned

  if (!EXECUTE) {
    console.log(`PLAN  ${tag}\n      ${ids.length} rows -> 1 · ${money(planned)} events would be dropped · winner ${g.winner.name}`)
    console.log(`      status -> ${dry.body?.resolved?.status ?? '?'}\n`)
    continue
  }

  const fingerprint = await readFingerprint(sql, ids)
  const run = await mergeCore(sql, {
    winnerId: g.winner.id, loserIds: g.losers.map((l) => l.id), opId, fingerprint,
    userId: HOUSEHOLD[0], householdIds: HOUSEHOLD, groupLabel: g.label,
  })
  if (run.status !== 200) {
    failed.push({ g, why: `merge ${run.status}: ${JSON.stringify(run.body)}` })
    console.error(`ABORT ${tag} — merge ${run.status}: ${JSON.stringify(run.body)}\n`); break
  }

  // Per-group invariants that must hold immediately, before touching the next group.
  const [live] = await sql`SELECT count(*)::int n FROM event_log
                           WHERE plant_id = ANY(${g.losers.map((l) => l.id)}) AND deleted_at IS NULL`
  const [dupes] = await sql`SELECT count(*)::int n FROM (
      SELECT event_type, metadata->>'batch_id' b FROM event_log
      WHERE plant_id = ${g.winner.id} AND deleted_at IS NULL AND metadata->>'batch_id' IS NOT NULL
      GROUP BY 1,2 HAVING count(*) > 1) x`
  if (live.n !== 0 || dupes.n !== 0) {
    failed.push({ g, why: `post-merge invariant: ${live.n} live loser events, ${dupes.n} dup keys` })
    console.error(`ABORT ${tag} — ${live.n} live loser events, ${dupes.n} duplicate keys\n`); break
  }

  droppedTotal += run.body.events_dropped
  done.push({ g, dropped: run.body.events_dropped, repointed: run.body.rows_repointed })
  console.log(`OK    ${tag}\n      ${money(run.body.events_dropped)} dropped · ${run.body.rows_repointed} repointed · winner ${g.winner.name}\n`)
}

const after = await audit(allIds)
console.log('=== garden-wide audit ===')
const same = (a, b) => (String(a) === String(b) ? 'unchanged' : `CHANGED ${a} -> ${b}`)
console.log(`  harvest count   ${same(before.harvest.n, after.harvest.n)}`)
console.log(`  harvest weight  ${same(before.harvest.w, after.harvest.w)}`)
console.log(`  harvest qty     ${same(before.harvest.q, after.harvest.q)}`)
console.log(`  photos          ${same(before.photos, after.photos)}`)
console.log(`  events OUTSIDE  ${same(before.outside.n, after.outside.n)} · digest ${before.outside.d === after.outside.d ? 'identical' : 'CHANGED'}`)
console.log(`  plantings       ${before.plants} -> ${after.plants}`)
console.log(`  events          ${before.events} -> ${after.events}`)

const outsideClean = before.outside.d === after.outside.d && before.outside.n === after.outside.n
const harvestClean = String(before.harvest.w) === String(after.harvest.w)
  && String(before.harvest.q) === String(after.harvest.q) && before.harvest.n === after.harvest.n
const photosClean = before.photos === after.photos

console.log(`\n=== summary ===`)
console.log(`  merged   ${done.length}`)
console.log(`  held     ${held.length}${held.length ? ` (groups ${held.map((h) => h.n).join(', ')} — need a ruling)` : ''}`)
console.log(`  failed   ${failed.length}${failed.length ? ` — ${failed[0].why}` : ''}`)
console.log(EXECUTE ? `  dropped  ${droppedTotal} events` : `  planned  ${plannedTotal} events would drop`)

if (EXECUTE && done.length) {
  console.log('\nPost-merge runbook NOT run — do these next, in order:')
  console.log('  1. scripts/rerun-daily-plan.sh --region us-east-1   (today\'s plan references soft-deleted ids)')
  console.log('  2. re-baseline scripts/integrity-weekly-check.sh')
  console.log('  3. scripts/measure-anchor-coverage.mjs')
  console.log('  NOTE: user_stats.total_events is an absolute recompute — the Dashboard total drops')
  console.log('        by the drop-set size on the NEXT logged event. Expected, not a bug.')
}

const ok = !failed.length && outsideClean && harvestClean && photosClean
if (!ok) console.error('\nFAILED — see above.')
process.exit(ok ? 0 : 1)
