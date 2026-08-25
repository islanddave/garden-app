// weighInSessionBaseBytes.test.jsx — THE BASE-e5a8ab9 BYTE PIN on the legacy weigh-in session.
//
// PROVENANCE, because it is the whole value of this file. The fixture beside it was captured at
// a94c7fd from an EventNew that had never heard of the wizard, the frame, or handedness — its
// parent is e5a8ab9, v4.49.0's weigh-in session exactly as Dave used it. It arrived as
// WeighWizard.flagOff.test.jsx's no-op proof; the wizard was retired (Dave's ruling, ledger
// V4-WEIGHFLAGEXCLUSION-001) and the fixture outlived it, because what it pins was never really
// about the wizard:
//
//   1. HANDEDNESS AT THE DEFAULT HAND (V4-HANDEDNESSCONTROLS-001 / BD-054). That lane branched off
//      the same e5a8ab9 and reorders NumberPad's `⌫` and `.` by thumb. Its claim is that RIGHT — the
//      default — is byte-identical to what shipped. This capture predates it, so a byte match IS
//      that proof, from outside the lane that made the claim. `orderByThumb` returning a reordered
//      array for `right` fails here and nowhere else.
//   2. THE FALLBACK ARM. WEIGH_IN_FRAME_ENABLED now ships TRUE, so this markup is no longer what
//      Dave sees — it is what he gets back if the frame is rolled back. A rollback lever that has
//      quietly drifted is worth nothing, so the flag is mocked FALSE explicitly rather than left to
//      the module default.
//
// Its sibling WeighInFrame.flagOff.test.jsx pins the same arm from the same base at a DIFFERENT
// state: four saves, plants empty, PROJECTS_HIDDEN/PLANTING_REQUIRED_ENABLED forced off to reach
// the ledger. This one pins the mount state with a real plant list and the shipped flag defaults
// untouched, so PlantingSelect's rendered list is inside the comparison. Neither subsumes the other.
//
// Regenerate deliberately, never to "fix" a red run — a diff is the point:
//   WEIGHIN_BASE_BYTES_WRITE=1 npx vitest run src/__tests__/weighInSessionBaseBytes.test.jsx
//
// Two determinism hazards are handled rather than hoped away. (1) The When field defaults to today,
// so the clock is frozen. (2) React's useId is rendered — Field.jsx:40 falls back to it for input
// ids and PlantingSelect.jsx:432 builds listboxId from it — and useId derives from a fiber's
// POSITION in the tree, so inserting a sibling before an existing one renames every id that
// follows. That is exactly the class of silent change a byte fixture exists to catch and a testid
// census cannot see.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  WEIGH_IN_FRAME_ENABLED: false,
}))

const { apiFetchSpy, navigateSpy, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { projects: [], locations: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// cwd-relative, not import.meta.url: under vitest the module URL is an http: one and fileURLToPath
// rejects it. Matches WeighInFrame.flagOff.test.jsx and bootPaint.test.jsx.
const FIXTURE = resolve(process.cwd(), 'src/__tests__/__fixtures__/weighInSession.base-e5a8ab9.html')
const WRITE = process.env.WEIGHIN_BASE_BYTES_WRITE === '1'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANTS = [
  { id: 'plant-1', name: 'Sungold', project_id: 'proj-1', quantity: 3, crop_type_slug: 'tomato' },
  { id: 'plant-2', name: 'Cayenne #1', project_id: 'proj-1', quantity: 2, crop_type_slug: 'pepper' },
]

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-25T12:00:00-04:00'))
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  localStorage.clear()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = PLANTS
  searchParamsRef.current = new URLSearchParams('session=harvest')
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

afterAll(() => { vi.useRealTimers() })

async function renderSession() {
  const view = render(<ToastProvider><EventNew /></ToastProvider>)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return view
}

describe('the legacy weigh-in session still renders base-e5a8ab9 bytes', () => {
  it('renders byte-for-byte identically to the v4.49.0 capture', async () => {
    const { container } = await renderSession()
    const html = container.innerHTML
    if (WRITE) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, html)
      // Deliberately not a silent pass: a run that WROTE the fixture proved nothing.
      expect(WRITE, 'baseline written — re-run without WEIGHIN_BASE_BYTES_WRITE to assert').toBe(true)
      return
    }
    expect(existsSync(FIXTURE), `missing baseline fixture ${FIXTURE}`).toBe(true)
    // Sanity on the fixture before it is used as an oracle: one that captured an empty or errored
    // render would pass against an equally empty render forever.
    const baseline = readFileSync(FIXTURE, 'utf8')
    expect(baseline).toContain('id="harvest-quantity"')
    expect(baseline).toContain('Harvest weight keypad')
    expect(html).toBe(baseline)
  })

  it('renders twice identically (the fixture is comparing a stable thing)', async () => {
    // Without this, a byte comparison that happened to be non-deterministic would be
    // indistinguishable from a real regression: the first would fail loudly and be "fixed" by
    // regenerating the fixture.
    const a = await renderSession()
    const first = a.container.innerHTML
    a.unmount()
    const b = await renderSession()
    expect(b.container.innerHTML).toBe(first)
  })

  it('mounts the session controls themselves, not a step body', async () => {
    const { container } = await renderSession()
    expect(container.querySelector('#harvest-quantity')).not.toBeNull()
    expect(container.querySelector('#harvest-weight')).not.toBeNull()
    // The frame is the other arm; with it off nothing of it may appear.
    expect(container.querySelector('[data-testid="weigh-frame"]')).toBeNull()
  })
})
