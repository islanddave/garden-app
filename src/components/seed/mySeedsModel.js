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
import { elapsedDays, fermentUrgency, lotMeasure, isSavedLot, isF2Lot, F2_LABEL } from './seedLots.js'
import { shuLabel } from '../../lib/varietySpec.js'
import { supplierKey, supplierLabel } from '../../lib/supplierPalette.js'

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
//
// EXACTLY "1 packet" says nothing and is left out (V5-SEEDCARDS-001, UX spec §1.3): 304 of 327 rows
// printed the same 11 characters — 68px of a 255px line — for a fact the eye had to skip on every row.
// Every other amount ("2 packets", "272 seeds", "0.5 oz", a saved lot's count) still shows, whole.
export function howMuch(i) {
  if (isSavedLot(i)) return lotMeasure(i)
  const qty = formatQty(i?.quantity_on_hand)
  if (qty === '') return ''
  const unit = String(i?.unit ?? '').trim()
  if ((unit === 'packet' || unit === '') && qty === '1') return ''
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
        // "Ferment", the ferment line's own word (V5-SEEDCARDS-001): ~20px back on a line that now
        // leads with a supplier chip, which is the margin the worst row needs on CI's wider fonts.
        label: d == null ? 'Ferment' : d <= 0 ? 'Ferment · today' : `Ferment · day ${d}`,
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
  // V5-SEEDSTAB-001 slice 3 — the one chip that is not an engine state: a lot saved off an F1 plant is
  // F2 seed (seedLots.isF2Lot). LAST and NEUTRAL, deliberately. Last, so a live state ("Ferment · day
  // 5", "Drying") keeps the first place and stays whole; neutral in tone, because it is a fact about the
  // seed, not an alarm. Where it sits on line 2 is lineLayout's call, below. Bought F1 packets never get it.
  if (isF2Lot(i)) chips.push({ key: 'f2', label: F2_LABEL, tone: 'neutral' })
  return chips
}

// ── Line 2's layout: which chips are WHOLE ITEMS of the line and which GIVE WAY ─────────────────────
// MySeeds renders line 2 from this (UX spec §1.3). Every row's line 2 is ONE line that WRAPS rather than
// drop the heat (BUG-MYSEEDSF2HIDESSHU-001, Dave 2026-09-24, on his phone at 426px: "I want the shu
// shown" — "I still prefer seeing heat … it is info for decisions/guidance for me"). The supplier chip,
// the live state chip (a lot in process), the F2 chip, the amount and the heat are whole items of the
// line; when one line cannot hold them, what does not fit — in practice the heat — moves to the next
// line, whole. A heat is shown whole or not at all, and it is always shown. The other chips
// (`giveWayChips`: "Archived for this season", a status, "Not started") ellipsise before the heat has to
// move; the tail (where from · how old) follows the heat and is cut first. A row that fits stays one line.
//   · an F2 row: the F2 chip is a whole item of the line, after any live chip, and the amount follows it —
//     the chip never costs the heat (the slice 3 amendment, abf8bf1, dropped the heat for it). Any other
//     chip comes after the amount.
//   · every other row: the chips that give way come before the amount, as they always have.
export function lineLayout(i, { now, year } = {}) {
  const chips = stateChips(i, { now, year })
  const live = chips[0] && chips[0].tone !== 'neutral' ? chips[0] : null
  const f2 = chips.find((c) => c.key === 'f2') ?? null
  return { live, f2, giveWayChips: chips.filter((c) => c !== live && c !== f2) }
}

// Where from, for the TAIL of line 2: a saved lot's origin words. A bought packet's vendor is not
// repeated here — the supplier chip that leads the line already names it (V5-SEEDCARDS-001).
export function originNote(i) {
  return whereFrom(i, null)
}

// Line 2 as one string, in the order it renders (lineLayout's): the supplier chip's label, the state
// chips, the amount, the heat, then the tail (origin words, how old) — on an F2 row the live chip, the F2
// chip and the amount lead, then any other chips. Also what row uniqueness is computed over, because it
// is what the eye reads.
export function lineText(i, { vendorOf, now, year } = {}) {
  const vendor = vendorOf ? String(vendorOf(i) ?? '').trim() : ''
  const { live, f2, giveWayChips } = lineLayout(i, { now, year })
  const amount = howMuch(i)
  const chips = giveWayChips.map((c) => c.label)
  const rest = [heatLabel(i), originNote(i), howOld(i)]
  const ordered = f2
    ? [live?.label, f2?.label, amount, ...chips, ...rest]
    : [live?.label, ...chips, amount, ...rest]
  return [vendor ? supplierLabel(vendor) : '', ...ordered].filter(Boolean).join(' · ')
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
  // V5-SEEDCARDS-001 — Dave: "for peppers, to sort them by expected SHU". Offered only when at least
  // two rows carry a heat figure (MySeeds decides; a control that cannot change the answer is hidden).
  { value: 'heat',   label: 'Heat' },
]

// ── Heat (V5-SEEDCARDS-001) ────────────────────────────────────────────────────────────────────────
// A cultivar's expected Scoville range, from the list row's cultivar facts. The SORT KEY is the top of
// the range (a "hottest first" list ranks a 100k-350k habanero above a 100k-150k one), falling back
// to the bottom when only one end is known. A best guess (scoville_source 'inference') is marked where
// it is SHOWN, never here: heatLabel's formatter (varietySpec.shuLabel) prefixes the WORD "est.", so a
// guess never reads as a stated number; Hottest ranks it by the same key as any other figure.
export function heatOf(i) {
  const mn = i?.scoville_min, mx = i?.scoville_max
  if (mn == null && mx == null) return null
  return { min: mn ?? mx, max: mx ?? mn, key: Number(mx ?? mn) }
}

export function heatLabel(i) {
  return heatOf(i) ? shuLabel(i) : ''
}

// ── Supplier facet (V5-SEEDCARDS-001) ──────────────────────────────────────────────────────────────
// Options for the supplier filter, from the PRE-filter rows (a facet derived from its own filtered
// output collapses to whatever is selected). Count-descending, ties by label; rows with no supplier on
// record (saved lots, and packets whose vendor was never entered) are one "No supplier" option, last.
// The value is the folded name (supplierPalette.supplierKey) — the same key the colours use, and
// stable across environments where registry uuids are not.
export const NO_SUPPLIER_VALUE = '__none__'
export function supplierOf(i, vendorOf) {
  const name = vendorOf ? String(vendorOf(i) ?? '').trim() : ''
  return name ? { key: supplierKey(name), name } : null
}
export function supplierOptions(rows, vendorOf) {
  const counts = new Map()
  let none = 0
  for (const r of rows) {
    const s = supplierOf(r, vendorOf)
    if (!s) { none++; continue }
    const cur = counts.get(s.key)
    counts.set(s.key, { value: s.key, name: s.name, count: (cur?.count ?? 0) + 1 })
  }
  const opts = [...counts.values()]
    .sort((a, b) => b.count - a.count || collator.compare(a.name, b.name))
    .map((o) => ({ value: o.value, label: supplierLabel(o.name), name: o.name, count: o.count }))
  if (none > 0) opts.push({ value: NO_SUPPLIER_VALUE, label: 'No supplier', name: '', count: none })
  return opts
}
export function matchesSuppliers(i, selected, vendorOf) {
  if (!selected || selected.size === 0) return true
  const s = supplierOf(i, vendorOf)
  return selected.has(s ? s.key : NO_SUPPLIER_VALUE)
}

// ── One filter object (V5-SEEDCARDS-001) ───────────────────────────────────────────────────────────
// Search, crop chips and supplier chips are ONE value, so "is anything filtering?", "clear them" and
// the write-never-lands-out-of-sight notice can never enumerate a different subset of them — a third
// facet added to two of three sites is exactly how a just-saved row ends up hidden with no notice.
export function isFilterActive(f) {
  return !!(f && (String(f.q ?? '').trim() || (f.crops && f.crops.size > 0) || (f.suppliers && f.suppliers.size > 0)))
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// Name: grouped by crop (the caller groups), A→Z inside. Oldest seed first: flat, by the age year,
// unknown years last. Newest added: flat, created_at descending, then id — July's intake put 104
// rows on one day, so the tie-break is what makes the order stable. Heat: grouped by crop like Name
// (the caller groups), hottest first inside a group — only peppers carry a figure, so every other
// group reads A→Z exactly as under Name.
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
  if (sort === 'heat') {
    // Hottest first — by the top of the range, then the bottom (so the right-hand number never rises
    // going down the list); rows with no figure keep their A→Z order after every row that has one. A
    // sort never hides a row.
    return out.sort((a, b) => {
      const A = heatOf(a), B = heatOf(b)
      if (!A && !B) return byTitle(a, b)
      if (!A) return 1
      if (!B) return -1
      return B.key - A.key || B.min - A.min || byTitle(a, b)
    })
  }
  return out.sort(byTitle)
}

// Crop groups for the grouped sorts, with rows that name no crop in their own group LAST rather than
// dropped (prod has none today; a row must never vanish for it).
//
// ORDER (V5-SEEDCARDS-001, UX spec §3.2): the crops PINNED in the chip row first, in pin order, then
// every other crop A→Z. Once groups are collapsed the list IS the overview, and A→Z put Pepper (103
// rows) 53rd and Tomato (52) 68th of 73 headers. `leadSlug` (the Hottest sort's pepper) goes first.
export const NO_CROP = '__none__'
export function groupByCrop(rows, labelOf, { pinned = [], leadSlug = null } = {}) {
  const groups = new Map()
  for (const r of rows) {
    const k = r.crop_slug || NO_CROP
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const rank = (slug) => {
    if (leadSlug && slug === leadSlug) return -1
    const p = pinned.indexOf(slug)
    return p === -1 ? Number.MAX_SAFE_INTEGER : p
  }
  return [...groups.entries()]
    .map(([slug, list]) => ({ slug, label: slug === NO_CROP ? 'No crop recorded' : labelOf(slug), rows: list }))
    .sort((a, b) => (a.slug === NO_CROP) - (b.slug === NO_CROP)
      || rank(a.slug) - rank(b.slug)
      || collator.compare(a.label, b.label))
}

// ── Which crop groups are open (V5-SEEDCARDS-001, UX spec §3.5–§3.6) ───────────────────────────────
// Collapsed by default. A group is open when the user did not close it AND (they opened it, OR a rule
// opens it): any active filter opens every group that still has rows (a filter means "show me the
// seeds"; no filter means "show me the kinds"); the Hottest sort opens the pepper group.
export function groupIsOpen(slug, { openGroups, closedByUser, filterActive, sort }) {
  if (closedByUser?.has(slug)) return false
  if (openGroups?.has(slug)) return true
  if (filterActive) return true
  if (sort === 'heat' && slug === 'pepper') return true
  return false
}
