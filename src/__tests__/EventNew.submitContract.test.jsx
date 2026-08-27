// V5-HARVESTVOICEFLOW-001 gate B5 / condition C6 — handleSubmit's re-entrancy guard and its
// return contract.
//
// WHY THE ENTER KEY IS THE SUBJECT. The Save button is disabled while a save is in flight, and that
// was the ONLY re-entrancy defence in the form. It covers a double-tap on that button and nothing
// else — and the weigh-in session deliberately makes Enter a second submit path on the grams field
// (V4-HARVSESSION-002), which does not consult the button's disabled state at all. So the hole is
// not hypothetical and it is not reachable through the control everyone looks at: it is two Enters
// in the flow whose entire premise is typing a number and pressing Enter, over and over.
//
// The crucible's resilience seat called `if (saving) return` "the highest-value single line in the
// whole build". This file is what makes that line non-vacuous.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postHangs: false },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null,
    reset: vi.fn(),
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

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      // A save that never settles is the whole point: `saving` stays true, which is exactly the
      // window a second Enter arrives in on a real phone.
      if (dataRef.postHangs) return new Promise(() => {})
      return Promise.resolve({ id: `evt-${postCalls.length}`, updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] })
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = 'session=harvest') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// The project field is required and does not auto-select, so every case picks it explicitly.
// PROJECTS_HIDDEN is mocked false here on purpose: the flag-ON path routes the same submit through
// an implied-project seam, and the re-entrancy hole this file is about is in handleSubmit itself,
// which both paths share. Pinning the visible-project arm keeps the fixture the simpler of the two.
function chooseProject(id = 'proj-1') {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: id } })
}

async function fillAndEnter({ qty = '3', weight = '231' } = {}) {
  chooseProject()
  fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: qty } })
  const w = screen.getByLabelText('Harvest weight')
  fireEvent.change(w, { target: { value: weight } })
  await act(async () => { fireEvent.keyDown(w, { key: 'Enter' }) })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = []
  dataRef.postHangs = false
  localStorage.clear()
  wireApiFetch()
})

describe('EventNew — submit re-entrancy (gate B5)', () => {
  it('a second Enter while the save is in flight does NOT post twice', async () => {
    dataRef.postHangs = true
    renderEventNew()
    await flushLoad()

    await fillAndEnter()
    expect(postCalls).toHaveLength(1)

    // The save has not settled, so `saving` is still true. On a phone this is the second press of a
    // key the user is already holding — the harvest form's own flow, not an unusual gesture.
    const w = screen.getByLabelText('Harvest weight')
    await act(async () => { fireEvent.keyDown(w, { key: 'Enter' }) })
    await act(async () => { fireEvent.keyDown(w, { key: 'Enter' }) })

    expect(postCalls).toHaveLength(1)
  })

  it('does not wedge the form — once the save settles, the next Enter posts again', async () => {
    // THE NON-VACUITY HALF. A guard that simply never lets a second save through would pass the test
    // above and break the feature, and the failure would be silent: the user presses Enter and
    // nothing happens, forever. `saving` resets on both exits, and this proves it.
    renderEventNew()
    await flushLoad()

    await fillAndEnter({ qty: '3', weight: '231' })
    await waitFor(() => expect(postCalls).toHaveLength(1))

    await fillAndEnter({ qty: '4', weight: '188' })
    await waitFor(() => expect(postCalls).toHaveLength(2))
    expect(postCalls[1].harvest?.quantity ?? postCalls[1].quantity).toBeDefined()
  })

  it('a failed save releases the guard, so the user can retry', async () => {
    // The recovery case. If the POST rejects and `saving` stayed true, the natural response —
    // press Enter again — would be swallowed, turning a recoverable failure into a dead form.
    renderEventNew()
    await flushLoad()
    apiFetchSpy.mockImplementation((path, options = {}) => {
      if (options.method === 'POST' && path === '/api/events') {
        postCalls.push(JSON.parse(options.body))
        return Promise.reject(new Error('Network unreachable'))
      }
      if (path === '/api/projects') return Promise.resolve(dataRef.projects)
      if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
      if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
      return Promise.resolve(null)
    })

    await fillAndEnter()
    await waitFor(() => expect(postCalls).toHaveLength(1))

    await fillAndEnter()
    await waitFor(() => expect(postCalls).toHaveLength(2))
  })
})

// ── The return contract, guarded at the source ────────────────────────────────────────────────
//
// The contract cannot be observed from outside the component: handleSubmit is passed to onSubmit /
// onClick / onKeyDown, and React discards a handler's return value. So it is pinned the way this
// repo pins its Lambda route invariants — statically, against the real source (L-072 house style).
// The regression this catches is the exact one C6 describes: someone adds a tenth refusal path and
// returns bare, and every caller that trusted { ok } silently reads undefined as "not ok" for a
// save that in fact never happened — or worse, as falsy-but-unexplained.
describe('EventNew — handleSubmit return contract (condition C6)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const SRC = readFileSync(resolve(__dirname, '../pages/EventNew.jsx'), 'utf8')

  function handleSubmitBody() {
    const start = SRC.indexOf('async function handleSubmit(e, { keepMode = ')
    expect(start, 'handleSubmit not found').toBeGreaterThan(-1)
    // Bounded by the function's own closing brace at its declaration indent, not by a character
    // count: a fixed window drifts every time the body grows and fails silently in both directions.
    const end = SRC.indexOf('\n  }\n', start)
    expect(end, 'handleSubmit never closes at its declaration indent').toBeGreaterThan(start)
    const body = SRC.slice(start, end)
    // Floor, so the negative assertions below cannot pass over a degenerate window.
    expect(body, 'window does not contain the save itself').toContain('setSaving(true)')
    return body
  }

  it('guards re-entrancy before doing anything else', () => {
    expect(handleSubmitBody()).toMatch(/e\.preventDefault\(\)\s*\n\s*if \(saving\) return \{ ok: false, reason: 'in_flight' \}/)
  })

  it('every return in handleSubmit is typed — no path answers undefined', () => {
    const body = handleSubmitBody()
    const bare = body.split('\n')
      .map((l, i) => [i, l])
      .filter(([, l]) => /(^|[^.\w])return\b/.test(l) && !/\/\//.test(l.trim().slice(0, 2)))
      .filter(([, l]) => !/return \{ ok: (true|false)/.test(l))
    expect(bare.map(([, l]) => l.trim()), 'these return paths are untyped').toEqual([])
  })

  it('answers ok:true exactly once — the one path where the row exists', () => {
    const body = handleSubmitBody()
    expect((body.match(/return \{ ok: true/g) || []).length).toBe(1)
    expect(body).toMatch(/return \{ ok: true, eventId \}/)
  })

  it('gives every refusal a distinct reason a caller can branch on', () => {
    const body = handleSubmitBody()
    const reasons = [...body.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1])
    expect(reasons.length).toBeGreaterThanOrEqual(9)
    // no_planting is deliberately shared by the planting gate and the flag gate — same refusal,
    // same fix for the user. Everything else is its own reason.
    expect(new Set(reasons).size).toBe(reasons.length - 1)
  })
})
