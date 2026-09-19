// V5-SEEDCARDS-001 — a seed's facts in ONE vocabulary, shared by My seeds' expanded row and the seed's
// detail page (UX spec §6.3 and §7.2: same words, same order). Two copies had already drifted apart
// once — the detail page showed heat with no word of where the number came from — so both read here.
//
// Fixed order. An absent fact is LEFT OUT, never dashed. The one stated absence is a pepper's heat:
// it is the fact looked for on a pepper, so "not recorded" goes where the eye goes. Pure: each fact
// is { key, label, value, italic? } with a string value, and the pages own the markup.
import { heatOf } from './mySeedsModel.js'
import { isSavedLot } from './seedLots.js'
import { fmtShu } from '../../lib/varietySpec.js'

// Where a Scoville figure came from, in words (UX spec §2). Never the LOT's supplier: heat is a
// cultivar fact and can come from another seller's page.
export const HEAT_SOURCE_WORDS = {
  packet_label: 'from the packet',
  vendor_catalog: 'from a seller’s catalogue',
  breeder: 'from the breeder',
  reference_work: 'from a reference',
  grower_record: 'grower’s record',
  inference: 'best guess',
}

const fullNumber = (n) => Number(n).toLocaleString('en-US')

// "1,200,000–2,000,000 SHU · best guess". `compact` gives the chip's "1.2M–2M" numbers for a narrow
// column (the detail page's facts column is ~168 px); the words are the same either way. A saved lot's
// words say "saved seed may have crossed" instead of the figure's source: home-saved pepper seed
// crosses readily and F1 seed segregates, so the cultivar's range is what it SHOULD be, not what this
// jar will do. With no provenance column on the row at all, no words; with the column present and
// empty, "source not recorded".
export function heatFact(i, { compact = false } = {}) {
  const h = heatOf(i)
  if (!h) return i?.crop_slug === 'pepper' ? 'not recorded' : ''
  const num = compact ? fmtShu : fullNumber
  const range = h.min === 0 && h.max === 0 ? 'Sweet · 0 SHU'
    : h.min === h.max ? `${num(h.max)} SHU` : `${num(h.min)}–${num(h.max)} SHU`
  const src = i?.scoville_source
  const words = isSavedLot(i) ? 'saved seed may have crossed'
    : src ? HEAT_SOURCE_WORDS[src] ?? '' : ('scoville_source' in (i ?? {}) ? 'source not recorded' : '')
  return words ? `${range} · ${words}` : range
}

// 'unknown' is a researched answer ("could not tell"), not a fact to show.
const BREEDING_LABEL = new Map([['f1', 'F1 hybrid'], ['open_pollinated', 'Open-pollinated'], ['landrace', 'Landrace']])
// dtm_basis is the cultivar's own override (NULL = inherit the crop's), so a NULL states no basis
// rather than guessing one.
const DTM_BASIS_SUFFIX = new Map([['from-transplant', ' from transplant'], ['from-sow', ' from sowing']])

const text = (v) => (typeof v === 'string' ? v.trim() : '')
const days = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// `from` is My seeds' first line (supplier · how old); the detail page shows its supplier as a chip
// instead and passes nothing.
export function seedFacts(i, { from = '', compact = false } = {}) {
  const out = []
  if (from) out.push({ key: 'from', label: 'From', value: from })
  const heat = heatFact(i, { compact })
  if (heat) out.push({ key: 'heat', label: 'Heat', value: heat })
  const origin = [text(i?.origin_country), text(i?.origin_region)].filter(Boolean).join(' · ')
  if (origin) out.push({ key: 'origin', label: 'Country of origin', value: origin })
  const species = text(i?.species)
  if (species) out.push({ key: 'species', label: 'Species', value: species, italic: true })
  const lo = days(i?.days_to_maturity_min) ?? days(i?.days_to_maturity_max)
  const hi = days(i?.days_to_maturity_max) ?? lo
  if (lo != null) {
    out.push({
      key: 'dtm', label: 'Days to maturity',
      value: `${lo === hi ? lo : `${lo}–${hi}`} days${DTM_BASIS_SUFFIX.get(i?.dtm_basis) ?? ''}`,
    })
  }
  const breeding = BREEDING_LABEL.get(i?.breeding_system)
  if (breeding) out.push({ key: 'breeding', label: 'Breeding', value: breeding })
  return out
}
