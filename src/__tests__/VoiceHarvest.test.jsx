// V5-HARVESTVOICEFLOW-001 — the first user-facing voice slice, and the first time the grammar and
// the commit debouncer run against real data rather than inside the /admin probe.
//
// WHAT THESE TESTS ARE FOR. Dave's own framing decides the priorities: "a silent wrong save is worse
// than a slow form", and BUG-VOICEFAILSILENT-001 verbatim — "I DON'T JUST MISS IT COMPLETELY AND
// BELIEVE IT WAS FINE. A SILENT FAIL IS A LOST LOG." So the cases that matter most here are not the
// happy path; they are the four ways a spoken record can fail to become a row, each of which must be
// impossible to mistake for success.
//
// The recogniser is driven through the SHARED fake (helpers/fakeSpeechRecognition.js), which models
// the `onend -> start -> onstart` re-arm loop the device proved is the dominant path. transcribe.js
// is deliberately NOT mocked — this page does not use it, and mocking it would hide that.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
// Haptics touch navigator.vibrate and a localStorage preference; neither is the subject here, and a
// real call would make the assertions depend on jsdom's vibrate stub rather than on the flow.
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(), hapticSaveFailed: vi.fn(),
  hapticDigitAccepted: vi.fn(), hapticDigitRejected: vi.fn(), hapticUndoApplied: vi.fn(),
}))

import VoiceHarvest, { matchPlantings, resolveCommandCollision, plantingAliases } from '../pages/VoiceHarvest.jsx'

const planting = (id, name, slug, unit = null) => ({
  id, name, archived_at: null,
  variety_ref: { id: `v-${id}`, name: `${name} cultivar`, crop_type_slug: slug, default_unit: unit },
})

const PLANTS = [
  planting('p1', 'Suyo Long', 'cucumber'),
  planting('p2', 'Marketmore', 'cucumber'),
  planting('p3', 'Chinese Red Noodle', 'bean'),
  planting('p4', 'Pineapple Tomatillo', 'tomatillo', 'count'),
]

let mic

beforeEach(() => {
  mic = installFakeSpeechRecognition(vi)
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: PLANTS })
    return Promise.resolve({ eventId: 'evt-1' })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// Start the mic and hand back the live fake. Everything downstream drives this.
async function startListening() {
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}

// One spoken utterance, settled. A DATA final commits at the session boundary; a WRITE command
// deliberately does not, and waits out the settle window on a tick — so a command needs its timer to
// land, which is what `advance` covers.
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}

const statusText = () => screen.getByTestId('voice-harvest-status').textContent
const record = () => screen.getByTestId('voice-harvest-record').textContent
const harvestPosts = () =>
  apiFetchSpy.mock.calls.filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')

describe('matchPlantings — what a planting can be called out loud', () => {
  it('matches on the crop type, not just the cultivar name', () => {
    // V4-SEARCHCROPTYPE-001's reason, made worse by speech: a recogniser has no chance on "Suyo
    // Long" and every chance on "cucumber".
    expect(matchPlantings(PLANTS, 'cucumber').map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('promotes an EXACT alias match over a merely-containing one', () => {
    // The case promotion exists for: a decoy whose NAME contains the spoken word without being it.
    // "cucumber" must not offer the trap crop alongside the cucumbers.
    const decoy = planting('p6', 'Cucumber Beetle Trap Crop', 'nasturtium')
    const hits = matchPlantings([...PLANTS, decoy], 'cucumber')
    expect(hits.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('does NOT narrow to the one planting literally NAMED the crop — every cucumber is a cucumber', () => {
    // A planting called "Cucumber" is exact on its name and p1/p2 are exact on their crop slug, so
    // all three are equally what he asked for. Narrowing to the name-match would silently hide two
    // real plantings behind a naming coincidence, and he would have to notice the absence to correct
    // it. Offering the choice is the honest answer.
    const hits = matchPlantings([...PLANTS, planting('p5', 'Cucumber', 'cucumber')], 'cucumber')
    expect(hits.map((p) => p.id)).toEqual(['p1', 'p2', 'p5'])
  })

  it('is voice-forgiving in the same way the picker is (looseKey)', () => {
    expect(matchPlantings(PLANTS, 'chinese').map((p) => p.id)).toEqual(['p3'])
  })

  it('returns nothing for an empty or unmatched utterance rather than everything', () => {
    expect(matchPlantings(PLANTS, '')).toEqual([])
    expect(matchPlantings(PLANTS, 'rhubarb')).toEqual([])
  })

  it('aliases are name, cultivar name and crop slug — nothing else', () => {
    expect(plantingAliases(PLANTS[0])).toEqual(['Suyo Long', 'Suyo Long cultivar', 'cucumber'])
  })
})

describe('resolveCommandCollision — a planting can be named after a command word', () => {
  it('demotes a command to a search when a planting is named EXACTLY that', () => {
    const plants = [planting('p9', 'Next', 'brassica')]
    const cmd = { kind: 'command', command: 'save_and_advance', transcript: 'next' }
    expect(resolveCommandCollision(cmd, plants).kind).toBe('search')
  })

  it('does NOT demote on a partial match — "save" must survive growing a Savoy', () => {
    const plants = [planting('p9', 'Savoy Cabbage', 'brassica')]
    const cmd = { kind: 'command', command: 'save', transcript: 'save' }
    expect(resolveCommandCollision(cmd, plants)).toBe(cmd)
  })

  it('leaves non-commands untouched', () => {
    const data = { kind: 'weight', value: 231, unit: 'g', transcript: '231 grams' }
    expect(resolveCommandCollision(data, PLANTS)).toBe(data)
  })
})

describe('VoiceHarvest — the spoken record', () => {
  it('a full spoken record posts ONE harvest with the values that were said', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, '231 grams')
    await speak(rec, 'next')
    // The write waits out the settle window; only a tick can commit it.
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    const posts = harvestPosts()
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0][1].body)
    expect(body.plant_id).toBe('p1')
    expect(body.event_type).toBe('harvest')
    expect(body.harvest).toMatchObject({ quantity: 3, unit: 'count', weight: 231, weight_unit: 'g' })
    // The container is derived server-side (deriveEventProjectId) — the client must not guess one.
    expect(body.project_id).toBeNull()
    // C8: the row says how it was captured, so voice rows are separable from typed ones later.
    expect(body.metadata).toMatchObject({ harvest_input_source: 'voice' })
    vi.useRealTimers()
  })

  it('names what it saved and leaves an undoable row — the loud confirmation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(statusText()).toContain('Saved Suyo Long')
    expect(statusText()).toContain('3 count')
    expect(screen.getAllByTestId('voice-harvest-row')).toHaveLength(1)
    expect(screen.getByLabelText(/Undo Suyo Long/)).toBeDefined()
    vi.useRealTimers()
  })

  it('CLEARS the record after a save so the next crop starts empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(record()).not.toContain('Suyo Long')
    vi.useRealTimers()
  })

  it('offers a choice when several plantings match, and saves NOTHING until one is picked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'cucumber')
    expect(statusText()).toContain('2 match')
    expect(screen.getAllByRole('button', { name: /Suyo Long|Marketmore/ }).length).toBeGreaterThan(0)

    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('still need a crop')
    vi.useRealTimers()
  })
})

describe('VoiceHarvest — the four ways a spoken record must fail LOUDLY', () => {
  it('refuses to save with no quantity, and KEEPS the record rather than advancing over it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(0)
    expect(statusText()).toContain('still need a quantity')
    // THE PROPERTY THAT MATTERS: the planting is still selected. Advancing over an unsaveable record
    // is how a picking is silently lost — the failure V101 found in /log's own save_and_advance.
    expect(record()).toContain('Suyo Long')
    vi.useRealTimers()
  })

  it('says NOT SAVED on a POST failure, keeps the record, and lets "next" retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')

    apiFetchSpy.mockImplementationOnce(() => Promise.reject(new Error('offline')))
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(statusText()).toContain('NOT SAVED')
    expect(record()).toContain('Suyo Long')
    expect(screen.queryAllByTestId('voice-harvest-row')).toHaveLength(0)

    // THE RETRY. A failed write releases the cooldown (invalidateLastWrite), so saying "next" again
    // inside the 1500 ms window is a real retry rather than being swallowed as a transport duplicate.
    // Without that release, the user's only natural recovery is dead for longer than they will wait.
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(harvestPosts()).toHaveLength(2)
    expect(statusText()).toContain('Saved Suyo Long')
    vi.useRealTimers()
  })

  it('says so when nothing matched, instead of leaving the last crop selected', async () => {
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'rhubarb')
    expect(statusText()).toContain('Nothing matched')
    expect(statusText()).toContain('rhubarb')
  })

  it('routes a near-miss of a command to "say it again", never to a different action', async () => {
    // "text" is a MEASURED 1-in-9 mishear of "next" on Dave's Android (2026-08-28 probe). The grammar
    // sends it to `unparsed` rather than letting it become a search, because a mishear that performs
    // a DIFFERENT action and looks like it worked is worse than one that does nothing.
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'text')
    expect(statusText()).toContain('say "next" again')
    expect(harvestPosts()).toHaveLength(0)
    expect(record()).toContain('Suyo Long')
  })
})

describe('VoiceHarvest — the mic itself', () => {
  it('re-arms on its own after every utterance, with no further taps', async () => {
    const rec = await startListening()
    expect(rec.startCount).toBe(1)
    await act(async () => { rec.endSession() })
    expect(rec.startCount).toBe(2)
  })

  it('RELEASES the mic on unmount, handlers detached first', async () => {
    // The leak this pins is the one S1 fixed on the OTHER hook (useVoiceInput had no useEffect at
    // all, so a recogniser it started outlived the component). Leaving this route is the primary
    // escape hatch for the whole slice — "close it if it misbehaves" is only true if closing it
    // actually stops the mic. Handlers are detached BEFORE abort because a teardown can still
    // dispatch, and a final arriving after unmount would commit against nothing.
    const view = render(<VoiceHarvest />)
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    const rec = mic.latest()
    expect(rec.started).toBe(true)

    await act(async () => { view.unmount() })
    expect(rec.started).toBe(false)
    expect(rec.onresult).toBeNull()
    expect(rec.onend).toBeNull()
    expect(rec.onerror).toBeNull()
  })

  it('stops listening on "done" without saving anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'done')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(statusText()).toContain('Stopped')
    expect(harvestPosts()).toHaveLength(0)
    vi.useRealTimers()
  })

  it('undo deletes the event and strikes the row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    await act(async () => { fireEvent.click(screen.getByLabelText(/Undo Suyo Long/)) })
    await waitFor(() => expect(
      apiFetchSpy.mock.calls.some(([u, o]) => u === '/api/events/evt-1' && o?.method === 'DELETE'),
    ).toBe(true))
    expect(statusText()).toContain('Removed Suyo Long')
    vi.useRealTimers()
  })
})
