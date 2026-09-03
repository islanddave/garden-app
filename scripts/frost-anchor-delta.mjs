// Measures the USER-VISIBLE delta of moving the measured first-fall-frost anchor.
//
// The question this answers: `FROST_ANCHORS.firstFallFrost` ('09-28') is a conservative sowing-safety
// margin and most latestSafeMs branches consume it. Only the FALL_HARDY_CROPS branch and the fall
// indoor-pass hardy arm consume the MEASURED anchor (FFobs). So "the stored frost median is 19 days
// wrong" does not by itself tell you that anything a user sees changes. This runs the real engine
// over the real candidate rows under both anchors and diffs the buckets, so the answer is measured
// rather than argued.
//
// The correction this was built to measure has LANDED (BUG-FROSTANCHORERA5-001, 10-29 -> 10-15), so
// the bare-run default now reads the other way: `from` is the shipped value and `to` is the
// superseded ERA5 one, i.e. it shows what the correction did rather than what it would do. Pass both
// month-days explicitly for any other comparison.
//
// Usage: node scripts/frost-anchor-delta.mjs <candidates.json> [todayISO] [fromMonthDay] [toMonthDay]
import { readFileSync } from 'node:fs'
import { bucketize, OBSERVED_FIRST_FALL_FROST } from '../src/lib/sowEngine.js'

const [, , path, todayArg, fromArg, toArg] = process.argv
const today = todayArg || new Date().toISOString().slice(0, 10)
const from = fromArg || OBSERVED_FIRST_FALL_FROST.medianMonthDay
const to = toArg || '10-29' // the superseded ERA5 median

const rows = JSON.parse(readFileSync(path, 'utf8'))
if (!Array.isArray(rows)) throw new Error('expected a JSON array of v_sow_candidates rows')

// bucketize returns { bucketName: [entry, ...] }. Invert to id -> bucket so the diff is per candidate
// rather than per bucket — a row moving A->B and another moving B->A would net to zero in a count
// comparison and look like "no change".
function indexOf(buckets) {
  const m = new Map()
  for (const [bucket, list] of Object.entries(buckets)) {
    for (const e of list) {
      const id = e?.id ?? e?.item_id ?? e?.inventory_item_id ?? e?.variety_id ?? JSON.stringify(e).slice(0, 80)
      m.set(id, { bucket, e })
    }
  }
  return m
}

const before = indexOf(bucketize(rows, today, { observedFirstFallFrost: from }))
const after = indexOf(bucketize(rows, today, { observedFirstFallFrost: to }))

const moved = []
for (const [id, b] of before) {
  const a = after.get(id)
  if (!a) { moved.push({ id, from: b.bucket, to: '(absent)', e: b.e }); continue }
  if (a.bucket !== b.bucket) moved.push({ id, from: b.bucket, to: a.bucket, e: b.e })
}
for (const [id, a] of after) if (!before.has(id)) moved.push({ id, from: '(absent)', to: a.bucket, e: a.e })

const countOf = (bs) => Object.fromEntries(Object.entries(bs).map(([k, v]) => [k, v.length]))
const bBuckets = bucketize(rows, today, { observedFirstFallFrost: from })
const aBuckets = bucketize(rows, today, { observedFirstFallFrost: to })

// The bucket entry is a wrapper, not the raw row, so dig for the candidate before naming it.
const cand = (e) => e?.candidate ?? e?.row ?? e?.c ?? e
const name = (e) => {
  const c = cand(e)
  return c?.variety_name || c?.item_name || c?.name || c?.crop_type_slug || `(keys: ${Object.keys(e || {}).slice(0, 8).join(',')})`
}
const slug = (e) => cand(e)?.crop_type_slug ?? '?'

console.log(`today=${today}  FFobs ${from} -> ${to}   candidates=${rows.length}`)
console.log('\nbucket counts BEFORE:', JSON.stringify(countOf(bBuckets)))
console.log('bucket counts  AFTER:', JSON.stringify(countOf(aBuckets)))
console.log(`\nCANDIDATES THAT CHANGE BUCKET: ${moved.length}`)
for (const m of moved.sort((x, y) => String(x.from).localeCompare(String(y.from)))) {
  console.log(`  ${m.from}  ->  ${m.to}   ${name(m.e)}  [${slug(m.e)}]`)
}
if (!moved.length) console.log('  (none — the measured anchor is inert at this date for these rows)')
