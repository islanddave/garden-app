// Put-Up release F — the client's ferment arithmetic and words, pinned to 06 §5.3's GOLDEN TABLE (the
// values both the Lambda lane and this lane pin independently) and to the line rules of contract-F §2.2.
// Every expected value below is a literal from the table, never re-derived from the function under test.
// CI LANE: `npm test` plus the blocking TZ re-run.
import { describe, it, expect } from 'vitest'
import {
  saltBase, saltGrams, actualPct, oneDecimal, saltLiveWords, saltAsideWords, saltLineWords, gramsOf,
  aboutPlaceholderGrams, formatShu, shuRangeWords, parseRating, parsePct, ACT_LABELS, SALT_BASE_LABELS,
} from '../components/putup/fermentMath.js'
import {
  lineBody, lineWords, emptyDraft, defaultUnit, nextOrdinal, isLegacyPick, gramsLeftAfter, jarHitWords,
  linePatch, unitNeeded, LINE_ERRORS, addedWords, offerListedHeat, lineSearchUrl,
} from '../components/putup/lines.js'

const L = (label, qty, qty_unit, o = {}) => ({ label, qty, qty_unit, role: null, put_up_stage_id: null, ...o })
const PETRI = [L('jalapeño', '170', 'g'), L('garlic', '8', 'g'), L('onion', '20', 'g'), L('Water', '250', 'ml', { role: 'water' })]
const SETTLERS = [L('Ristra Cayenne', '150', 'g'), L('sugar', '2', 'g'), L('Salt', '4.5', 'g', { role: 'salt' })]
const KIMCHI = [L('napa', '1500', 'g'), L('radish', '300', 'g'), L('gochugaru', '40', 'g', { form: 'dried' }),
  L('garlic', '20', 'g'), L('ginger', '10', 'g'), L('fish sauce', '30', 'ml')]
const APPENDIX_C = [L('Megatron', '412', 'g'), L('Serranos', '230', 'g'), L('Reaper', '8', 'g', { input_kind: 'put_up' }),
  L('Carrots', '150', 'g', { input_kind: 'put_up', count_drawn: 1 }), L('onion', null, null), L('garlic', '4', 'count')]

describe('the salt helper — golden table (06 §5.3)', () => {
  it('Petri forward: 3.5% of Veg + water → base 448, 15.68 g, shown 15.7', () => {
    const b = saltBase(PETRI, 'all')
    expect(b.grams).toBe(448)
    expect(saltGrams(3.5, b.grams)).toBeCloseTo(15.68, 10)
    expect(oneDecimal(saltGrams(3.5, b.grams))).toBe('15.7')
    expect(saltLiveWords({ pct: 3.5, base: 'all', baseG: b.grams })).toBe('3.5% of veg + water (448 g) → 15.7 g salt')
  })

  it('Petri card: aimed 3.5%, grams edited to 13.5 → "aimed 3.5% · put in 13.5 g = 3.0% of 448 g"', () => {
    const line = { role: 'salt', qty: '13.5', qty_unit: 'g', salt_pct: '3.5', salt_base: 'all', base_g: '448', salt_method: 'brine' }
    expect(saltLineWords(line)).toBe('Brine · aimed 3.5% · put in 13.5 g = 3.0% of 448 g')
  })

  it('Settlers: Veg only is 152 g (sugar in), 3% → 4.56 g; the card\'s 4.5 g reads 3.0%', () => {
    const b = saltBase(SETTLERS, 'produce')
    expect(b.grams).toBe(152)
    expect(saltGrams(3, 152)).toBeCloseTo(4.56, 10)
    expect(oneDecimal(actualPct(4.5, 152))).toBe('3.0')
    expect(actualPct(4.5, 152)).toBeCloseTo(2.96, 2)
  })

  it('Kraut: cabbage 1,000 g, 2% of Veg only → 20.0 g', () => {
    expect(oneDecimal(saltGrams(2, saltBase([L('cabbage', '1000', 'g')], 'produce').grams))).toBe('20.0')
  })

  it('Kimchi: the paste is 1% of 1,870 g → 18.7 g; fish sauce has no weight; the soak is its own typed base', () => {
    const b = saltBase(KIMCHI, 'produce')
    expect(b.grams).toBe(1870)
    expect(b.no_weight).toEqual(['fish sauce'])
    expect(oneDecimal(saltGrams(1, b.grams))).toBe('18.7')
    const rinsed = { role: 'salt', qty: '200', qty_unit: 'g', salt_pct: '10', salt_base: 'water', base_g: '2000', salt_method: 'rinsed', base_from: 'scale' }
    expect(saltLineWords(rinsed)).toBe("Salted then rinsed · 10% of 2,000 g soak water · put in 200.0 g · soaked, then rinsed off, so not what's in the jar")
    // …and the soak water is in no base (it is never a line).
    expect(saltBase(KIMCHI, 'all').grams).toBe(1870)
  })

  it('Appendix C: 2.5% of Veg only → base 800, 20.0 g; "no weight: onion, garlic"', () => {
    const b = saltBase(APPENDIX_C, 'produce')
    expect(b.grams).toBe(800)
    expect(oneDecimal(saltGrams(2.5, b.grams))).toBe('20.0')
    expect(saltAsideWords(b)).toBe('no weight: onion, garlic')
  })

  it('water is left out of Veg only and named; Water only leaves the veg out', () => {
    expect(saltAsideWords(saltBase(PETRI, 'produce'))).toBe('left out: Water')
    expect(saltBase(PETRI, 'water').grams).toBe(250)
    expect(saltAsideWords(saltBase(PETRI, 'water'))).toBe('left out: jalapeño, garlic, onion')
  })

  it('a salt line and a sitting line are in no base', () => {
    expect(saltBase([...PETRI, L('Salt', '15.68', 'g', { role: 'salt' }), L('vinegar', '35', 'g', { put_up_stage_id: 'ksl-1' })], 'all').grams).toBe(448)
  })

  it('parses a typed percent and refuses a nonsense one', () => {
    expect(parsePct('3.5')).toBe(3.5); expect(parsePct(' 3,5 % ')).toBe(3.5)
    expect(parsePct('0')).toBeNull(); expect(parsePct('101')).toBeNull(); expect(parsePct('abc')).toBeNull()
  })
})

describe('units (06 §5.3 units row, §3.3)', () => {
  it('0.5 oz counts as 14.17 g; vinegar in ml has no weight; only a water line converts volume', () => {
    expect(gramsOf('0.5', 'oz')).toBeCloseTo(14.17, 2)
    expect(gramsOf('30', 'ml')).toBeNull()
    expect(gramsOf('30', 'ml', { water: true })).toBe(30)
    expect(gramsOf('1', 'qt', { water: true })).toBeCloseTo(946.353, 3)
  })
  it('the "About" placeholder is the weighed sum of what went in (water in, salt and sitting lines out)', () => {
    expect(aboutPlaceholderGrams([...PETRI, L('Salt', '15.68', 'g', { role: 'salt' })])).toBe(448)
    expect(aboutPlaceholderGrams([L('onion', null, null)])).toBeNull()
  })
})

describe('heat words (06 §2.6.5) — golden table', () => {
  it('two significant figures, "est." always, k once when both ends share it', () => {
    expect(shuRangeWords(949, 3036)).toBe('est. 950–3.0k SHU')
    expect(shuRangeWords(1660, 5313)).toBe('est. 1.7–5.3k SHU')
    expect(shuRangeWords(15991, 22996)).toBe('est. 16–23k SHU')
    expect(shuRangeWords(3036, 3036)).toBe('est. 3.0k SHU')
    expect(shuRangeWords(3036, null)).toBe('est. 3.0k SHU')
    expect(formatShu(0)).toBe('0')
    expect(formatShu(1641183)).toBe('1.6M')
  })
  // NEVER 0 FROM ABSENCE (06 §2.6.2): no figure is no words, not "0".
  it('no figure → null, never "est. 0"', () => {
    expect(shuRangeWords(null, null)).toBeNull()
    expect(shuRangeWords('', '')).toBeNull()
    expect(shuRangeWords(0, 0)).toBe('est. 0 SHU')
  })
  it('a typed listed heat parses a range or one number; 0 is a rating', () => {
    expect(parseRating('2,500–8,000')).toEqual({ low: 2500, high: 8000 })
    expect(parseRating('2500-8000')).toEqual({ low: 2500, high: 8000 })
    expect(parseRating('30k')).toEqual({ low: 30000, high: 30000 })
    expect(parseRating('0')).toEqual({ low: 0, high: 0 })
    expect(parseRating('')).toBeNull()
    expect(parseRating('hot').error).toBeTruthy()
  })
})

describe('lines — the four ways in, as bodies (contract-F §2.2)', () => {
  const key = 'k-1'
  const MEGATRON = { plant_id: 'p-mega', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v-mega',
    recent_picks: [{ harvest_log_id: 'h-1', picked_on: '2026-09-27', qty: '412', qty_unit: 'g' }] }
  const REAPER_BAG = { preservation_log_id: 'j-reaper', label: 'Reaper, frozen', stock_mode: 'weighed', quantity_value: '100', quantity_unit: 'g', package_count: 1, remaining_amount: '100' }
  const CARROT_BAGS = { preservation_log_id: 'j-carrot', label: 'Carrots', stock_mode: 'counted', quantity_value: '3', quantity_unit: 'lb', package_count: 4, remaining_count: 4 }

  it('a planting with no pick is a garden line; with a pick it is a harvest line', () => {
    const d = { ...emptyDraft(key), source: { kind: 'planting', hit: MEGATRON, pickId: null }, qty: '412', unit: 'g', form: 'fresh' }
    expect(lineBody(d, { ordinal: 3 }).body).toEqual({ idempotency_key: key, input_kind: 'garden', plant_id: 'p-mega',
      label: 'Megatron jalapeño', crop_type_slug: 'pepper', qty: '412', qty_unit: 'g', form: 'fresh', ordinal: 3 })
    const withPick = lineBody({ ...d, source: { ...d.source, pickId: 'h-1' } }).body
    expect(withPick.input_kind).toBe('harvest'); expect(withPick.harvest_log_id).toBe('h-1'); expect(withPick.plant_id).toBeUndefined()
  })

  // MUTATION: send count_drawn on a weighed bag -> the route 400s it; this literal reds.
  it('a weighed bag is drawn in grams (no count); a counted jar by count, grams optional', () => {
    const w = lineBody({ ...emptyDraft(key), source: { kind: 'jar', hit: REAPER_BAG }, qty: '8', unit: 'g' }).body
    expect(w).toEqual({ idempotency_key: key, input_kind: 'put_up', preservation_log_id: 'j-reaper', label: 'Reaper, frozen', qty: '8', qty_unit: 'g' })
    expect(lineBody({ ...emptyDraft(key), source: { kind: 'jar', hit: REAPER_BAG } })).toEqual({ error: LINE_ERRORS.weighed, field: 'qty' })
    expect(lineBody({ ...emptyDraft(key), source: { kind: 'jar', hit: REAPER_BAG }, qty: '8', unit: 'ml' })).toEqual({ error: LINE_ERRORS.weighedUnit, field: 'unit' })
    const c = lineBody({ ...emptyDraft(key), source: { kind: 'jar', hit: CARROT_BAGS }, qty: '150', unit: 'g' }).body
    expect(c.count_drawn).toBe(1); expect(c.qty).toBe('150')
    expect(lineBody({ ...emptyDraft(key), source: { kind: 'jar', hit: CARROT_BAGS }, countDrawn: '0' }).error).toBe(LINE_ERRORS.count)
    expect(gramsLeftAfter(REAPER_BAG, '8', 'g')).toBe(92)
    expect(jarHitWords(REAPER_BAG)).toBe('Reaper, frozen · about 100 g left')
    expect(jarHitWords(CARROT_BAGS)).toBe('Carrots · 4 left')
  })

  it('a typed name is kept; an amount with no unit is refused inline, naming the number', () => {
    expect(lineBody({ ...emptyDraft(key, { unit: null }), label: 'onion' }).body).toEqual({ idempotency_key: key, input_kind: 'other', label: 'onion' })
    expect(lineBody({ ...emptyDraft(key, { unit: null }), label: 'garlic', qty: '412' })).toEqual({ error: unitNeeded('412'), field: 'unit' })
    expect(unitNeeded(' 412 ')).toBe('Pick a unit for 412')
    expect(lineBody({ ...emptyDraft(key), label: '  ' })).toEqual({ error: LINE_ERRORS.name, field: 'name' })
  })

  it('[Water] is a typed line with the water role and ml preselected; it takes no form or heat', () => {
    const d = { ...emptyDraft(key, { role: 'water', label: 'Water' }), qty: '800', form: 'fresh', rating: '10' }
    expect(d.unit).toBe('ml')
    expect(lineBody(d).body).toEqual({ idempotency_key: key, input_kind: 'other', label: 'Water', qty: '800', qty_unit: 'ml', role: 'water' })
    expect(addedWords(lineBody(d).body)).toBe('Added · Water 800 ml')
  })

  // Dave 17:1x: a typed rating on a dried chili is the FRESH pepper's; it is stored as typed.
  it('a typed listed heat is sent as typed — never scaled for dried', () => {
    const b = lineBody({ ...emptyDraft(key), label: 'gochugaru', qty: '40', unit: 'g', form: 'dried', rating: '4000–8000' }).body
    expect(b.shu_rating_low).toBe(4000); expect(b.shu_rating_high).toBe(8000); expect(b.form).toBe('dried')
  })

  it('Listed heat is offered on a typed line, or once a form is set, but not on a variety with a rating to fall back on', () => {
    expect(offerListedHeat(emptyDraft(key))).toBe(true)
    expect(offerListedHeat({ ...emptyDraft(key), source: { kind: 'planting', hit: MEGATRON } })).toBe(false)
    expect(offerListedHeat({ ...emptyDraft(key), source: { kind: 'planting', hit: MEGATRON }, form: 'fresh' })).toBe(true)
    expect(offerListedHeat(emptyDraft(key, { role: 'water' }))).toBe(false)
  })

  it('says a line in words: amount, form, brand, draw count; a typed 0 is "counted as 0"', () => {
    expect(lineWords({ label: 'Megatron jalapeño', qty: '412.000', qty_unit: 'g', form: 'fresh' })).toBe('Megatron jalapeño · 412 g · fresh')
    expect(lineWords({ label: 'Carrots', input_kind: 'put_up', count_drawn: 1, qty: '150', qty_unit: 'g' })).toBe('Carrots · 1 used · 150 g')
    expect(lineWords({ label: 'Gochugaru', qty: '40', qty_unit: 'g', form: 'dried', brand: 'Taekyung', shu_rating_low: 4000, shu_rating_high: 8000 }))
      .toBe('Gochugaru · 40 g · dried · Taekyung · listed 4,000–8,000 SHU')
    expect(lineWords({ label: 'Sweet pepper', qty: '100', qty_unit: 'g', shu_rating_low: 0, shu_rating_high: 0 })).toBe('Sweet pepper · 100 g · counted as 0')
  })

  it('the unit preselect, the next ordinal, the legacy test and the search URL', () => {
    expect(defaultUnit([])).toBe('g')
    expect(defaultUnit([{ qty_unit: 'oz', added_at: '2026-09-01' }, { qty_unit: 'lb', added_at: '2026-09-02' }])).toBe('lb')
    expect(nextOrdinal([{ ordinal: null }, { ordinal: 2 }, { ordinal: 5 }])).toBe(6)
    expect(nextOrdinal([])).toBe(1)
    expect(isLegacyPick({ input_kind: 'harvest', ordinal: null })).toBe(true)
    expect(isLegacyPick({ input_kind: 'harvest', ordinal: 4 })).toBe(false)
    expect(lineSearchUrl(' reaper & co ')).toBe('/api/kitchen-batches/line-search?q=reaper%20%26%20co')
  })

  it('a line edit sends only what changed, the amount as a pair, and the values Undo sends back', () => {
    const stored = { label: 'Water', qty: '800.000', qty_unit: 'ml', note: null, role: 'water' }
    const r = linePatch(stored, { label: 'Water', qty: '750', qty_unit: 'ml', note: 'filtered' })
    expect(r.patch).toEqual({ qty: '750', qty_unit: 'ml', note: 'filtered' })
    expect(r.undo).toEqual({ qty: '800.000', qty_unit: 'ml', note: null })
    expect(linePatch(stored, { label: 'Water', qty: '800', qty_unit: 'ml' }).changed).toBe(false)
  })

  it('the act words are Dave\'s (16:30) and the base chips are the design\'s', () => {
    expect(Object.values(ACT_LABELS)).toEqual(['Topped up brine', 'Pushed it back under', 'Skimmed the top'])
    expect(Object.values(SALT_BASE_LABELS)).toEqual(['Veg only', 'Veg + water', 'Water only'])
  })
})
