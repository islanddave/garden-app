// BUG-POSTSAVEVALIDATION-001 — a SUCCESSFUL save must not leave a red validation error behind.
//
// Found by smoking S5b on staging, not by any test: after saving a harvest, the still-live form
// immediately rendered "Choose a planting." in red against the planting field — one beat after
// telling the user the save worked.
//
// Mechanism: `touched` is PlantingSelect's OWN local state, set when the user picks. EventNew's
// resetForNext() clears form.plant_id but does not unmount the picker, so `selected` goes null
// while `touched` stays true, and
//     showBlankError = required && touched && !selected && !query
// renders an error against a field the user has not touched on THIS form. Fixed by a `resetNonce`
// prop that marks the picker fresh again.
//
// LATENT BEFORE S5b, NOT INTRODUCED BY IT: the confirmation card used to replace the form body, so
// the error sat behind the "Log another" tap. Keeping the form live is what exposed it.
//
// FLAG POSTURE MATTERS HERE. `required` is
//     (PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) && requiresPlanting(event_type)
// so with both flags OFF the picker is never `required`, showBlankError can never be true, and this
// bug is UNREPRODUCIBLE. Both flags are ON in prod as of v4.8.0, so this suite pins the SHIPPED
// configuration — the sibling EventNew suites deliberately mock them off and could not have caught
// this. A future flag-posture change to this file makes the test vacuous rather than failing.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1', project_id: 'proj-1' } },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))
// The SHIPPED v4.8.0 posture — see the flag note in the header. Do not "align" this with the
// other EventNew suites; the divergence is the point.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
  PLANTING_REQUIRED_ENABLED: true,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const BLANK_ERROR = 'Choose a planting.'

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') return Promise.resolve(dataRef.postResult)
    if (options.method === 'DELETE') return Promise.resolve({ undone: true })
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    if (path.startsWith('/api/harvests')) return Promise.resolve(null)
    return Promise.resolve(null)
  })
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

async function pickPlanting(id) {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

async function saveAHarvest() {
  dataRef.plants = [{ id: 'pl-1', name: 'Roma #1', variety_ref: { id: 'v-1', crop_type_slug: 'tomato' } }]
  searchParamsRef.current = new URLSearchParams('event_type=harvest')
  render(<ToastProvider><OverlaySurfaceProvider><EventNew /></OverlaySurfaceProvider></ToastProvider>)
  await flushLoad()
  await pickPlanting('pl-1')
  fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2' } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }
  sessionStorage.clear()
  // V4-STICKY-001 persists the last plant on every save; without this a cold mount arrives
  // pre-seeded from the previous test and the picker renders already-chosen.
  localStorage.clear()
  wireApiFetch()
})

describe('BUG-POSTSAVEVALIDATION-001 — a successful save leaves no validation error', () => {
  // THE REGRESSION PIN. Reverting the resetNonce wiring makes exactly this assertion fail.
  it('does not render "Choose a planting." after a successful harvest save', async () => {
    await saveAHarvest()

    expect(screen.getByRole('status').textContent).toMatch(/Logged/)   // the save really succeeded
    expect(screen.getByText('Save')).toBeTruthy()                       // the form really is live
    expect(screen.queryByText(BLANK_ERROR)).toBeNull()                  // ...and is not scolding
  })

  // Guards the fix from over-reaching: resetNonce must reset `touched`, NOT suppress the error
  // permanently. A fix that simply stopped rendering showBlankError would pass the test above and
  // silently delete a real affordance — this is the assertion that catches that.
  it('still renders the error when the user blanks the planting on the NEW form', async () => {
    await saveAHarvest()
    expect(screen.queryByText(BLANK_ERROR)).toBeNull()

    // Touch the fresh picker and leave it empty — the error must come back.
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    fireEvent.blur(screen.getByLabelText('Plant or group'))
    await act(async () => { await new Promise(r => setTimeout(r, 200)) })  // the 150ms blur-close

    expect(screen.getByText(BLANK_ERROR)).toBeTruthy()
  })

  // The error must still work on a form that has NOT been saved — proves the nonce did not
  // disarm the first-mount path.
  it('renders the error on a pristine form when the planting is touched and left blank', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Roma #1', variety_ref: { id: 'v-1', crop_type_slug: 'tomato' } }]
    searchParamsRef.current = new URLSearchParams('event_type=harvest')
    render(<ToastProvider><OverlaySurfaceProvider><EventNew /></OverlaySurfaceProvider></ToastProvider>)
    await flushLoad()

    expect(screen.queryByText(BLANK_ERROR)).toBeNull()                  // pristine: silent
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    fireEvent.blur(screen.getByLabelText('Plant or group'))
    await act(async () => { await new Promise(r => setTimeout(r, 200)) })

    expect(screen.getByText(BLANK_ERROR)).toBeTruthy()                  // touched + blank: speaks
  })
})
