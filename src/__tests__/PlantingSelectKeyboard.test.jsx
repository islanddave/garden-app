// PlantingSelectKeyboard.test.jsx — V4-PICKERKB-002 + V4-PICKERVOICE-001 + V4-PICKERKBDEF-001.
//
// Dave, prod smoke 2026-08-03: "It should act the same on every place where I can pick a
// planting unless we've carved out an exception. For now, I don't know of an exception."
// This suite pins the PlantingSelect side of that contract — the same pins
// VarietyPickerKeyboard.test.jsx holds for the picker the mechanism shipped on.
//
// V4-PICKERKBDEF-001 (Dave, 2026-08-16) INVERTS the default for THIS picker only: it now opens
// keyboard-ready. The first describe below therefore pins the opposite of what it used to, and
// VarietyPickerKeyboard.test.jsx is the regression pin that the flip did not leak through the
// shared hook.
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
const typeBtn = () => screen.queryByLabelText('Type to search plantings')
const hideBtn = () => screen.queryByLabelText('Hide the keyboard and browse plantings')
const kbBtn = () => typeBtn() ?? hideBtn()
const micBtn = () => screen.queryByLabelText(/Speak to search plantings|Stop listening|Microphone unavailable/)

async function openPicker(props = {}) {
  render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" {...props} />)
  field().focus()
  await act(async () => { await Promise.resolve() })
}

describe('V4-PICKERKBDEF-001 — PlantingSelect opens keyboard-ready', () => {
  it('declares inputmode="text" when the list opens, so the tap that focused it raises the keyboard', async () => {
    await openPicker()
    expect(field().getAttribute('inputmode')).toBe('text')
  })

  // The keyboard-open default is carried ENTIRELY by inputmode. If a future change reaches for
  // autoFocus instead, Chrome Android would ignore it on the gesture path (no user activation on a
  // mount-time focus) and it would steal focus everywhere else — so the absence is a pin, not a gap.
  it('does not focus itself on mount — the user gesture is the only thing that opens the keyboard', async () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(document.body)
    expect(field().getAttribute('aria-expanded')).toBe('false')
    expect(field().hasAttribute('autofocus')).toBe(false)
  })

  // V4-HARVFAB-001's programmatic open is the one path with no tap behind it. It must open the
  // PANEL without taking focus, or the harvest FAB lands on a keyboard nobody asked for.
  it('autoOpen shows the list without stealing focus', async () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" autoOpen />)
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(document.body)
  })

  it('still holds focus once opened — the combobox contract is unchanged by the flip', async () => {
    await openPicker()
    expect(document.activeElement).toBe(field())
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  it('offers the toggle only while the list is open', async () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    expect(kbBtn()).toBeNull()
    field().focus()
    await act(async () => { await Promise.resolve() })
    expect(hideBtn()).toBeTruthy()
    expect(hideBtn().getAttribute('aria-pressed')).toBe('true')
  })

  // The escape hatch V4-PICKERKB-001 exists for: browse the whole list with no keyboard in the way.
  it('⌄ drops back to inputmode="none" and the slot becomes the ⌨ control again', async () => {
    await openPicker()
    fireEvent.click(hideBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('none'))
    expect(typeBtn()).toBeTruthy()
    expect(typeBtn().getAttribute('aria-pressed')).toBe('false')
  })

  it('round-trips back to inputmode="text" from the ⌨ control', async () => {
    await openPicker()
    fireEvent.click(hideBtn())
    await waitFor(() => expect(typeBtn()).toBeTruthy())
    fireEvent.click(typeBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('text'))
    expect(hideBtn()).toBeTruthy()
  })

  it('keeps the list open through the deliberate blur+refocus the inputMode swap requires', async () => {
    await openPicker()
    fireEvent.click(hideBtn())
    fireEvent.blur(field())
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  it('reverts to keyboard-ready on the next open — hiding it once is not sticky', async () => {
    await openPicker()
    fireEvent.click(hideBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('none'))
    field().blur()
    await act(async () => { await new Promise(r => setTimeout(r, 250)) })
    field().focus()
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('inputmode')).toBe('text')
    expect(hideBtn()).toBeTruthy()
  })

  // Re-entering the picker from chip mode is a tap on "Change", so Chrome's transient user
  // activation still covers the setTimeout(0) refocus — the same mechanism the ⌨ swap relies on.
  it('re-opening from the chip "Change" button returns a keyboard-ready focused field', async () => {
    render(<PlantingSelect value="p1" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    expect(document.activeElement).toBe(field())
    expect(field().getAttribute('inputmode')).toBe('text')
  })

  it('typing still works with the keyboard suppressed — hardware keyboards are unaffected', async () => {
    await openPicker()
    fireEvent.click(hideBtn())
    await waitFor(() => expect(field().getAttribute('inputmode')).toBe('none'))
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

// BUG-PICKERUNDISMISSABLE-001 — the autoOpen panel above opens with no focus behind it (by
// design, per V4-HARVFAB-001 just above), so Escape/Tab/onBlur are all unreachable: every one of
// them fires off a focus->blur transition, and nothing was ever focused to blur FROM. Before this
// fix a real device had no way to close it short of picking a row — including when the list
// failed to load or simply didn't contain what the user wanted. This pins the fallback.
describe('BUG-PICKERUNDISMISSABLE-001 — an un-focused autoOpen panel is still touch-dismissable', () => {
  it('closes on an outside tap even though nothing was ever focused', async () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" autoOpen />)
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(document.body)   // still unfocused — the autoOpen contract
    fireEvent.pointerDown(document.body)
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves row selection untouched — a tap inside the panel is never "outside"', async () => {
    const onChange = vi.fn()
    render(<PlantingSelect value="" onChange={onChange} plants={PLANTS} aria-label="Planting" autoOpen />)
    await act(async () => { await Promise.resolve() })
    const row = screen.getByTestId('ps-opt-p1')
    fireEvent.pointerDown(row)   // the same event the fallback listens for, aimed INSIDE the panel
    fireEvent.click(row)
    expect(onChange).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'p1' }))
  })

  it('leaves the picker in an ordinary, reopenable state after the fallback closes it', async () => {
    render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" autoOpen />)
    await act(async () => { await Promise.resolve() })
    fireEvent.pointerDown(document.body)
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('aria-expanded')).toBe('false')
    field().focus()
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(field())
  })

  // Scope guard: the fallback attaches only while focus has never landed, so a picker opened the
  // ORDINARY way (a tap that focuses the field, every one of the six other call sites) gets no
  // new listener at all — a bare outside pointerdown with no accompanying blur must leave it open,
  // exactly as it did before this fix.
  it('adds no new listener once the field already holds real focus', async () => {
    await openPicker()
    expect(field().getAttribute('aria-expanded')).toBe('true')
    fireEvent.pointerDown(document.body)
    await act(async () => { await Promise.resolve() })
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })
})
