// BUG-VOICEDUPE-002 — the duplication regression, driven through the REAL EventNew voice path with
// a fake SpeechRecognition emitting RAW events.
//
// WHY THIS FILE EXISTS AT THIS LEVEL. BUG-VOICEDUPE-001 hardened src/lib/transcribe.js and shipped
// green. It could not have fixed Dave's bug: EventNew.jsx carries its OWN `useVoiceInput` hook that
// constructs `window.SpeechRecognition` directly and never imports transcribe.js, and three of the
// four MicBtn call sites (notes, private_notes, issueOther) APPEND the emitted text into the field.
// The old handler read a FIXED index — `e.results[0][0].transcript` — while event.results is
// CUMULATIVE for the session, so every additional onresult dispatch re-read and re-appended the
// first utterance.
//
// So the test drives the real component, the real hook, and raw cumulative events. A unit test
// against a normalized `{transcript, isFinal}` callback could not have caught this and did not.
//
// RENDER assertions only. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
// BUG-VOICEDUPE-005 — the echo window is imported, never re-stated as a literal here. A test that
// hardcoded 600 would keep passing if the constant moved, which is the one change most likely to
// invalidate what these two tests assert.
import { DUPLICATE_ECHO_WINDOW_MS } from '../lib/transcribe.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { projects: [], locations: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider, OverlayDirtyProvider } from '../context/OverlayContext.jsx'

// ── A fake SpeechRecognition that dispatches RAW events, not normalized callbacks ──────────────
class FakeSR {
  constructor() {
    this.lang = ''
    this.continuous = false
    this.interimResults = false
    this.onresult = null
    this.onend = null
    this.onerror = null
    this.started = false
    this.stopped = false
    FakeSR.instances.push(this)
  }
  start() { this.started = true }
  stop()  { this.stopped = true }
  abort() { this.stopped = true }

  // Dispatch one onresult carrying the CUMULATIVE results list the browser would hold at this
  // point, plus the resultIndex the browser would report (first CHANGED result, not first new one).
  emit(resultIndex, items) {
    if (!this.onresult) return
    const results = items.map((it) => {
      const r = [{ transcript: it.text, confidence: 0.9 }]
      r.isFinal = !!it.final
      return r
    })
    results.length = items.length
    this.onresult({ resultIndex, results })
  }
}
FakeSR.instances = []

beforeEach(() => {
  apiFetchSpy.mockReset()
  localStorage.clear()
  sessionStorage.clear()   // EventNew stashes an in-progress draft here; it would leak across tests
  FakeSR.instances = []
  window.SpeechRecognition = FakeSR
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

afterEach(() => {
  delete window.SpeechRecognition
})

async function renderForm(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  await act(async () => {
    render(
      <ToastProvider>
        <OverlaySurfaceProvider>
          <OverlayDirtyProvider onDirtyChange={() => {}}>
            <EventNew />
          </OverlayDirtyProvider>
        </OverlaySurfaceProvider>
      </ToastProvider>
    )
  })
}

// Open the collapsed Notes disclosure and start dictation into it.
async function startNotesDictation() {
  fireEvent.click(screen.getByTestId('notes-disclosure'))
  const mic = screen.getByLabelText('Speak to fill this field')
  await act(async () => { fireEvent.click(mic) })
  const sr = FakeSR.instances.at(-1)
  expect(sr).toBeTruthy()
  expect(sr.started).toBe(true)
  return sr
}

const notesValue = () => screen.getByLabelText('Notes').value

describe('EventNew voice dictation — BUG-VOICEDUPE-002', () => {
  it('mounts a recognizer and fills Notes from a single final result', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => { sr.emit(0, [{ text: 'watered the tomatoes', final: true }]) })
    expect(notesValue()).toBe('watered the tomatoes')
  })

  it('does NOT duplicate when a second event carries the cumulative list (the reported bug)', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => {
      sr.emit(0, [{ text: 'watered the tomatoes', final: true }])
      // Second dispatch: index 0 is STILL in event.results. The old `e.results[0][0]` read appended
      // "watered the tomatoes" a second time and dropped "and the beans" entirely.
      sr.emit(1, [
        { text: 'watered the tomatoes', final: true },
        { text: 'and the beans', final: true },
      ])
    })
    expect(notesValue()).toBe('watered the tomatoes and the beans')
    expect(notesValue().match(/watered the tomatoes/g)).toHaveLength(1)
  })

  it('does NOT duplicate when Chrome REVISES a settled final at the same index', async () => {
    // resultIndex points BACKWARDS at index 0 because its text changed (capitalization/number
    // normalization). Re-walking from resultIndex would append the phrase again in revised form.
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => {
      sr.emit(0, [{ text: 'harvested six beans', final: true }])
      sr.emit(0, [
        { text: 'Harvested 6 beans.', final: true },
        { text: 'and two peppers', final: true },
      ])
    })
    expect(notesValue()).toBe('harvested six beans and two peppers')
  })

  it('does NOT duplicate on a verbatim re-delivery of the identical event', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => {
      sr.emit(0, [{ text: 'aphids on the kale', final: true }])
      sr.emit(0, [{ text: 'aphids on the kale', final: true }])
    })
    expect(notesValue()).toBe('aphids on the kale')
  })

  it('handles a multi-final utterance delivered in one event', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => {
      sr.emit(0, [
        { text: 'checked the leeks', final: true },
        { text: 'they look leggy', final: true },
      ])
    })
    expect(notesValue()).toBe('checked the leeks they look leggy')
  })

  it('interim results never land in the field; only the final does', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => {
      sr.emit(0, [{ text: 'mul', final: false }])
      sr.emit(0, [{ text: 'mulched bed', final: false }])
    })
    expect(notesValue()).toBe('')
    await act(async () => { sr.emit(0, [{ text: 'mulched bed three', final: true }]) })
    expect(notesValue()).toBe('mulched bed three')
  })

  it('a RESTART gets a clean high-water mark and appends to what is already there', async () => {
    await renderForm()
    const first = await startNotesDictation()
    await act(async () => {
      first.emit(0, [{ text: 'staked the peas', final: true }])
      first.onend()
    })
    const mic = screen.getByLabelText('Speak to fill this field')
    await act(async () => { fireEvent.click(mic) })
    const second = FakeSR.instances.at(-1)
    expect(second).not.toBe(first)
    await act(async () => { second.emit(0, [{ text: 'and netted the brassicas', final: true }]) })
    expect(notesValue()).toBe('staked the peas and netted the brassicas')
  })

  it('the OUTGOING recognizer is muted on handover — its flush cannot append', async () => {
    // start() calls stop() on the previous instance. `stop()` is a GRACEFUL shutdown: the engine may
    // dispatch one more onresult on the OLD object, whose handler still closes over the OLD append.
    await renderForm()
    const first = await startNotesDictation()
    await act(async () => { first.emit(0, [{ text: 'staked the peas', final: true }]) })

    // Tap again while still listening -> stop(); then tap to start a fresh recognizer.
    await act(async () => { fireEvent.click(screen.getByLabelText('Stop voice input')) })
    await act(async () => { fireEvent.click(screen.getByLabelText('Speak to fill this field')) })
    const second = FakeSR.instances.at(-1)
    expect(second).not.toBe(first)

    // The old recognizer flushes late. It must be inert.
    await act(async () => { first.emit(0, [{ text: 'staked the peas', final: true }]) })
    expect(notesValue()).toBe('staked the peas')
    expect(first.onresult).toBe(null)
  })

  // BUG-VOICEDUPE-005 — THE DISCRIMINATOR IS NOW TIME, so this test's two halves split.
  //
  // It used to assert 'ripe ripe' from two finals delivered back to back at distinct indices, on the
  // reasoning that a repeat at a new index is speech the user really said. That reasoning was right
  // when index and text were the only evidence available, and the 2026-08-27 device run replaced it
  // with a measurement: the engine echoes a settled final onto the NEXT index 272 ms later, so
  // "distinct indices, no elapsed time" is the ECHO, not the repeat. transcribe.js took this same
  // correction in BUG-VOICEDUPE-004; this reader is the path that did not, which is why it still
  // doubled a dictated word into Notes.
  //
  // The PROPERTY the original test protects — a deliberate repeat must never be deleted — is not
  // dropped. It is asserted below with the elapsed time a deliberate repeat actually takes, which is
  // the only thing that ever distinguished the two cases.
  it('an immediate re-delivery at the next index is the engine echo, and is dropped', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => {
      sr.emit(0, [{ text: 'ripe', final: true }])
      sr.emit(1, [{ text: 'ripe', final: true }, { text: 'ripe', final: true }])
    })
    expect(notesValue()).toBe('ripe')
  })

  it('real repetition the user actually said IS preserved — it lands outside the echo window', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    const base = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    await act(async () => { sr.emit(0, [{ text: 'ripe', final: true }]) })
    // A second "ripe" the user actually said: the first final has to END before the word can be
    // spoken again, and closing a segment takes far longer than the echo interval.
    nowSpy.mockReturnValue(base + DUPLICATE_ECHO_WINDOW_MS + 1)
    await act(async () => {
      sr.emit(1, [{ text: 'ripe', final: true }, { text: 'ripe', final: true }])
    })
    nowSpy.mockRestore()
    expect(notesValue()).toBe('ripe ripe')
  })

  it('a malformed event does not throw into the recognizer callback', async () => {
    await renderForm()
    const sr = await startNotesDictation()
    await act(async () => { sr.onresult({ resultIndex: 0, results: [] }) })
    expect(notesValue()).toBe('')
  })
})
