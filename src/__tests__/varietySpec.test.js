import { describe, it, expect } from 'vitest'
import { shuLabel, determinacyLabel } from '../lib/varietySpec.js'
import { parseDeterminacy } from '../../lambda/tags/crop-derive.js'

describe('V4-VARSLUG-001 shuLabel', () => {
  it('null when no scoville data', () => expect(shuLabel({})).toBeNull())
  it('range with K/M', () => {
    expect(shuLabel({ scoville_min: 50000, scoville_max: 100000 })).toBe('50K–100K SHU')
    expect(shuLabel({ scoville_min: 800000, scoville_max: 1041427 })).toBe('800K–1.04M SHU')
  })
  it('sweet peppers read as Sweet · 0 SHU', () => expect(shuLabel({ scoville_min: 0, scoville_max: 0 })).toBe('Sweet · 0 SHU'))
  it('single value when min==max or one side null', () => {
    expect(shuLabel({ scoville_min: 2500, scoville_max: 2500 })).toBe('2.5K SHU')
    expect(shuLabel({ scoville_min: 8000, scoville_max: null })).toBe('8K SHU')
  })
})

// V5-SEEDCARDS-001 / v5-scovillesource-001 — a best guess is labelled as one. The marker is the WORD
// "est. " (commit 4382da4's house rule: no leading glyph on a line this small), and ONLY the
// 'inference' source earns it. Everything else must stay byte-identical to the pre-source label,
// which is why the "unchanged" cases compare against literals rather than against shuLabel itself.
describe('V5-SEEDCARDS-001 shuLabel — scoville_source', () => {
  const RANGE = { scoville_min: 100000, scoville_max: 350000 }

  it("an 'inference' figure is prefixed with the word est.", () => {
    expect(shuLabel({ ...RANGE, scoville_source: 'inference' })).toBe('est. 100K–350K SHU')
    expect(shuLabel({ scoville_min: 2500, scoville_max: 2500, scoville_source: 'inference' })).toBe('est. 2.5K SHU')
    expect(shuLabel({ scoville_min: 8000, scoville_max: null, scoville_source: 'inference' })).toBe('est. 8K SHU')
    expect(shuLabel({ scoville_min: 0, scoville_max: 0, scoville_source: 'inference' })).toBe('est. Sweet · 0 SHU')
  })

  it('a sourced figure renders exactly as before, for every other vocabulary value', () => {
    for (const src of ['packet_label', 'vendor_catalog', 'breeder', 'reference_work', 'grower_record']) {
      expect(shuLabel({ ...RANGE, scoville_source: src }), src).toBe('100K–350K SHU')
      expect(shuLabel({ scoville_min: 0, scoville_max: 0, scoville_source: src }), src).toBe('Sweet · 0 SHU')
    }
  })

  it('no source — null, undefined or absent — renders exactly as before', () => {
    expect(shuLabel({ ...RANGE, scoville_source: null })).toBe('100K–350K SHU')
    expect(shuLabel({ ...RANGE, scoville_source: undefined })).toBe('100K–350K SHU')
    expect(shuLabel(RANGE)).toBe('100K–350K SHU')
  })

  it('matches the one value exactly — a near-miss spelling is not treated as a guess', () => {
    // The DB CHECK admits only the lower-case value, so these cannot arrive from the API; pinned so
    // a loosened comparison (includes / toLowerCase) is a deliberate change rather than a drift.
    for (const src of ['Inference', 'inferred', ' inference', 'est']) {
      expect(shuLabel({ ...RANGE, scoville_source: src }), src).toBe('100K–350K SHU')
    }
  })

  it('a source alone never makes a chip appear — no numbers is still null', () => {
    expect(shuLabel({ scoville_source: 'inference' })).toBeNull()
    expect(shuLabel({ scoville_min: null, scoville_max: null, scoville_source: 'vendor_catalog' })).toBeNull()
  })
})

describe('V4-VARSLUG-001 determinacyLabel', () => {
  it('null when no growth_habit', () => expect(determinacyLabel({})).toBeNull())
  it('maps indeterminate/determinate/semi', () => {
    expect(determinacyLabel({ growth_habit: 'indeterminate' })).toBe('Indeterminate')
    expect(determinacyLabel({ growth_habit: 'determinate' })).toBe('Determinate')
    expect(determinacyLabel({ growth_habit: 'semi-determinate' })).toBe('Semi-determinate')
  })
})

// The pill names a determinacy class or nothing (2026-09-25). Before, prose with no determinacy word
// came back WHOLE as the pill (146 live non-tomato cards: a 150-char bean description, a 209-char
// garlic-chives one) and a bare `semi` test made "semi-woody" and friends Semi-determinate (7 more).
// Every prose string here is live prod growth_habit read 2026-09-25, except MADE_UP, which pins
// spellings no live row carries yet.
describe('determinacyLabel — a real determinacy term, or nothing', () => {
  const label = gh => determinacyLabel({ growth_habit: gh })
  const WORDS = ['Determinate', 'Indeterminate', 'Semi-determinate']

  const SENTENCES = [
    // bean: Contender, Gold Rush, Tavera (the three live bean plantings)
    'Compact bush plant ~18-24 in tall, self-supporting; heavy sets of round, meaty, medium-green stringless snap pods ~6 in long. Early and heat-tolerant.',
    'Upright bush plant ~18-22 in tall holding pods off the ground; bright golden-yellow, straight, round stringless wax pods ~5-6 in long.',
    'Bush filet plant ~16-20 in tall; slim, straight dark-green pods ~4-5 in long with a very concentrated set-good for once-over picking.',
    // pepper: Quadrato d'Asti Rosso; basil: Purple Basil; melon: Green Flesh
    'sturdy productive bushy, 2-3 ft tall; massive blocky 4-lobed fruit 4-6 in wide and long, thick-walled; may need staking',
    'upright bushy annual 12-24 in tall; deep purple foliage; branching; slightly less vigorous than green sweet basil',
    'vining annual; sprawling vines 6-10 ft; large smooth-skinned fruits 5-6 lb; harvest when ground color shifts from greenish-white to creamy yellow',
    // chives: Garlic Chives, the longest pill on prod (209 chars)
    'Clump-forming perennial with flat, garlic-scented leaves (unlike round hollow chive leaves); upright 18-24 in tall, 12 in wide; white star-shaped flowers late summer; self-seeds aggressively if not deadheaded.',
  ]

  // Every live `semi-` compound that is not semi-determinate. The first seven are on live plantings
  // (Green Magic, Australe, Greek Oregano, Oregano, Garden Sage, Sugar Rush Peach, Cavendish).
  const SEMI_COMPOUNDS = [
    'compact upright plant ~24 in tall; semi-domed 6-8 in dark green head with medium-small beads; abundant side shoots after main harvest',
    'Butterhead rosette, semi-upright heading',
    'compact spreading semi-woody perennial subshrub to 12-18 in tall; fuzzy gray-green leaves; white flowers; low mounding',
    'spreading low mounding semi-woody perennial subshrub 12-24 in tall; branching square stems; opposite oval leaves',
    'bushy spreading semi-woody perennial subshrub 18-24 in tall by 24-36 in wide; grayish woolly leaves; blue-purple flowers in early summer',
    'vigorous bushy semi-vining, 4-5 ft tall; pendant elongated 3 in peachy-orange pods; prolific branching habit',
    'low ground-hugging runner; plants 6-8 in tall; produces runners (stolons) for vegetative spread; semi-compact habit',
    'Semi-dwarf snap pea, vines ~2.5-3 ft; plump sweet thick-walled dark-green edible-pod snap peas ~3 in long. Benefits from light support.',
    "huge plant, about 5 ft tall; semi-dark foliage; very long, large, tapering red pods (Patrick's)",
    'semi-bushy, well-branched woody perennial, 3.5-4 ft (smaller if pruned); small leaves, white flowers; upright pea-sized pods',
    'Semi-savoy upright basal rosette',
    '24-36 in tall, sprawling/semi-vining 12-18 in; clusters of sky-blue star-shaped flowers; grey-green fuzzy foliage, milky sap',
    'low spreading semi-prostrate perennial to 8-20 in tall; branching stems root at nodes; narrow pointed leaves with dark chevron markings',
    'large copper-red semi-flat globes with red-and-white ringed flesh', // Red Amposta onion (excerpt)
  ]

  // [prose, label] — tomatoes, then the non-tomato habit statements (tomatillo, potato, bush bean).
  const TERMS = [
    ['indeterminate vine; 5-7 ft; stake or cage required', 'Indeterminate'],
    ["Indeterminate, potato-leaf; rosy-pink beefsteak, large 12-16+ oz slicing fruit", 'Indeterminate'],
    ["indeterminate (compact, to ~5 ft); NZ 'black' beefsteak; container-suitable; reported early-blight resistance", 'Indeterminate'],
    ['indeterminate vine; 5-6 ft; compact for an indeterminate; stake or cage required', 'Indeterminate'],
    ['determinate; heat-tolerant Florida-series slicer', 'Determinate'],
    ['trailing/cascading determinate; 24-36 in spreading; bred for hanging baskets and containers; no staking required', 'Determinate'],
    ['determinate dwarf bush; 30-36 in; no staking needed but may need support under heavy fruit load', 'Determinate'],
    ['semi-determinate bush, 4-5 ft', 'Semi-determinate'],
    ["semi-determinate bush (= Tom Wagner 'Cream Sausage'); meaty cream-yellow paste fruit", 'Semi-determinate'],
    ['sprawling indeterminate vine; benefits from tomato cage or trellis; 3-4 ft tall, spreading 3+ ft', 'Indeterminate'],
    ['Sprawling indeterminate 3-4 ft plant; large husked green fruit. Plant 2+ for pollination.', 'Indeterminate'],
    ['upright herbaceous annual, 24-36 in tall; indeterminate late-season type; large russet-skinned mealy tubers on stolons; tall vigorous foliage', 'Indeterminate'],
    ['upright herbaceous annual, 18-24 in tall; early-mid season; medium-large smooth oval yellow-fleshed tubers on stolons; slightly determinate habit', 'Determinate'],
    ['Compact upright determinate bush ~18-24 in tall (no trellis); pods carry classic tan-and-brown-speckled pinto seeds', 'Determinate'],
  ]

  // The leading term is the claim; a later one is a hedge. Rosa Sicilian (the "Rosso Sicilian" card)
  // showed Semi-determinate over an Indeterminate facet chip. Fingerling's prose really does say it
  // varies; the pill reads its leading word, as it did before and as the facet engine does.
  const LEFTMOST = [
    ['indeterminate vine (semi-determinate per some sources); deeply ribbed costoluto-type; 5-6 ft; stake or cage required', 'Indeterminate'],
    ['upright herbaceous annual, 18-24 in tall; indeterminate or determinate depending on sub-type; elongated finger-shaped tubers form on stolons underground', 'Indeterminate'],
  ]
  const LIVE = [...SENTENCES, ...SEMI_COMPOUNDS, ...TERMS.map(([s]) => s), ...LEFTMOST.map(([s]) => s)]

  const EN_DASH = String.fromCodePoint(0x2013)
  const HYPHEN = String.fromCodePoint(0x2010)
  const NB_HYPHEN = String.fromCodePoint(0x2011)
  const MADE_UP = {
    semi: ['semi determinate', 'semideterminate', 'Semi-Determinate', 'SEMI-DETERMINATE', 'semi_determinate',
      `semi${EN_DASH}determinate`, `semi${HYPHEN}determinate`, `semi${NB_HYPHEN}determinate`, 'compact (semi-determinate) bush'],
    indeterminate: ['INDETERMINATE', 'vigorous; indeterminate.', 'indeterminate-type vine', '(indeterminate)', 'tall,indeterminate'],
    determinate: ['DETERMINATE', 'Determinate bush', 'bush; determinate-type', 'compact/determinate'],
    none: ['non-determinate', 'semi-indeterminate', 'the main determinant of bulbing', 'height determined by pruning',
      'determinacy not stated', 'unlike indeterminates, stays compact'],
  }

  it('null when growth_habit is absent, empty or blank', () => {
    for (const v of [undefined, null, {}, { growth_habit: null }, { growth_habit: '' }, { growth_habit: '   ' }]) {
      expect(determinacyLabel(v), JSON.stringify(v)).toBeNull()
    }
  })

  it('a habit sentence with no determinacy term labels nothing — never the sentence itself', () => {
    for (const s of SENTENCES) expect(label(s), s).toBeNull()
  })

  it('"semi-" in front of anything but determinate is not a determinacy word', () => {
    for (const s of SEMI_COMPOUNDS) expect(label(s), s).toBeNull()
  })

  it('a real term labels its class — tomatoes, and habit statements on other crops (no crop gate)', () => {
    for (const [s, want] of TERMS) expect(label(s), s).toBe(want)
  })

  it('the leftmost term wins over a later hedge', () => {
    for (const [s, want] of LEFTMOST) expect(label(s), s).toBe(want)
  })

  it('every spelling of the semi-determinate family reads Semi-determinate', () => {
    for (const s of MADE_UP.semi) expect(label(s), s).toBe('Semi-determinate')
  })

  it('whole words in any case and punctuation', () => {
    for (const s of MADE_UP.indeterminate) expect(label(s), s).toBe('Indeterminate')
    for (const s of MADE_UP.determinate) expect(label(s), s).toBe('Determinate')
  })

  it('a term inside a longer word or a hyphen compound labels nothing', () => {
    for (const s of MADE_UP.none) expect(label(s), s).toBeNull()
  })

  it('only ever one of the three words or null, over every live sample', () => {
    for (const s of LIVE) {
      const got = label(s)
      expect(got === null || WORDS.includes(got), `${s} -> ${got}`).toBe(true)
    }
  })

  // The facet chip under the pill comes from parseDeterminacy (tomatoes only, structured column first,
  // Dwarf as a refinement of Determinate). On every live sample the two readings must agree, so a card
  // can never again say Semi-determinate over an Indeterminate chip.
  it('agrees with the derived determinacy facet on every live sample', () => {
    const asPill = { determinate: 'Determinate', dwarf: 'Determinate', indeterminate: 'Indeterminate', semi_determinate: 'Semi-determinate' }
    for (const s of LIVE) expect(label(s), s).toBe(asPill[parseDeterminacy(s)] ?? null)
  })
})
