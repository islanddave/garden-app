// Put-Up B′ release 3 (V4 §2.2) — "How it was made →": the Start-a-batch sheet in retrospective posture,
// "Like <batch>, except…", the close sheet's When ("A make with nothing kept"), the ranked name search in
// the line adder, and the pure halves. Each assertion names what it pins.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }), apiFetch: (...a) => fetchSpy(...a) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import HowItWasMadeSheet, { useHowItWasMade } from '../components/putup/HowItWasMadeSheet.jsx'
import {
  canSayHowItWasMade, jarStart, candidateJars, asksMadeCount, fromJarsBody, nextTimeLines, startedOf, jarName, FROM_JARS_ERRORS,
} from '../components/putup/howItWasMade.js'
import { likeLine, likeDraft, likeChoices } from '../components/putup/likeBatch.js'
import { closeWhenBody } from '../components/putup/batchCloseWhen.js'
import { lineBody, emptyDraft, sourceOfHit, rankedHitWords, hitKey } from '../components/putup/lines.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { KITCHEN_LINE_KINDS } from '../../lambda/preservation/kitchenBatch.js'
import { validateFromJars } from '../../lambda/preservation/batchBuilder.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PLACE = 'loc-fridge'
const JAR = {
  id: 'j-1', label: 'Megatron plain', batch_id: null, harvest_log_id: null, storage_location_id: PLACE,
  preserved_at: '2026-09-08', preserved_at_precision: 'day', package_count: 2, remaining_count: 2, stock_mode: 'counted',
  notes: 'Sep 9 · Next time: more carrot',
}
const OTHER = { ...JAR, id: 'j-2', label: 'Megatron reaper', notes: 'Next time: less reaper' }
const ELSEWHERE = { ...JAR, id: 'j-3', label: 'Freezer bag', storage_location_id: 'loc-freezer' }
const LINKED = { ...JAR, id: 'j-4', label: 'Already in a batch', batch_id: 'kb-9' }
const PAST = {
  id: 'kb-past', label: 'Megatron mash 2025', kind: 'ferment',
  inputs: [
    { id: 'l1', input_kind: 'garden', plant_id: 'p-mega', label: 'Megatron', qty: '412', qty_unit: 'g', form: 'fresh', ordinal: 1 },
    { id: 'l2', input_kind: 'harvest', harvest_log_id: 'h-1', plant_id: 'p-ser', label: 'Serranos', qty: '230', qty_unit: 'g', ordinal: 2 },
    { id: 'l3', input_kind: 'put_up', preservation_log_id: 'j-old', label: 'Reaper bag', qty: '8', qty_unit: 'g', ordinal: 3 },
    { id: 'l4', input_kind: 'other', role: 'salt', label: 'Salt', qty: '20', qty_unit: 'g', salt_pct: '2.5', salt_base: 'produce', base_g: '800', salt_method: 'dry', ordinal: 4 },
    { id: 'l5', input_kind: 'other', label: 'Vinegar', qty: '72', qty_unit: 'g', put_up_stage_id: 's-1', ordinal: 5 },
  ],
}

function wire(extra = () => null) {
  fetchSpy.mockImplementation((path, o = {}) => {
    const x = extra(path, o)
    if (x) return x
    if (String(path).startsWith('/api/preservation/whats-put-up')) {
      return Promise.resolve({ groups: [{ label: 'Fridge', records: [JAR, OTHER, ELSEWHERE, LINKED] }] })
    }
    if (path === '/api/kitchen-batches?state=all') return Promise.resolve({ state: 'all', batches: [{ id: 'kb-past', label: PAST.label }] })
    if (path === '/api/kitchen-batches/kb-past') return Promise.resolve(PAST)
    if (path === '/api/kitchen-batches/from-jars') return Promise.resolve({ id: 'kb-new', label: 'Megatron plain' })
    return Promise.resolve(null)
  })
}
const posted = () => fetchSpy.mock.calls.filter(([p, o]) => p === '/api/kitchen-batches/from-jars' && o?.method === 'POST').map(([, o]) => JSON.parse(o.body))
const mount = (props = {}) => render(
  <DismissRegistryProvider><HowItWasMadeSheet jar={JAR} open onClose={() => {}} onSaved={() => {}} {...props} /></DismissRegistryProvider>,
)

beforeEach(() => { fetchSpy.mockReset(); clearReloadBlocks() })
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('howItWasMade.js — the pure rules', () => {
  it('offers the door only on a live, batchless, not-harvest-linked jar', () => {
    expect(canSayHowItWasMade(JAR)).toBe(true)
    expect(canSayHowItWasMade(LINKED)).toBe(false)
    expect(canSayHowItWasMade({ ...JAR, harvest_log_id: 'h' })).toBe(false)
    expect(canSayHowItWasMade({ ...JAR, deleted_at: 'x' })).toBe(false)
  })
  it('start = the jar\'s date (a floor or a logged day is Not sure)', () => {
    expect(jarStart(JAR)).toEqual({ date: '2026-09-08', precision: 'day' })
    expect(jarStart({ ...JAR, preserved_at_precision: 'after' })).toEqual({ date: null, precision: 'unknown' })
    expect(jarStart({ ...JAR, preserved_at_precision: null, preserved_at_approx: true })).toEqual({ date: null, precision: 'unknown' })
    expect(jarStart({ ...JAR, preserved_at_precision: null })).toEqual({ date: '2026-09-08', precision: 'day' })
  })
  it('candidates: this jar first, then batchless jars at the same place only', () => {
    expect(candidateJars([JAR, OTHER, ELSEWHERE, LINKED], JAR).map(j => j.id)).toEqual(['j-1', 'j-2'])
  })
  it('asks How many only for one counted jar', () => {
    expect(asksMadeCount([JAR])).toBe(true)
    expect(asksMadeCount([JAR, OTHER])).toBe(false)
    expect(asksMadeCount([{ ...JAR, stock_mode: 'weighed' }])).toBe(false)
  })
  it('the body the route accepts (validated by the Lambda\'s own rule)', () => {
    const r = fromJarsBody({ key: '11111111-1111-4222-8333-444444444444', label: ' Megatron plain ', started: jarStart(JAR), jarIds: ['j-1'], madeCount: '6', nextTime: ' less salt ' })
    expect(r.body).toEqual({
      idempotency_key: '11111111-1111-4222-8333-444444444444', label: 'Megatron plain', started: { date: '2026-09-08', precision: 'day' },
      jar_ids: ['j-1'], made_count: 6, next_time: 'less salt',
    })
    expect(validateFromJars({ ...r.body, jar_ids: ['cccccccc-1111-2222-3333-444444444444'] })).toBeNull()
    expect(fromJarsBody({ key: 'k', label: '', jarIds: ['j'] }).error).toBe(FROM_JARS_ERRORS.label)
    expect(fromJarsBody({ key: 'k', label: 'x', jarIds: [] }).error).toBe(FROM_JARS_ERRORS.jars)
    expect(fromJarsBody({ key: 'k', label: 'x', jarIds: ['a', 'b'], madeCount: '6' }).body.made_count).toBeUndefined()
  })
  it('Next time lines, name fallback, started from the chips', () => {
    expect(nextTimeLines('a\nNext time: more\nnext time more')).toEqual(['Next time: more', 'next time more'])
    expect(jarName({ crop_type_slug: 'hot_pepper' })).toBe('Hot pepper')
    expect(startedOf({ start: { started_at: null, start_precision: 'unknown' } })).toEqual({ date: null, precision: 'unknown' })
  })
})

describe('Like <batch>, except… — likeBatch.js', () => {
  let n = 0
  const mint = () => `k${++n}`
  it('copies What went in: planting kept, pick → its planting, a draw → its name, salt with its facts; a bottling line stays behind', () => {
    const d = likeDraft(PAST, mint)
    expect(d.kind).toBe('ferment')
    expect(d.from).toEqual({ id: 'kb-past', label: 'Megatron mash 2025' })
    expect(d.lines.map(l => [l.input_kind, l.plant_id ?? null, l.label, l.role ?? null])).toEqual([
      ['garden', 'p-mega', 'Megatron', null], ['garden', 'p-ser', 'Serranos', null],
      ['other', null, 'Reaper bag', null], ['other', null, 'Salt', 'salt'],
    ])
    expect(d.lines[3]).toMatchObject({ salt_pct: '2.5', salt_base: 'produce', base_g: '800', salt_method: 'dry' })
    expect(d.lines.every(l => l.harvest_log_id === undefined && l.preservation_log_id === undefined)).toBe(true)
    expect(d.lines.map(l => l.ordinal)).toEqual([0, 1, 2, 3])
    expect(new Set(d.lines.map(l => l.idempotency_key)).size).toBe(4)
  })
  it('every copied line passes the Lambda\'s line rule', async () => {
    const { lineError } = await import('../../lambda/preservation/kitchenLines.js')
    for (const l of likeDraft(PAST, () => '11111111-1111-4222-8333-444444444444').lines) {
      expect(lineError({ ...l, plant_id: l.plant_id ? 'dddddddd-1111-2222-3333-444444444444' : undefined })).toBeNull()
    }
  })
  it('a legacy peppers salt base drops its facts; blank lines drop; choices skip the batch itself', () => {
    expect(likeLine({ input_kind: 'other', role: 'salt', label: 'Salt', qty: '5', qty_unit: 'g', salt_pct: '2', salt_base: 'peppers', base_g: '250' }, mint).salt_pct).toBeUndefined()
    expect(likeLine({ input_kind: 'other', label: ' ' }, mint)).toBeNull()
    expect(likeChoices([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], 'a').map(b => b.id)).toEqual(['b'])
  })
})

describe('HowItWasMadeSheet — the retrospective posture', () => {
  it('opens with the jar\'s name and date, this jar chosen and fixed, the others at its place offered', async () => {
    wire()
    mount()
    expect(screen.getByTestId('how-label').value).toBe('Megatron plain')
    expect(screen.getByTestId('how-start-words').textContent).not.toBe('Not sure')
    // What went in is OPEN (the adder is on screen, no disclosure).
    expect(screen.getByTestId('how-add-name')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('how-jar-j-2')).toBeTruthy())
    expect(screen.queryByTestId('how-jar-j-3')).toBeNull()
    expect(screen.queryByTestId('how-jar-j-4')).toBeNull()
    expect(screen.getByTestId('how-jar-j-1').disabled).toBe(true)
    expect(screen.getByTestId('how-made')).toBeTruthy()
    expect(screen.getByTestId('how-copied-next-time').textContent).toContain('more carrot')
  })

  it('Save sends ONE keyed body: the jar\'s date, the chosen jars, How many; a second jar hides How many', async () => {
    wire()
    const onSaved = vi.fn()
    mount({ onSaved })
    await waitFor(() => screen.getByTestId('how-jar-j-2'))
    fireEvent.change(screen.getByTestId('how-made'), { target: { value: '6' } })
    fireEvent.click(screen.getByTestId('how-submit'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'kb-new', label: 'Megatron plain' }))
    const [b] = posted()
    expect(b.idempotency_key).toMatch(UUID)
    expect(b).toMatchObject({ label: 'Megatron plain', started: { date: '2026-09-08', precision: 'day' }, jar_ids: ['j-1'], made_count: 6 })
    cleanup(); fetchSpy.mockReset(); wire()
    mount()
    await waitFor(() => screen.getByTestId('how-jar-j-2'))
    fireEvent.click(screen.getByTestId('how-jar-j-2'))
    expect(screen.queryByTestId('how-made')).toBeNull()
    expect(screen.getByTestId('how-copied-next-time').textContent).toContain('less reaper')
    fireEvent.click(screen.getByTestId('how-submit'))
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0].jar_ids).toEqual(['j-1', 'j-2'])
    expect(posted()[0].made_count).toBeUndefined()
  })

  it('a refused write keeps the sheet and says why; a retry reuses the same key', async () => {
    let first = true
    wire((p, o) => {
      if (p === '/api/kitchen-batches/from-jars' && o.method === 'POST' && first) {
        first = false
        return Promise.reject(Object.assign(new Error('x'), { status: 409, body: { code: 'jar_has_batch', error: 'x' } }))
      }
      return null
    })
    mount()
    fireEvent.click(screen.getByTestId('how-submit'))
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toMatch(/already has a batch/))
    fireEvent.click(screen.getByTestId('how-submit'))
    await waitFor(() => expect(posted()).toHaveLength(2))
    expect(posted()[0].idempotency_key).toBe(posted()[1].idempotency_key)
  })

  it('Like a past batch, except… fills What went in (and the kind) for editing', async () => {
    wire()
    mount()
    fireEvent.click(screen.getByTestId('how-like-open'))
    await waitFor(() => screen.getByTestId('how-like-batch-kb-past'))
    fireEvent.click(screen.getByTestId('how-like-batch-kb-past'))
    await waitFor(() => expect(screen.getAllByTestId('how-line')).toHaveLength(4))
    expect(screen.getByTestId('how-like-picked').textContent).toMatch(/Like Megatron mash 2025, except/)
    fireEvent.click(screen.getByTestId('how-line-out-0'))
    expect(screen.getAllByTestId('how-line')).toHaveLength(3)
    fireEvent.click(screen.getByTestId('how-submit'))
    await waitFor(() => expect(posted()).toHaveLength(1))
    const b = posted()[0]
    expect(b.kind).toBe('ferment')
    expect(b.inputs.map(l => l.label)).toEqual(['Serranos', 'Reaper bag', 'Salt'])
  })

  it('useHowItWasMade: open(jar) mounts the sheet; a batch jar does not open it', () => {
    wire()
    let api
    function Host({ jar }) { api = useHowItWasMade(); return <><button data-testid="door" onClick={() => api.open(jar)} />{api.sheet}</> }
    const { rerender } = render(<DismissRegistryProvider><Host jar={LINKED} /></DismissRegistryProvider>)
    fireEvent.click(screen.getByTestId('door'))
    expect(screen.queryByTestId('how-sheet')).toBeNull()
    rerender(<DismissRegistryProvider><Host jar={JAR} /></DismissRegistryProvider>)
    fireEvent.click(screen.getByTestId('door'))
    expect(screen.getByTestId('how-sheet')).toBeTruthy()
  })
})

describe('A make with nothing kept — the close sheet\'s When', () => {
  it('Today sends nothing; another answer sends its date and precision; Not sure no date; a half answer refuses', () => {
    expect(closeWhenBody({ start: { started_at: 'x', start_precision: 'exact' } }, 'today')).toBeNull()
    expect(closeWhenBody({ start: { started_at: '2026-10-08T04:00:00.000Z', start_precision: 'day' } }, 'yesterday'))
      .toEqual({ date: '2026-10-08T04:00:00.000Z', precision: 'day' })
    expect(closeWhenBody({ start: { started_at: null, start_precision: 'unknown' } }, 'unsure')).toEqual({ date: null, precision: 'unknown' })
    expect(closeWhenBody({ error: 'Pick when' }, 'earlier').error).toBe('Pick when')
  })
})

describe('the ranked name search in the line adder (lines.js)', () => {
  const pantry = { kind: 'pantry_item', key: 'pantry:i-1', pantry_item_id: 'i-1', label: 'Onions', crop_type_slug: 'onion', plant_id: 'p-x', place_label: 'Counter' }
  const variety = { kind: 'variety', key: 'variety:v-1', variety_id: 'v-1', label: 'Megatron', crop_type_slug: 'pepper' }
  it('a pantry item → a pantry line; a crop/variety → a named line with its crop; typed → the resolved crop', () => {
    expect(lineBody({ ...emptyDraft('k'), source: sourceOfHit(pantry), label: 'Onions' }).body)
      .toEqual({ idempotency_key: 'k', input_kind: 'pantry', pantry_item_id: 'i-1', label: 'Onions', crop_type_slug: 'onion' })
    expect(lineBody({ ...emptyDraft('k'), source: sourceOfHit(variety), label: 'Megatron' }).body)
      .toEqual({ idempotency_key: 'k', input_kind: 'other', label: 'Megatron', crop_type_slug: 'pepper' })
    expect(lineBody({ ...emptyDraft('k'), label: 'megatron' }, { crop: 'pepper' }).body.crop_type_slug).toBe('pepper')
    for (const h of [pantry, variety]) expect(KITCHEN_LINE_KINDS).toContain(lineBody({ ...emptyDraft('k'), source: sourceOfHit(h), label: 'x' }).body.input_kind)
  })
  it('a ranked hit keys by its own key (a pantry item from a planting is not the planting)', () => {
    expect(hitKey(pantry)).toBe('pantry:i-1')
    expect(rankedHitWords(pantry)).toEqual({ text: 'Onions · Counter', tail: 'in the pantry' })
    expect(rankedHitWords({ kind: 'planting', label: 'Jalapeño', ended: true, recent_picks: [] }).tail).toBe('ended · from the garden')
  })
})
