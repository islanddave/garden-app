// WeighWizard.flagOff.test.jsx — V4-WEIGHWIZARDFLOW-001 (BD-055) Slice 1. THE NO-OP PROOF.
//
// The wizard rebuilds Dave's most-used flow. Slice 1 ships behind WEIGH_WIZARD_ENABLED, and the
// only thing that makes that flag a real safety net rather than a comment is a proof that the
// existing weigh-in session is BYTE-IDENTICAL with it off. "No wizard testid in the document" is
// not that proof — it passes just as happily if the wizard leaked a wrapper div, shifted a React
// useId, reordered a sibling, or mounted an effect that scrolled the page.
//
// So this file compares the WHOLE rendered document against a fixture captured from the UNTOUCHED
// EventNew at base e5a8ab9 — before src/pages/EventNew.jsx had ever heard of the wizard:
//
//   WEIGHWIZARD_BASELINE_WRITE=1 npx vitest run src/__tests__/WeighWizard.flagOff.test.jsx
//
// Regenerating it is therefore a DELIBERATE act with a visible diff, which is the property that
// makes the comparison mean something. The fixture is committed at
// src/__tests__/fixtures/weighWizard.flagOff.baseline.html.
//
// Two determinism hazards are handled rather than hoped away. (1) The When field defaults to today,
// so the clock is frozen. (2) React's useId is rendered — Field.jsx:40 falls back to it for input
// ids and PlantingSelect.jsx:432 builds listboxId from it — and useId derives from a fiber's
// POSITION in the tree, so inserting a sibling before an existing one renames ids that follow. That
// is exactly the class of silent change this fixture exists to catch, and it is why the wizard
// renders LAST in EventNew's tree.
//
// Its counterpart WeighWizard.flagOn.test.jsx owns the pin on the SHIPPED flag value, so a future
// flip is a deliberate decision rather than a test that quietly needs fixing. This file mocks the
// flag false explicitly and keeps proving the rollback lever forever.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  WEIGH_WIZARD_ENABLED: false,
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

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(HERE, 'fixtures/weighWizard.flagOff.baseline.html')
const WRITE = process.env.WEIGHWIZARD_BASELINE_WRITE === '1'

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

describe('WEIGH_WIZARD_ENABLED=false — the weigh-in session is unchanged', () => {
  it('renders the session byte-for-byte identically to the pre-wizard baseline', async () => {
    const { container } = await renderSession()
    const html = container.innerHTML
    if (WRITE) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, html)
      // Deliberately not a silent pass: a run that WROTE the fixture proved nothing about the flag.
      expect(WRITE, 'baseline written — re-run without WEIGHWIZARD_BASELINE_WRITE to assert').toBe(true)
      return
    }
    expect(existsSync(FIXTURE), `missing baseline fixture ${FIXTURE}`).toBe(true)
    expect(html).toBe(readFileSync(FIXTURE, 'utf8'))
  })

  it('renders the session render twice identically (the fixture is comparing a stable thing)', async () => {
    // Without this, a byte comparison that happened to be non-deterministic would be indistinguishable
    // from a broken flag: the first would fail loudly and be "fixed" by regenerating the fixture.
    const a = await renderSession()
    const first = a.container.innerHTML
    a.unmount()
    const b = await renderSession()
    expect(b.container.innerHTML).toBe(first)
  })

  it('mounts no wizard surface at all', async () => {
    const { container } = await renderSession()
    expect(container.querySelector('[data-testid="weigh-wizard"]')).toBeNull()
    expect(container.querySelector('[data-testid="weigh-wizard-sheet"]')).toBeNull()
    expect(container.querySelector('[data-testid="confirm-sheet"]')).toBeNull()
    // The session's own controls are the ones on screen, not a step body.
    expect(container.querySelector('#harvest-quantity')).not.toBeNull()
    expect(container.querySelector('#harvest-weight')).not.toBeNull()
  })
})
