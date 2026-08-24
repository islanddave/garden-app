// V4-HANDEDNESSCONTROLS-001 (BD-054) §8.4 partial — the MicBtn touch target.
//
// WHAT THIS CAN AND CANNOT PROVE. jsdom has no layout engine, so it cannot measure that the target
// is 44 CSS px — every getBoundingClientRect here returns zeros (tests/harness/README.md:14-16).
// What it CAN pin is the mechanism: that the expanded-hit-area child exists on every MicBtn, that
// it is inset by -7 on all four sides, and that the visible circle stayed 30px. 30 + 7 + 7 = 44 is
// then arithmetic, not a measurement, and this file says so rather than implying otherwise.
//
// Why the mechanism and not a bigger button: two of the four MicBtn call sites pass `top` in px
// with transform:none, positioning the box by its EDGE — growing the button to 44 would silently
// slide those two mics 7px down the textarea. The transparent child leaves all geometry identical.
//
// Deliberately NOT the handedness flip itself. That is still an open question (whether
// HarvestWatchBand's left/right split, which is a SAFETY decision, should mirror), so this closes
// only the WCAG 2.5.5 half that needs no decision from Dave.
//
// RENDER assertions only. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

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

class FakeSR {
  constructor() { this.lang = ''; this.continuous = false; this.interimResults = false }
  start() {}
  stop() {}
  abort() {}
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  // MicBtn renders nothing unless voice.supported, which gates on this constructor existing.
  window.SpeechRecognition = FakeSR
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (String(path).startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

afterEach(() => { delete window.SpeechRecognition })

async function renderForm(query = 'event_type=watering') {
  searchParamsRef.current = new URLSearchParams(query)
  await act(async () => { render(<ToastProvider><EventNew /></ToastProvider>) })
  await act(async () => { await Promise.resolve() })
  // V4-NOTESCOLLAPSE-001: on non-harvest types Notes lives in a collapsed disclosure, so the mic
  // is not mounted until it is opened. Opening it is what a user does to reach the mic at all.
  const disclosure = screen.queryByTestId('notes-disclosure')
  if (disclosure) await act(async () => { fireEvent.click(disclosure) })
}

const mics = () => screen.queryAllByLabelText('Speak to fill this field')

describe('EventNew MicBtn — touch target (BD-054 §8.4)', () => {
  it('renders at least one mic once voice is supported (guards the whole file from going vacuous)', async () => {
    // Without this, every assertion below would pass trivially on an empty array the day the
    // support probe or the aria-label changes.
    await renderForm()
    expect(mics().length).toBeGreaterThan(0)
  })

  it('every mic carries an expanded hit area inset -7px on all four sides', async () => {
    await renderForm()
    for (const m of mics()) {
      const pad = m.querySelector('span[aria-hidden="true"]')
      expect(pad).toBeTruthy()
      expect(pad.style.position).toBe('absolute')
      // -7 on each side of a 30px circle is a 44px target: WCAG 2.5.5. The number is asserted on
      // all four sides because a single missed side makes the target 37px on that edge.
      expect(pad.style.top).toBe('-7px')
      expect(pad.style.right).toBe('-7px')
      expect(pad.style.bottom).toBe('-7px')
      expect(pad.style.left).toBe('-7px')
    }
  })

  it('the VISIBLE circle is still 30px — the expansion must not change the look', async () => {
    // The anti-regression half. If someone later "simplifies" this by growing the button, the two
    // textarea call sites (top in px, transform:none) shift their mic 7px down and this REDs.
    await renderForm()
    for (const m of mics()) {
      expect(m.style.width).toBe('30px')
      expect(m.style.height).toBe('30px')
      expect(m.style.right).toBe('8px')
    }
  })

  it('the hit area is aria-hidden and empty, so it adds no accessible name or content', async () => {
    await renderForm()
    for (const m of mics()) {
      const pad = m.querySelector('span[aria-hidden="true"]')
      expect(pad.textContent).toBe('')
      expect(m.getAttribute('aria-label')).toBe('Speak to fill this field')
    }
  })
})
