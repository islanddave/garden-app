// V4-LOGMANYHONEST-001 — Log Many is honest about harvest BEFORE the tap.
//
// The harvest tiles render on the bulk surface but route OUT to per-plant entry (LogMany.jsx
// goPerPlant), because a harvest needs its own quantity and unit and the batch body cannot carry
// per-planting values. Un-announced, that reads as a mis-tap: the user deliberately chose the bulk
// surface and silently lands on a single-event form with nothing to attribute the jump to. The
// standing hint sets the expectation up front instead of apologising afterwards.
//
// Own file rather than appended to LogManyPicker.test.jsx: adding a fourth LogMany render to that
// harness reliably exhausted the JS heap (4GB OOM, worker killed). Not diagnosed further — an
// isolated harness is cheaper than fighting it, and keeps this assertion independent of that file.
// COVERAGE LIMIT — this file mocks react-router-dom, including
// `useSearchParams: () => [new URLSearchParams(), vi.fn()]`, which returns a FRESH identity on every
// render. LogMany's load effect is keyed on [fetch, params], so under this mock it re-runs on every
// render; with a real router (measured 2026-08-22, react-router-dom 7.18.1) that identity is stable
// and the effect runs once. This file therefore cannot say anything about router semantics, effect
// re-entry, or the BUG-LOGMANYCANCELFLAG-001 params race — it is a rendering test and only that.
// Real-router coverage of the load effect lives in LogMany.paramsRace.test.jsx.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ children }) => children,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])) }) }))
vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, ScopeChecklist: () => null }
})

import LogMany from '../pages/LogMany.jsx'

describe('LogMany — harvest honesty hint (V4-LOGMANYHONEST-001)', () => {
  it('warns up front that harvests are logged one at a time, and why', async () => {
    render(<LogMany />)
    await screen.findByText('Harvested')
    const hint = screen.getByTestId('logmany-harvest-hint')
    // Both halves matter: WHAT happens (one at a time) and WHY (each needs a quantity). Without
    // the reason it reads as an arbitrary limitation rather than a consequence of the data.
    expect(/one at a time/i.test(hint.textContent)).toBe(true)
    expect(/quantity/i.test(hint.textContent)).toBe(true)
  })
})
