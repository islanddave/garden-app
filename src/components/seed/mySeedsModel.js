// src/components/seed/mySeedsModel.js — V5-SEEDSTAB-001. What one row of My seeds SAYS, as pure
// functions, so the page and its tests read the same answer.
//
// My seeds answers "what seed do I have?" over every packet and saved lot — ~330 rows, 289 cultivars,
// pepper and tomato half of them. Each row is one packet or lot, and its second line is ordered
// quantity first so an ellipsis cuts the vendor, never the amount: state chips · how much · where
// from · how old.
//
// STATE CHIPS use the SOW ENGINE's predicates, in the engine's order and in the engine's words — so a
// lot that is "Fermenting" here is exactly the lot Sow now files under Still in process, and a packet
// that sits under Sowed previously is exactly the one Sow now calls sowed previously. Re-deciding any
// of these here would let the two views disagree about one jar.
import { formatQty } from '../../lib/format.js'
import { isInProcess, isUnstartedSave, isDepleted, isArchivedForSeason } from '../../lib/sowEngine.js'
import { elapsedDays, fermentUrgency, lotMeasure, isSavedLot } from './seedLots.js'

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Line 1: the variety — except for a saved lot the user named. SaveSeedSheet names a lot
// "<variety> — saved <year>" (or "Saved seed <year>" before a variety is known); a lot still carrying
// that default says nothing the variety does not, while a hand-typed name is the user's own label for
// that jar and is what they will look for.
export function rowTitle(i) {
  const variety = String(i?.variety_name ?? '').trim()
  const name = String(i?.name ?? '').trim()
  if (!variety) return name
  if (!isSavedLot(i) || !name) return variety
  const isDefault = new RegExp(`^${escapeRe(variety)} — saved \\d{4}$`).test(name)
    || /^Saved seed \d{4}$/.test(name)
  return isDefault ? variety : name
}

const plural = (n, one, many) => (String(n) === '1' ? one : many)

// How much. A saved lot is measured in SEED (count or weight) — every saved lot is "1 packet", which
// says nothing — and says nothing at all when nobody has counted it. A bought packet is measured in
// what the shelf holds: packets, or seeds when the unit is `each`.
export function howMuch(i) {
  if (isSavedLot(i)) return lotMeasure(i)
  const qty = formatQty(i?.quantity_on_hand)
  if (qty === '') return ''
  const unit = String(i?.unit ?? '').trim()
  if (unit === 'packet' || unit === '') return `${qty} ${plural(qty, 'packet', 'packets')}`
  if (unit === 'each') return `${qty} ${plural(qty, 'seed', 'seeds')}`
  return `${qty} ${unit}`
}

// Where from. `source` is an order reference on prod, so the vendor comes from the registry through
// `vendorOf`; a saved lot names its origin instead, and a packet with no recorded vendor says nothing.
export function whereFrom(i, vendorOf) {
  if (i?.source_plant_id != null && i.source_plant_id !== '') return 'Saved from my plant'
  const kind = String(i?.source_kind ?? '').trim()
  if (kind === 'own_garden') return 'Saved from my garden'
  if (kind) return `Saved · ${kind.replace(/_/g, ' ')}`
  if (isSavedLot(i)) return 'Saved'
  const vendor = vendorOf ? String(vendorOf(i) ?? '').trim() : ''
  return vendor
}

// The seed's year, and what kind of year it is. The harvest year when it was recorded; for a saved
// lot still being processed, the year of its current stage (it is this season's seed); otherwise the
// purchase year — a LOWER bound on age, so it is labelled "bought", never passed off as the seed's own.
export function ageOf(i) {
  const y = Number(i?.year_harvested)
  if (Number.isInteger(y) && y > 1900) return { year: y, kind: 'harvested' }
  if (isInProcess(i)) {
    const sy = Number(String(i?.stage_entered_at ?? '').slice(0, 4))
    if (Number.isInteger(sy) && sy > 1900) return { year: sy, kind: 'harvested' }
  }
  const py = Number(String(i?.purchase_date ?? '').slice(0, 4))
  if (Number.isInteger(py) && py > 1900) return { year: py, kind: 'bought' }
  return null
}

export function howOld(i) {
  const a = ageOf(i)
  return a ? `${a.kind} ${a.year}` : ''
}

// The chips, in the engine's order. `now` and `year` are injectable so the season boundary is
// testable: the archive stamp is a season, and on 1 January the chip simply stops applying.
export function stateChips(i, { now = new Date(), year = now.getFullYear() } = {}) {
  const chips = []
  if (isInProcess(i)) {
    const stage = String(i.seed_stage).trim().toLowerCase()
    if (stage === 'fermenting') {
      const d = elapsedDays(i.stage_entered_at, now)
      const level = fermentUrgency(i, now)
      chips.push({
        key: 'fermenting',
        label: d == null ? 'Fermenting' : d <= 0 ? 'Fermenting · today' : `Fermenting · day ${d}`,
        tone: level === 'alarm' ? 'danger' : level === 'warn' ? 'warn' : 'info',
      })
    } else {
      chips.push({ key: 'drying', label: 'Drying', tone: 'info' })
    }
  } else if (isUnstartedSave(i)) {
    chips.push({ key: 'unstarted', label: 'Not started', tone: 'neutral' })
  }
  if (isArchivedForSeason(i, year)) chips.push({ key: 'archived', label: 'Archived for this season', tone: 'neutral' })
  const status = String(i?.status ?? 'active')
  if (status !== 'active') chips.push({ key: 'status', label: status[0].toUpperCase() + status.slice(1), tone: 'neutral' })
  return chips
}

// Line 2 as one string: the chips' words, then the facts. Also what row uniqueness is computed over,
// because it is what the eye reads.
export function lineText(i, { vendorOf, now, year } = {}) {
  const chips = stateChips(i, { now, year }).map((c) => c.label)
  const facts = [howMuch(i), whereFrom(i, vendorOf), howOld(i)].filter(Boolean)
  return [...chips, ...facts].join(' · ')
}

// Sowed previously — Dave's term, and Sow now's section — is a packet there is none of left. Never a
// lot still being made (a fermenting jar at 0 is not used up) and never an unstarted save: the engine
// resolves those two AHEAD of depletion, and so does this.
export function isSowedPreviously(i) {
  return isDepleted(i) && !isInProcess(i) && !isUnstartedSave(i)
}

export const SORTS = [
  { value: 'name',   label: 'Name' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'newest', label: 'Newest' },
]

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// Name: grouped by crop (the caller groups), A→Z inside. Oldest seed first: flat, by the age year,
// unknown years last. Newest added: flat, created_at descending, then id — July's intake put 104
// rows on one day, so the tie-break is what makes the order stable.
export function sortRows(rows, sort) {
  const byTitle = (a, b) => collator.compare(rowTitle(a), rowTitle(b)) || String(a.id).localeCompare(String(b.id))
  const out = [...rows]
  if (sort === 'oldest') {
    return out.sort((a, b) => {
      const A = ageOf(a)?.year, B = ageOf(b)?.year
      if (A == null && B == null) return byTitle(a, b)
      if (A == null) return 1
      if (B == null) return -1
      return A - B || byTitle(a, b)
    })
  }
  if (sort === 'newest') {
    return out.sort((a, b) =>
      String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || String(a.id).localeCompare(String(b.id)))
  }
  return out.sort(byTitle)
}

// Crop groups for the Name sort, in the order the crops' labels sort, with rows that name no crop in
// their own group LAST rather than dropped (prod has none today; a row must never vanish for it).
export const NO_CROP = '__none__'
export function groupByCrop(rows, labelOf) {
  const groups = new Map()
  for (const r of rows) {
    const k = r.crop_slug || NO_CROP
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  return [...groups.entries()]
    .map(([slug, list]) => ({ slug, label: slug === NO_CROP ? 'No crop recorded' : labelOf(slug), rows: list }))
    .sort((a, b) => (a.slug === NO_CROP) - (b.slug === NO_CROP) || collator.compare(a.label, b.label))
}
