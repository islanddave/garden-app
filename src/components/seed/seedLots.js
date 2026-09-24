// src/components/seed/seedLots.js — V5-SEEDSTAB-001. What a seed lot IS, said once.
//
// These helpers lived inside SavedSeeds.jsx until the Seeds page gave that page two siblings that
// render the same rows. My seeds and Saved seeds now sit one tap apart on one page, so a lot that read
// "approx. 175 seeds" on one and "~175 seeds" on the other, or a ferment that was "day 5" here and
// "day 4" there, would be the page contradicting itself. Moved rather than re-spelled, into the leaf
// module seedStages.js already lives beside, so no page imports another page for them.
//
// Two defects are fixed here rather than carried across, because the move is the moment every
// consumer starts sharing the answer:
//   · VENDOR (candidateFacts). `inventory_items.source` stopped meaning "vendor" when the source
//     registry landed: on prod it holds order references and whole intake sentences ("Order #4411
//     rec'd 7/2"). The vendor is `source_id` -> GET /api/varieties/sources. The facts line printed
//     the order text as though it were the shop. Callers now pass a resolver.
//   · CALENDAR DAYS (elapsedDays), BUG-SEEDSOWRELDAY-001. Dave saved two lots one evening and both
//     cards still read "today" the next morning, because the count was a rolling 24-hour window.
//     A day is a calendar date in Eastern, the same rule the harvest export's Today/Yesterday chips
//     use (V4-HARVEXPORTDAYS-001). The ferment thresholds read the same number, so "day 4" now means
//     the fourth calendar day, which is how a person counts a jar on the counter.
import { formatQty, formatDate, formatSeedWeight } from '../../lib/format.js'
import { etDay } from '../../lib/harvestSummary.js'
import { IN_PROCESS_STAGES } from '../../lib/sowEngine.js'
import { seedsHref } from '../../lib/seedsRoutes.js'

// Last-resort chip label when the crop vocabulary has no row for a slug the lots DO carry. Sentence
// case ("Winter squash"), unchanged from SavedSeeds.
export const prettySlug = (s) => {
  const t = String(s ?? '').replace(/_/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

// The first line of a lot in the picker: what the seed IS.
export const candidateTitle = (i) => i?.variety_name || i?.name || ''

// V5-SEEDQTY-001 / V5-SEEDCOUNTCARD-001 — "how many SEEDS", as its own fact. null is "nobody has
// counted this" and renders nothing; 0 is a counted lot that yielded nothing and DOES render.
// "approx." is a word rather than a glyph on purpose — see SavedSeeds' history of this line.
export const seedCountLabel = (n, estimated) => {
  if (n == null || n === '') return ''
  const c = Number(n)
  if (!Number.isFinite(c)) return ''
  const shown = formatQty(c)
  const counted = `${shown} ${shown === '1' ? 'seed' : 'seeds'}`
  return estimated ? `approx. ${counted}` : counted
}

/**
 * The picker's second line: the facts that separate two packets of one cultivar, in the order they
 * separate them — how much seed, how many containers, who sold it, when it was bought. Absent facts
 * are dropped, never dashed.
 *
 * `vendorOf(row)` resolves the row's `source_id` to a name. Absent (or answering '') means no
 * vendor segment at all — and never the free-text `source` column, which is an order reference.
 */
export function candidateFacts(i, vendorOf) {
  const parts = []
  const seeds = seedCountLabel(i?.seed_count, i?.seed_count_estimated)
  if (seeds) parts.push(seeds)
  const weight = formatSeedWeight(i?.seed_weight_g)
  if (weight) parts.push(weight)
  const qty = formatQty(i?.quantity_on_hand)
  if (qty !== '') parts.push(i.unit ? `${qty} ${i.unit}` : qty)
  const vendor = vendorOf ? String(vendorOf(i) ?? '').trim() : ''
  if (vendor) parts.push(vendor)
  const bought = formatDate(i?.purchase_date)
  if (bought) parts.push(bought)
  return parts.join(' · ')
}

/**
 * V5-SEEDCOUNTCARD-001 — how much seed a TRACKED lot holds: count and/or weight, never the
 * container count (every saved lot is "1 packet", which says nothing). '' when nothing was measured.
 */
export function lotMeasure(i) {
  const parts = []
  const seeds = seedCountLabel(i?.seed_count, i?.seed_count_estimated)
  if (seeds) parts.push(seeds)
  const weight = formatSeedWeight(i?.seed_weight_g)
  if (weight) parts.push(weight)
  return parts.join(' · ')
}

/**
 * Decorate the rows about to be rendered so that NO TWO READ ALIKE (BUG-SEEDCANDIDATEAMBIG-001).
 *
 * Computed over the RENDERED lines — title plus whatever the caller renders as the second line —
 * because the property being kept is "nothing on this screen reads the same". My seeds' rows carry
 * a stepper since V5-SEEDSTAB-001, so two rows that looked identical would now let a thumb write to
 * the wrong lot, not merely pick the wrong one.
 *
 * `facts(row)` is the second line (default: the picker's candidateFacts with no vendor resolver);
 * `title(row)` the first. A group that still collides gets an ordinal naming its size, and a second
 * pass backstops with the row id, the one thing guaranteed distinct.
 */
export function labelCandidates(rows, facts = candidateFacts, title = candidateTitle) {
  const base = rows.map((i) => ({ item: i, title: title(i), facts: facts(i) }))
  const size = new Map()
  for (const r of base) {
    const k = `${r.title}\n${r.facts}`
    size.set(k, (size.get(k) ?? 0) + 1)
  }

  const nth = new Map()
  const labelled = base.map(({ item, title: t, facts: f }) => {
    const k = `${t}\n${f}`
    const total = size.get(k)
    if (total < 2) return { item, title: t, detail: f }
    const n = (nth.get(k) ?? 0) + 1
    nth.set(k, n)
    const ord = `${n} of ${total} with identical details`
    return { item, title: t, detail: f ? `${f} · ${ord}` : ord }
  })

  const used = new Set()
  return labelled.map((r) => {
    const full = `${r.title}\n${r.detail}`
    if (!used.has(full)) { used.add(full); return r }
    const tail = `#${String(r.item.id ?? '')}`
    return { ...r, detail: r.detail ? `${r.detail} · ${tail}` : tail }
  })
}

const DAY_MS = 86400000

// Whole CALENDAR days from `iso` to `now`, both read as dates in Eastern. Null when there is no
// timestamp or it does not parse. A lot entered at 9pm and read at 8am the next morning is 1, not 0.
export function elapsedDays(iso, now = new Date()) {
  if (!iso) return null
  const from = etDay(iso)
  const to = etDay(now)
  if (!from || !to) return null
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

// Same-day reads "today" rather than "0 days", because 0 of anything looks like missing data.
export function elapsedLabel(iso, now = new Date()) {
  const days = elapsedDays(iso, now)
  if (days == null) return null
  if (days <= 0) return 'today'
  return days === 1 ? '1 day' : `${days} days`
}

// A ferment is done at two to four days; past about five the seed sprouts in the jar and the lot is
// finished. `fermenting` only — a lot three weeks on a screen is dry, not spoiled.
export const FERMENT_WARN_DAYS = 4
export const FERMENT_ALARM_DAYS = 5

export function fermentUrgency(item, now = new Date()) {
  if (item?.seed_stage !== 'fermenting') return null
  const days = elapsedDays(item.stage_entered_at, now)
  if (days == null) return null
  if (days >= FERMENT_ALARM_DAYS) return 'alarm'
  if (days >= FERMENT_WARN_DAYS) return 'warn'
  return null
}

// Lots whose ferment needs checking now, most overdue first. Feeds the ferment line that sits under
// the Seeds switch on every view — the only overdue-ferment warning the app has, so it must not live
// only on the one view you might not be looking at.
export function dueFerments(items, now = new Date()) {
  return (items ?? [])
    .map((i) => ({ item: i, level: fermentUrgency(i, now), days: elapsedDays(i?.stage_entered_at, now) }))
    .filter((r) => r.level)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
}

const isLotInProcess = (i) => IN_PROCESS_STAGES.includes(String(i?.seed_stage ?? '').trim().toLowerCase())

// §4.2 — the Seeds page lands on Saved seeds while any lot is fermenting or drying, else My seeds.
// Exactly the rows Saved seeds files under its Fermenting and Drying sections (a stage, any status),
// so the rule and the sections it points at cannot disagree.
export function hasLotInProcess(items) {
  return (items ?? []).some(isLotInProcess)
}

// V5-SEEDSTAB-001 slice 2 — where a door into ONE lot lands: Saved seeds on that lot while it is
// fermenting or drying (the view that holds its clock and its stage controls), else the lot's own
// page. The same split SaveSeedSheet makes after a save and the detail page's stage link makes. null
// for a row with no id, so a caller renders no link rather than a link to nowhere.
export function lotHref(lot) {
  if (lot?.id == null || lot.id === '') return null
  return isLotInProcess(lot) ? seedsHref('saved', { lot: lot.id }) : `/inventory/${lot.id}`
}

// V5-SEEDSTAB-001 slice 2 — Saved seeds' "Not started" group: seed you SAVED that has not entered a
// stage yet. Decided by the lot's ORIGIN (off one of your plants, or out of produce — a farm-stand
// pepper, a gift), never by the sow engine's isUnstartedSave, which also asks whether anything was
// measured and counts only `own_garden` among the kinds, so a farm-stand lot saved "Not yet" would be
// missing (BUG-SOWSEEDSTATEGAPS-001). A bought packet carries neither origin fact and never qualifies.
export function isNotStartedLot(i) {
  if (!i || (i.seed_stage != null && i.seed_stage !== '')) return false
  return isSavedLot(i)
}

// BUG-SAVEDSEEDPARENTONPRODUCE-001 — may this lot be given a parent PLANT? The database's answer, not an
// approximation of it: chk_inventory_seed_source_plant is `source_kind IS NULL OR source_kind =
// 'own_garden' OR source_plant_id IS NULL` (read off live prod 2026-09-24; the same text as
// migrations/v4-seedorigin-001), so a lot whose origin kind names somewhere other than this garden — a
// farm stand, a gift, a shop — is REFUSED a parent, and any door offering to set one on it offers a
// write that can only fail. NULL and 'own_garden' both admit one; "has a source_kind" is not the rule.
// Takes the KIND rather than the lot so /inventory/:id can ask it of its live select, whose '' is "Not
// recorded" (sent as null) — the only other spelling of NULL this client has.
// seedLots.parentPlant.test.js derives the admitted kinds from the migration's CHECK text itself.
export function kindAllowsParentPlant(kind) {
  return kind == null || kind === '' || kind === 'own_garden'
}

// Seed you saved yourself, as opposed to a packet you bought: it came off one of your plants, or its
// origin kind was recorded (a farm-stand pepper, a gift), or it has been through a stage. Three
// facts, any one sufficient, because each door that makes a saved lot writes a different one of them.
export function isSavedLot(i) {
  if (!i) return false
  if (i.source_plant_id != null && i.source_plant_id !== '') return true
  if (i.source_kind != null && i.source_kind !== '') return true
  return i.seed_stage != null && i.seed_stage !== ''
}

// V5-SEEDSTAB-001 slice 3 (design §2 rule 8, §5.4) — seed saved off an F1 plant is F2 seed, and F2 does
// not come true: the F1's one uniform combination segregates in its seed, so next year's plants vary,
// some of them a lot. Said about the saved LOT only. A bought F1 packet sows true as the F1 — that is
// what it is bought for — so it is never labelled. The words name the consequence and stop: saving F2
// seed on purpose is how dehybridizing starts, so nothing here calls it a mistake.
//
// The parent's breeding is the lot's CULTIVAR's (`breeding_system`, projected onto the list and the
// detail rows from the cultivar view): a saved lot is filed under its parent's variety. Only 'f1'
// speaks. NULL (never researched), 'unknown', open-pollinated and landrace say nothing here.
//
// One predicate and one label, read by My seeds' row chip, the Saved seeds card and the Breeding fact
// (seedFacts.js), so no two surfaces can disagree about one jar.
export const F2_LABEL = 'F2 — won’t come true'
export function isF2Lot(i) {
  return isSavedLot(i) && i?.breeding_system === 'f1'
}
