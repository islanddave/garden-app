// src/components/seed/seedParents.js — V5-SEEDMULTIPARENT-001 release 2b. What a jar's PARENT SET says,
// decided once.
//
// A saved lot used to have one parent plant, and every notice about it read the FILED variety. A jar can
// now be gathered off several plantings, of one cultivar or of several, so the chip, the sentences, the
// F2 label and the Breeding fact all come from this one function over one table (the geneticist's truth
// table, rows 0-10). The save sheet, the lot page, My seeds and the Saved seeds cards read it, so no two
// of them can disagree about one jar.
//
// A LEAF module: it imports the flag and nothing else, and seedLots.js imports IT (isF2Lot is
// lotNotice(i).f2 === 'full'). That direction is the only one without a cycle, which is why isSavedLot is
// defined here and re-exported from seedLots.js, and why the F2 words are spelled here as well as in
// seedLots.js's `export const F2_LABEL` line (two gate scripts read that line by regex, so it stays a
// literal there; seedParents.test.js pins the two spellings equal).
//
// SEED_MULTI_PARENT off: lotNotice answers today's rule on the filed variety (row 0, no sentence) whatever
// `source_plants` holds. parentSetFacts, sourcePlantFromPlanting and previewMixName are pure on their
// input and do not read the flag; their callers do.
import { SEED_MULTI_PARENT } from '../../lib/featureFlags.js'

const F2_WORDS = 'F2 — won’t come true'
const NO_VARIETY_WORDS = 'a plant with no variety recorded'

// Seed you saved yourself, as opposed to a packet you bought: it came off one of your plants, or its
// origin kind was recorded (a farm-stand pepper, a gift), or it has been through a stage. Three
// facts, any one sufficient, because each door that makes a saved lot writes a different one of them.
export function isSavedLot(i) {
  if (!i) return false
  if (i.source_plant_id != null && i.source_plant_id !== '') return true
  if (i.source_kind != null && i.source_kind !== '') return true
  return i.seed_stage != null && i.seed_stage !== ''
}

// A picker or detail planting row -> the contract element (tests/contracts/seed-mix.json
// `source_plant_required`). The only place the two shapes meet.
export function sourcePlantFromPlanting(p) {
  return {
    id: p.id,
    name: p.name ?? '',
    variety_id: p.variety_ref?.id ?? p.variety_id ?? null,
    variety_name: p.variety_ref?.name ?? null,
    breeding_system: p.variety_ref?.breeding_system ?? null,
    variety_rank: p.variety_ref?.variety_rank ?? null,
    crop_slug: p.variety_ref?.crop_type_slug ?? null,
    archived: !!p.archived_at,
    deleted: false,
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// The set, read once. `known` is false for null (the parents read failed) and undefined (a row from
// before release 1): both are "no answer", never "no parents". Every element counts, archived and
// deleted included: a retired planting is still where the seed came off. Varieties are distinct by
// variety_id in first-seen order, and every planting with NO variety is one entry between them.
export function parentSetFacts(sourcePlants) {
  const known = Array.isArray(sourcePlants)
  const plantings = known ? sourcePlants.filter(Boolean) : []
  const byKey = new Map()
  for (const p of plantings) {
    const vid = p.variety_id ?? null
    const key = vid == null ? '' : String(vid)
    if (!byKey.has(key)) {
      byKey.set(key, {
        variety_id: vid == null ? null : String(vid),
        variety_name: p.variety_name ?? null,
        breeding_system: p.breeding_system ?? null,
        variety_rank: p.variety_rank ?? null,
        crop_slug: p.crop_slug ?? null,
        plantingIds: [],
      })
    }
    byKey.get(key).plantingIds.push(String(p.id))
  }
  const varieties = [...byKey.values()]
  const crops = [...new Set(plantings.map((p) => p.crop_slug ?? null))]
  return {
    known,
    plantings,
    varieties,
    k: varieties.length,
    mixed: varieties.length >= 2,
    varietyIds: varieties.map((v) => v.variety_id).filter((id) => id != null).sort(cmp),
    cropSlug: crops.length > 1 ? undefined : crops[0] ?? null,
  }
}

// lambda/varieties/blend.js sortLeaves, copied: lower(name) by code unit, then id. Never localeCompare —
// the mix's name is built from this order and the server does not consult the runtime's ICU data.
const nameKey = (v) => String(v.variety_name ?? '').toLowerCase()
const byNameThenId = (a, b) => cmp(nameKey(a), nameKey(b)) || cmp(String(a.variety_id), String(b.variety_id))
const SAYS_MIX = /\b(?:mix|blend)\b/i

// The name the server will give a mix of these varieties (blend.js automaticBlendName), as the client's
// best reading: it cannot flatten a parent that is itself a mix into that mix's own components, so the
// name the server returns replaces this one at Save. An entry with no variety is not part of a mix name.
// Fewer than two varieties is not a mix: the one name, or ''.
export function previewMixName(varieties) {
  const named = (varieties ?? []).filter((v) => v && v.variety_id != null).sort(byNameThenId)
  const names = named.map((v) => String(v.variety_name ?? '').trim())
  if (names.length < 2) return names[0] ?? ''
  if (names.length >= 4) return `${names[0]} + ${names[1]} + ${names.length - 2} more`
  const joined = names.join(' + ')
  return names.every((n) => SAYS_MIX.test(n)) ? joined : `${joined} mix`
}

const listWords = (words) => (words.length <= 1 ? words.join('')
  : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)

const n1 = (names) => (names.length === 2
  ? `Mixed seed from ${names[0]} and ${names[1]}. Each seed came off one or the other, and some may be crosses. Expect more than one kind of plant from this jar.`
  : `Mixed seed from ${listWords(names)}. Each seed came off one of them, and some may be crosses. Expect more than one kind of plant from this jar.`)
const n2 = (x) => `${x} is a mix, not one variety. This jar holds only what the plants you gathered from carried, so the mix shifts each time it is saved.`
const n3 = (x) => `The seed that came off ${x}, an F1 hybrid, will vary, sometimes a lot.`
const N4 = 'Every plant here is an F1 hybrid, so none of this seed will come true.'
const n5 = (n, x) => `From ${n} plantings of ${x}.`

const CHIP = {
  mixed: { key: 'mixed', label: 'Mixed seed' },
  f2: { key: 'f2', label: F2_WORDS },
  part_f2: { key: 'part_f2', label: 'Part F2' },
}
const text = (v) => String(v ?? '').trim()
const f2Fact = `${F2_WORDS} (parent F1 hybrid)`

// The geneticist's truth table. `row` names the row that answered; `sentences` holds N1-N5 only (the
// one-variety breeding line is still breedingNotice's, read beside this). `breedingFact` is seedFacts'
// Breeding value: null = print the filed variety's own word, '' = print NO Breeding fact (rows 2 and 10:
// a mix has no single breeding to state).
//
// The parent set may ADD an F2 label to a one-cultivar jar and never removes one: in rows 2-7 a jar filed
// under an F1 keeps today's label. With two or more cultivars every single-variety arm is suppressed, so
// row 10 carries no F2 label even when the jar is filed, by hand, under an F1 it only partly is.
export function lotNotice(lot) {
  const filedF1 = lot?.breeding_system === 'f1'
  const facts = SEED_MULTI_PARENT ? parentSetFacts(lot?.source_plants) : null

  // Row 0: no parent set to read (flag off, a failed read, an old row, a lot with no parents). Today's
  // rule on the filed variety. Row 7 (the one entry is a plant with no variety) reads the same.
  if (!facts || facts.plantings.length === 0 || (facts.k === 1 && facts.varieties[0].variety_id == null)) {
    const full = isSavedLot(lot) && filedF1
    const filed = text(lot?.variety_name)
    return {
      row: facts && facts.plantings.length > 0 ? 7 : 0,
      chips: full ? [CHIP.f2] : [],
      sentences: facts && lot?.variety_rank === 'blend' && filed ? [n2(filed)] : [],
      f2: full ? 'full' : null,
      breedingFact: full ? f2Fact : null,
    }
  }

  const count = facts.plantings.length
  if (facts.k === 1) {
    const v = facts.varieties[0]
    const name = text(v.variety_name) || text(lot?.variety_name)
    const from = count >= 2 && name ? [n5(count, name)] : []
    if (v.breeding_system === 'f1') {
      return { row: 1, chips: [CHIP.f2], sentences: from, f2: 'full', breedingFact: f2Fact }
    }
    const blend = v.variety_rank === 'blend'
    const row = blend ? 2
      : v.breeding_system === 'open_pollinated' ? 3
      : v.breeding_system === 'landrace' ? 4
      : v.breeding_system === 'unknown' ? 5 : 6
    return {
      row,
      chips: filedF1 ? [CHIP.f2] : [],
      sentences: blend && name ? [n2(name), ...from] : from,
      f2: filedF1 ? 'full' : null,
      breedingFact: filedF1 ? f2Fact : blend ? '' : null,
    }
  }

  // Two or more cultivars. Only 'f1' is ever asserted, and a parent that is itself a mix, or has no
  // variety, counts as not F1. Names in the mix name's own order, the no-variety entry last.
  const named = facts.varieties.filter((v) => v.variety_id != null).sort(byNameThenId)
  const names = named.map((v) => text(v.variety_name) || NO_VARIETY_WORDS)
  if (named.length < facts.k) names.push(NO_VARIETY_WORDS)
  const f1 = named.filter((v) => v.breeding_system === 'f1' && v.variety_rank !== 'blend')
  const mixedLine = n1(names)
  if (f1.length === facts.k) {
    return {
      row: 8, chips: [CHIP.mixed, CHIP.f2], sentences: [mixedLine, N4], f2: 'full',
      breedingFact: `${F2_WORDS} (parents F1 hybrids)`,
    }
  }
  if (f1.length > 0) {
    const f1Names = f1.map((v) => text(v.variety_name)).filter(Boolean)
    return {
      row: 9, chips: [CHIP.mixed, CHIP.part_f2], sentences: [mixedLine, ...f1Names.map(n3)], f2: 'part',
      breedingFact: f1Names.length === 0 ? 'Part F2'
        : f1Names.length === 1 ? `Part F2 (${f1Names[0]} is an F1 hybrid)`
        : `Part F2 (${listWords(f1Names)} are F1 hybrids)`,
    }
  }
  return { row: 10, chips: [CHIP.mixed], sentences: [mixedLine], f2: null, breedingFact: '' }
}
