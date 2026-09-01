// PlantingSelect × micArbiter — V5-HARVESTVOICEFLOW-001 S1, the C7 regression pin.
//
// ── WHY THIS FILE IS NOT WHAT C7 ASKED FOR ──────────────────────────────────────────────────────
//
// Build plan V101's C7 says the arbiter's regression test "must be CaptureFlow's own", because
// CaptureFlow.jsx:682/721/736 mounts THREE concurrent PlantingSelects and a mount-time acquisition
// would silently disable two of them.
//
// THAT PREMISE DOES NOT HOLD ON dev 90a383b8. The three pickers (now pages/CaptureFlow.jsx:695, 734,
// 749 — the file moved from components/) sit in MUTUALLY EXCLUSIVE branches: `mode === 'event'`,
// `mode === 'replace'`, `mode === 'attachonly'`. Exactly one is mounted at a time. A test written to
// C7's letter would render CaptureFlow, find one picker, and pass no matter where the acquire lives
// — a guard that cannot fail is not a guard.
//
// So this pins the invariant C7 was PROTECTING rather than the surface it named: mounting a picker
// must not take the mic; only starting one may. That is testable non-vacuously by mounting several
// pickers side by side, which is what the block below does. Moving `acquireMic` from the start path
// to mount reddens the first two tests here.
//
// ── AND WHY IT DOES NOT MOCK transcribe.js ──────────────────────────────────────────────────────
//
// Gate B3: all eleven existing consumer suites `vi.mock('../lib/transcribe.js')`, so every change to
// that file is invisible to all of them — and the arbiter acquire lives inside it. Mocking here
// would rebuild the exact blind spot. This drives the real transcribe.js over the shared fake
// recogniser instead, which is also the B4 direction (one more of the five start-paths converted).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { FakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { isMicHeld, micHolder, resetMicArbiter } from '../lib/micArbiter.js'

const apiFetchSpy = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'

const PLANTS = [
  { id: 'p1', name: 'Brentwood Leaf Lettuce', crop_type: 'lettuce' },
  { id: 'p2', name: 'Chinese 5-Color', crop_type: 'pepper' },
]

beforeEach(() => {
  resetMicArbiter()
  FakeSpeechRecognition.instances = []
  window.SpeechRecognition = FakeSpeechRecognition
  window.webkitSpeechRecognition = FakeSpeechRecognition
})
afterEach(() => {
  cleanup()
  resetMicArbiter()
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
})

// The mic button only renders while the list is open (PlantingSelect.jsx:1018
// `showMicBtn = open && !disabled && voiceSupported`), so each picker must be opened first.
function renderPickers(n) {
  const view = render(
    <div>
      {Array.from({ length: n }, (_, i) => (
        <PlantingSelect key={i} data-testid={`pick-${i}`} plants={PLANTS} value={null}
          onChange={() => {}} placeholder={`— picker ${i} —`} />
      ))}
    </div>,
  )
  return view
}

function openAll() {
  // Opening is a tap on the picker's own trigger; every rendered picker exposes one.
  const triggers = screen.getAllByRole('combobox')
  triggers.forEach((t) => act(() => { fireEvent.click(t) }))
}

function mics() {
  return screen.queryAllByRole('button', { name: /Speak to search plantings|Stop listening|Microphone unavailable/i })
}

describe('PlantingSelect × micArbiter — mounting must not take the mic', () => {
  it('three pickers mounted and opened hold no mic between them', () => {
    renderPickers(3)
    openAll()
    expect(mics().length).toBe(3)
    // The whole point: three live pickers, zero holds. A mount-time acquire fails here.
    expect(isMicHeld()).toBe(false)
  })

  it('every mounted picker stays enabled — none is disabled by the presence of the others', () => {
    renderPickers(3)
    openAll()
    // Asserted before the loop: an empty list would make every for-of assertion below pass
    // vacuously, which is how this test read on its first draft.
    expect(mics().length).toBe(3)
    for (const btn of mics()) {
      expect(btn.getAttribute('aria-disabled')).toBe(null)
      expect(btn.hasAttribute('disabled')).toBe(false)
    }
  })
})

describe('PlantingSelect × micArbiter — starting takes it, and only one at a time', () => {
  it('starting one picker acquires the mic', () => {
    renderPickers(2)
    openAll()
    act(() => { fireEvent.click(mics()[0]) })
    expect(isMicHeld()).toBe(true)
    expect(micHolder()).toBe('Picker')
    expect(FakeSpeechRecognition.instances.filter((r) => r.started).length).toBe(1)
  })

  it('starting a second picker stops the first — never two live recognisers', () => {
    renderPickers(2)
    openAll()
    act(() => { fireEvent.click(mics()[0]) })
    act(() => { fireEvent.click(mics()[1]) })
    // This is the defect the arbiter exists to close: before it, both stayed started.
    expect(FakeSpeechRecognition.instances.filter((r) => r.started).length).toBe(1)
    expect(isMicHeld()).toBe(true)
  })

  it('the mic is free again once the only listener ends', () => {
    renderPickers(1)
    openAll()
    act(() => { fireEvent.click(mics()[0]) })
    expect(isMicHeld()).toBe(true)
    const rec = FakeSpeechRecognition.instances.find((r) => r.started)
    act(() => { rec.stop() })
    expect(isMicHeld()).toBe(false)
  })

  it('unmounting a listening picker releases the mic', () => {
    const view = renderPickers(1)
    openAll()
    act(() => { fireEvent.click(mics()[0]) })
    expect(isMicHeld()).toBe(true)
    act(() => { view.unmount() })
    expect(isMicHeld()).toBe(false)
  })
})
