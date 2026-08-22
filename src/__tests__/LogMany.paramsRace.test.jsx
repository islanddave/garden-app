// BUG-LOGMANYCANCELFLAG-001 — does a mid-flight querystring change strand /log/many un-ready?
//
// THE COVERAGE THIS REPLACES WAS INVERTED IN BOTH DIRECTIONS. LogManyPicker.test.jsx and
// LogManyHarvestHint.test.jsx both mock `useSearchParams: () => [new URLSearchParams(), vi.fn()]`,
// which hands back a FRESH identity on every render. The load effect is keyed on [fetch, params], so
// under that mock it re-runs on every render — constantly in test, once in prod. Neither the real
// behaviour nor the failure mode is observable through it: the tests exercise a params-churns-always
// world, and prod is a params-never-churns world.
//
// This file uses a REAL MemoryRouter and a REAL useSearchParams, for the reason the routermock lane
// established on 2026-08-21: a hand-written router mock is a copy of react-router's identity and
// memoization semantics, and those semantics ARE the subject here. A mock cannot be evidence about
// them. The deferred fetch lets the URL change while the load is genuinely in flight, which is the
// only way to reach the state the row describes.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter, useSearchParams } from 'react-router-dom'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const state = { gates: [] }

// STABLE IDENTITY, and this is not incidental. The effect under test is keyed on [fetch, params].
// The real useApiFetch memoizes `fetch` with useCallback, so in prod it changes only when the Clerk
// token getter does. A mock that builds a new closure per render — which is what my first version of
// this file did, and what the existing LogMany tests do with useSearchParams — makes the effect
// re-run on EVERY render and quietly tests a different program. Measured: it produced 4 mount
// fetches instead of 2. The churn has to come from the URL change alone or this file proves nothing.
const stableFetch = vi.fn(() => {
  const d = deferred()
  state.gates.push(d)
  return d.promise
})
const stableToken = vi.fn(async () => 'tok')
const api = { fetch: stableFetch, getToken: stableToken }

vi.mock('../lib/api.js', () => ({ useApiFetch: () => api }))

vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, ScopeChecklist: () => null }
})

import LogMany from '../pages/LogMany.jsx'

// Drives a real URL change from inside the router, so `params` changes exactly the way it would in
// the app rather than by swapping a mock's return value.
function Harness() {
  const [, setParams] = useSearchParams()
  return (
    <>
      <button data-testid="change-url" onClick={() => setParams({ project_id: 'p-123' })}>change</button>
      <LogMany />
    </>
  )
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

// Every pending fetch resolves to [] — enough for the load to complete; the row's claim is about
// readiness, not about content.
const resolveAll = async () => {
  const pending = state.gates.splice(0)
  pending.forEach((g) => g.resolve([]))
  await flush()
}

beforeEach(() => { state.gates = []; stableFetch.mockClear(); localStorage.clear() })

describe('BUG-LOGMANYCANCELFLAG-001 — mid-flight querystring change', () => {
  it('reaches ready on a clean load (the guard is not vacuous)', async () => {
    render(<MemoryRouter initialEntries={['/log/many']}><Harness /></MemoryRouter>)
    expect(state.gates.length).toBe(2)          // projects + locations
    await resolveAll()
    // !ready renders ONLY <Shell><Spinner block/></Shell>, so any real control proves the page got
    // past the gate. The event-type tile is a <button>; the "Log one ->" links share its label text,
    // which is why this queries by role rather than by text.
    // findAll, not find: the tile and its "Log one ->" sibling both carry the label. The claim being
    // made is "the page rendered its controls", not "exactly one control matches".
    expect((await screen.findAllByRole('button', { name: /Watered/i })).length).toBeGreaterThan(0)
  })

  // THE ROW'S CLAIM, stated as an executable question rather than inherited. If the page ends up
  // permanently un-ready, this fails and the row is confirmed. If it recovers, the row's severity is
  // overstated and that is worth knowing BEFORE anyone writes a fix for it.
  it('recovers when the URL changes while the first load is still in flight', async () => {
    render(<MemoryRouter initialEntries={['/log/many']}><Harness /></MemoryRouter>)
    expect(state.gates.length).toBe(2)
    const firstRun = state.gates.splice(0)

    // URL changes mid-flight: cleanup sets the first run's `on = false` and the effect re-runs.
    await act(async () => { screen.getByTestId('change-url').click() })

    // The stranded first-run responses arrive AFTER the cancel — they must be discarded.
    firstRun.forEach((g) => g.resolve([]))
    await flush()

    // The second run's own fetches must exist and must complete the load.
    expect(state.gates.length).toBeGreaterThan(0)
    await resolveAll()

    // findAll, not find: the tile and its "Log one ->" sibling both carry the label. The claim being
    // made is "the page rendered its controls", not "exactly one control matches".
    expect((await screen.findAllByRole('button', { name: /Watered/i })).length).toBeGreaterThan(0)
  })
})
