// PlantingSelectKeyboard.test.jsx — V4-PICKERKB-002 + V4-PICKERVOICE-001.
//
// Dave, prod smoke 2026-08-03: "It should act the same on every place where I can pick a
// planting unless we've carved out an exception. For now, I don't know of an exception."
// This suite pins the PlantingSelect side of that contract — the same pins
// VarietyPickerKeyboard.test.jsx holds for the picker the mechanism shipped on.
//
// WHAT THIS CAN PROVE (same scoping as the VarietyPicker suite): whether Chrome Android actually
// raises/withholds the on-screen keyboard is not observable in jsdom. What IS deterministic is
// the contract the browser reads — the `inputmode` attribute and the focus state — plus, for
// voice, the wiring from a final transcript to the query to the filtered list. The microphone
// itself, recognition quality, and the permission prompt belong to the device pass.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const apiFetchSpy = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

// The transcribe seam (src/lib/transcribe.js) is the ONLY thing between the hook and the Web
// Speech API, which jsdom does not have. The mock records each session and exposes its callbacks
// so tests can play the browser's part.
const transcribe = vi.hoisted(() => ({ supported: false, sessions: [] }))
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => transcribe.supported,
  startLiveTranscription: (opts) => {
    const session = {
      opts,
      stop: vi.fn(() => opts.onEnd?.({ finalTranscript: session.finalOnStop ?? '' })),
      cancel: vi.fn(),
      finalOnStop: '',
    }
    transcribe.sessions.push(session)
    return session
  },
}))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'

// Dave's four spoken examples from the directive, as planting names.
const PLANTS = [
  { id: 'p1', name: 'Sunray', quantity: 1 },
  { id: 'p2', name: 'Chili Red', quantity: 1 },
  { id: 'p3', name: 'Minnesota Mini', quantity: 1 },
  { id: 'p4', name: 'Spineless', quantity: 1 },
]

beforeEach(() => {
  transcribe.supported = false
  transcribe.sessions.length = 0
})

const field = () => screen.getByRole('combobox')
const kbBtn = () => screen.queryByLabelText('Type to search plantings')
const micBtn = () => screen.queryByLabelText(/Speak to search plantings|Stop listening|Microphone unavailable/)

async function openPicker(props = {}) {
  render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" {...props} />)
  field().focus()
  await act(async () => { await Promise.resolve() })
}

describe('V4-PICKERKB-002 — PlantingSelect opens without asking for the keyboard', () => {
  it('declares inputmode="none" when the list opens, so the on-screen keyboard stays down', async () => {
    await openPicker()
    expect(field().getAttribute('inputmode')).toBe('none')
  })

  it('still holds focus — the combobox contract survives suppressing the keyboard', async () => {
    await openPicker()
    expect(document.activeElement).toBe(field())
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  it('offers the ⌨ control only while the list is open', async () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    expect(kbBtn()).toBeNull()
    field().focus()
    await act(async () => { await Promise.resolve() })
    expect(kbBtn()).toBeTruthy()
  })

  it('switches to inputmode="text" when ⌨ is used, then hides the control', async () => {
    await openPicker()
    fireEvent.click(kbBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('text'))
    expect(kbBtn()).toBeNull()
  })

  it('keeps the list open through the deliberate blur+refocus the inputMode swap requires', async () => {
    await openPicker()
    fireEvent.click(kbBtn())
    fireEvent.blur(field())
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  it('reverts to keyboard-free on the next open — one opt-in does not become the default', async () => {
    await openPicker()
    fireEvent.click(kbBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('text'))
    field().blur()
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })
    field().focus()
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('inputmode')).toBe('none')
    expect(kbBtn()).toBeTruthy()
  })

  it('typing still works with the keyboard suppressed — hardware keyboards are unaffected', async () => {
    await openPicker()
    fireEvent.change(field(), { target: { value: 'Spine' } })
    expect(field().value).toBe('Spine')
    expect(screen.getByText('Spineless')).toBeTruthy()
  })
})

describe('V4-PICKERVOICE-001 — the 🎤 mode', () => {
  it('renders no mic where the Web Speech API is missing (jsdom, Firefox) — fully inert', async () => {
    await openPicker()
    expect(micBtn()).toBeNull()
  })

  it('offers the mic while the list is open when speech is supported', async () => {
    transcribe.supported = true
    await openPicker()
    expect(screen.getByLabelText('Speak to search plantings')).toBeTruthy()
  })

  it('final transcript lands in the query and the existing filter runs on it', async () => {
    transcribe.supported = true
    await openPicker()
    fireEvent.click(screen.getByLabelText('Speak to search plantings'))
    expect(transcribe.sessions.length).toBe(1)
    // The browser hears Dave say "Sunray" as two words.
    await act(async () => { transcribe.sessions[0].opts.onEnd({ finalTranscript: 'sun ray' }) })
    expect(field().value).toBe('sun ray')
    expect(screen.getByText('Sunray')).toBeTruthy()          // normalization bridges the gap
    expect(screen.queryByText('Spineless')).toBeNull()       // and still actually filters
  })

  it('marks listening state accessibly and stops on second tap', async () => {
    transcribe.supported = true
    await openPicker()
    fireEvent.click(screen.getByLabelText('Speak to search plantings'))
    const listening = screen.getByLabelText('Stop listening')
    expect(listening.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(listening)
    expect(transcribe.sessions[0].stop).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByLabelText('Speak to search plantings')).toBeTruthy())
  })

  it('mic denial degrades to a quiet disabled state — no modal, no toast', async () => {
    transcribe.supported = true
    await openPicker()
    fireEvent.click(screen.getByLabelText('Speak to search plantings'))
    await act(async () => { transcribe.sessions[0].opts.onError('denied') })
    const denied = screen.getByLabelText('Microphone unavailable')
    expect(denied.getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('non-denial errors quietly return to idle — the recovery path is typing', async () => {
    transcribe.supported = true
    await openPicker()
    fireEvent.click(screen.getByLabelText('Speak to search plantings'))
    await act(async () => { transcribe.sessions[0].opts.onError('no-speech') })
    expect(screen.getByLabelText('Speak to search plantings')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('voice-forgiving matching stays a WIDENING of typed search', () => {
  it.each([
    ['sun ray', 'Sunray'],
    ['chilli red', 'Chili Red'],
    ['minnesota mini', 'Minnesota Mini'],
    ['spine less', 'Spineless'],
  ])('spoken %j surfaces %j', async (spoken, expected) => {
    await openPicker()
    fireEvent.change(field(), { target: { value: spoken } })
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it('every match the strict filter found is still found (old-yes => new-yes)', async () => {
    await openPicker()
    fireEvent.change(field(), { target: { value: 'chili' } })
    expect(screen.getByText('Chili Red')).toBeTruthy()
    fireEvent.change(field(), { target: { value: 'SUN' } })
    expect(screen.getByText('Sunray')).toBeTruthy()
  })

  it('garbage still misses — normalization is not a match-everything pass', async () => {
    await openPicker()
    fireEvent.change(field(), { target: { value: 'zzz quartz' } })
    expect(screen.getByText(/No plantings match/)).toBeTruthy()
  })
})
