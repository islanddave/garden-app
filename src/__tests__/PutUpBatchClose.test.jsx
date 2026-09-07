// V5-KBCLOSE-001 — closing a batch: the staged sheet, the wire, and the rulings this new surface
// carries that no shipped sweep can see.
//
// ⚠ WHY THIS FILE EXISTS AT ALL, and it is the single largest risk in the build. Every food-safety
// and readiness sweep in this repo is scoped to `screen.getByTestId('going-now-view')`. The moment
// this copy moved onto a NEW surface, all eight inherited rulings went unguarded — and the old
// sweeps stayed GREEN, because the assertion did not break, it stopped being about anything. This
// file is the replacement: its own root testid (`batch-close-sheet`), and a green control on every
// arm so a sweep over an empty string cannot pass for a pass.
//
// AND THE SWEEP RUNS AT BOTH STEPS. The form unmounts on submit, which is exactly how a prior sweep
// in this repo went vacuous — it ran after the element it asserted about had gone. Each step carries
// its own anchor (`batch-close-step-kept` / `batch-close-step-outcome`) and each sweep proves it is
// standing on that anchor before it claims anything.
//
// ⚠ THE `spoil` ARM IS DELIBERATELY NOT COPIED FROM THE CARD'S SWEEP. On the Going-now card no
// spelling of "spoil" may appear. Here, "It spoiled — threw it out" is the FINAL adjudicated label
// and the whole point of splitting `discarded_spoiled` from `consumed`. The arm that replaces it is
// stricter and is the one that actually matters: no RAW OUTCOME VALUE may reach the DOM in any
// attribute or text node.
//
// TEST-SHAPE RULES: full literals; every assertion about THE WIRE (which verb, which path, which
// body), because a door that renders and calls the wrong route is the same defect wearing a UI.
//
// CI LANE: `npm test` (vitest run --coverage) plus the blocking TZ=America/New_York re-run. Nothing
// here formats a date, so the TZ lane is a no-op over this file.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import { P } from '../lib/constants.js'
import BatchCloseField, { CLOSE_DRAFT_KEY } from '../components/putup/BatchCloseField.jsx'
import { CLOSE_OUTCOMES } from '../components/putup/batchClose.js'
import { readDraft, writeDraft, draftKey } from '../lib/draftStash.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')

// jsdom normalises inline colour to rgb(), so a regex over hex matches nothing and passes whatever
// the element is painted. Convert first — this repo shipped two vacuous colour assertions.
const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const ALARM_INKS = [P.terra, P.warnBorder, P.severityUrgent].map(toRgb)
const hasNoAlarmInk = (el) => ALARM_INKS.every(ink => !el.outerHTML.includes(ink))

// NOON UTC, not 16:00Z: a half-width margin is how a date literal becomes zone-dependent by accident.
const FIRST_RECORDED_SEP_3 = '2026-09-03T12:00:00.000Z'

const MASH = {
  id: 'kb-mash', user_id: 'user_dave', label: 'Pepper mash', kind: null, kind_other: null,
  started_at: null, start_precision: null, first_recorded_at: FIRST_RECORDED_SEP_3,
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null,
  current_stage_kind: 'started', current_stage_entered_at: FIRST_RECORDED_SEP_3,
  input_count: '139', output_count: '0',
}
const FERMENT = { ...MASH, id: 'kb-ferment', label: 'Reaper mash', kind: 'ferment' }
// The two-user pair. A single-owner fixture cannot fail an ownership bug in a two-person household.
const JEN_BATCH = { ...MASH, id: 'kb-jen', user_id: 'user_jen', label: "Jen's plum butter", kind: 'candy' }
const CLOSED = {
  ...MASH, id: 'kb-closed', closed_at: '2026-09-04T12:00:00.000Z', outcome: 'put_up',
  outcome_note: 'two pints', input_count: '139', output_count: '2',
}

const JAR = {
  id: '11111111-1111-4111-8111-111111111111', harvest_log_id: null, batch_id: null,
  preserved_at: '2026-08-12', quantity_value: '3', quantity_unit: 'pint', package_count: 3,
  use_by_target: '2026-11-12', use_by_status: 'use_soon',
}
const JARS = { group_by: 'crop', groups: [{ group_key: 'pepper', label: 'Peppers', records: [JAR] }] }

function route({ close = { id: 'kb-mash', closed_at: 'x' }, stage = { stage: {}, batch: {} }, jars = JARS } = {}) {
  fetchMock.mockImplementation((path) => {
    if (String(path).startsWith('/api/preservation/whats-put-up')) return Promise.resolve(jars)
    if (String(path).endsWith('/stages')) return Promise.resolve(stage)
    if (String(path).endsWith('/close')) return Promise.resolve(close)
    return Promise.reject(new Error(`unexpected path ${path}`))
  })
}

const renderField = (batch = MASH, onChanged = vi.fn()) =>
  render(<BatchCloseField batch={batch} onChanged={onChanged} />)

const openTo = (step, batch = MASH, onChanged = vi.fn()) => {
  const r = renderField(batch, onChanged)
  fireEvent.click(screen.getByTestId('batch-close-open'))
  if (step === 'kept') return r
  fireEvent.click(screen.getByTestId(step === 'yes' ? 'batch-close-kept-yes' : 'batch-close-kept-no'))
  return r
}

beforeEach(() => {
  fetchMock.mockReset()
  try { sessionStorage.clear() } catch { /* no storage in this jsdom build */ }
  route()
})

describe('BatchCloseField — the door', () => {
  it('offers a question, not an imperative, and never spends the word "Finish"', () => {
    renderField()
    const btn = screen.getByTestId('batch-close-open')
    expect(btn.textContent).toBe('What happened to it? →')
    expect(btn.textContent).not.toMatch(/finish/i)
    expect(btn.style.color).toBe(toRgb(P.green))
  })

  it('is absent on a batch that is already closed', () => {
    const { container } = renderField(CLOSED)
    expect(screen.queryByTestId('batch-close-open')).toBeNull()
    expect(container.innerHTML).toBe('')
    // GREEN CONTROL: the identical render on the SAME fixture with closed_at cleared DOES offer it,
    // so the absence above is about the closed state and not about a broken selector.
    renderField({ ...CLOSED, closed_at: null, outcome: null })
    expect(screen.getByTestId('batch-close-open')).toBeTruthy()
  })

  it('renders nothing at all without a batch', () => {
    const { container } = render(<BatchCloseField batch={null} onChanged={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('declines cleanly: the labelled Close leaves the batch exactly as it was', () => {
    const onChanged = vi.fn()
    openTo('no', MASH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    fireEvent.click(screen.getByLabelText('Leave this batch going'))
    expect(screen.queryByTestId('batch-close-sheet')).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/close'))).toEqual([])
    // GREEN CONTROL: the door is back, so the sheet closed rather than the component unmounting.
    expect(screen.getByTestId('batch-close-open')).toBeTruthy()
  })
})

describe('BatchCloseField — two steps, not one screen', () => {
  it('opens on the kept question and shows no outcome yet', () => {
    openTo('kept')
    expect(screen.getByTestId('batch-close-step-kept')).toBeTruthy()
    expect(screen.queryByTestId('batch-close-step-outcome')).toBeNull()
    expect(screen.getByTestId('batch-close-step-kept').textContent)
      .toContain('Did it make anything you kept?')
  })

  it('offers exactly the two "kept" outcomes on Yes, with their full labels', () => {
    openTo('yes')
    const chips = screen.getAllByTestId(/^batch-close-outcome-/)
    expect(chips.map(c => c.textContent)).toEqual([
      'Put it up',
      'Put it up — but not what I set out to make',
    ])
    expect(screen.queryByTestId('batch-close-step-kept')).toBeNull()
  })

  it('offers exactly the four "not kept" outcomes on No', () => {
    openTo('no')
    expect(screen.getAllByTestId(/^batch-close-outcome-/).map(c => c.textContent)).toEqual([
      'Ate it',
      'Gave it away',
      'It spoiled — threw it out',
      'Gave up on it',
    ])
  })

  it('never puts all six on one surface', () => {
    openTo('yes')
    expect(screen.getAllByTestId(/^batch-close-outcome-/)).toHaveLength(2)
    fireEvent.click(screen.getByTestId('batch-close-back'))
    fireEvent.click(screen.getByTestId('batch-close-kept-no'))
    expect(screen.getAllByTestId(/^batch-close-outcome-/)).toHaveLength(4)
  })

  it('goes back to the question without losing the sheet', () => {
    openTo('no')
    fireEvent.click(screen.getByTestId('batch-close-back'))
    expect(screen.getByTestId('batch-close-step-kept')).toBeTruthy()
    expect(screen.getByTestId('batch-close-sheet')).toBeTruthy()
  })

  it('offers the jar picker only on the branch that produced jars', async () => {
    openTo('yes')
    await screen.findByTestId('jar-picker')
    // GREEN CONTROL on the same component, one tap apart: the No branch does not.
    fireEvent.click(screen.getByTestId('batch-close-back'))
    fireEvent.click(screen.getByTestId('batch-close-kept-no'))
    expect(screen.queryByTestId('jar-picker')).toBeNull()
  })

  it('keys the cue placeholder off the batch kind', () => {
    openTo('no', FERMENT)
    expect(screen.getByTestId('batch-close-cue').getAttribute('placeholder')).toBe('bubbling stopped')
  })

  it('falls back to a neutral placeholder on a kind-less batch', () => {
    openTo('no', MASH)
    expect(screen.getByTestId('batch-close-cue').getAttribute('placeholder')).toBe('what made you call it?')
  })
})

describe('BatchCloseField — the wire', () => {
  it('closes in EXACTLY ONE request, carrying the cue on the close body', async () => {
    const onChanged = vi.fn()
    openTo('no', MASH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    fireEvent.change(screen.getByTestId('batch-close-cue'), { target: { value: 'ran out' } })
    fireEvent.change(screen.getByTestId('batch-close-note'), { target: { value: '  the last of it  ' } })
    fireEvent.click(screen.getByTestId('batch-close-submit'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const calls = fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/kitchen-batches'))
    // The SERVER writes the `finished` stage row from cue_observed, in the same statement as the
    // close and gated on the `closed` CTE. A client-side /stages POST would be a second writer for
    // one act and would put TWO `finished` rows on the batch.
    expect(calls.map(c => String(c[0]))).toEqual(['/api/kitchen-batches/kb-mash/close'])
    expect(calls[0][1].method).toBe('POST')
    expect(JSON.parse(calls[0][1].body)).toEqual({
      outcome: 'consumed', outcome_note: 'the last of it', cue_observed: 'ran out',
    })
  })

  it('issues no /stages request at all — and the same query proves the close DID go out', async () => {
    const onChanged = vi.fn()
    openTo('no', MASH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    fireEvent.change(screen.getByTestId('batch-close-cue'), { target: { value: 'ran out' } })
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))

    // ONE fetch-mock query, split two ways: the absence and its green control are the same
    // derivation over the same recorded calls, so the absence cannot pass because nothing ran.
    const paths = fetchMock.mock.calls.map(c => String(c[0]))
    expect(paths.filter(p => p.endsWith('/stages'))).toEqual([])
    expect(paths.filter(p => p.endsWith('/close'))).toEqual(['/api/kitchen-batches/kb-mash/close'])
  })

  it('sends the jar ids the cook actually picked', async () => {
    const onChanged = vi.fn()
    openTo('yes', MASH, onChanged)
    await screen.findByTestId('jar-picker-list')
    fireEvent.click(screen.getByTestId(`jar-picker-toggle-${JAR.id}`))
    fireEvent.click(screen.getByTestId('batch-close-outcome-kept'))
    fireEvent.click(screen.getByTestId('batch-close-submit'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const close = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/close'))
    expect(JSON.parse(close[1].body)).toEqual({
      outcome: 'put_up', output_preservation_log_ids: [JAR.id],
    })
  })

  it('sends no cue key when nothing was typed — a NULL cue is the server\'s honest record', async () => {
    const onChanged = vi.fn()
    openTo('no', MASH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-gaveup'))
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const close = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/close'))
    const body = JSON.parse(close[1].body)
    expect(body).toEqual({ outcome: 'abandoned' })
    expect(body.cue_observed).toBeUndefined()
    // The server still writes the `finished` row — it is written on every close, cue or no cue — so
    // an absent key records that nobody said how they knew rather than inventing that they did.
    // GREEN CONTROL for the absence: the SAME field on the SAME component does reach the wire when
    // it is filled, asserted one describe up ("closes in EXACTLY ONE request, carrying the cue").
    expect(String(close[0])).toBe('/api/kitchen-batches/kb-mash/close')
  })

  it('closes a peer\'s batch through the peer\'s own id — scoping is the server\'s job', async () => {
    const onChanged = vi.fn()
    openTo('no', JEN_BATCH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-gave'))
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    const close = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/close'))
    expect(close[0]).toBe('/api/kitchen-batches/kb-jen/close')
    expect(JSON.parse(close[1].body)).toEqual({ outcome: 'given_away' })
  })

  it('will not submit until an outcome is picked', () => {
    openTo('no')
    expect(screen.getByTestId('batch-close-submit').disabled).toBe(true)
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    expect(screen.getByTestId('batch-close-submit').disabled).toBe(false)
  })
})

describe('BatchCloseField — a failed write keeps what was entered', () => {
  it('reports the batch is still open and holds the outcome, cue and note', async () => {
    fetchMock.mockImplementation((path) => {
      if (String(path).endsWith('/close')) return Promise.reject(new Error('network'))
      return Promise.resolve({})
    })
    const onChanged = vi.fn()
    openTo('no', MASH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-binned'))
    fireEvent.change(screen.getByTestId('batch-close-cue'), { target: { value: 'went furry' } })
    fireEvent.click(screen.getByTestId('batch-close-submit'))

    const alert = await screen.findByTestId('batch-close-error')
    expect(alert.textContent)
      .toBe('Couldn’t record that — the batch is still open. Try again; what you picked is still here.')
    expect(onChanged).not.toHaveBeenCalled()
    expect(screen.getByTestId('batch-close-cue').value).toBe('went furry')
    expect(screen.getByTestId('batch-close-outcome-binned').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('batch-close-sheet')).toBeTruthy()
  })

  it('retries the close and nothing else — one request per attempt, never a stray second writer', async () => {
    let closeAttempts = 0
    fetchMock.mockImplementation((path) => {
      if (String(path).endsWith('/close')) {
        closeAttempts += 1
        return closeAttempts === 1 ? Promise.reject(new Error('network')) : Promise.resolve({})
      }
      return Promise.resolve({})
    })
    const onChanged = vi.fn()
    openTo('no', MASH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    fireEvent.change(screen.getByTestId('batch-close-cue'), { target: { value: 'ran out' } })
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    await screen.findByTestId('batch-close-error')
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))

    const kbPaths = fetchMock.mock.calls
      .map(c => String(c[0])).filter(p => p.startsWith('/api/kitchen-batches'))
    // Two attempts, two requests. The `finished` row is the server's to write inside the close
    // statement, so a failed attempt leaves NOTHING behind and a retry duplicates nothing.
    expect(kbPaths).toEqual([
      '/api/kitchen-batches/kb-mash/close',
      '/api/kitchen-batches/kb-mash/close',
    ])
    // GREEN CONTROL: the second attempt really did fire, so "two and only two" is about the wire and
    // not about the retry never happening.
    expect(closeAttempts).toBe(2)
    // And the cue rode on BOTH — a retry that dropped it would silently lose the record.
    for (const c of fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/close'))) {
      expect(JSON.parse(c[1].body).cue_observed).toBe('ran out')
    }
  })

  it('names the 409 for what it is instead of offering a retry that cannot work', async () => {
    fetchMock.mockImplementation((path) => {
      if (String(path).endsWith('/close')) {
        const e = new Error('This batch is already closed')
        e.status = 409
        return Promise.reject(e)
      }
      return Promise.resolve({})
    })
    openTo('no')
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    const alert = await screen.findByTestId('batch-close-error')
    expect(alert.textContent).toBe('This batch is already closed — reload to see it.')
  })
})

describe('BatchCloseField — the draft survives a deploy reload', () => {
  it('stashes what was entered under a batch-scoped key', () => {
    openTo('no')
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    fireEvent.change(screen.getByTestId('batch-close-note'), { target: { value: 'nothing left' } })
    const draft = readDraft(CLOSE_DRAFT_KEY)
    expect(draft.batchId).toBe('kb-mash')
    expect(draft.outcome).toBe('consumed')
    expect(draft.note).toBe('nothing left')
    expect(draft.step).toBe('outcome')
  })

  it('restores a draft written against the SAME batch', () => {
    writeDraft(CLOSE_DRAFT_KEY, {
      batchId: 'kb-mash', step: 'outcome', kept: false, outcome: 'abandoned',
      note: 'lost track', cue: 'gave up', ids: [],
    })
    renderField()
    fireEvent.click(screen.getByTestId('batch-close-open'))
    expect(screen.getByTestId('batch-close-outcome-gaveup').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('batch-close-note').value).toBe('lost track')
    expect(screen.getByTestId('batch-close-cue').value).toBe('gave up')
  })

  it('refuses a draft written against a DIFFERENT batch', () => {
    writeDraft(CLOSE_DRAFT_KEY, {
      batchId: 'kb-somebody-else', step: 'outcome', kept: false, outcome: 'abandoned',
      note: 'lost track', cue: 'gave up', ids: [],
    })
    renderField()
    fireEvent.click(screen.getByTestId('batch-close-open'))
    expect(screen.getByTestId('batch-close-step-kept')).toBeTruthy()
    expect(screen.queryByTestId('batch-close-step-outcome')).toBeNull()
  })

  it('clears the stash once the close lands', async () => {
    const onChanged = vi.fn()
    openTo('no', MASH, onChanged)
    fireEvent.click(screen.getByTestId('batch-close-outcome-ate'))
    expect(readDraft(CLOSE_DRAFT_KEY)).not.toBeNull()
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(readDraft(CLOSE_DRAFT_KEY)).toBeNull()
  })

  it('uses a permanent route key — renaming it orphans live drafts', () => {
    expect(CLOSE_DRAFT_KEY).toBe('put-up/batch-close')
    expect(draftKey(CLOSE_DRAFT_KEY)).toBe('gardenApp.draft.put-up/batch-close')
  })
})

describe('BatchCloseField — no raw outcome value ever reaches the DOM', () => {
  it('renders labels and testid slugs, never the stored enum, on either branch', () => {
    openTo('yes')
    let html = screen.getByTestId('batch-close-sheet').innerHTML
    for (const o of CLOSE_OUTCOMES) expect(html).not.toContain(o.value)
    expect(html).toContain('Put it up')

    fireEvent.click(screen.getByTestId('batch-close-back'))
    fireEvent.click(screen.getByTestId('batch-close-kept-no'))
    html = screen.getByTestId('batch-close-sheet').innerHTML
    for (const o of CLOSE_OUTCOMES) expect(html).not.toContain(o.value)
    // GREEN CONTROL on the same render: the labels for those very values ARE present, so the arms
    // above are about the machine value and not about an empty surface.
    expect(html).toContain('It spoiled — threw it out')
    expect(html).toContain('Gave up on it')
  })
})

describe('BatchCloseField — the inherited rulings, swept at BOTH steps', () => {
  const FOOD_SAFETY = /acidif|shelf.stab|\bsafe\b|\bsafety\b|botul/i
  const READINESS = /\bdue\b|\bremaining\b|\boverdue\b|\bready\b|\bdays left\b|\blate\b/i
  const ACID_NUMBER = /(?<![\d.])(4\.60|4\.6|4\.4|4\.2|4\.1|4\.0|3\.8|3\.3|5\.0)(?!\d)(?!\.\d)/

  it('step 1 says nothing about acidification, safety, shelf stability or readiness', () => {
    openTo('kept', FERMENT)
    // THE STEP ANCHOR. The sweep proves it is standing on step 1 before it claims anything — a sweep
    // that ran after the step unmounted is exactly how one in this repo went vacuous.
    expect(screen.getByTestId('batch-close-step-kept')).toBeTruthy()
    const html = screen.getByTestId('batch-close-sheet').innerHTML
    expect(html).not.toMatch(FOOD_SAFETY)
    expect(html).not.toMatch(READINESS)
    expect(html).not.toMatch(ACID_NUMBER)
    expect(html).not.toMatch(/role="progressbar"/)
    expect(screen.getByTestId('batch-close-sheet').querySelector('progress')).toBeNull()
    // GREEN CONTROL: step 1's own copy is on screen, so the five arms swept a populated surface.
    expect(html).toContain('Did it make anything you kept?')
  })

  it('step 2 says nothing about acidification, safety, shelf stability or readiness', async () => {
    openTo('yes', FERMENT)
    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('batch-close-step-outcome')).toBeTruthy()
    const html = screen.getByTestId('batch-close-sheet').innerHTML
    expect(html).not.toMatch(FOOD_SAFETY)
    expect(html).not.toMatch(READINESS)
    expect(html).not.toMatch(ACID_NUMBER)
    expect(html).not.toMatch(/Use soon|Past use-by|use by/i)
    expect(html).not.toMatch(/role="progressbar"/)
    // GREEN CONTROLS: the outcome copy AND the jar row are both on screen, so the arms above swept
    // the fully-populated step and not a half-mounted one.
    expect(html).toContain('How did you know it was done?')
    expect(html).toContain('Peppers · 3 pint · Aug 12')
  })

  it('paints no alarm ink on either step, and the error string is the one sanctioned exception', async () => {
    // STEP 1 FIRST, with its own anchor. Mutation K10 (paint a step-1 control in P.terra) survived
    // when this assertion only ran on step 2 — the step it was about had already unmounted, which is
    // the same vacuity this file's two-step sweeps exist to prevent.
    openTo('kept', FERMENT)
    expect(screen.getByTestId('batch-close-step-kept')).toBeTruthy()
    expect(hasNoAlarmInk(screen.getByTestId('batch-close-sheet'))).toBe(true)
    fireEvent.click(screen.getByTestId('batch-close-kept-yes'))

    await screen.findByTestId('jar-picker-list')
    expect(screen.getByTestId('batch-close-step-outcome')).toBeTruthy()
    expect(hasNoAlarmInk(screen.getByTestId('batch-close-sheet'))).toBe(true)

    fetchMock.mockImplementation((path) => (String(path).endsWith('/close')
      ? Promise.reject(new Error('network'))
      : Promise.resolve(JARS)))
    fireEvent.click(screen.getByTestId('batch-close-outcome-kept'))
    fireEvent.click(screen.getByTestId('batch-close-submit'))
    await screen.findByTestId('batch-close-error')
    // GREEN CONTROL for the helper itself: it CAN see P.terra when P.terra is on screen, so the
    // clean result above is a real absence and not a regex that matches nothing (jsdom normalises
    // every inline colour to rgb(), which is how two shipped colour assertions went vacuous).
    expect(hasNoAlarmInk(screen.getByTestId('batch-close-sheet'))).toBe(false)
    expect(screen.getByTestId('batch-close-error').style.color).toBe(toRgb(P.terra))
  })

  it('holds the mandated Sheet contract in source: busy={saving} and armsBack', () => {
    const raw = readFileSync(resolve(REPO, 'src/components/putup/BatchCloseField.jsx'), 'utf8')
    // DECOMMENTED, and this is load-bearing rather than tidy: the file's own header explains WHY
    // `busy={saving}` is mandatory, and it says so by quoting it. A raw-source scan therefore
    // matched the prose and stayed green with the prop deleted — mutation L3-14 survived exactly
    // once, against the raw form, and this is the fix. Same reason VarietyPicker.tapFloor.test.js
    // decomments: the fix's own comment names the thing the guard hunts.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
    // GREEN CONTROL on the read AND on the decommenter: the declaration survives stripping, and the
    // header prose does not — so a moved file or an over-eager strip cannot leave this vacuous.
    expect(src).toContain('export default function BatchCloseField')
    expect(raw).toContain('IS MANDATORY, not decorative')
    expect(src).not.toContain('IS MANDATORY, not decorative')
    // Close is NOT idempotent (a second POST is a 409), so a stray backdrop tap or an Escape
    // mid-write must not discard the surface. jsdom cannot deliver an Android Back gesture, so the
    // contract is asserted where it is written.
    expect(src).toMatch(/busy=\{saving\}/)
    expect(src).toMatch(/\barmsBack\b/)
  })
})
