import { describe, it, expect } from 'vitest'
import {
  sortAggregates, harvestComparator, pickCount, naturalDirFor,
  HARVEST_SORT_MODES, DEFAULT_SORT_MODE, DEFAULT_SORT_DIR,
} from '../lib/harvestSort.js'

// Shaped like the real wire object: units[] carry {unit, unit_key, total, count} and weight is the
// V4-HARVGRAIN-001 merge, absent on rows the weight pass never resolved.
const crop = (name, grams, units = [], unquantified = 0, varieties = []) => ({
  crop_type_slug: name.toLowerCase(),
  crop_name: name,
  units,
  unquantified,
  varieties,
  ...(grams == null ? {} : { weight: { grams } }),
})
const u = (unit, total, count) => ({ unit, unit_key: unit, total, count })

describe('pickCount', () => {
  it('counts EVENTS across units, never summed quantity', () => {
    // 128 tomatoes in 40 picks plus 12 cups in 3 picks. The count axis must say 43, not 140 —
    // summing `total` would add cups to counts and produce a meaningless number.
    expect(pickCount(crop('Tomato', 1, [u('count', 128, 40), u('cup', 12, 3)]))).toBe(43)
  })

  it('includes unquantified picks — they happened', () => {
    expect(pickCount(crop('Kale', 1, [u('count', 5, 2)], 3))).toBe(5)
  })

  it('is 0, not NaN, for a crop with nothing on it', () => {
    expect(pickCount(crop('Empty', null))).toBe(0)
    expect(pickCount(undefined)).toBe(0)
  })
})

describe('defaults — Dave asked for alphabetical', () => {
  it('ships name/ascending', () => {
    expect(DEFAULT_SORT_MODE).toBe('name')
    expect(DEFAULT_SORT_DIR).toBe('asc')
  })

  it('offers exactly name, weight and picks', () => {
    expect(HARVEST_SORT_MODES.map((o) => o.value)).toEqual(['name', 'weight', 'count'])
  })

  it('each axis has its own natural direction, so picking Weight shows the heaviest first', () => {
    expect(naturalDirFor('name')).toBe('asc')
    expect(naturalDirFor('weight')).toBe('desc')
    expect(naturalDirFor('count')).toBe('desc')
  })
})

describe('name ordering', () => {
  it('is alphanumeric, not merely alphabetic — Bed 2 precedes Bed 10', () => {
    const rows = [crop('Bed 10', null), crop('Bed 2', null), crop('Bed 1', null)]
    expect(rows.sort(harvestComparator('name', 'asc')).map((c) => c.crop_name))
      .toEqual(['Bed 1', 'Bed 2', 'Bed 10'])
  })

  it('reverses on desc', () => {
    const rows = [crop('Arugula', null), crop('Zucchini', null), crop('Mache', null)]
    expect(rows.sort(harvestComparator('name', 'desc')).map((c) => c.crop_name))
      .toEqual(['Zucchini', 'Mache', 'Arugula'])
  })

  it('ignores case rather than sorting lowercase after uppercase', () => {
    const rows = [crop('beet', null), crop('Arugula', null)]
    expect(rows.sort(harvestComparator('name', 'asc')).map((c) => c.crop_name))
      .toEqual(['Arugula', 'beet'])
  })
})

describe('weight ordering', () => {
  // The defect that started all of this: alphabetical put a currant tomato above an 8kg heirloom.
  it('ranks by grams, not by pick count — the Moskvich / Cherry Falls case', () => {
    const rows = [
      crop('Cherry Falls', 763, [u('count', 128, 128)]),
      crop('Moskvich Heirloom', 8233, [u('count', 65, 65)]),
    ]
    expect(rows.sort(harvestComparator('weight', 'desc')).map((c) => c.crop_name))
      .toEqual(['Moskvich Heirloom', 'Cherry Falls'])
  })

  // The CONTRACT test, and the only one that catches a flipped null branch. Asserting a sorted
  // PERMUTATION cannot: flipping `ga == null` to -1 leaves both null branches returning -1, which
  // makes the comparator inconsistent (it claims "first argument first" for a pair in either
  // order). An inconsistent comparator's output is implementation-defined, and V8 happens to still
  // land nulls last for this input — so the mutant survives every output-shaped assertion I tried,
  // at n=3 and at n=6. Antisymmetry is the property that actually breaks, so assert it directly.
  it('comparator is ANTISYMMETRIC across the weighed/unweighed boundary', () => {
    const weighed = crop('Heavy', 900)
    const unweighed = crop('Unknown', null)
    for (const dir of ['asc', 'desc']) {
      const cmp = harvestComparator('weight', dir)
      expect(cmp(unweighed, weighed), `${dir}: unweighed must sort after`).toBeGreaterThan(0)
      expect(cmp(weighed, unweighed), `${dir}: weighed must sort before`).toBeLessThan(0)
    }
  })

  it('puts weightless rows LAST in BOTH directions — unknown is not zero', () => {
    const rows = [
      crop('AAA-unweighed', null), crop('BBB-unweighed', null), crop('CCC-unweighed', null),
      crop('Heavy', 900), crop('Mid', 400), crop('Light', 10),
    ]
    for (const dir of ['asc', 'desc']) {
      const out = rows.slice().sort(harvestComparator('weight', dir)).map((c) => c.crop_name)
      const firstNullAt = out.findIndex((n) => n.endsWith('-unweighed'))
      const weighed = out.filter((n) => !n.endsWith('-unweighed'))
      expect(firstNullAt, `${dir}: unweighed rows must form the tail`).toBe(weighed.length)
      expect(out.slice(firstNullAt).every((n) => n.endsWith('-unweighed'))).toBe(true)
      expect(weighed).toEqual(dir === 'asc' ? ['Light', 'Mid', 'Heavy'] : ['Heavy', 'Mid', 'Light'])
    }
  })

  it('breaks ties by name so equal-weight rows keep a stable, readable order', () => {
    const rows = [crop('Zucchini', 500), crop('Arugula', 500)]
    expect(rows.sort(harvestComparator('weight', 'desc')).map((c) => c.crop_name))
      .toEqual(['Arugula', 'Zucchini'])
  })
})

describe('count ordering', () => {
  it('ranks by picks, which can disagree with weight — that is the point of having both', () => {
    const heavyFewPicks = crop('Watermelon', 10200, [u('count', 4, 4)])
    const lightManyPicks = crop('Tomatillo', 1088, [u('count', 63, 63)])
    const rows = [heavyFewPicks, lightManyPicks]
    expect(rows.slice().sort(harvestComparator('count', 'desc')).map((c) => c.crop_name))
      .toEqual(['Tomatillo', 'Watermelon'])
    expect(rows.slice().sort(harvestComparator('weight', 'desc')).map((c) => c.crop_name))
      .toEqual(['Watermelon', 'Tomatillo'])
  })
})

describe('sortAggregates', () => {
  const agg = () => ({
    crops: [
      crop('Tomato', 27712, [u('count', 267, 267)], 0, [
        { variety_id: 'v1', variety_name: 'Moskvich Heirloom', units: [u('count', 65, 65)], unquantified: 0, weight: { grams: 8233 } },
        { variety_id: 'v2', variety_name: 'Cherry Falls', units: [u('count', 128, 128)], unquantified: 0, weight: { grams: 763 } },
      ]),
      crop('Arugula', 400, [u('cup', 8, 4)]),
    ],
    other: [{ project_id: 'p1', project_name: 'Zeta' }, { project_id: 'p2', project_name: 'Alpha' }],
    weight: { grams: 28112 },
  })

  it('sorts crops AND the varieties inside each crop with the same comparator', () => {
    const out = sortAggregates(agg(), 'weight', 'desc')
    expect(out.crops.map((c) => c.crop_name)).toEqual(['Tomato', 'Arugula'])
    expect(out.crops[0].varieties.map((v) => v.variety_name)).toEqual(['Moskvich Heirloom', 'Cherry Falls'])
  })

  it('applies name order to varieties too — the retrieval case Dave asked for', () => {
    const out = sortAggregates(agg(), 'name', 'asc')
    expect(out.crops.map((c) => c.crop_name)).toEqual(['Arugula', 'Tomato'])
    expect(out.crops[1].varieties.map((v) => v.variety_name)).toEqual(['Cherry Falls', 'Moskvich Heirloom'])
  })

  // MUTATION-HARDENED. The first version used the agg() fixture, whose crops are already in
  // weight-desc order — so an in-place sort produced a byte-identical array and the test passed
  // against a mutant that sorted the caller's own array. The input order MUST differ from the
  // sorted order or this asserts nothing.
  it('does NOT mutate the caller — the server array is shared with sparkline and first-pick lookups', () => {
    const input = {
      crops: [
        crop('Arugula', 400, [u('cup', 8, 4)], 0, [
          { variety_id: 'a1', variety_name: 'Astro', units: [u('cup', 2, 1)], unquantified: 0, weight: { grams: 100 } },
          { variety_id: 'a2', variety_name: 'Bellezia', units: [u('cup', 6, 3)], unquantified: 0, weight: { grams: 300 } },
        ]),
        crop('Tomato', 27712, [u('count', 267, 267)]),
      ],
    }
    // Weight-desc reverses BOTH levels here, so an in-place sort is unmissable.
    const out = sortAggregates(input, 'weight', 'desc')
    expect(out.crops.map((c) => c.crop_name)).toEqual(['Tomato', 'Arugula'])
    expect(input.crops.map((c) => c.crop_name)).toEqual(['Arugula', 'Tomato'])
    const inputArugula = input.crops.find((c) => c.crop_name === 'Arugula')
    expect(inputArugula.varieties.map((v) => v.variety_name)).toEqual(['Astro', 'Bellezia'])
    expect(out.crops.find((c) => c.crop_name === 'Arugula').varieties.map((v) => v.variety_name))
      .toEqual(['Bellezia', 'Astro'])
  })

  it('changes order ONLY — every other field passes through untouched', () => {
    const out = sortAggregates(agg(), 'name', 'asc')
    expect(out.weight).toEqual({ grams: 28112 })
    expect(out.other).toHaveLength(2)
    const tomato = out.crops.find((c) => c.crop_name === 'Tomato')
    expect(tomato.units).toEqual([u('count', 267, 267)])
    expect(tomato.crop_type_slug).toBe('tomato')
  })

  it('leaves the unattributed bucket alone — it has no weight and is a footnote, not a ranked list', () => {
    const out = sortAggregates(agg(), 'name', 'asc')
    expect(out.other.map((o) => o.project_name)).toEqual(['Zeta', 'Alpha'])
  })

  it('degrades to the input rather than throwing on a malformed payload', () => {
    expect(sortAggregates(null, 'name', 'asc')).toBeNull()
    expect(sortAggregates({}, 'name', 'asc')).toEqual({})
    const noVarieties = { crops: [crop('Solo', 5)] }
    expect(sortAggregates(noVarieties, 'weight', 'desc').crops).toHaveLength(1)
  })
})
