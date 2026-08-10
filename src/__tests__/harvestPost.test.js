import { describe, it, expect } from 'vitest'
import {
  detectLastBatch, toLines, buildPostModel, renderPost, renderLine,
  normalizeVarietyName, pluralizeCrop, leadFacts, LINE_SOFT_CAP,
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

  it('is stable across the whole 20–240 minute plateau measured in prod', () => {
    for (const gapMinutes of [20, 45, 90, 240]) {
      expect(detectLastBatch([...AUG6_EARLIER, ...AUG6], { gapMinutes }).items).toHaveLength(9)
    }
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
    expect(model.lineCount).toBe(LINE_SOFT_CAP + 1)
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

describe('leadFacts', () => {
  it('hands Dave numbers, never a sentence', () => {
    const batch = detectLastBatch(AUG6)
    const facts = leadFacts(batch, AUG6)
    expect(facts).toContain('24 picked tonight')
    expect(facts.some((f) => /varieties/.test(f))).toBe(true)
    for (const f of facts) expect(f).not.toMatch(/[.!]$/) // fragments, not prose
  })
})
