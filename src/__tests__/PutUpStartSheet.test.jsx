// Put-Up 1a item 4 (V4 §2.2 "Start a batch", §3.6, §6.2–§6.6) — the ONE shared Start sheet.
//
// WHAT THIS FILE HOLDS, each with the mutation that proves it:
//   • required at open = 1 (the label) — the Jen census, counted through aria-required;
//   • the start chips write ONLY precisions the LIVE CHECK accepts in 1a (read on prod and staging
//     2026-09-29: exact · hour · day · week · month · unknown). "Earlier…" therefore offers This month,
//     Last month, Pick a date — never the season/year chips that arrive with 1b's DDL;
//   • "Not sure" = NULL date + `unknown`, the shipped biconditional;
//   • the kind is optional and collapsed; "Other" still needs its short name in 1a;
//   • one POST (photo first, into the inbox), busy refuses a second Start it, a retry never uploads the
//     photo twice;
//   • <Sheet armsBack>: the draft survives Back; the reload gate is held while dirty or saving; the
//     host is handed the batch only after the sheet's own Back entry has been consumed.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy, uploadSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), uploadSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))

import StartBatchSheet, { START_CTA, photoDayChoice } from '../components/kitchen/StartBatchSheet.jsx'
import { resolveSheetStart, SHEET_START_CHIPS, EARLIER_CHIPS, START_ERRORS } from '../components/kitchen/StartChips.jsx'
import { SHEET_DRAFT_TTL_MS } from '../components/kitchen/sheetDraft.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

// ZONELESS LOCAL clock literals, so the TZ lane has something to bite on.
const NOW = new Date(2026, 8, 29, 21, 30, 0, 0)          // 2026-09-29 21:30 local
const JAN = new Date(2026, 0, 3, 8, 0, 0, 0)             // 2026-01-03 08:00 local — month rollover
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:start:new'
// chk_kitchen_batch_start_precision as release 1b widens it (v5-putupmake-001/0a: + season, year).
const ALLOWED = ['exact', 'hour', 'day', 'week', 'month', 'season', 'year', 'unknown']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// The create body minus its minted key, which is asserted separately (V4 §5.2).
const unkeyed = (b) => { const { idempotency_key: k, ...rest } = b; expect(k).toMatch(UUID); return rest }
const CREATED = { id: 'kb-new', label: 'Pepper mash', kind: null }

const kbPosts = () => fetchSpy.mock.calls.filter(([p, o]) => p === '/api/kitchen-batches' && o?.method === 'POST')
const body = (i = 0) => JSON.parse(kbPosts()[i][1].body)

function Host({ onStarted, photo, photoPreview, photoTakenAt, withRegistry = false }) {
  const [open, setOpen] = useState(true)
  const tree = (
    <>
      <StartBatchSheet open={open} onClose={() => setOpen(false)} onStarted={onStarted} photo={photo}
        photoPreview={photoPreview} photoTakenAt={photoTakenAt} now={NOW.getTime()} />
      {!open && <button type="button" onClick={() => setOpen(true)}>reopen</button>}
    </>
  )
  return withRegistry ? <DismissRegistryProvider>{tree}</DismissRegistryProvider> : tree
}
const sheet = () => screen.queryByTestId('start-sheet')
const type = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const startIt = async () => { await act(async () => { tap('start-submit') }) }

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset()
  fetchSpy.mockImplementation((path, o = {}) => (o.method === 'POST' ? Promise.resolve(CREATED) : Promise.resolve(null)))
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: null } })
  localStorage.clear()
  clearReloadBlocks()
  auth.user = { id: 'user_dave' }
  window.history.replaceState({ __floor: 1 }, '')
  global.URL.createObjectURL = vi.fn(() => 'blob:mine')
  global.URL.revokeObjectURL = vi.fn()
})
afterEach(() => { clearReloadBlocks() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('resolveSheetStart — only what the 1b CHECK can store', () => {
  const pairing = (s) => (s.started_at !== null) === (s.start_precision !== null && s.start_precision !== 'unknown')

  it('every chip and every Earlier… choice resolves to an allowed precision that satisfies the pairing', () => {
    const cases = [
      { chip: 'today' }, { chip: 'yesterday' }, { chip: 'unsure' },
      { chip: 'earlier', earlier: 'this_month' }, { chip: 'earlier', earlier: 'last_month' },
      { chip: 'earlier', earlier: 'two_three' }, { chip: 'earlier', earlier: 'earlier_year' },
      { chip: 'earlier', earlier: 'last_year' },
      { chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-07-04' },
    ]
    for (const c of cases) {
      const { start, error } = resolveSheetStart({ ...c, now: NOW })
      expect({ c, error }).toEqual({ c, error: undefined })
      expect({ c, allowed: ALLOWED.includes(start.start_precision), pairing: pairing(start) })
        .toEqual({ c, allowed: true, pairing: true })
    }
  })

  // Amended for release 1b (V4 §3.6, §8.3): the CHECK widens, so Earlier… offers all six windows.
  it('offers Today · Yesterday · Earlier… · Not sure, and under Earlier… the six §3.6 windows', () => {
    expect(SHEET_START_CHIPS.map(c => c.label)).toEqual(['Today', 'Yesterday', 'Earlier…', 'Not sure'])
    expect(EARLIER_CHIPS.map(c => [c.label, c.precision])).toEqual([
      ['This month', 'month'], ['Last month', 'month'], ['2–3 months ago', 'season'],
      ['Earlier this year', 'year'], ['Last year', 'year'], ['Pick a date', 'day'],
    ])
    for (const c of EARLIER_CHIPS) expect(ALLOWED).toContain(c.precision)
  })

  it('Today is the instant, exact; Yesterday is local midnight, day', () => {
    expect(resolveSheetStart({ chip: 'today', now: NOW }).start).toEqual({
      started_at: NOW.toISOString(), start_precision: 'exact', start_anchor_kind: 'memory', start_anchor_id: null })
    expect(resolveSheetStart({ chip: 'yesterday', now: NOW }).start).toEqual({
      started_at: new Date(2026, 8, 28).toISOString(), start_precision: 'day', start_anchor_kind: 'memory', start_anchor_id: null })
  })

  it('Not sure is NO date + `unknown` — the other legal half of the biconditional', () => {
    expect(resolveSheetStart({ chip: 'unsure', now: NOW }).start).toEqual({
      started_at: null, start_precision: 'unknown', start_anchor_kind: null, start_anchor_id: null })
  })

  it('This month / Last month store their WINDOW START, including across a year boundary', () => {
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'this_month', now: NOW }).start.started_at).toBe(new Date(2026, 8, 1).toISOString())
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'last_month', now: NOW }).start.started_at).toBe(new Date(2026, 7, 1).toISOString())
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'last_month', now: JAN }).start.started_at).toBe(new Date(2025, 11, 1).toISOString())
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'this_month', now: JAN }).start.started_at).toBe(new Date(2026, 0, 1).toISOString())
  })

  it('Pick a date is a LOCAL calendar day, manual; empty, malformed or future dates are refused', () => {
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-09-13', now: NOW }).start).toEqual({
      started_at: new Date(2026, 8, 13).toISOString(), start_precision: 'day', start_anchor_kind: 'manual', start_anchor_id: null })
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-09-29', now: NOW }).start.start_precision).toBe('day')
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'pickdate', pickedDate: '', now: NOW })).toEqual({ error: START_ERRORS.pickdate })
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'pickdate', pickedDate: 'soon', now: NOW })).toEqual({ error: START_ERRORS.pickdate })
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-09-30', now: NOW })).toEqual({ error: START_ERRORS.future })
  })

  it('refuses Earlier… with nothing chosen under it, rather than storing "never asked"', () => {
    expect(resolveSheetStart({ chip: 'earlier', earlier: null, now: NOW })).toEqual({ error: START_ERRORS.earlier })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the Start sheet — what it asks', () => {
  // The Jen census, V4 §6.3: required AND visible at open = 1. Fails on any increase.
  // MUTATION: make the kind chips or the start chips aria-required -> 2.
  it('asks exactly ONE required thing at open: the label', () => {
    render(<Host />)
    const required = screen.getByTestId('start-sheet').querySelectorAll('[aria-required="true"]')
    expect(required).toHaveLength(1)
    expect(required[0]).toBe(screen.getByTestId('start-label'))
    expect(screen.getByRole('dialog', { name: 'Start a batch' })).toBeTruthy()
  })

  // Put-Up UX pass R1 (PLAN-V3 D10), ADDED beside the two tests it must not disturb: the field is "Name it",
  // and the new "Start from" row — on screen at open — adds nothing to what the sheet requires.
  it('the one required thing is the textbox named "Name it"', () => {
    render(<Host />)
    // Field appends a screen-reader "(required)" to a required field's label; the words are "Name it".
    const named = screen.getByRole('textbox', { name: (n) => n.replace(/\s*\(required\)\s*$/, '').trim() === 'Name it' })
    expect(named).toBe(screen.getByTestId('start-label'))
    expect(named.getAttribute('aria-required')).toBe('true')
  })

  it('with the Start-from row at open, the required list is still [start-label] and there is still no radiogroup', () => {
    render(<Host />)
    expect(screen.getByRole('group', { name: 'Start from' })).toBeTruthy()   // green control: the row IS at open
    const required = [...screen.getByTestId('start-sheet').querySelectorAll('[aria-required="true"]')]
    expect(required.map(e => e.getAttribute('data-testid'))).toEqual(['start-label'])
    expect(screen.queryByRole('radiogroup')).toBeNull()
    // …and with each of its doors open.
    tap('start-from-recipe')
    expect([...screen.getByTestId('start-sheet').querySelectorAll('[aria-required="true"]')].map(e => e.getAttribute('data-testid')))
      .toEqual(['start-label'])
    tap('start-from-batch')
    expect([...screen.getByTestId('start-sheet').querySelectorAll('[aria-required="true"]')].map(e => e.getAttribute('data-testid')))
      .toEqual(['start-label'])
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('starts on Today, as an optional group of 48px chips', () => {
    render(<Host />)
    const group = screen.getByRole('group', { name: 'When did it start?' })
    const chips = within(group).getAllByRole('button')
    expect(chips.map(c => [c.textContent, c.getAttribute('aria-pressed')])).toEqual([
      ['Today', 'true'], ['Yesterday', 'false'], ['Earlier…', 'false'], ['Not sure', 'false'],
    ])
    expect(chips.every(c => c.style.minHeight === '48px')).toBe(true)
    expect(group.style.gap).toBe('8px')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('Earlier… reveals the windows that are not empty today, and the date field only for Pick a date', () => {
    render(<Host />)
    expect(screen.queryByTestId('start-when-this_month')).toBeNull()
    tap('start-when-earlier')
    expect(within(screen.getByRole('group', { name: 'Earlier…' })).getAllByRole('button').map(b => b.textContent))
      .toEqual(['This month', 'Last month', '2–3 months ago', 'Earlier this year', 'Last year', 'Pick a date'])
    expect(screen.queryByTestId('start-when-date')).toBeNull()
    tap('start-when-pickdate')
    expect(screen.getByTestId('start-when-date').getAttribute('max')).toBe('2026-09-29')
  })

  it('keeps the kind collapsed and optional until it is opened', () => {
    render(<Host />)
    expect(screen.getByTestId('start-kind-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('start-kind-ferment')).toBeNull()
    tap('start-kind-toggle')
    expect(screen.getByTestId('start-kind-ferment')).toBeTruthy()
  })

  it('pins Start it in a sticky footer', () => {
    render(<Host />)
    expect(screen.getByTestId('start-footer').style.position).toBe('sticky')
    expect(screen.getByTestId('start-submit').textContent).toBe(START_CTA)
    expect(START_CTA).toBe('Start it')
  })
})

describe('the Start sheet — the write', () => {
  it('a label alone is a complete start: exactly this body, no kind, no photo, Today', async () => {
    const onStarted = vi.fn()
    render(<Host onStarted={onStarted} />)
    type('start-label', '  Pepper mash ')
    await startIt()
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(CREATED))
    expect(kbPosts()).toHaveLength(1)
    expect(unkeyed(body())).toEqual({
      label: 'Pepper mash', started_at: NOW.toISOString(), start_precision: 'exact',
      start_anchor_kind: 'memory', start_anchor_id: null,
    })
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(sheet()).toBeNull()
  })

  it('refuses a blank label with one line, and uploads and writes nothing', async () => {
    render(<Host />)
    type('start-label', '   ')
    await startIt()
    expect(screen.getByTestId('start-error').textContent).toBe('Give it a name first.')
    expect(kbPosts()).toHaveLength(0)
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it('carries a chosen kind, and "Not sure" as no date + unknown', async () => {
    render(<Host />)
    type('start-label', 'Kraut')
    tap('start-when-unsure')
    tap('start-kind-toggle')
    tap('start-kind-ferment')
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(1))
    expect(unkeyed(body())).toEqual({
      label: 'Kraut', started_at: null, start_precision: 'unknown', start_anchor_kind: null, start_anchor_id: null,
      kind: 'ferment',
    })
  })

  // Amended for release 1b (V4 §2.3): "Other" needs no text; a typed name still rides along.
  it('"Other" needs no short name from 1b, and sends one when it is typed', async () => {
    render(<Host />)
    type('start-label', 'Shrub')
    tap('start-kind-toggle')
    tap('start-kind-other')
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(1))
    expect(body().kind).toBe('other')
    expect('kind_other' in body()).toBe(false)
  })

  it('a typed name for Other rides with the kind', async () => {
    render(<Host />)
    type('start-label', 'Shrub')
    tap('start-kind-toggle')
    tap('start-kind-other')
    type('start-kind-other-text', 'drinking vinegar')
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(1))
    expect(body()).toMatchObject({ kind: 'other', kind_other: 'drinking vinegar' })
  })

  // MUTATION: mint a key per Start it -> the two keys differ.
  it('a retry carries the SAME idempotency key (V4 §5.2)', async () => {
    let fail = true
    fetchSpy.mockImplementation((p, o = {}) => (o.method === 'POST'
      ? (fail ? Promise.reject(new Error('502')) : Promise.resolve(CREATED)) : Promise.resolve(null)))
    render(<Host />)
    type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(screen.getByTestId('start-error')).toBeTruthy())
    fail = false
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(2))
    expect(body(1).idempotency_key).toMatch(UUID)
    expect(body(1).idempotency_key).toBe(body(0).idempotency_key)
  })

  it('refuses an Earlier… with nothing picked under it', async () => {
    render(<Host />)
    type('start-label', 'Mash')
    tap('start-when-earlier')
    await startIt()
    expect(screen.getByTestId('start-error').textContent).toBe(START_ERRORS.earlier)
    expect(kbPosts()).toHaveLength(0)
  })

  it('a photo goes up FIRST, into the inbox with no parent, and rides as cover_photo_id', async () => {
    const file = new File(['x'], 'crock.jpg', { type: 'image/jpeg' })
    render(<Host photo={file} photoPreview="blob:snap" />)
    expect(screen.getByTestId('start-photo-preview').getAttribute('src')).toBe('blob:snap')
    expect(screen.queryByTestId('start-photo-add')).toBeNull()      // Snap's photo is not re-pickable here
    type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(1))
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const [sent, opts] = uploadSpy.mock.calls[0]
    expect(sent).toBe(file)
    expect(opts).toEqual({ keyPrefix: 'standalone', parentId: null, linkage: { intake_status: 'pending_tag' }, is_public: true })
    expect(body().cover_photo_id).toBe('photo-1')
  })

  it('a retry after a failed write reuses the uploaded photo — it is never uploaded twice', async () => {
    let fail = true
    fetchSpy.mockImplementation((p, o = {}) => (o.method === 'POST'
      ? (fail ? Promise.reject(new Error('502')) : Promise.resolve(CREATED)) : Promise.resolve(null)))
    const file = new File(['x'], 'crock.jpg', { type: 'image/jpeg' })
    render(<Host photo={file} photoPreview="blob:snap" />)
    type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(screen.getByTestId('start-error').textContent).toBe("Couldn't start it — try again. What you typed is still here."))
    expect(screen.getByTestId('start-label').value).toBe('Pepper mash')
    fail = false
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(2))
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(body(1).cover_photo_id).toBe('photo-1')
  })

  // BUG-PUTUPSAVEFAILHIDDEN-001: the failure line is the last line of the scroller, under the pinned Start it.
  it('a start that fails is brought into view and scrolled clear of the pinned footer, and so is the same failure again', async () => {
    const on = []
    Element.prototype.scrollIntoView = function scrollIntoView() { on.push(this) }
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const box = (top, bottom) => ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top })
      if (this.getAttribute?.('data-testid') === 'start-footer') return box(700, 780)
      if (this.getAttribute?.('data-testid') === 'start-error') return box(730, 745)
      return box(0, 0)
    })
    try {
      fetchSpy.mockImplementation((p, o = {}) => (o.method === 'POST' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(null)))
      render(<Host />)
      const panel = sheet().closest('[role=dialog]')
      let top = 0
      Object.defineProperty(panel, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v } })
      type('start-label', 'Pepper mash')
      await startIt()
      await waitFor(() => expect(screen.getByTestId('start-error').textContent).toBe("Couldn't start it — try again. What you typed is still here."))
      await waitFor(() => expect(on).toContain(screen.getByTestId('start-error')))
      expect(top).toBe(53)                                                     // 745 + the 8 px gap − 700
      on.length = 0
      await startIt()
      await waitFor(() => expect(kbPosts()).toHaveLength(2))
      await waitFor(() => expect(on).toContain(screen.getByTestId('start-error')))
    } finally {
      rects.mockRestore()
      delete Element.prototype.scrollIntoView
    }
  })

  it('the Going-now door can add its own photo', async () => {
    render(<Host />)
    expect(screen.getByTestId('start-photo-add').textContent).toBe('Add a photo')
    const file = new File(['x'], 'jar.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByTestId('start-photo-input'), { target: { files: [file] } })
    expect(screen.getByTestId('start-photo-preview').getAttribute('src')).toBe('blob:mine')
    type('start-label', 'Apple rings')
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(1))
    expect(uploadSpy.mock.calls[0][0]).toBe(file)
  })

  // MUTATION: remove the writingRef early-return -> two POSTs (both taps inside one act()).
  it('busy refuses a second Start it — two taps inside one frame start ONE batch', async () => {
    let settle
    fetchSpy.mockImplementation((p, o = {}) => (o.method === 'POST' ? new Promise(r => { settle = r }) : Promise.resolve(null)))
    render(<Host />)
    type('start-label', 'Mash')
    const btn = screen.getByTestId('start-submit')
    act(() => { btn.click(); btn.click() })
    await act(async () => { await Promise.resolve() })
    expect(kbPosts()).toHaveLength(1)
    expect(btn.textContent).toBe('Starting…')
    await act(async () => { settle(CREATED) })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the Start sheet — the draft survives a dismiss (V4 §6.5)', () => {
  it('keeps the label, the start and the kind under the person + sheet key, and restores them', () => {
    render(<Host />)
    type('start-label', 'Megatron mash')
    tap('start-when-yesterday')
    tap('start-kind-toggle')
    tap('start-kind-ferment')
    const rec = JSON.parse(localStorage.getItem(DRAFT_KEY))
    expect([rec.v, rec.sheet, typeof rec.savedAt]).toEqual([1, 'start', 'number'])
    const { key, ...data } = rec.data
    expect(key).toMatch(UUID)
    expect(data).toEqual({ label: 'Megatron mash', chip: 'yesterday', earlier: null, pickedDate: '', kind: 'ferment', kindOther: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(sheet()).toBeNull()
    fireEvent.click(screen.getByText('reopen'))
    expect(screen.getByTestId('start-label').value).toBe('Megatron mash')
    expect(screen.getByTestId('start-when-yesterday').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('start-kind-ferment').getAttribute('aria-pressed')).toBe('true')
  })

  it('is cleared by a successful start', async () => {
    const onStarted = vi.fn()
    render(<Host onStarted={onStarted} />)
    type('start-label', 'Mash')
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull()
    await startIt()
    await waitFor(() => expect(onStarted).toHaveBeenCalled())
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('is not restored after 24 hours', () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'start', savedAt: Date.now() - SHEET_DRAFT_TTL_MS - 1,
      data: { label: 'old', chip: 'today', earlier: null, pickedDate: '', kind: null, kindOther: '' } }))
    render(<Host />)
    expect(screen.getByTestId('start-label').value).toBe('')
  })

  it('drops a draft of the wrong shape (an unknown chip) rather than half-restoring it', () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'start', savedAt: Date.now(),
      data: { label: 'x', chip: 'last_year', earlier: null, pickedDate: '', kind: null, kindOther: '' } }))
    render(<Host />)
    expect(screen.getByTestId('start-label').value).toBe('')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })
})

describe('the Start sheet — the reload gate (reloadGateWire)', () => {
  it('is free while pristine, held once anything is typed, released on close', () => {
    render(<Host />)
    expect(isReloadBlocked()).toBe(false)
    type('start-label', 'M')
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(isReloadBlocked()).toBe(false)
  })
})

describe('the Start sheet — Android Back and the landing (popstate)', () => {
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })
  const armed = () => !!readMarker(window.history.state)
  // BUG-BACKTWICECLOSESAPP-001: a Back the registry refuses is answered by a RETURN to the same marker,
  // history.go(1): a second traversal that lands two jsdom tasks and one popstate later. After the sleep, wait
  // until a whole round of turns passes with no further popstate, so the marker is read after it has settled.
  let pops = 0
  window.addEventListener('popstate', () => { pops += 1 })
  const markerSettled = () => act(async () => {
    let seen
    do {
      seen = pops
      for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
    } while (pops !== seen)
  })

  it('Back closes the sheet, not the page under it, and the draft survives', async () => {
    await act(async () => { render(<Host withRegistry />) })
    await waitFor(() => expect(armed()).toBe(true))
    expect(armed()).toBe(true)
    type('start-label', 'Kraut, second crock')
    act(() => { window.history.back() }); await settle()
    await waitFor(() => expect(sheet()).toBeNull())
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)).data.label).toBe('Kraut, second crock')
  })

  // THE SEAM'S PROMISE: onStarted arrives only after the sheet's own Back entry is gone, so the host
  // can push or replace without stranding a dead entry mid-stack.
  it('hands the batch over only after the sheet has closed AND its Back entry is consumed', async () => {
    const seen = []
    const onStarted = vi.fn(() => seen.push({ sheetOpen: !!sheet(), markerCurrent: armed() }))
    await act(async () => { render(<Host withRegistry onStarted={onStarted} />) })
    await waitFor(() => expect(armed()).toBe(true))
    expect(armed()).toBe(true)
    type('start-label', 'Mash')
    await startIt()
    await settle()
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1))
    expect(onStarted).toHaveBeenCalledWith(CREATED)
    expect(seen).toEqual([{ sheetOpen: false, markerCurrent: false }])
  })

  it('Back mid-write is refused — the sheet stays up over its in-flight write', async () => {
    let settleWrite
    fetchSpy.mockImplementation((p, o = {}) => (o.method === 'POST' ? new Promise(r => { settleWrite = r }) : Promise.resolve(null)))
    await act(async () => { render(<Host withRegistry />) })
    await settle()
    type('start-label', 'Mash')
    await startIt()
    const seq0 = readMarker(window.history.state).seq
    const pops0 = pops
    act(() => { window.history.back() }); await settle(); await markerSettled()
    // The Back WAS processed and refused: on a BLOCKED Back the registry RETURNS to the marker it stood
    // on and pushes nothing (BUG-BACKTWICECLOSESAPP-001; it used to push a fresh one, a higher seq, and
    // that entry is what Android skipped). So a refusal is exactly two traversals, the Back and the
    // return. Waiting on both popstates — not on `armed()`, which is also true before the traversal
    // lands — is what makes the assertions below about a refused Back, not an early look.
    await waitFor(() => expect(pops - pops0).toBe(2))
    expect(readMarker(window.history.state)?.seq).toBe(seq0)      // the SAME marker, stood on again
    expect(sheet()).toBeTruthy()
    await act(async () => { settleWrite(CREATED) })
  })
})

// Put-Up 1a item 7 — confirmOnDirty OFF, and the BACKDROP refused mid-write exactly as Back is.
describe('the Start sheet — the Sheet contract (item 7)', () => {
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })

  // MUTATION: pass confirmOnDirty to the Sheet -> Back raises the ConfirmSheet and this reds.
  it('Back on a typed-in sheet asks nothing — it closes, and the draft keeps the label', async () => {
    await act(async () => { render(<Host withRegistry />) })
    await settle()
    type('start-label', 'Mash')
    act(() => { window.history.back() }); await settle()
    expect(screen.queryByTestId('confirm-sheet')).toBeNull()
    await waitFor(() => expect(sheet()).toBeNull())
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)).data.label).toBe('Mash')
  })

  it('a backdrop tap is refused while the write is in flight, and closes an idle sheet', async () => {
    let settleWrite
    fetchSpy.mockImplementation((p, o = {}) => (o.method === 'POST' ? new Promise(r => { settleWrite = r }) : Promise.resolve(null)))
    const first = render(<Host />)
    type('start-label', 'Mash')
    await startIt()
    fireEvent.click(screen.getByRole('dialog').previousElementSibling)
    expect(sheet()).toBeTruthy()                          // refused mid-write
    await act(async () => { settleWrite(CREATED) })
    first.unmount()
    render(<Host />)
    fireEvent.click(screen.getByRole('dialog').previousElementSibling)
    expect(sheet()).toBeNull()
  })
})

describe('the Start sheet uses none of the banned words (V4 §3.2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it('with every section open', () => {
    render(<Host />)
    tap('start-when-earlier')
    tap('start-when-pickdate')
    tap('start-kind-toggle')
    tap('start-kind-other')
    const text = screen.getByRole('dialog', { name: 'Start a batch' }).textContent
    expect(text).toContain('This month')                   // green control: the open sheet is what is read
    expect(text).not.toMatch(BANNED)
  })
})

// Put-Up release 1b (train §6a "Snap's start date"): the Start sheet preselects the photo's capture day
// when it is not today — the shipped kitchen path used the photo's date, and 1a lost it.
describe('the Start sheet — Snap\'s photo day', () => {
  const file = () => new File(['x'], 'crock.jpg', { type: 'image/jpeg' })
  const pressed = (id) => screen.getByTestId(id).getAttribute('aria-pressed')

  it('photoDayChoice: today → none; yesterday → Yesterday; older → Pick a date on that day; no time → none', () => {
    expect(photoDayChoice(new Date(2026, 8, 29, 7), NOW)).toBeNull()
    expect(photoDayChoice(new Date(2026, 8, 28, 23), NOW)).toEqual({ chip: 'yesterday', earlier: null, pickedDate: '' })
    expect(photoDayChoice(new Date(2026, 8, 20, 12), NOW)).toEqual({ chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-09-20' })
    expect(photoDayChoice(null, NOW)).toBeNull()
    expect(photoDayChoice(new Date(2026, 8, 30, 12), NOW)).toBeNull()
  })

  // MUTATION: drop the preselect effect -> Today stays pressed and this reds.
  it('an older Snap photo opens on its own day, and writes it', async () => {
    render(<Host photo={file()} photoPreview="blob:snap" photoTakenAt={new Date(2026, 8, 20, 12)} />)
    await waitFor(() => expect(screen.getByTestId('start-when-date').value).toBe('2026-09-20'))
    expect(pressed('start-when-earlier')).toBe('true')
    type('start-label', 'Pepper mash')
    await startIt()
    await waitFor(() => expect(kbPosts()).toHaveLength(1))
    expect(body()).toMatchObject({ started_at: new Date(2026, 8, 20).toISOString(), start_precision: 'day', start_anchor_kind: 'manual' })
  })

  it('a photo taken today keeps Today; a restored draft is never overridden', async () => {
    render(<Host photo={file()} photoPreview="blob:snap" photoTakenAt={new Date(2026, 8, 29, 6)} />)
    await act(async () => { await Promise.resolve() })
    expect(pressed('start-when-today')).toBe('true')
    cleanup()
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'start', savedAt: Date.now(),
      data: { label: 'x', chip: 'unsure', earlier: null, pickedDate: '', kind: null, kindOther: '' } }))
    render(<Host photo={file()} photoPreview="blob:snap" photoTakenAt={new Date(2026, 8, 20, 12)} />)
    await act(async () => { await Promise.resolve() })
    expect(pressed('start-when-unsure')).toBe('true')
  })
})
