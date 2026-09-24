// V5-VOICECARE-001 — the voice path on Log many, driven end to end on the REAL page.
//
// What is real here: LogMany, LogManyVoice, the real ScopeChecklist, lib/transcribe.js, the mic
// arbiter, the grammar, the resolver and the batch client. What is faked: the recogniser (the shared
// fake that models Chrome's session loop) and the far side of the wire (apiFetch). Assertions are on
// the POSTed bodies — a read-back that looks right is not a batch that is.
//
// DAVE-SHAPED DATA, NOT A TOY GARDEN (L-499). The plantings and the 21-node location tree are the
// 2026-09-23 prod snapshot in voiceCare.fixture.js, served as the RAW picker payload (no crop_aliases —
// the page attaches them from the crop-type vocabulary, as it does in the app) and the aliases are HIS
// taught heard-forms, served the way GET /api/varieties/voice-aliases serves them. The VoiceHarvest
// suites once served `[]` for aliases and a blocker walked straight past them; "cucumber one" below is
// the case that proves this page actually loads and uses his.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within, cleanup, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { U, LOCATIONS, byName, dryRunResponse, locationByPath } from './voiceCare.fixture.js'
import { looseKey } from '../lib/comboboxInput.js'
import { resetMicArbiter, acquireMic, micHolder } from '../lib/micArbiter.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

installStoragePolyfill()

const navigate = vi.fn()
const location = { pathname: '/log/many', search: '', state: {} }
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  useLocation: () => location,
  Link: ({ children }) => children,
}))

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch, getToken: vi.fn(async () => null) }) }))

import LogMany from '../pages/LogMany.jsx'
import { CONFIRM_WINDOW_MS, REARM_DELAY_MS, HELD_RECHECKS } from '../components/LogManyVoice.jsx'

const BAG = locationByPath('Pasture > Bag Area')
const IN_GROUND = locationByPath('Pasture > In-Ground')

// GET /api/locations, in the server's own two-part shape (lambda/locations/index.js).
const LOCATIONS_RES = {
  locations: LOCATIONS.map(({ id, name, level, parent_id }, i) => ({ id, name, level, parent_id, sort_order: i })),
  locations_with_path: LOCATIONS.map(({ id, full_path, level }) => ({ id, full_path, level, is_active: true })),
}
// The picker projection as the Lambda returns it: no crop_aliases on the row.
const PICKER = U.map(({ crop_aliases: _drop, ...p }) => ({
  ...p, archived_at: null, variety_ref: p.variety_ref && { ...p.variety_ref, default_unit: null },
}))
// The crop-type vocabulary those aliases came from.
const CROP_TYPES = [...new Map(U.filter((p) => p.variety_ref?.crop_type_slug).map((p) => [p.variety_ref.crop_type_slug, {
  slug: p.variety_ref.crop_type_slug,
  display_name: p.variety_ref.crop_type_slug,
  category: 'vegetable',
  search_aliases: p.crop_aliases?.length ? p.crop_aliases.join(', ') : null,
}])).values()]
// His taught heard-forms (lane-G §2e: 30 rows, all his). Each maps to the variety he corrected it to.
const aliasRow = (heard, plantingName) => ({
  heard_key: looseKey(heard), heard_text: heard, variety_id: byName(plantingName).variety_ref.id,
  hit_count: 0, last_used_at: null,
})
const DAVE_ALIASES = [
  aliasRow('cucumber one', 'Suyo Long'),
  aliasRow('studio long', 'Suyo Long'),
  aliasRow("damn i'll see you", 'Cucamelon'),
  aliasRow('squash', 'Zephyr Squash'),
  aliasRow('orange', 'Tender Sweet Orange'),
  aliasRow('green', 'Cherokee Green'),
  aliasRow('striped roman', 'Speckled Roman'),
  aliasRow('stupid chica', 'Stupice'),
  aliasRow('honeydew', 'Green Flesh'),
  aliasRow('rescue', 'Cherry Rescue 1'),
]

let mic
let writeReply
let deleteReply
let locationsReply
const posts = []
const deletes = []

beforeEach(() => {
  navigate.mockClear()
  posts.length = 0
  deletes.length = 0
  writeReply = null
  deleteReply = null
  locationsReply = LOCATIONS_RES
  resetMicArbiter()
  clearReloadBlocks()
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  mic = installFakeSpeechRecognition(vi)
  apiFetch.mockReset()
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve(locationsReply)
    if (path === '/api/plants?view=picker') return Promise.resolve({ plants: PICKER })
    if (path === '/api/varieties/crop-types') return Promise.resolve(CROP_TYPES)
    if (path === '/api/varieties/voice-aliases') return Promise.resolve({ aliases: DAVE_ALIASES })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      posts.push(body)
      if (body.dry_run) {
        if (body.scope?.type === 'space') return Promise.resolve(dryRunResponse(body.scope.location_id))
        return Promise.resolve({ count: 0, capped: false, plantings: [] })
      }
      if (typeof writeReply === 'function') return writeReply(body)
      return Promise.resolve({ batch_id: 'b-voice-1', count: body.scope.plant_ids.length, event_ids: [] })
    }
    if (String(path).startsWith('/api/events/batch/') && opts.method === 'DELETE') {
      deletes.push(path)
      if (typeof deleteReply === 'function') return deleteReply(path)
      return Promise.resolve({ undone: true, batch_id: path.split('/').pop() })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const dryRuns = () => posts.filter((b) => b.dry_run && b.scope?.type === 'space')
const writes = () => posts.filter((b) => !b.dry_run)
const frame = () => screen.getByTestId('lmv-frame')
const inFrame = () => within(frame())
const idsIn = (loc) => dryRunResponse(loc.id).plantings.map((p) => p.id)

async function openPage() {
  render(<LogMany />)
  return screen.findByTestId('lmv-start')
}
// One utterance, delivered the way Chrome Android does it: a final, then the session ends.
async function speak(text, rec = mic.latest()) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}
async function sayCommand(text) {
  await openPage()
  fireEvent.click(screen.getByTestId('lmv-start'))
  await speak(text)
}
async function sayCommandToReadBack(text) {
  await sayCommand(text)
  await screen.findByTestId('lmv-readback')
  // The confirm session starts by itself — no tap — once the read-back is on screen.
  await waitFor(() => expect(mic.latest().started).toBe(true))
  return mic.latest()
}

describe('Log many — the voice entry', () => {
  it('sits on the page when the browser can listen, and is absent when it cannot', async () => {
    await openPage()
    expect(screen.getByTestId('lmv-start').textContent).toContain('Log by voice')
    cleanup()
    vi.unstubAllGlobals()
    render(<LogMany />)
    await screen.findByText('What happened?')
    expect(screen.queryByTestId('lmv-start')).toBeNull()
  })

  it('review MINOR-4: a location row voice cannot read turns voice OFF and the manual form still loads', async () => {
    // careLocations reads every row of BOTH halves of GET /api/locations, and `locations_with_path`
    // is read by nothing else on this page. It runs in the page's only load `.then`, so before the
    // guard one unreadable row there sent the whole manual form to its error screen.
    locationsReply = { ...LOCATIONS_RES, locations_with_path: [null, ...LOCATIONS_RES.locations_with_path] }
    render(<LogMany />)
    await screen.findByText('What happened?')
    // The manual form is whole: its scope chips (fed by the same response) and its commit button.
    expect(screen.getByText('By zone')).toBeTruthy()
    await screen.findByText(/^Log watered on \d+$/)
    // Voice alone is off.
    expect(screen.queryByTestId('lmv-start')).toBeNull()
  })
})

describe('"water all bag area" — the happy path', () => {
  it('dry-runs the area, reads back, and on "next" writes the named ids with the voice marker', async () => {
    const confirmRec = await sayCommandToReadBack('water all bag area')

    expect(dryRuns()).toEqual([{ dry_run: true, event_type: 'watering', scope: { type: 'space', location_id: BAG.id } }])
    expect(inFrame().getByTestId('lmv-readback').textContent).toBe('Water 101 in Pasture > Bag Area.')
    expect(inFrame().getByTestId('lmv-heard').textContent).toBe('Heard: “water all bag area”')
    // The checklist twin: the same area, the same count, nothing skipped.
    expect(inFrame().getByText(/^Log/, { selector: 'p' }).textContent).toBe('Log watered on 101 plantings')
    expect(writes()).toEqual([])
    expect(mic.instances.length).toBe(2)

    await speak('next', confirmRec)

    await screen.findByText('✓ 101 plantings watered')
    expect(writes()).toEqual([{
      idempotency_key: expect.any(String),
      event_type: 'watering',
      scope: { type: 'ids', plant_ids: idsIn(BAG) },
      metadata: { care_input_source: 'voice' },
    }])
    expect(screen.getByText('in Pasture > Bag Area')).toBeTruthy()
    expect(screen.getByTestId('logmany-voice-recorded').textContent).toBe('Logged by voice, for today.')
    // The form's water-amount line would be a lie here: the voice batch recorded no amount.
    expect(screen.queryByTestId('logmany-depth-recorded')).toBeNull()
    // The critter check wakes exactly as after a manual batch.
    expect(navigate.mock.calls.some(([to, o]) => to === '.' && typeof o?.state?.critterCheck === 'number')).toBe(true)
  })
})

describe('the except example — Dave’s own sentence', () => {
  const SAID = 'fed all pasture in ground except zephyr, crimson sweet, king richard'
  const SKIPPED = ['Zephyr Squash', 'Crimson Sweet', 'King Richard']

  it('names each skip in the read-back, shows it UNTICKED in the checklist, and leaves it out of the write', async () => {
    await sayCommandToReadBack(SAID)
    expect(inFrame().getByTestId('lmv-readback').textContent)
      .toBe('Feed 21 in Pasture > In-Ground, skipping 3: Zephyr Squash, Crimson Sweet, King Richard.')
    expect(inFrame().getByTestId('net-count').textContent).toBe('24 matched − 3 skipped → 21 will be logged')

    fireEvent.click(inFrame().getByRole('button', { name: /Review 24 plantings/ }))
    const list = within(inFrame().getByTestId('sc-review-list'))
    for (const name of SKIPPED) {
      expect(list.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false')
    }
    expect(list.getByRole('button', { name: 'Tender Sweet Orange' }).getAttribute('aria-pressed')).toBe('true')
    // Opening the list is not an edit — the plan is still armed.
    expect(inFrame().getByTestId('lmv-readback')).toBeTruthy()

    // The TAP confirms exactly as "next" does.
    fireEvent.click(inFrame().getByTestId('lmv-confirm'))
    await screen.findByText(/^✓ 21 plantings/)

    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].scope.type).toBe('ids')
    expect(w[0]).not.toHaveProperty('exclude_plant_ids')
    const skippedIds = SKIPPED.map((n) => byName(n).id)
    expect(w[0].scope.plant_ids).toHaveLength(21)
    expect(w[0].scope.plant_ids.filter((id) => skippedIds.includes(id))).toEqual([])
    expect([...w[0].scope.plant_ids].sort()).toEqual(idsIn(IN_GROUND).filter((id) => !skippedIds.includes(id)).sort())
  })

  it('review MINOR-5: the read-back twin cannot change his stored default — no "Start with everything selected"', async () => {
    await sayCommandToReadBack(SAID)
    // The twin is in exactly the state where ScopeChecklist would otherwise render that checkbox:
    // bulk mode, a non-empty area (its Review link renders under the same condition).
    expect(inFrame().getByTestId('sc-mode-bulk').getAttribute('aria-pressed')).toBe('true')
    expect(inFrame().getByRole('button', { name: /Review 24 plantings/ })).toBeTruthy()
    expect(inFrame().queryByTestId('sc-default-all')).toBeNull()
    expect(inFrame().queryByText('Start with everything selected')).toBeNull()
  })

  it('a fuzzy or taught skip is SAID in the read-back with what was heard, and still waits (Q-C)', async () => {
    await sayCommandToReadBack('water all bag area except studio long')
    expect(inFrame().getByTestId('lmv-readback').textContent)
      .toBe('Water 100 in Pasture > Bag Area, skipping 1: Suyo Long — heard ‘studio long’.')
    expect(writes()).toEqual([])
  })
})

describe('refusals — the whole command, nothing written, no confirm window', () => {
  const refusal = () => inFrame().getByTestId('lmv-message').textContent

  it('an unknown area is refused before any request', async () => {
    await sayCommand('water all bag aria')
    await screen.findByTestId('lmv-message')
    expect(inFrame().getByText('Nothing was logged')).toBeTruthy()
    expect(refusal()).toBe('I don’t know an area called “bag aria”.')
    expect(dryRuns()).toEqual([])
    expect(writes()).toEqual([])
    expect(mic.instances.length).toBe(1)
  })

  it('an ambiguous name is refused, naming the candidates', async () => {
    await sayCommand('fed all pasture in ground except king')
    await screen.findByTestId('lmv-message')
    expect(refusal()).toBe('“king” could be King Richard or King of the North.')
    expect(writes()).toEqual([])
    expect(mic.instances.length).toBe(1)
  })

  it('ALL OR NOTHING: one name it cannot find refuses the two it could', async () => {
    await sayCommand('fed all pasture in ground except zephyr, crimson sweet, blorp')
    await screen.findByTestId('lmv-message')
    expect(refusal()).toBe('I couldn’t find “blorp”.')
    expect(writes()).toEqual([])
  })

  it('HIS alias is loaded: "cucumber one" is Suyo Long, which is not in In-Ground', async () => {
    // With no aliases this same sentence reads "could be Cucamelon or Suyo Long" — the difference is
    // the proof the page fetched his list and handed it to the resolver.
    await sayCommand('fed all pasture in ground except cucumber one')
    await screen.findByTestId('lmv-message')
    expect(refusal()).toBe('Suyo Long (heard “cucumber one”) isn’t one of the 24 plants in Pasture > In-Ground.')
    expect(writes()).toEqual([])
  })

  it('words that are not a care command are refused without a request', async () => {
    await sayCommand('hello there')
    await screen.findByTestId('lmv-message')
    expect(refusal()).toContain('doesn’t start with water, feed, mulch or weed')
    expect(dryRuns()).toEqual([])
    expect(writes()).toEqual([])
  })
})

describe('the go-ahead — only "next" or a tap; everything else writes NOTHING', () => {
  it('silence: no words before the window closes cancels, however often Chrome ends the session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await sayCommandToReadBack('water all bag area')
    const before = mic.instances.length
    // Chrome ends silent sessions on its own; the page keeps listening until the deadline.
    for (let i = 0; i < 3; i++) {
      await act(async () => { mic.latest().endSession() })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    }
    expect(mic.instances.length).toBeGreaterThan(before)
    await act(async () => { await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS) })
    await screen.findByText('Cancelled — nothing was logged')
    expect(inFrame().getByTestId('lmv-message').textContent).toBe('No “next” within 20 seconds.')
    expect(writes()).toEqual([])
    // Nothing left listening, and a late "next" from a dead session cannot resurrect it.
    await act(async () => { mic.latest().deliverFinal('next') })
    await act(async () => { mic.latest().endSession() })
    expect(writes()).toEqual([])
  })

  it.each([
    ['yes', 'Heard “yes” — only “next” logs it.'],
    ['next next', 'Heard “next next” — only “next” logs it.'],
    ['except zephyr', 'Heard “except zephyr” — the command was split at a pause. Say it again in one go.'],
  ])('%j cancels', async (said, message) => {
    const rec = await sayCommandToReadBack('water all bag area')
    await speak(said, rec)
    await screen.findByText('Cancelled — nothing was logged')
    expect(inFrame().getByTestId('lmv-message').textContent).toBe(message)
    expect(writes()).toEqual([])
  })

  it('a "next" that Chrome REVISES inside the session is decided on the revision, and cancels', async () => {
    const rec = await sayCommandToReadBack('water all bag area')
    await act(async () => { rec.deliverFinal('next', 0) })
    await act(async () => { rec.deliverFinal('next to the fence', 0) })
    await act(async () => { rec.endSession() })
    await screen.findByText('Cancelled — nothing was logged')
    expect(writes()).toEqual([])
  })

  it('the Cancel tap cancels, and a "next" after it writes nothing', async () => {
    const rec = await sayCommandToReadBack('water all bag area')
    fireEvent.click(inFrame().getByTestId('lmv-cancel'))
    await screen.findByText('Cancelled — nothing was logged')
    await speak('next', rec)
    expect(writes()).toEqual([])
  })

  it('another mic taking over (the checklist’s search mic) is not stolen back; the tap still logs', async () => {
    await sayCommandToReadBack('water all bag area')
    // The arbiter hands the mic to the NEWEST start. The voice listener must not re-arm and take it
    // back from a mic the user just tapped.
    let otherStopped = false
    act(() => { acquireMic('search-field', () => { otherStopped = true }) })
    await screen.findByText(/Another microphone on this screen took over/)
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })   // longer than a re-arm
    expect(micHolder()).toBe('search-field')
    expect(otherStopped).toBe(false)
    fireEvent.click(inFrame().getByTestId('lmv-confirm'))
    await screen.findByText('✓ 101 plantings watered')
    expect(writes()).toHaveLength(1)
  })

  it('editing the list cancels — the read-back no longer describes it', async () => {
    const rec = await sayCommandToReadBack('fed all pasture in ground except zephyr')
    fireEvent.click(inFrame().getByRole('button', { name: /Review 24 plantings/ }))
    fireEvent.click(within(inFrame().getByTestId('sc-review-list')).getByRole('button', { name: 'Crimson Sweet' }))
    await screen.findByText('Cancelled — nothing was logged')
    expect(inFrame().getByTestId('lmv-message').textContent)
      .toBe('The list was changed, so it no longer matches what was read back.')
    await speak('next', rec)
    expect(writes()).toEqual([])
  })
})

// REVIEW MINOR-1 (review-logmany-voice.md) — only a TAP takes the mic. The seat reproduced the voice
// listener taking the mic BACK from another surface: Chrome ends an empty "next" session, the re-arm is
// 150 ms away, the other surface acquires inside that gap, and the re-arm evicted it. The seat's
// control ordering — the other surface acquiring while a voice session is LIVE — is the test above
// ("another mic taking over … is not stolen back"), and it was already right.
describe('the microphone — only a tap takes it (review MINOR-1)', () => {
  it('the race: another surface takes the mic in the re-arm gap, and it is NOT taken back', async () => {
    const rec = await sayCommandToReadBack('water all bag area')
    // CONTROL: with nobody else on the mic, an empty session that Chrome ends IS re-armed — so the
    // "no new session" assertion below is able to fail.
    await act(async () => { rec.endSession() })
    await waitFor(() => expect(mic.latest()).not.toBe(rec))
    const rearmed = mic.latest()
    expect(rearmed.started).toBe(true)
    expect(micHolder()).toBe('log-many-voice')

    // THE RACE: Chrome ends the next empty session, and inside the gap before the re-arm another
    // surface — the checklist's own search mic, the only other one reachable here — takes the mic.
    let otherStopped = false
    await act(async () => { rearmed.endSession() })
    act(() => { acquireMic('search-field', () => { otherStopped = true }) })
    const sessions = mic.instances.length
    await screen.findByText(/Another microphone on this screen took over/)
    // Well past the re-arm and every re-check a held mic gets.
    await act(async () => { await new Promise((r) => setTimeout(r, REARM_DELAY_MS * (HELD_RECHECKS + 3))) })
    expect(micHolder()).toBe('search-field')
    expect(otherStopped).toBe(false)
    expect(mic.instances.length).toBe(sessions)
    expect(writes()).toEqual([])
    // The plan is still armed for the tap.
    fireEvent.click(inFrame().getByTestId('lmv-confirm'))
    await screen.findByText('✓ 101 plantings watered')
    expect(writes()).toHaveLength(1)
  })

  it('the TAP on "Log by voice" still takes the mic from another surface (newest user start wins)', async () => {
    // The fix must not over-reach: every other mic in the app takes the mic on its user's tap
    // (micArbiter.js), and so must this one — a running harvest capture under the overlay included.
    await openPage()
    let otherStopped = false
    act(() => { acquireMic('voice-harvest', () => { otherStopped = true }) })
    fireEvent.click(screen.getByTestId('lmv-start'))
    expect(otherStopped).toBe(true)
    expect(micHolder()).toBe('log-many-voice')
    expect(mic.latest().started).toBe(true)
    await speak('water all bag area')
    await screen.findByTestId('lmv-readback')
  })

  it('our OWN cancelled session still releasing is not "another microphone": the retry listens', async () => {
    // A confirm TAP cancels the live "next" session before writing. Chrome delivers that session's
    // `end` — the moment transcribe.js releases the hold — ASYNCHRONOUSLY after abort(); modelled here
    // on this one instance. A write that fails at once (offline) reopens the window inside that gap.
    let n = 0
    writeReply = (body) => (++n === 1
      ? Promise.reject(Object.assign(new Error('offline'), { status: 0 }))
      : Promise.resolve({ batch_id: 'b-voice-1', count: body.scope.plant_ids.length, idempotent: true }))
    const rec = await sayCommandToReadBack('water all bag area')
    const realAbort = rec.abort.bind(rec)
    rec.abort = () => { setTimeout(realAbort, REARM_DELAY_MS / 2) }
    fireEvent.click(inFrame().getByTestId('lmv-confirm'))
    await screen.findByTestId('lmv-retry-note')
    await waitFor(() => expect(mic.latest()).not.toBe(rec))
    expect(mic.latest().started).toBe(true)
    expect(micHolder()).toBe('log-many-voice')
    expect(screen.queryByText(/Another microphone on this screen took over/)).toBeNull()
    await speak('next', mic.latest())
    await screen.findByText('✓ 101 plantings watered')
    const w = writes()
    expect(w).toHaveLength(2)
    expect(w[1].idempotency_key).toBe(w[0].idempotency_key)
  })
})

describe('after the write', () => {
  it('409 SCOPE_IDS_UNRESOLVED: says something changed, shows no result, writes once', async () => {
    writeReply = () => Promise.reject(Object.assign(new Error('Conflict'), {
      status: 409, body: { code: 'SCOPE_IDS_UNRESOLVED', unresolved_plant_ids: [byName('Zephyr Squash').id] },
    }))
    const rec = await sayCommandToReadBack('water all bag area')
    await speak('next', rec)
    await screen.findByText('Something changed. Say it again.')
    expect(inFrame().getByText('Nothing was logged')).toBeTruthy()
    expect(screen.queryByText(/plantings watered/)).toBeNull()
    expect(writes()).toHaveLength(1)
  })

  it('an unconfirmed write reopens the window for the SAME plan and key', async () => {
    let n = 0
    writeReply = (body) => (++n === 1
      ? Promise.reject(Object.assign(new Error('timeout'), { status: 0 }))
      : Promise.resolve({ batch_id: 'b-voice-1', count: body.scope.plant_ids.length, idempotent: true }))
    const rec = await sayCommandToReadBack('water all bag area')
    await speak('next', rec)
    await screen.findByTestId('lmv-retry-note')
    await waitFor(() => expect(mic.latest()).not.toBe(rec))
    await speak('next', mic.latest())
    await screen.findByText('✓ 101 plantings watered')
    const w = writes()
    expect(w).toHaveLength(2)
    expect(w[1].idempotency_key).toBe(w[0].idempotency_key)
  })

  it('Undo removes the batch through its own route and returns to the form', async () => {
    const rec = await sayCommandToReadBack('water all bag area')
    await speak('next', rec)
    await screen.findByText('✓ 101 plantings watered')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    expect(deletes).toEqual(['/api/events/batch/b-voice-1'])
    await screen.findByTestId('lmv-start')
    expect(screen.queryByText(/plantings watered/)).toBeNull()
  })
})

describe('the page’s own form, mid-edit', () => {
  it('is left alone: the voice write carries none of it, says so, and the form is intact afterwards', async () => {
    await openPage()
    fireEvent.change(screen.getByLabelText('Event date (leave as today, or back-date)'), { target: { value: '2026-09-20' } })
    fireEvent.click(screen.getByTestId('logmany-notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes for this batch'), { target: { value: 'soaker hose' } })

    fireEvent.click(screen.getByTestId('lmv-start'))
    await speak('water all bag area')
    await screen.findByTestId('lmv-readback')
    expect(inFrame().getByTestId('lmv-notice').textContent)
      .toBe('Voice logs only what it read back, for today. The back-date and note on the form are kept but not used.')
    await waitFor(() => expect(mic.latest().started).toBe(true))
    await speak('next', mic.latest())
    await screen.findByText('✓ 101 plantings watered')

    const [w] = writes()
    expect(w).not.toHaveProperty('event_date')
    expect(w).not.toHaveProperty('notes')
    expect(screen.queryByTestId('logmany-note-recorded')).toBeNull()

    // The note was NOT written, so the reload guard must still be holding it on the result screen.
    expect(isReloadBlocked()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Log more' }))
    expect((await screen.findByLabelText('Event date (leave as today, or back-date)')).value).toBe('2026-09-20')
    expect(screen.getByLabelText('Notes for this batch').value).toBe('soaker hose')
  })

  it('Undo of a voice batch leaves the form’s own draft alone', async () => {
    await openPage()
    fireEvent.click(screen.getByTestId('logmany-notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes for this batch'), { target: { value: 'side-dressed' } })
    fireEvent.click(screen.getByTestId('lmv-start'))
    await speak('water all bag area')
    await screen.findByTestId('lmv-readback')
    await waitFor(() => expect(mic.latest().started).toBe(true))
    await speak('next', mic.latest())
    await screen.findByText('✓ 101 plantings watered')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    expect(deletes).toEqual(['/api/events/batch/b-voice-1'])
    expect((await screen.findByLabelText('Notes for this batch')).value).toBe('side-dressed')
    expect(sessionStorage.getItem('gardenApp.draft.logmany')).toContain('side-dressed')
  })

  it('Undo that finds the batch already gone (404) is not reported as a failure', async () => {
    const rec = await sayCommandToReadBack('water all bag area')
    await speak('next', rec)
    await screen.findByText('✓ 101 plantings watered')
    deleteReply = () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    await screen.findByTestId('lmv-start')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
