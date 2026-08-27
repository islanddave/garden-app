// V5-HARVESTVOICEFLOW-001 S1 (the pre-existing half) — useVoiceInput must release the mic on unmount.
//
// THE DEFECT, which was live in prod: `useVoiceInput` (EventNew.jsx) had NO useEffect at all. A
// recogniser started by its mic button outlived the component — navigate away mid-dictation and
// nothing stopped it. Bounded by the engine's own silence timeout rather than permanent, but for
// those seconds the mic indicator stays lit on a page the user has left, the handlers still hold the
// OLD onResult and write into a form that is gone, and a remount can stand a SECOND recogniser up
// beside the first.
//
// It is guarded here rather than inside the S1 arbiter slice because it is not an arbiter bug: it is
// true today, with no voice flow shipped, and it should not wait on one.
//
// USES THE SHARED FAKE (tests/helpers/fakeSpeechRecognition.js), which is the point as much as the
// coverage: gate B4 asks for every start-path to run against one fake that models the real lifecycle,
// and this converts the first of the five. `useVoiceInput` builds its own SpeechRecognition and never
// touches src/lib/transcribe.js, so the 11 consumer suites that vi.mock transcribe.js are all blind
// to it — mocking it here would have reproduced exactly the gap B3 exists to close.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

const { apiFetchSpy, navigateSpy, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { projects: [], locations: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn(async () => 'tok') }),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null, stage: null,
    progress: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
  WEIGH_IN_FRAME_ENABLED: false,
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

let mic

beforeEach(() => {
  apiFetchSpy.mockReset()
  mic = installFakeSpeechRecognition(vi)
  dataRef.projects = [{ id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }]
  searchParamsRef.current = new URLSearchParams()
  localStorage.clear()
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

afterEach(() => { vi.unstubAllGlobals() })

async function renderAndListen() {
  render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  // The mic'd fields sit behind two steps, both of which a real user takes: the form opens on the
  // event-type picker, and the quantity/notes fields live inside the collapsed "Add details"
  // disclosure. "Watered" is the cheapest type to reach — no harvest panel, no severity, no photo.
  await act(async () => { fireEvent.click(screen.getByText('Watered')) })
  await act(async () => { fireEvent.click(screen.getByText(/Add details/)) })
  const buttons = screen.getAllByLabelText('Speak to fill this field')
  expect(buttons.length, 'no mic button rendered — the fake SpeechRecognition did not install')
    .toBeGreaterThan(0)
  await act(async () => { fireEvent.click(buttons[0]) })
  const rec = mic.latest()
  expect(rec, 'clicking the mic did not construct a recogniser').toBeTruthy()
  expect(rec.started).toBe(true)
  return rec
}

describe('useVoiceInput — the mic does not outlive the page', () => {
  it('aborts a live recogniser when the component unmounts', async () => {
    const rec = await renderAndListen()

    act(() => { cleanup() })

    expect(rec.started).toBe(false)
  })

  it('detaches the handlers BEFORE aborting, so nothing dispatches into a dead component', async () => {
    // Order matters and is the whole reason this is abort()-after-detach rather than plain stop().
    // A teardown that still holds onresult writes the finalised transcript into a form that no
    // longer exists — which is the same class as the outgoing-instance handover start() already
    // guards, just at the other end of the lifecycle.
    const rec = await renderAndListen()

    act(() => { cleanup() })

    expect(rec.onresult).toBe(null)
    expect(rec.onend).toBe(null)
    expect(rec.onerror).toBe(null)
  })

  it('unmounting without ever starting a recogniser is a no-op, not a throw', async () => {
    render(<ToastProvider><EventNew /></ToastProvider>)
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByText('Watered')) })
    await act(async () => { fireEvent.click(screen.getByText(/Add details/)) })

    expect(() => act(() => { cleanup() })).not.toThrow()
    expect(mic.instances).toHaveLength(0)
  })

  it('a remount does not leave two live recognisers behind', async () => {
    // The compounding case. Route away mid-dictation and back, and the pre-fix hook stood a second
    // recogniser up while the first was still holding the mic — two actors, one of them invisible.
    const first = await renderAndListen()
    act(() => { cleanup() })
    const second = await renderAndListen()

    expect(first.started).toBe(false)
    expect(second.started).toBe(true)
    expect(mic.instances).toHaveLength(2)

    act(() => { cleanup() })
    expect(second.started).toBe(false)
  })
})
