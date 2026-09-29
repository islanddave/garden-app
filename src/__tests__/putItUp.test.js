// Put-Up release 1b (V4 §2.4, §3.1–§3.6) — the pure half of Put it up (putItUp.js) and the jar words
// every surface shares (jarWords.js). Instants are local-time literals, never derived from the
// function under test, so either half can red alone. CI LANE: `npm test` plus the blocking TZ re-run.
import { describe, it, expect } from 'vitest'
import {
  estimateChips, preselectWhen, notSureDate, resolveWhen, methodChipsForKind, METHOD_LABELS, ALL_PUT_UP_METHODS,
  placeChips, newRow, effectiveRows, rowSummary, rowCount, previewDiscard, groupPreviews, putUpBody, labelHint,
  completionStub, containerChoices, CONTAINER_PRESETS, WHEN_ERRORS,
} from '../components/putup/putItUp.js'
import {
  putUpDateWords, discardWords, basisWords, sizeWords, countedSize, METHOD_WORDS, KIND_WORDS, qtyText, totalOfEach,
} from '../components/putup/jarWords.js'
import { VALID_METHODS } from '../../lambda/preservation/jarRules.js'

const NOW = new Date(2026, 8, 29, 15, 0)   // Tue Sep 29 2026, 3 pm local
const BANNED = /\bsafe\b|shelf.life|shelf.stable|\bkeeps\b|\bgood\b|\bready\b|\bdone\b|\bexpired\b|\btable\b|\bdefault\b|\bbasis\b/i

const fridge = { key: 'id:p1', id: 'p1', label: 'Fridge', kind: 'fridge' }
const chest = { key: 'id:p2', id: 'p2', label: 'Chest Freezer 1', kind: 'deep_freezer' }
const woozy = CONTAINER_PRESETS.find(c => c.label === '8 oz woozy')

describe('When — the estimate chips are windows from today (§3.6)', () => {
  it('on Sep 29 2026 offers six, each storing its window start and one precision word', () => {
    expect(estimateChips(NOW).map(c => [c.id, c.start ? c.start.toDateString() : null, c.precision])).toEqual([
      ['this_month', 'Tue Sep 01 2026', 'month'],
      ['last_month', 'Sat Aug 01 2026', 'month'],
      ['two_three', 'Mon Jun 01 2026', 'season'],
      ['earlier_year', 'Thu Jan 01 2026', 'year'],
      ['last_year', 'Wed Jan 01 2025', 'year'],
      ['pickdate', null, 'day'],
    ])
  })
  it('hides "Earlier this year" when 2–3 months ago already reaches January', () => {
    const ids = estimateChips(new Date(2026, 2, 15)).map(c => c.id)
    expect(ids).toEqual(['this_month', 'last_month', 'two_three', 'last_year', 'pickdate'])
    // …and shows it one month later (the window Jan 1 → Feb 1 is not empty).
    expect(estimateChips(new Date(2026, 4, 2)).map(c => c.id)).toContain('earlier_year')
  })
})

describe('When — preselect and resolve (§2.4)', () => {
  it('preselects Today only when the batch was started or last checked today', () => {
    expect(preselectWhen({ started_at: new Date(2026, 8, 29, 8).toISOString() }, NOW)).toBe('today')
    expect(preselectWhen({ started_at: new Date(2026, 8, 20).toISOString(),
      current_stage_entered_at: new Date(2026, 8, 29, 7).toISOString() }, NOW)).toBe('today')
    expect(preselectWhen({ started_at: new Date(2026, 8, 20).toISOString(),
      current_stage_entered_at: new Date(2026, 8, 28, 23).toISOString() }, NOW)).toBeNull()
    expect(preselectWhen({ started_at: null }, NOW)).toBeNull()
  })

  it('Today and Yesterday are days; an estimate stores its window start', () => {
    expect(resolveWhen({ chip: 'today', now: NOW }).when).toEqual({ date: '2026-09-29', precision: 'day' })
    expect(resolveWhen({ chip: 'yesterday', now: NOW }).when).toEqual({ date: '2026-09-28', precision: 'day' })
    const lm = resolveWhen({ chip: 'earlier', estimate: 'last_month', now: NOW })
    expect(lm.when).toEqual({ date: '2026-08-01', precision: 'month' })
    expect(lm.words).toBe('sometime in August')
    expect(resolveWhen({ chip: 'earlier', estimate: 'two_three', now: NOW }).words).toBe('sometime in Jun–Jul')
  })

  it('Not sure goes on the wire as unknown with no date; its anchor is the latest dated event, never before the start', () => {
    const batch = { started_at: new Date(2026, 8, 1, 9).toISOString(), current_stage_entered_at: new Date(2026, 8, 12, 9).toISOString() }
    expect(notSureDate(batch)).toBe('2026-09-12')
    const r = resolveWhen({ chip: 'unsure', batch, now: NOW })
    // The wire says unknown with no date (the 1b Lambda refuses 'after' there and resolves the day
    // itself); the preview counts from the same earliest day, precision after.
    expect(r.when).toEqual({ date: null, precision: 'unknown' })
    expect(r.anchor).toEqual({ date: '2026-09-12', precision: 'after' })
    expect(r.words).toBe('sometime after Sep 12 — the last date we have')
    // A stage row dated before the start (a mis-typed check-in) never pulls the date earlier.
    expect(notSureDate({ started_at: new Date(2026, 8, 5).toISOString(), current_stage_entered_at: new Date(2026, 7, 1).toISOString() }))
      .toBe('2026-09-05')
  })

  it('refuses the half-answers rather than inventing a day', () => {
    expect(resolveWhen({ chip: 'unsure', batch: { started_at: null }, now: NOW }).error).toBe(WHEN_ERRORS.unsure)
    expect(resolveWhen({ chip: 'earlier', now: NOW }).error).toBe(WHEN_ERRORS.earlier)
    expect(resolveWhen({ chip: 'earlier', estimate: 'pickdate', pickedDate: '', now: NOW }).error).toBe(WHEN_ERRORS.pickdate)
    expect(resolveWhen({ chip: 'earlier', estimate: 'pickdate', pickedDate: '2026-09-30', now: NOW }).error).toBe(WHEN_ERRORS.future)
    expect(resolveWhen({ chip: 'earlier', estimate: 'pickdate', pickedDate: '2026-09-29', now: NOW }).when)
      .toEqual({ date: '2026-09-29', precision: 'day' })
    expect(resolveWhen({ chip: null, now: NOW }).error).toBe(WHEN_ERRORS.none)
  })
})

describe('What it is now — method chips by kind (Appendix B)', () => {
  it('offers the kind\'s ≤ 4 chips with More…, and the full list with no kind', () => {
    expect(methodChipsForKind('ferment')).toEqual({ chips: ['hot_sauce', 'ferment_mash', 'ferment', 'other'], more: true })
    expect(methodChipsForKind('dehydrate').chips).toEqual(['dehydrate', 'powder', 'other'])
    expect(methodChipsForKind('candy').chips).toEqual(['candy', 'jam_preserve', 'can_water_bath', 'quick_pickle'])
    expect(methodChipsForKind('cure').chips).toEqual(['cure_store', 'cold_store', 'other'])
    expect(methodChipsForKind('infuse').chips).toEqual(['other'])
    for (const k of [null, undefined, 'other', 'age']) expect(methodChipsForKind(k)).toEqual({ chips: ALL_PUT_UP_METHODS, more: false })
    for (const k of ['ferment', 'dehydrate', 'candy', 'cure', 'infuse']) expect(methodChipsForKind(k).chips.length).toBeLessThanOrEqual(4)
  })

  it('names every method the Lambda accepts (parity with jarRules VALID_METHODS)', () => {
    expect(Object.keys(METHOD_LABELS).sort()).toEqual([...VALID_METHODS].sort())
    expect(Object.keys(METHOD_WORDS).sort()).toEqual([...VALID_METHODS].sort())
    expect(ALL_PUT_UP_METHODS).not.toContain('purchased_preserved')
  })
})

describe('places and rows', () => {
  it('lists own places by label, then a template only for a kind with no place', () => {
    const chips = placeChips([{ id: 'b', label: 'Meat deep freezer', kind: 'deep_freezer' }, { id: 'a', label: 'Chest Freezer 1', kind: 'deep_freezer' }])
    expect(chips.map(c => c.label)).toEqual(['Chest Freezer 1', 'Meat deep freezer', 'Fridge', 'Pantry shelf', 'Counter'])
    expect(chips[2]).toEqual({ key: 'new:fridge:fridge', id: null, label: 'Fridge', kind: 'fridge' })
  })

  it('rows 2..N inherit container and place live from the row above', () => {
    const r1 = { ...newRow(), container: woozy, place: fridge }
    const r2 = newRow(r1)
    expect(r2.inherit).toBe(true)
    expect(effectiveRows([r1, r2])[1].place).toBe(fridge)
    // Row 1 changes place → the inheriting row follows it.
    expect(effectiveRows([{ ...r1, place: chest }, r2])[1].place).toBe(chest)
    expect(rowSummary(effectiveRows([{ ...r1, count: '2' }, r2])[0])).toBe('2 × 8 oz woozy · Fridge')
  })

  it('a count mid-edit ("" or 0) sends 1; containers de-duplicate past labels', () => {
    expect(rowCount({ count: '' })).toBe(1)
    expect(rowCount({ count: '0' })).toBe(1)
    expect(rowCount({ count: '3' })).toBe(3)
    expect(containerChoices(['Pint', 'Swing-top', ' swing-top ']).map(c => c.label).slice(-1)).toEqual(['Swing-top'])
  })
})

describe('the discard-by preview (§3.1, §3.3)', () => {
  const when = { date: '2026-09-29', precision: 'day' }
  it('comes from the engine, with the general figure words', () => {
    const p = previewDiscard({ row: { ...newRow(), place: fridge }, method: 'hot_sauce', when, now: NOW })
    expect(p).toEqual({ date: '2027-03-29', basis: 'table', words: 'discard by Mar 29, 2027 · general figure: hot sauce, fridge' })
  })
  it('an estimated put-up date renders "around"', () => {
    const p = previewDiscard({ row: { ...newRow(), place: fridge }, method: 'hot_sauce', when: { date: '2026-08-01', precision: 'month' }, now: NOW })
    expect(p.words).toBe('discard by around Feb 1, 2027 · general figure: hot sauce, fridge')
  })
  it('Raw or In oil anywhere but a freezer gets no date; at a freezer the freezer leg applies', () => {
    expect(previewDiscard({ row: { ...newRow(), place: fridge, isRaw: true }, method: 'hot_sauce', when, now: NOW }).basis).toBe('none')
    expect(previewDiscard({ row: { ...newRow(), place: fridge, inOil: true }, method: 'hot_sauce', when, now: NOW }).words)
      .toBe('no date — check it before using')
    expect(previewDiscard({ row: { ...newRow(), place: chest, inOil: true }, method: 'hot_sauce', when, now: NOW }).basis).toBe('table')
  })
  it('dried and Bends or Still soft → no date; Snaps keeps the figure', () => {
    const pantry = { key: 'new:pantry:pantry shelf', id: null, label: 'Pantry shelf', kind: 'pantry' }
    expect(previewDiscard({ row: { ...newRow(), place: pantry, texture: 'bends' }, method: 'dehydrate', when, now: NOW }).basis).toBe('none')
    expect(previewDiscard({ row: { ...newRow(), place: pantry, texture: 'still_soft' }, method: 'dehydrate', when, now: NOW }).basis).toBe('none')
    expect(previewDiscard({ row: { ...newRow(), place: pantry, texture: 'snaps' }, method: 'dehydrate', when, now: NOW }).basis).not.toBe('none')
  })
  it('cured or cellared produce with an estimated date gets no date; with a day it does', () => {
    const pantry = { key: 'new:pantry:pantry shelf', id: null, label: 'Pantry shelf', kind: 'pantry' }
    expect(previewDiscard({ row: { ...newRow(), place: pantry }, method: 'cure_store', when: { date: '2026-08-01', precision: 'month' }, now: NOW }).basis).toBe('none')
    expect(previewDiscard({ row: { ...newRow(), place: pantry }, method: 'cure_store', when, now: NOW }).basis).toBe('table')
  })
  it('Raw on a method that does not offer it is not counted (the chip was never shown)', () => {
    expect(previewDiscard({ row: { ...newRow(), place: fridge, isRaw: true }, method: 'ferment', when, now: NOW }).basis).toBe('table')
  })
  it('typed beats the engine; "No date" is typed with no date', () => {
    const typed = previewDiscard({ row: { ...newRow(), place: fridge, discard: { mode: 'date', date: '2026-12-08' } }, method: 'hot_sauce', when, now: NOW })
    expect(typed).toEqual({ date: '2026-12-08', basis: 'typed', words: 'discard by Dec 8 · set by hand' })
    expect(previewDiscard({ row: { ...newRow(), place: fridge, discard: { mode: 'none', date: '' } }, method: 'hot_sauce', when, now: NOW }))
      .toEqual({ date: null, basis: 'typed', words: 'no date · set by hand' })
  })
  it('groups rows with the same words into one line', () => {
    expect(groupPreviews([{ words: 'a' }, { words: 'b' }, { words: 'a' }, null])).toEqual([{ words: 'a', rows: [1, 3] }, { words: 'b', rows: [2] }])
  })
})

describe('the one body (§5.1)', () => {
  const batch = { id: 'kb1', label: 'Megatron mash' }
  const when = { date: '2026-09-29', precision: 'day' }
  const key = '11111111-2222-4333-8444-555555555555'

  it('refuses only the three required answers, in order', () => {
    expect(putUpBody({ key, when: null, method: 'hot_sauce', rows: [newRow()], batch }).field).toBe('when')
    expect(putUpBody({ key, when, method: null, rows: [newRow()], batch }).field).toBe('method')
    expect(putUpBody({ key, when, method: 'hot_sauce', rows: [newRow()], batch })).toEqual({ error: 'Where is it going? Pick a place.', field: 'place', row: 0 })
  })

  it('sends the minimum: an absent key for every unanswered question', () => {
    const { body } = putUpBody({ key, when, method: 'hot_sauce', rows: [{ ...newRow(), place: fridge }], finish: true, batch })
    expect(body).toEqual({ idempotency_key: key, when, method: 'hot_sauce', rows: [{ count: 1, place: { id: 'p1' } }], finish: true })
  })

  it('writes Appendix C\'s two rows, the second inheriting container and place', () => {
    const r1 = { ...newRow(), count: '2', container: woozy, place: { key: 'new:fridge:fridge', id: null, label: 'Fridge', kind: 'fridge' }, name: 'Megatron plain', ph: '3.7' }
    const r2 = { ...newRow(r1), count: '2', name: 'Megatron reaper', ph: '3.7',
      lines: [{ key: 'k-reaper', label: 'reaper', qty: '5', unit: 'g' }, { key: 'k-vinegar', label: 'vinegar', qty: '72', unit: 'g' }],
      discard: { mode: 'date', date: '2026-12-08' } }
    const { body } = putUpBody({ key, when, method: 'hot_sauce', rows: [r1, r2], madeG: '910', nextTime: 'more carrot', finish: true, batch })
    expect(body.rows).toEqual([
      { count: 2, place: { kind: 'fridge', label: 'Fridge' }, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz', name: 'Megatron plain', ph: '3.7' },
      { count: 2, place: { kind: 'fridge', label: 'Fridge' }, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz', name: 'Megatron reaper', ph: '3.7',
        discard_by: '2026-12-08', added_lines: [{ input_kind: 'other', idempotency_key: 'k-reaper', label: 'reaper', qty: '5', qty_unit: 'g' },
          { input_kind: 'other', idempotency_key: 'k-vinegar', label: 'vinegar', qty: '72', qty_unit: 'g' }] },
    ])
    expect(body.made_g).toBe('910')
    expect(body.next_time).toBe('more carrot')
  })

  it('asks only what the method allows: Raw, texture and pH are dropped elsewhere; the batch label is not a name', () => {
    const row = { ...newRow(), place: fridge, isRaw: true, inOil: true, texture: 'bends', ph: '3.5', name: 'Megatron mash' }
    const { body } = putUpBody({ key, when, method: 'whole_freeze', rows: [row], batch })
    expect(body.rows[0]).toEqual({ count: 1, place: { id: 'p1' }, in_oil: true })
    const hs = putUpBody({ key, when, method: 'hot_sauce', rows: [row], batch }).body.rows[0]
    expect(hs).toEqual({ count: 1, place: { id: 'p1' }, is_raw: true, in_oil: true, ph: '3.5' })
    expect(putUpBody({ key, when, method: 'dehydrate', rows: [row], batch }).body.rows[0].texture).toBe('bends')
  })

  it('a line with no key of its own is refused rather than sent unkeyed (contract-F §2.2)', () => {
    expect(putUpBody({ key, when, method: 'hot_sauce', rows: [{ ...newRow(), place: fridge, lines: [{ label: 'salt', qty: '', unit: 'g' }] }], batch }).field).toBe('lines')
    expect(putUpBody({ key, when, method: 'hot_sauce', rows: [{ ...newRow(), place: fridge }], sittingLines: [{ label: 'vinegar' }], batch }).field).toBe('lines')
  })

  it('pH is sent as the typed string, never through a Number', () => {
    const { body } = putUpBody({ key, when, method: 'ferment', rows: [{ ...newRow(), place: fridge, ph: '3.80' }], batch })
    expect(body.rows[0].ph).toBe('3.80')
  })

  it('"No date" is sent as discard_by "none"; a half-picked label date is refused', () => {
    expect(putUpBody({ key, when, method: 'hot_sauce', rows: [{ ...newRow(), place: fridge, discard: { mode: 'none', date: '' } }], batch }).body.rows[0].discard_by).toBe('none')
    expect(putUpBody({ key, when, method: 'hot_sauce', rows: [{ ...newRow(), place: fridge, discard: { mode: 'date', date: '' } }], batch }).field).toBe('discard')
  })
})

describe('completion words (§2.4)', () => {
  it('the label hint names the discard date only for a typed or recipe basis', () => {
    const jar = { label: 'Megatron reaper', preserved_at: '2026-10-08', preserved_at_precision: 'day', use_by_target: '2026-12-08', use_by_basis: 'typed' }
    expect(labelHint(jar, NOW)).toBe("Write 'Megatron reaper · Oct 8 · discard Dec 8' on the label")
    expect(labelHint({ ...jar, use_by_basis: 'table' }, NOW)).toBe("Write 'Megatron reaper · Oct 8' on the label")
    expect(labelHint({ ...jar, preserved_at_precision: 'after', use_by_basis: 'recipe' }, NOW))
      .toBe("Write 'Megatron reaper · sometime after Oct 8 · discard around Dec 8' on the label")
  })
  it('the stub names every row and the first jar\'s label hint', () => {
    const r1 = { ...newRow(), count: '2', container: woozy, place: fridge }
    const stub = completionStub({ batch: { label: 'Megatron mash' }, rows: [r1, newRow(r1)],
      jars: [{ label: 'Megatron mash', preserved_at: '2026-10-08', preserved_at_precision: 'day', use_by_target: '2026-12-08', use_by_basis: 'typed' }], now: NOW })
    expect(stub).toBe("Megatron mash — put up · 2 × 8 oz woozy · Fridge · 1 × 8 oz woozy · Fridge · Write 'Megatron mash · Oct 8 · discard Dec 8' on the label")
  })
})

describe('jar words (§3.2, §3.6)', () => {
  it('a put-up date at each precision, never an invented day', () => {
    expect(putUpDateWords('2026-08-01', 'month', { now: NOW })).toBe('sometime in August')
    expect(putUpDateWords('2025-11-01', 'season', { now: NOW })).toBe('sometime in Nov–Dec 2025')
    expect(putUpDateWords('2025-01-01', 'year', { now: NOW })).toBe('in 2025')
    expect(putUpDateWords('2026-09-01', 'after', { now: NOW })).toBe('sometime after Sep 1')
    expect(putUpDateWords('2026-09-29', 'unknown', { now: NOW })).toBe('not sure')
    expect(putUpDateWords('2026-09-03', 'day', { now: NOW })).toBe('Sep 3')
    // A pre-1b row: NULL precision renders as it always did.
    expect(putUpDateWords('2026-09-03', null, { approx: true, now: NOW })).toBe('around Sep 3')
    expect(putUpDateWords('2026-09-03', null, { now: NOW })).toBe('Sep 3')
  })

  it('the discard chip, stated once, in every state', () => {
    const base = { date: '2027-03-29', basis: 'table', method: 'hot_sauce', kind: 'fridge', now: NOW }
    expect(discardWords(base)).toBe('discard by Mar 29, 2027 · general figure: hot sauce, fridge')
    expect(discardWords({ ...base, status: 'use_soon' })).toBe('discard by Mar 29, 2027 · general figure: hot sauce, fridge · soon')
    expect(discardWords({ ...base, status: 'past_use_by' })).toBe('discard date passed Mar 29, 2027 · general figure: hot sauce, fridge')
    expect(discardWords({ ...base, method: 'cure_store', kind: 'pantry', basis: 'table' })).toBe('use by Mar 29, 2027 · general figure: cure & store, pantry shelf')
    expect(discardWords({ ...base, estimated: true })).toBe('discard by around Mar 29, 2027 · general figure: hot sauce, fridge')
    expect(discardWords({ ...base, basis: 'typed', estimated: true })).toBe('discard by Mar 29, 2027 · set by hand')
    expect(discardWords({ date: null, basis: 'typed' })).toBe('no date · set by hand')
    expect(discardWords({ date: null, basis: 'none' })).toBe('no date — check it before using')
    expect(discardWords({ date: null, basis: null })).toBeNull()
  })

  // Contract-F A3: quantity_value is the TOTAL. MUTATION: render a bare quantity as `${n} × ${q}` ->
  // the zucchini literal reds (it would read as three 2.5-qt bags).
  it('A3: a bare quantity is a total — the zucchini (2.5 qt, 3 containers) never reads "3 × 2.5 qt"', () => {
    const ZUCCHINI = { quantity_value: '2.5', quantity_unit: 'qt', package_count: 3, container_label: null }
    expect(countedSize(3, ZUCCHINI)).toBe('3 containers · 2.5 qt in all')
    expect(sizeWords(ZUCCHINI)).toBe('2.5 qt in all')
    expect(countedSize(1, { ...ZUCCHINI, package_count: 1 })).toBe('2.5 qt')
    expect(sizeWords({ ...ZUCCHINI, package_count: 1 })).toBe('2.5 qt')
    // A container that says its own size keeps the per-container form, and the total is not repeated.
    expect(countedSize(2, { quantity_value: '16', quantity_unit: 'fl oz', container_label: '8 oz woozy' })).toBe('2 × 8 oz woozy')
    // A container with no size of its own keeps its count and still says the total.
    expect(countedSize(3, { quantity_value: '2', quantity_unit: 'lb', container_label: 'bag' })).toBe('3 × bag · 2 lb in all')
    for (const out of [countedSize(3, ZUCCHINI), sizeWords(ZUCCHINI)]) expect(out).not.toMatch(/\d\s*×\s*2\.5/)
  })

  // numeric(10,2) comes back "2.50" / "2.00": said "2.5" / "2". MUTATION: drop qtyText from sizeWords
  // or countedSize -> the driver-shaped arms red.
  it('says a quantity the way it reads, not the way the column pads it', () => {
    expect(qtyText('2.50')).toBe('2.5')
    expect(qtyText('2.00')).toBe('2')
    expect(qtyText('16')).toBe('16')
    expect(qtyText('0.70')).toBe('0.7')
    expect(qtyText(2.49)).toBe('2.49')
    expect(qtyText('about 2')).toBe('about 2')
    expect(qtyText(null)).toBe('')
    expect(sizeWords({ quantity_value: '2.50', quantity_unit: 'qt', package_count: 3 })).toBe('2.5 qt in all')
    expect(countedSize(2, { quantity_value: '2.00', quantity_unit: 'lb' })).toBe('2 containers · 2 lb in all')
  })

  // The walk's "How big is each?" (A3): the TOTAL is each × how many, in decimal, never float, rounded to
  // the column's two places. MUTATION: compute it as Number(each) * count -> the 0.83 arm reads
  // 2.4899999999999998; round each before multiplying -> the 0.333 arm reads 0.99.
  it('a walk item\'s total is each × how many, decimal-safe', () => {
    expect(totalOfEach('0.83', 3)).toBe('2.49')
    expect(totalOfEach('1', 2)).toBe('2')
    expect(totalOfEach('2.5', 3)).toBe('7.5')
    expect(totalOfEach('.5', 4)).toBe('2')
    expect(totalOfEach('0.333', 3)).toBe('1')          // 0.999 → 1.00 at two places
    expect(totalOfEach('1.005', 1)).toBe('1.01')       // half-up on the exact digits (float would say 1)
    expect(totalOfEach('12', 1)).toBe('12')
    for (const bad of ['', '0', '1e3', 'abc', '-1', '.']) expect(totalOfEach(bad, 3)).toBeNull()
    for (const n of [0, 1.5, -2, '']) expect(totalOfEach('1', n)).toBeNull()
  })

  it('a jar with no size reads as its container or as nothing — never null or 0', () => {
    expect(sizeWords({ quantity_value: null, quantity_unit: null, container_label: null })).toBe('')
    expect(sizeWords({ quantity_value: '2.5', quantity_unit: 'qt' })).toBe('2.5 qt')
    expect(sizeWords({ quantity_value: 8, quantity_unit: 'fl oz', container_label: '8 oz woozy' })).toBe('8 oz woozy')
    expect(countedSize(3, {})).toBe('3 containers')
    expect(countedSize(1, { container_label: 'bag' })).toBe('1 × bag')
  })

  it('no word on the banned list in anything these modules say', () => {
    const said = [
      ...Object.values(METHOD_WORDS), ...Object.values(KIND_WORDS), ...Object.values(METHOD_LABELS),
      ...['typed', 'recipe', 'table', 'house', 'none'].map(b => basisWords(b, { method: 'hot_sauce', kind: 'fridge' })),
      ...Object.values(WHEN_ERRORS),
    ]
    for (const s of said) expect(`${s}: ${BANNED.test(s)}`).toBe(`${s}: false`)
  })
})

describe('mintKey — a v4 uuid on every platform', () => {
  it('uses randomUUID, and without it still makes a well-formed v4 key from getRandomValues', async () => {
    const { mintKey } = await import('../components/kitchen/idempotencyKey.js')
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(mintKey()).toMatch(V4)
    const orig = crypto.randomUUID
    try {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
      const a = mintKey(); const b = mintKey()
      expect(a).toMatch(V4)
      expect(a).not.toBe(b)
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: orig, configurable: true })
    }
  })
})
