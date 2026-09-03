// V5-HARVESTONEDOOR-001 — the combined harvest page and the two legacy urls that now redirect to it.
//
// The page itself is a shell, so what is worth asserting is not markup but the four decisions it
// encodes: voice is the default, the selector really swaps the mounted surface, the url is the
// state, and the pre-combination urls still land somewhere correct. The last one is the one a
// future edit is most likely to break silently, because nothing in the app links to those strings
// any more — the only remaining caller is Dave's launcher-cached home-screen tile.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null,
    stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

import HarvestLog, { resolveMode, DEFAULT_MODE } from '../pages/HarvestLog.jsx'
import VoiceHarvestRedirect, { HarvestSessionRedirect } from '../components/LegacyHarvestRedirect.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

beforeEach(() => {
  apiFetchSpy.mockReset()
  try { localStorage.clear() } catch { /* noop */ }
  apiFetchSpy.mockImplementation(path => {
    if (path === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (String(path).startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

// `${pathname}${search}` so a wrong target and a wrong param are distinguishable in the failure
// message rather than collapsing into a bare boolean.
function Probe() {
  const loc = useLocation()
  return <div data-testid="probe">{`${loc.pathname}${loc.search}`}</div>
}

function mountAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ToastProvider>
        <Routes>
          <Route path="/log/harvest" element={<><HarvestLog /><Probe /></>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  )
}

describe('HarvestLog — mode resolution', () => {
  it('defaults to voice', () => {
    expect(DEFAULT_MODE).toBe('voice')
    expect(resolveMode(null)).toBe('voice')
    expect(resolveMode(undefined)).toBe('voice')
  })

  it('accepts the two real modes verbatim', () => {
    expect(resolveMode('voice')).toBe('voice')
    expect(resolveMode('manual')).toBe('manual')
  })

  // A typo in a shortcut, or a stale launcher url from some future rename, must still land on a
  // working harvest page rather than rendering nothing.
  it('falls back to the default for anything unrecognised, rather than rendering neither surface', () => {
    for (const bad of ['', 'VOICE', 'session', 'manual ', 'true', '1']) {
      expect(resolveMode(bad), `mode=${JSON.stringify(bad)}`).toBe('voice')
    }
  })
})

describe('HarvestLog — the selector swaps the mounted surface', () => {
  it('a bare arrival renders voice and NOT the weigh-in session', async () => {
    mountAt('/log/harvest')
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    expect(screen.queryByTestId('harvest-session-lock')).toBeNull()
  })

  it('?mode=manual renders the session and NOT voice', async () => {
    mountAt('/log/harvest?mode=manual')
    await waitFor(() => expect(screen.getByTestId('harvest-session-lock')).toBeTruthy())
    expect(screen.queryByTestId('voice-harvest')).toBeNull()
  })

  // The behavioural half: tapping really switches, and really writes the url. Both are asserted,
  // because a selector that changed local state without the url would look right and then lose the
  // mode on any reload or back-forward.
  it('tapping Manual mounts the session and puts mode=manual in the url', async () => {
    mountAt('/log/harvest')
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }))
    await waitFor(() => expect(screen.getByTestId('harvest-session-lock')).toBeTruthy())
    expect(screen.getByTestId('probe').textContent).toBe('/log/harvest?mode=manual')
    expect(screen.queryByTestId('voice-harvest')).toBeNull()
  })

  // Going BACK to the default drops the param rather than writing ?mode=voice. The canonical url
  // for the common case has to be one string — the header action, the manifest shortcut and a
  // round trip through the selector must all produce the same one, or the parity assertion in
  // PwaHarvestShortcut.test.jsx is testing a coincidence.
  it('tapping By voice again drops the param entirely', async () => {
    mountAt('/log/harvest?mode=manual')
    await waitFor(() => expect(screen.getByTestId('harvest-session-lock')).toBeTruthy())
    fireEvent.click(screen.getByRole('radio', { name: 'By voice' }))
    await waitFor(() => expect(screen.getByTestId('voice-harvest')).toBeTruthy())
    expect(screen.getByTestId('probe').textContent).toBe('/log/harvest')
  })

  it('exposes both modes as a radiogroup with the active one checked', async () => {
    mountAt('/log/harvest')
    await waitFor(() => expect(screen.getByTestId('harvest-log-mode')).toBeTruthy())
    const group = screen.getByTestId('harvest-log-mode')
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2)
    expect(group.querySelector('[aria-checked="true"]').textContent).toBe('By voice')
  })
})

// ── the legacy urls ─────────────────────────────────────────────────────
// Nothing in the app links to these any more. They exist for the installed PWA, whose manifest the
// launcher caches for days with no way to force a re-read, and for bookmarks and restored tabs.
// That makes them exactly the kind of thing that rots unnoticed, which is why they are pinned.
function redirectProbe(entry, element) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/log" element={element} />
        <Route path="/log/voice" element={element} />
        <Route path="/log/harvest" element={<Probe />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('V5-HARVESTONEDOOR-001 legacy urls', () => {
  it('/log/voice redirects to the combined page on the default mode', () => {
    redirectProbe('/log/voice', <VoiceHarvestRedirect />)
    expect(screen.getByTestId('probe').textContent).toBe('/log/harvest')
  })

  // Lands on the DEFAULT mode, not on the manual session this url used to open. That is deliberate
  // and it is the opposite of the first implementation — see LegacyHarvestRedirect.jsx for why.
  // Short version: the only remaining caller is a launcher-cached home-screen tile, so a faithful
  // mapping would have kept Dave's main door on manual for days and then flipped it to voice with
  // no deploy, when Chrome finally re-read the manifest.
  it('/log?session=harvest redirects to the combined page on the DEFAULT mode, not manual', () => {
    redirectProbe('/log?session=harvest', <HarvestSessionRedirect><Probe /></HarvestSessionRedirect>)
    expect(screen.getByTestId('probe').textContent).toBe('/log/harvest')
  })

  // Deep-link scope must survive the hop. ?plant= and ?project= are real state EventNew reads, and
  // dropping them would silently turn a scoped harvest into an unscoped one — a wrong write behind
  // a redirect that otherwise looks like it worked.
  it('carries ?plant= and ?project= through the redirect', () => {
    redirectProbe('/log?session=harvest&plant=p1&project=proj-1', <HarvestSessionRedirect><Probe /></HarvestSessionRedirect>)
    const url = new URL(screen.getByTestId('probe').textContent, 'https://garden.futureishere.net')
    expect(url.pathname).toBe('/log/harvest')
    expect(url.searchParams.get('plant')).toBe('p1')
    expect(url.searchParams.get('project')).toBe('proj-1')
    // The retired discriminator must not survive the hop, or /log would intercept it again.
    expect(url.searchParams.get('session')).toBeNull()
    // And no mode is forced — a scoped arrival gets the default like every other arrival.
    expect(url.searchParams.get('mode')).toBeNull()
  })

  // THE NON-VACUITY CONTROL, and the one that protects the ordinary Log-an-event form. The wrapper
  // sits on the /log route, so every non-harvest /log passes through it — if it redirected those
  // too, the whole event form would be gone and this suite would still be green without this case.
  it('leaves a plain /log alone — only session=harvest is intercepted', () => {
    redirectProbe('/log', <HarvestSessionRedirect><div data-testid="passthrough">event form</div></HarvestSessionRedirect>)
    expect(screen.getByTestId('passthrough')).toBeTruthy()
  })

  it('leaves /log?event_type=harvest alone too — that is the single-event deep link, not the session', () => {
    redirectProbe('/log?event_type=harvest&plant=p1', <HarvestSessionRedirect><div data-testid="passthrough">event form</div></HarvestSessionRedirect>)
    expect(screen.getByTestId('passthrough')).toBeTruthy()
  })
})
