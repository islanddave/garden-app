// Search × the REAL transcribe.js — gate B3.
//
// FIVE suites render pages/Search.jsx with ../lib/transcribe.js mocked — Search.test.jsx,
// Search.server.test.jsx, SearchPeek.test.jsx, cropTypeAliasClient.test.jsx and
// cropTypeSearchClientParity.test.jsx — and every one of them stubs isTranscriptionSupported to
// FALSE, so the mic button never even renders in them. Search's voice path has, until now, had zero
// coverage of any kind. This is it, driving the real wrapper over the SHARED fake recogniser
// (gate B4).
//
// The api mock defines `fetch` ONCE in the factory rather than per useApiFetch() call, for the
// reason spelled out in Search.test.jsx: the real hook returns a useCallback'd identity, and a mock
// that mints a new one per render makes useCropTypes' effect re-run forever and HANGS the suite.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { acquireMic, isMicHeld, micHolder, resetMicArbiter } from '../lib/micArbiter.js'

const SAMPLE = {
  '/api/plants': [{ id: 'p1', project_id: 'pr1', name: 'Cherokee Purple' }],
  '/api/locations': [{ id: 'l1', name: 'Greenhouse Bench' }],
  '/api/varieties': [],
}
vi.mock('../lib/api.js', () => {
  const fetch = async (path) => SAMPLE[path] ?? []
  return { useApiFetch: () => ({ fetch }) }
})

import Search from '../pages/Search.jsx'

let mic

beforeEach(() => {
  resetMicArbiter()
  mic = installFakeSpeechRecognition(vi)
})

afterEach(() => {
  cleanup()
  resetMicArbiter()
  vi.unstubAllGlobals()
})

const box = () => screen.getByLabelText('Search your garden')

async function startVoiceSearch() {
  render(<MemoryRouter initialEntries={['/search']}><Search /></MemoryRouter>)
  // speechOk is read at render time, so the fake has to be installed before this point — it is,
  // in beforeEach. If it were not, this query throws and the failure names the cause.
  const btn = await screen.findByLabelText('Voice search')
  await act(async () => { fireEvent.click(btn) })
  // Asserted before latest(): an empty list would make every assertion below run against undefined.
  expect(mic.instances.length, 'no recogniser was constructed — the real transcribe.js did not run').toBe(1)
  return mic.latest()
}

describe('Search × real transcribe.js — a revised final', () => {
  it('ends the session with the REVISION in the box, not the prefix and not both', async () => {
    const rec = await startVoiceSearch()

    await act(async () => { rec.deliverFinal('cherokee', 0) })
    expect(box().value).toBe('cherokee')

    // Same slot, revised — Chrome finalising "cherokee" early on an enunciated pause. The wrapper
    // suppresses the emit (Search's onResult would otherwise overwrite the box with it), but it
    // still REPLACES the slot, so the session's final transcript is the longer utterance.
    await act(async () => { rec.deliverFinal('cherokee purple', 0) })
    await act(async () => { rec.stop() })

    // The whole point of re-joining from the slots instead of appending: a revision never leaves a
    // stale prefix behind. Appending would search for "cherokee cherokee purple" and find nothing.
    expect(box().value).toBe('cherokee purple')
  })

  it('joins separate finals with a single space', async () => {
    const rec = await startVoiceSearch()

    await act(async () => { rec.deliverFinal('greenhouse', 0) })
    await act(async () => { rec.deliverFinal('bench', 1) })
    await act(async () => { rec.stop() })

    expect(box().value).toBe('greenhouse bench')
  })
})

describe('Search × real transcribe.js — the mic arbiter hold', () => {
  it('another surface taking the mic stops this one gracefully, keeping what was already heard', async () => {
    const rec = await startVoiceSearch()
    expect(micHolder()).toBe('Search')
    expect(screen.getByLabelText('Stop voice search')).toBeTruthy()

    await act(async () => { rec.deliverFinal('greenhouse bench', 0) })

    // What another start-path does. Eviction uses the GRACEFUL stop, not abort: the words already
    // spoken belong to THIS caller's own field, so the finalising onend must still land here.
    await act(async () => { acquireMic('SomeOtherSurface', () => {}) })

    expect(rec.started).toBe(false)
    expect(screen.queryByLabelText('Stop voice search')).toBe(null)
    expect(box().value).toBe('greenhouse bench')
    // The evicted owner's late release must NOT steal the mic back from its new holder.
    expect(isMicHeld()).toBe(true)
    expect(micHolder()).toBe('SomeOtherSurface')
  })
})
