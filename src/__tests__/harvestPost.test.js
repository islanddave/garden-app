import { describe, it, expect } from 'vitest'
import {
  detectLastBatch, toLines, buildPostModel, renderPost, renderLine,
  normalizeVarietyName, pluralizeCrop, isUncertainName, leadFacts, seasonCountsByCrop, LINE_SOFT_CAP,
} from '../lib/harvestPost.js'

// GOLDEN FIXTURE — the real 2026-08-06 evening batch, pulled verbatim from prod Neon on 2026-08-10.
// Nine rows logged 20:41:44–20:45:12 ET (00:41–00:45 UTC on 08-07). This is the batch behind Dave's
// published post, so it is the one artefact that can tell us whether the generator reproduces what
// he actually writes. Two lines in his post ("1 Cherry Falls", "1 Suyo Long cucumber") are NOT in
// the data — Cherry Falls was never logged in this batch and the cucumber was never logged at all.
// That divergence is asserted below on purpose rather than tolerated.
const DAVE = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'
const e = (created_at, planting_name, crop_name, quantity, extra = {}) => ({
  event_id: `${planting_name}-${created_at}`,
  event_type: 'harvest',
  created_at,
  created_by: DAVE,
  planting_name,
  variety_name: planting_name,
  crop_name,
  quantity,
  unit: 'count',
  note_excerpt: null,
  ...extra,
})

const AUG6 = [
  e('2026-08-07T00:41:44Z', '1884', 'Tomato', 3),
  e('2026-08-07T00:42:21Z', 'Moskvich Heirloom', 'Tomato', 2),
  e('2026-08-07T00:42:42Z', 'San Marzano Roma', 'Tomato', 2),
  e('2026-08-07T00:43:06Z', 'Ukrainian Purple', 'Tomato', 1, { note_excerpt: 'Knocked off plant, very green' }),
  e('2026-08-07T00:43:40Z', 'Cucamelon', 'Cucamelon', 10),
  e('2026-08-07T00:43:52Z', 'Pineapple Tomatillo', 'Tomatillo', 2),
  e('2026-08-07T00:44:27Z', 'Dark Green Zucchini', 'Summer Squash', 2, { note_excerpt: 'Taken early for dish' }),
  e('2026-08-07T00:44:55Z', 'Cubanelle', 'Pepper', 1),
  e('2026-08-07T00:45:12Z', 'Piri Piri', 'Pepper', 1),
]

// Earlier the same ET day — the berry/cup picks Dave consistently leaves out of his posts.
const AUG6_EARLIER = [
  { ...e('2026-08-06T14:02:00Z', 'Blueberries', 'Blueberry', 2), unit: 'cup' },
  { ...e('2026-08-06T14:05:00Z', 'Allegheny Blackberry', 'Blackberry', 1), unit: 'cup' },
]

const compose = (entries, opts = {}) => {
  const batch = detectLastBatch(entries, opts)
  const model = buildPostModel(toLines(batch.items), opts)
  return { batch, model, text: renderPost(model, opts) }
}

describe('detectLastBatch', () => {
  it('reproduces the real 2026-08-06 evening batch and excludes the earlier same-day picks', () => {
    const batch = detectLastBatch([...AUG6_EARLIER, ...AUG6])
    expect(batch.items).toHaveLength(9)
    expect(batch.startedAt).toBe('2026-08-07T00:41:44.000Z')
    expect(batch.endedAt).toBe('2026-08-07T00:45:12.000Z')
    // The whole reason this module exists: a calendar-day summary would have included these.
    expect(batch.items.some((i) => i.crop_name === 'Blueberry')).toBe(false)
  })

  // The previous version of this test looped 20/45/90/240 over AUG6 and called the result a
  // "plateau". It was tautological: AUG6's nearest preceding pick is 636 minutes away, so no
  // threshold in [1, 630] can change the answer. It proved the fixture is insensitive to N, which is
  // the opposite of evidence about N. Replaced with the shape that actually discriminates.
  it('encodes the real N tradeoff: a straggler evening splits at 45 and fuses at 90', () => {
    // 2026-08-08 in prod: a tight 31-pick run, then ONE lone pick 76.6 minutes later.
    const run = Array.from({ length: 5 }, (_, i) =>
      e(`2026-08-08T21:5${i}:00Z`, `Variety ${i}`, 'Tomato', 1))
    const straggler = e('2026-08-08T23:10:00Z', 'Late Pick', 'Tomato', 1) // 76 min after the run
    expect(detectLastBatch([...run, straggler], { gapMinutes: 45 }).items).toHaveLength(1)
    expect(detectLastBatch([...run, straggler], { gapMinutes: 90 }).items).toHaveLength(6)
  })

  it('ends the run at a different logger so two overlapping sessions never merge', () => {
    const jen = { ...e('2026-08-07T00:40:00Z', 'Red Raspberries', 'Raspberry', 4), created_by: 'user_jen' }
    const batch = detectLastBatch([jen, ...AUG6])
    expect(batch.createdBy).toBe(DAVE)
    expect(batch.items).toHaveLength(9)
  })

  it('returns null when nothing has a usable created_at', () => {
    expect(detectLastBatch([{ event_id: 'x', created_at: null }])).toBeNull()
    expect(detectLastBatch([])).toBeNull()
  })

  it('orders the batch chronologically even though the read model arrives event_date DESC', () => {
    const batch = detectLastBatch([...AUG6].reverse())
    expect(batch.items[0].planting_name).toBe('1884')
    expect(batch.items[8].planting_name).toBe('Piri Piri')
  })
})

describe('normalizeVarietyName', () => {
  it('strips only the suffixes verified safe against the live cultivar corpus', () => {
    expect(normalizeVarietyName('Moskvich Heirloom')).toBe('Moskvich')
    expect(normalizeVarietyName('Armageddon F1')).toBe('Armageddon')
    expect(normalizeVarietyName('Cherry Stuffer (Burpee)')).toBe('Cherry Stuffer')
  })

  it('applies evidence-backed overrides taken from Dave’s published post text', () => {
    expect(normalizeVarietyName('San Marzano Roma')).toBe('San Marzano')
    expect(normalizeVarietyName("Czech's Bush")).toBe('Czech Bush')
    expect(normalizeVarietyName('Chilly Chill')).toBe('Chilly Chills')
  })

  it('never spell-corrects or re-cases a name Dave typed', () => {
    // He wrote "Grandadero" for the DB's "Granadero" and `"beefsteak"` in scare quotes. Both survive.
    expect(normalizeVarietyName('Granadero')).toBe('Granadero')
    expect(normalizeVarietyName('"beefsteak"')).toBe('"beefsteak"')
    expect(normalizeVarietyName('Rista Cayanne II')).toBe('Rista Cayanne II')
  })

  // V4-SEASONRETRO-001. Found by RENDERING the season retrospective over the real prod corpus, not
  // by reading the code: the draft's very first line was "June 7 — Scallion (thin clump)". Every
  // parenthetical in the live harvested-name corpus is internal bookkeeping — measured 2026-08-21,
  // all four of them, and the other two are refused outright by isUncertainName.
  it('drops a trailing parenthetical — it is bookkeeping, never part of the published name', () => {
    expect(normalizeVarietyName('Scallion (thin clump)')).toBe('Scallion')
    expect(normalizeVarietyName('Cherokee Green (Rescue)')).toBe('Cherokee Green')
  })

  it('still strips a suffix that sits BEHIND a parenthetical', () => {
    // Order matters: the note is appended after the name, so stripping it first is what lets the
    // suffix rules see the real end of the string.
    expect(normalizeVarietyName('Moskvich Heirloom (Rescue)')).toBe('Moskvich')
  })

  it('leaves a mid-string parenthetical alone — only a TRAILING note is bookkeeping', () => {
    expect(normalizeVarietyName('Bull (Red) Nose')).toBe('Bull (Red) Nose')
  })

  it('the two names that must never publish are still refused, not merely tidied', () => {
    // Stripping the note off these would turn "unknown variety" into a confident "Strawberry".
    // isUncertainName is the guard; normalize is not a substitute for it.
    expect(isUncertainName('Strawberry (unknown variety)')).toBe(true)
    expect(isUncertainName('Onion — scallion-type (thick blue-green, ID pending)')).toBe(true)
    expect(isUncertainName('Scallion (thin clump)')).toBe(false)   // safe once the note is dropped
    expect(isUncertainName('Cherokee Green')).toBe(false)
  })
})

describe('pluralizeCrop — multi-word crop names', () => {
  // Six multi-word crop names reach a post in the live corpus. The rules used to be applied to the
  // WHOLE string, so the qualifier hid the noun from every one of them.
  it('applies the invariant to the head noun, not the whole phrase', () => {
    expect(pluralizeCrop('Summer Squash', 3)).toBe('Summer Squash')   // was "Summer Squashes"
    expect(pluralizeCrop('Squash', 3)).toBe('Squash')
  })

  it('applies the -o rule to the head noun', () => {
    expect(pluralizeCrop('Cherry Tomato', 3)).toBe('Cherry Tomatoes') // was "Cherry Tomatos"
    expect(pluralizeCrop('Tomato', 3)).toBe('Tomatoes')
  })

  it('keeps the qualifier and pluralises the noun for the ordinary cases', () => {
    expect(pluralizeCrop('Red Raspberry', 3)).toBe('Red Raspberries')
    expect(pluralizeCrop('Bee Balm', 3)).toBe('Bee Balms')
    expect(pluralizeCrop('Bitter Melon', 3)).toBe('Bitter Melons')
  })

  it('drops a parenthetical from a CROP name too', () => {
    // "Onion (bunching / scallion)" is a real crop_types row and was rendering as
    // "Onion (bunching / scallion)s" — the generic -s rule firing on a closing bracket.
    expect(pluralizeCrop('Onion (bunching / scallion)', 3)).toBe('Onions')
    expect(pluralizeCrop('Onion (bunching / scallion)', 1)).toBe('Onion')
  })

  it('still returns the singular at qty 1', () => {
    expect(pluralizeCrop('Red Raspberry', 1)).toBe('Red Raspberry')
    expect(pluralizeCrop('Summer Squash', 1)).toBe('Summer Squash')
  })
})

describe('renderLine', () => {
  const L = (name, crop, quantity) => ({ name: normalizeVarietyName(name), crop, quantity })

  it('writes the crop word the way Dave does, not the way the taxonomy does', () => {
    expect(renderLine(L('Cubanelle', 'Pepper', 1), { withCrop: true })).toBe('1 Cubanelle pepper')
    expect(renderLine(L('Cucamelon', 'Cucamelon', 10), { withCrop: true })).toBe('10 cucamelons')
    expect(renderLine(L('Pineapple Tomatillo', 'Tomatillo', 2), { withCrop: true })).toBe('2 Pineapple tomatillos')
    // "Summer Squash" is a taxonomy label, never speech — the variety name already says zucchini.
    expect(renderLine(L('Dark Green Zucchini', 'Summer Squash', 2), { withCrop: true })).toBe('2 Dark Green Zucchini')
  })

  it('omits the crop entirely under a crop heading', () => {
    expect(renderLine(L('Moskvich Heirloom', 'Tomato', 2), { withCrop: false })).toBe('2 Moskvich')
  })
})

describe('pluralizeCrop', () => {
  it('leaves invariant crops alone', () => {
    expect(pluralizeCrop('Squash', 3)).toBe('Squash')
    expect(pluralizeCrop('Kale', 2)).toBe('Kale')
  })
  it('does not pluralise a single item', () => {
    expect(pluralizeCrop('Pepper', 1)).toBe('Pepper')
  })
  it('handles the shapes in Dave’s crop list', () => {
    expect(pluralizeCrop('Tomato', 6)).toBe('Tomatoes')
    expect(pluralizeCrop('Tomatillo', 2)).toBe('Tomatillos')
    expect(pluralizeCrop('Cucamelon', 10)).toBe('Cucamelons')
  })
})

describe('buildPostModel grouping', () => {
  it('reproduces the heading/flat split of the real 2026-08-06 post', () => {
    const { model } = compose(AUG6)
    // Four tomato varieties -> heading. TWO pepper varieties -> flat, exactly as Dave wrote it.
    expect(model.groups.map((g) => g.crop)).toEqual(['Tomato'])
    expect(model.groups[0].lines).toHaveLength(4)
    const singleNames = model.singles.map((l) => l.name)
    expect(singleNames).toContain('Cubanelle')
    expect(singleNames).toContain('Piri Piri')
  })

  it('a >=2 threshold would have invented a heading Dave did not write', () => {
    const { model } = compose(AUG6, { groupThreshold: 2 })
    expect(model.groups.map((g) => g.crop)).toContain('Pepper')
  })

  it('leads a group with a first harvest rather than the biggest number', () => {
    const withFirst = AUG6.map((r) =>
      r.planting_name === 'Ukrainian Purple' ? { ...r, event_type: 'first_harvest' } : r)
    const { model } = compose(withFirst)
    expect(model.groups[0].lines[0].name).toBe('Ukrainian Purple')
  })

  it('flags an over-long list without truncating it', () => {
    const many = Array.from({ length: LINE_SOFT_CAP + 1 }, (_, i) =>
      e(`2026-08-07T00:${String(10 + i).padStart(2, '0')}:00Z`, `Variety ${i}`, 'Tomato', 1))
    const { model } = compose(many)
    expect(model.overCap).toBe(true)
    expect(renderPost(model).split('\n').filter(Boolean).length).toBeGreaterThan(LINE_SOFT_CAP)
  })

  // Sibling plantings of one cultivar are distinct garden_node rows. Prod hits this in 2 of 35
  // historical batches — the 08-08 evening renders "4 San Marzano / 4 San Marzano" unmerged.
  it('sums sibling plantings of the same variety into one line', () => {
    const siblings = [
      e('2026-08-07T00:41:00Z', 'San Marzano Roma', 'Tomato', 4),
      e('2026-08-07T00:42:00Z', 'San Marzano Roma', 'Tomato', 4),
      e('2026-08-07T00:43:00Z', 'Moskvich Heirloom', 'Tomato', 1),
    ]
    const { text, model } = compose(siblings)
    expect(text).toContain('8 San Marzano')
    expect(text.match(/San Marzano/g)).toHaveLength(1)
    expect(model.lineCount).toBe(2)
  })

  it('carries a first-harvest through the sibling merge', () => {
    const siblings = [
      e('2026-08-07T00:41:00Z', 'San Marzano Roma', 'Tomato', 4),
      { ...e('2026-08-07T00:42:00Z', 'San Marzano Roma', 'Tomato', 4), event_type: 'first_harvest' },
    ]
    expect(compose(siblings).text).toContain('8 San Marzano tomatoes (1st harvest!)')
  })
})

describe('renderPost', () => {
  it('golden: the 2026-08-06 batch renders as Dave’s post shape', () => {
    const { text } = compose(AUG6)
    expect(text).toBe([
      'Tomatoes:',
      '  3 1884',
      '  2 Moskvich',
      '  2 San Marzano',
      '  1 Ukrainian Purple',
      '',
      '10 cucamelons',
      '2 Pineapple tomatillos',
      '2 Dark Green Zucchini',
      '1 Cubanelle pepper',
      '1 Piri Piri pepper',
    ].join('\n'))
  })

  it('EXPECTED DIVERGENCE: two lines Dave posted are absent because they were never logged', () => {
    const { text } = compose(AUG6)
    // He wrote "1 Cherry Falls" and "1 Suyo Long cucumber". Neither is in this batch in prod.
    // The generator must NOT invent them — this asserts the gap rather than tolerating it.
    expect(text).not.toContain('Cherry Falls')
    expect(text).not.toContain('Suyo Long')
  })

  it('puts Dave’s lead above the list and never writes prose itself', () => {
    const { model } = compose(AUG6)
    expect(renderPost(model, { lead: '' }).startsWith('Tomatoes:')).toBe(true)
    expect(renderPost(model, { lead: 'The evening harvest:' }).startsWith('The evening harvest:\n\n')).toBe(true)
  })

  it('emits "1st harvest!" only from Dave’s own first_harvest event type', () => {
    const plain = compose(AUG6).text
    expect(plain).not.toContain('1st harvest')
    const marked = AUG6.map((r) => (r.planting_name === 'Cubanelle' ? { ...r, event_type: 'first_harvest' } : r))
    expect(compose(marked).text).toContain('1 Cubanelle pepper (1st harvest!)')
  })

  it('carries a per-line annotation Dave typed, and never the raw logged note', () => {
    const { model } = compose(AUG6)
    const uk = model.groups[0].lines.find((l) => l.name === 'Ukrainian Purple')
    // The DB note is "Knocked off plant, very green"; he published "(green, accidental)".
    expect(uk.noteSuggestion).toBe('Knocked off plant, very green')
    expect(compose(AUG6).text).not.toContain('Knocked off plant')
    const text = renderPost(model, { annotations: { [uk.id]: 'green, accidental' } })
    expect(text).toContain('1 Ukrainian Purple (green, accidental)')
  })
})

describe('what must never happen', () => {
  it('never emits a weight', () => {
    const withWeight = AUG6.map((r) => ({ ...r, weight_grams: 1360.776, weight_estimated: true }))
    expect(compose(withWeight).text).not.toMatch(/136|gram|\blb\b|\boz\b/)
  })

  it('excludes non-count units rather than rendering a cup of berries as a number', () => {
    const { model } = compose([...AUG6, { ...e('2026-08-07T00:46:00Z', 'Blueberries', 'Blueberry', 2), unit: 'cup' }])
    expect(model.lineCount).toBe(9)
    expect(renderPost(model)).not.toContain('Blueberries')
  })

  it('renders an unnamed harvest at crop level instead of dropping it', () => {
    const orphan = { ...e('2026-08-07T00:46:00Z', '', 'Cucumber', 2), planting_name: null, variety_name: null }
    const lines = toLines([orphan])
    expect(lines[0].needsName).toBe(true)
    expect(lines[0].postable).toBe(true)
    expect(renderPost(buildPostModel(lines))).toBe('2 cucumbers')
  })

  // Every one of the 5 live plant_id-IS-NULL harvests in prod has NO crop either — no plant means no
  // cultivar means no crop_types join. Running this module over 504 real rows put a bare "2" into
  // 3 of 35 batches, including the 08-05 batch this file's own header cites as its proof.
  it('never emits a bare integer for a harvest with neither a name nor a crop', () => {
    const nameless = { ...e('2026-08-07T00:46:00Z', '', '', 2), planting_name: null, variety_name: null, crop_name: null }
    const lines = toLines([nameless])
    expect(lines[0].needsName).toBe(true)
    expect(lines[0].postable).toBe(false)          // kept for the UI, kept OUT of the post
    expect(renderPost(buildPostModel(lines))).toBe('')
  })

  it('treats a string quantity from the numeric column as a number', () => {
    // harvest_log.quantity is `numeric`; the neon driver returns a STRING.
    const asString = { ...e('2026-08-07T00:46:00Z', 'Moskvich Heirloom', 'Tomato', '3') }
    const lines = toLines([asString])
    expect(lines[0].quantity).toBe(3)
    expect(renderPost(buildPostModel(lines))).toBe('3 Moskvich tomatoes')
  })

  it('suppresses a name carrying identification uncertainty', () => {
    const vague = e('2026-08-07T00:46:00Z', 'Onion — scallion-type (thick blue-green, ID pending)', 'Onion', 3)
    const lines = toLines([vague])
    expect(lines[0].uncertainName).toBe(true)
    expect(renderPost(buildPostModel(lines))).toBe('3 onions')
  })

  it('produces an empty model, not an empty post, when a batch has nothing postable', () => {
    const cupsOnly = [{ ...e('2026-08-07T00:46:00Z', 'Blueberries', 'Blueberry', 2), unit: 'cup' }]
    const model = buildPostModel(toLines(detectLastBatch(cupsOnly).items))
    expect(model.lineCount).toBe(0)
    expect(renderPost(model)).toBe('')
  })

  it('honours a per-line exclusion', () => {
    const lines = toLines(AUG6).map((l) => (l.name === 'Cucamelon' ? { ...l, include: false } : l))
    expect(renderPost(buildPostModel(lines))).not.toContain('cucamelons')
  })
})

describe('leadFacts + seasonCountsByCrop', () => {
  const AGG = {
    crops: [
      { crop_name: 'Tomato', crop_type_slug: 'tomato', units: [{ unit: 'count', unit_key: 'count', total: 382, count: 120 }] },
      { crop_name: 'Cucamelon', crop_type_slug: 'cucamelon', units: [{ unit: 'count', unit_key: 'count', total: 167, count: 20 }] },
      { crop_name: 'Blueberry', crop_type_slug: 'blueberry', units: [{ unit: 'cup', unit_key: 'cup', total: 12, count: 6 }] },
    ],
  }

  it('reads season totals from the full-range aggregates, not from a paginated entries page', () => {
    const counts = seasonCountsByCrop(AGG)
    expect(counts.get('Tomato')).toBe(382)
    expect(counts.get('Cucamelon')).toBe(167)
    // A cup-only crop contributes no count total — it must not appear as a countable season figure.
    expect(counts.has('Blueberry')).toBe(false)
  })

  it('hands Dave numbers, never a sentence, and labels the window it counted', () => {
    const batch = detectLastBatch(AUG6)
    const facts = leadFacts(batch, seasonCountsByCrop(AGG), 'this season')
    expect(facts).toContain('24 picked tonight')
    expect(facts.some((f) => /varieties/.test(f))).toBe(true)
    expect(facts).toContain('382 tomatoes this season')
    // BUG-COMPOSETOTALS-001: the chip must state its window. "382 tomatoes" alone reads as
    // season-to-date regardless of what was actually summed.
    for (const f of facts.filter((x) => /tomatoes|cucamelons/.test(x))) {
      expect(f).toMatch(/this season$/)
    }
    for (const f of facts) expect(f).not.toMatch(/[.!]$/) // fragments, not prose
  })

  it('compares each season figure against its OWN crop, not the cross-crop batch sum', () => {
    // Cucamelon: 10 in this batch, 167 for the season -> emitted. Under the old guard (compare against
    // the 24-item batch TOTAL) a crop whose season figure sat between its own batch qty and the batch
    // sum was silently dropped.
    const batch = detectLastBatch(AUG6)
    const facts = leadFacts(batch, new Map([['Cucamelon', 20], ['Tomato', 8]]), 'this week')
    expect(facts).toContain('20 cucamelons this week')   // 20 > this batch's 10
    expect(facts).not.toContain('8 tomatoes this week')  // 8 < this batch's 8 tomatoes -> suppressed
  })

  it('emits no season facts when aggregates are missing rather than inventing them', () => {
    const batch = detectLastBatch(AUG6)
    expect(leadFacts(batch, seasonCountsByCrop(null))).toEqual(['24 picked tonight', '9 varieties'])
  })
})
