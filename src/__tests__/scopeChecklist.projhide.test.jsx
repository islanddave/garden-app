// V4-PROJHIDE-001 — ScopeChecklist with PROJECTS_HIDDEN mocked TRUE.
//
// GAP CLOSED 2026-08-10: one of only three genuinely uncovered surfaces at flip time. ScopeChecklist
// is shared by Log Many AND Put Up, so a defect here hits both bulk surfaces at once — and the flag
// removes an entire scope MODE ("By project"), not just a label. The failure worth guarding is the
// silent one: removing a chip while leaving the mode reachable through stale persisted scope state,
// which would render a project selector the flag is supposed to have retired.
//
// Flag-OFF behavior (all three chips) is covered by scopeChecklist.test.jsx. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import ScopeChecklist from '../components/forms/ScopeChecklist.jsx'

const PLANTINGS = [
  { id: 'a', name: 'Tomato' },
  { id: 'b', name: 'Basil' },
]
const dryRunOk = (plantings = PLANTINGS) =>
  vi.fn(() => Promise.resolve({ count: plantings.length, capped: false, plantings }))

function Harness({ runDryRun, onSelectionChange = () => {}, initialScope = { type: 'all' }, ...rest }) {
  const [scope, setScope] = useState(initialScope)
  return (
    <ScopeChecklist
      scope={scope}
      onScopeChange={setScope}
      projects={[{ id: 'P1', name: 'Bed Alpha' }]}
      locations={[{ id: 'L1', name: 'Greenhouse' }]}
      eventType="watering"
      eventDate=""
      verbLabel="watering"
      runDryRun={runDryRun}
      onSelectionChange={onSelectionChange}
      {...rest}
    />
  )
}

beforeEach(() => { try { localStorage.clear() } catch (e) { /* noop */ } })

describe('ScopeChecklist — V4-PROJHIDE-001 (flag ON)', () => {
  it('offers All active and By zone, but not By project', () => {
    render(<Harness runDryRun={dryRunOk()} />)
    expect(screen.getByText(/All active/i)).toBeTruthy()
    expect(screen.getByText(/By zone/i)).toBeTruthy()
    expect(screen.queryByText(/By project/i)).toBeNull()
  })

  it('renders no project selector even when projects are passed in', () => {
    // The prop is deliberately still supplied above: the caller (LogMany) has no reason to stop
    // passing it, so the flag — not an empty list — must be what suppresses the control.
    render(<Harness runDryRun={dryRunOk()} />)
    expect(screen.queryByText('Bed Alpha')).toBeNull()
  })

  it('does not render a project selector even when a stale project scope is restored', () => {
    // The silent failure this exists for: hiding the chip while leaving the MODE reachable through
    // persisted scope state would put the retired selector back on screen by the back door.
    render(<Harness runDryRun={dryRunOk()} initialScope={{ type: 'project', project_id: 'P1' }} />)
    expect(screen.queryByText(/By project/i)).toBeNull()
    expect(screen.queryByText('Bed Alpha')).toBeNull()
  })
})
