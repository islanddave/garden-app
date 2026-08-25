// V4-HANDEDNESSCONTROLS-001 (BD-054) — the picker's ⌨/🎤/✕ slots follow the handedness setting.
//
// THIS IS THE DEFECT BD-054 WAS FILED ABOUT, in Dave's own words: on "choose a planting" the
// MICROPHONE sits on the RIGHT of the field, which is the far side for his logging thumb during a
// weigh-in (right hand moves fruit onto the scale, left hand works the phone).
//
// These are absolute `right:`/`left:` offsets, so — unlike every other site wired to this setting —
// DOM order proves nothing here and the assertions have to be on the computed offsets. jsdom does
// report inline `style.left`/`style.right` verbatim, which is exactly what this component sets, so
// the claim is falsifiable without the harness. Actual PIXEL positions are not, and are not claimed.
//
// The transcribe seam is mocked the same way PlantingSelectKeyboard.test.jsx mocks it — jsdom has
// no Web Speech API, so without this the 🎤 slot never renders and the central case is untestable.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const apiFetchSpy = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

const transcribe = vi.hoisted(() => ({ supported: false, sessions: [] }))
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => transcribe.supported,
  startLiveTranscription: (opts) => {
    const session = { opts, stop: vi.fn(), cancel: vi.fn() }
    transcribe.sessions.push(session)
    return session
  },
}))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import {
  kbToggleBtnStyle, micToggleBtnStyle, closeToggleBtnStyle, toggleSlotsPaddingStyle,
} from '../lib/comboboxInput.js'
import { HANDEDNESS_KEY } from '../lib/handedness.js'
import { T } from '../components/forms/formStyles.js'

const PLANTS = [
  { id: 'p1', name: 'Sunray', quantity: 1 },
  { id: 'p2', name: 'Chili Red', quantity: 1 },
]

beforeEach(() => {
  transcribe.supported = true
  transcribe.sessions.length = 0
  localStorage.clear()
})

const field = () => screen.getByRole('combobox')
const kbBtn = () => screen.queryByLabelText(/Type to search plantings|Hide the keyboard and browse plantings/)
const micBtn = () => screen.queryByLabelText(/Speak to search plantings|Stop listening|Microphone unavailable/)
const closeBtn = () => screen.queryByLabelText('Close the planting list')

async function openPicker() {
  render(<PlantingSelect value="" onChange={() => {}} plants={PLANTS} aria-label="Planting" />)
  field().focus()
  await act(async () => { await Promise.resolve() })
}

describe('comboboxInput slot styles — the pure edge arithmetic', () => {
  it('right-handed (the default, unset) reproduces the shipped offsets exactly', () => {
    // V4-PICKERKB-001's shipped geometry: ⌨ at right:0, 🎤 at right:44, ✕ appended beyond both.
    expect(kbToggleBtnStyle(undefined).right).toBe(0)
    expect(kbToggleBtnStyle(undefined).left).toBeUndefined()
    expect(micToggleBtnStyle('idle', undefined).right).toBe(44)
    expect(closeToggleBtnStyle(true, undefined).right).toBe(88)
    expect(closeToggleBtnStyle(false, undefined).right).toBe(44)
    expect(toggleSlotsPaddingStyle({ showKb: true, showMic: true, showClose: true })).toEqual({ paddingRight: 136 })
  })

  it('left-handed mirrors every slot to the left edge, keeping their order off that edge', () => {
    expect(kbToggleBtnStyle('left').left).toBe(0)
    expect(kbToggleBtnStyle('left').right).toBeUndefined()
    expect(micToggleBtnStyle('idle', 'left').left).toBe(44)
    // BUG-PICKERUNDISMISSABLE-001's rule survives mirroring: ✕ is APPENDED beyond the two shipped
    // slots, never inserted between them, so it still takes the OUTERMOST occupied position.
    expect(closeToggleBtnStyle(true, 'left').left).toBe(88)
    expect(closeToggleBtnStyle(false, 'left').left).toBe(44)
  })

  it('moves the input padding with the slots — otherwise the query runs under them', () => {
    expect(toggleSlotsPaddingStyle({ showKb: true, showMic: true, showClose: true, hand: 'left' }))
      .toEqual({ paddingLeft: 136 })
    // No slot occupied → null, not {}, so the caller's `togglePad ? … : base` branch is unchanged.
    expect(toggleSlotsPaddingStyle({ showKb: false, showMic: false, hand: 'left' })).toBeNull()
  })

  it('keeps the mic state styling independent of the edge', () => {
    // Mirroring must not quietly drop the listening/denied tones — they are the only feedback that
    // the mic is live.
    expect(micToggleBtnStyle('listening', 'left').backgroundColor).toBeTruthy()
    expect(micToggleBtnStyle('denied', 'left').opacity).toBe(0.35)
  })
})

describe('PlantingSelect — the slots as rendered', () => {
  it('right-handed: ⌨/🎤/✕ sit on the right, unchanged from what shipped', async () => {
    await openPicker()
    expect(kbBtn().style.right).toBe('0px')
    expect(micBtn().style.right).toBe('44px')
    expect(closeBtn().style.right).toBe('88px')
    // The far side keeps inputChrome's base field padding — only the slot side is widened.
    expect(field().style.paddingRight).toBe('136px')
    expect(field().style.paddingLeft).toBe(`${T.fieldPadX}px`)
  })

  it('LEFT-handed: the microphone lands on the thumb side — BD-054’s named defect', async () => {
    localStorage.setItem(HANDEDNESS_KEY, 'left')
    await openPicker()
    expect(micBtn().style.left).toBe('44px')
    expect(micBtn().style.right).toBe('')
    expect(kbBtn().style.left).toBe('0px')
    expect(closeBtn().style.left).toBe('88px')
    // And the text is kept out from under them on the side they actually occupy.
    expect(field().style.paddingLeft).toBe('136px')
    expect(field().style.paddingRight).toBe(`${T.fieldPadX}px`)
  })

  it('a junk stored value renders right-handed rather than half-mirroring the cluster', async () => {
    localStorage.setItem(HANDEDNESS_KEY, 'sideways')
    await openPicker()
    expect(kbBtn().style.right).toBe('0px')
    expect(micBtn().style.right).toBe('44px')
    expect(field().style.paddingRight).toBe('136px')
  })
})

// NAMED MUTATION TARGETS (each VERIFIED red on the listed test, 2026-08-25):
//   thumbEdge always 'right'                            => the left-handed pure + rendered tests
//   thumbEdge always 'left'                             => the right-handed default tests
//   padding stays paddingRight when the slots mirror    => the padding test + the rendered left test
//   ✕ INSERTED at 44 instead of appended when mirrored  => the ✕ outermost assertions
