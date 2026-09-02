// VarietyPicker × the REAL transcribe.js — gate B3.
//
// VarietyPickerKeyboard.test.jsx and cropTypeSearchClientParity.test.jsx both render VarietyPicker
// with ../lib/transcribe.js mocked; the first even documents its stub as a deliberate "seam", which
// is right for what those files pin (the inputmode contract, the server rescue) and is exactly why
// neither can see the wrapper. This is the non-mocked half, over the SHARED fake recogniser
// (gate B4).
//
// VarietyPicker reaches transcribe.js through lib/comboboxInput.js, the hook PlantingSelect uses
// too — so this and PlantingSelect.micArbiter.test.jsx cover the same call site from its two
// consumers. They are not redundant: the hook is the shared half, and each picker wires
// `onVoiceText` to a different query pipeline.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { isMicHeld, micHolder, resetMicArbiter } from '../lib/micArbiter.js'

const apiFetchSpy = vi.hoisted(() => vi.fn())
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

import VarietyPicker from '../components/VarietyPicker.jsx'

const VARIETIES = [
  { id: 'v-1', name: 'Cherokee Purple', crop_type_slug: 'tomato' },
  { id: 'v-2', name: 'Brandywine', crop_type_slug: 'tomato' },
]

let mic

beforeEach(() => {
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation(() => Promise.resolve(VARIETIES))
  resetMicArbiter()
  mic = installFakeSpeechRecognition(vi)
})

afterEach(() => {
  cleanup()
  resetMicArbiter()
  vi.unstubAllGlobals()
})

const field = () => screen.getByRole('combobox')
const micBtn = () => screen.getByLabelText(/Speak to search varieties|Stop listening/)

// Real .focus(), not fireEvent.focus() — the mic button only renders while the list is open
// (`showMicBtn = open && ...`), and only real focus opens it.
async function openAndListen() {
  const view = render(<VarietyPicker value={null} onChange={() => {}} aria-label="Variety" />)
  field().focus()
  await act(async () => { await Promise.resolve() })
  await act(async () => { fireEvent.click(micBtn()) })
  // Asserted before latest(): an empty list would make every assertion below run against undefined.
  expect(mic.instances.length, 'no recogniser was constructed — the real transcribe.js did not run').toBe(1)
  return { view, rec: mic.latest() }
}

describe('VarietyPicker × real transcribe.js — the transcript that reaches the query', () => {
  it('joins separate finals with a single space and searches on the whole utterance', async () => {
    const { rec } = await openAndListen()
    expect(micHolder()).toBe('Picker')

    await act(async () => { rec.deliverFinal('cherokee', 0) })
    await act(async () => { rec.deliverFinal('purple', 1) })

    // comboboxInput passes NO onResult — the picker deliberately searches once, on the completed
    // utterance, rather than re-querying per interim. So the entire transcript this surface ever
    // sees is the wrapper's slot-joined `finalTranscript`, delivered at onEnd.
    expect(field().value).toBe('')
    await act(async () => { rec.stop() })

    expect(field().value).toBe('cherokee purple')
    expect(screen.getByLabelText('Speak to search varieties')).toBeTruthy()
  })
})

describe('VarietyPicker × real transcribe.js — leaving mid-listen', () => {
  it('unmount aborts the real session and hands the mic back', async () => {
    const { view, rec } = await openAndListen()
    await act(async () => { rec.deliverFinal('brandywine', 0) })
    expect(rec.started).toBe(true)
    expect(isMicHeld()).toBe(true)

    // A route change mid-listen. The hook's cleanup calls the wrapper's cancel(), which must abort
    // the recogniser rather than stop it: stop() is the graceful shutdown that asks the engine to
    // FINALISE, i.e. the dispatch a component being torn down is specifically trying not to receive.
    await act(async () => { view.unmount() })

    expect(rec.started).toBe(false)
    expect(isMicHeld()).toBe(false)
  })
})
