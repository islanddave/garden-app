// Lane D / Phase D (slice 2) — ScopeChecklist behavior tests. Covers the extracted
// scope selector + 500-cap exclusion checklist: dry-run preview render, the running
// NET-COUNT (plan §5 Phase D — never make the user compute the set difference),
// exclusion toggling, the default-selection flip, capped warning, empty scope, the
// committed-selection lifted to the parent, and a11y associations.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ScopeChecklist from '../components/forms/ScopeChecklist.jsx'

const PLANTINGS = [
  { id: 'a', name: 'Tomato' },
  { id: 'b', name: 'Basil' },
  { id: 'c', name: 'Pepper' },
]
const dryRunOk = (plantings = PLANTINGS, capped = false) =>
  vi.fn(() => Promise.resolve({ count: plantings.length, capped, plantings }))

// Stateful harness so scope is controlled like in LogMany.
function Harness({ runDryRun, onSelectionChange = () => {}, initialScope = { type: 'all' }, ...rest }) {
  const [scope, setScope] = useState(initialScope)
  return (
    <ScopeChecklist
      scope={scope}
      onScopeChange={setScope}
      projects={[]}
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

// Robust against JSX text-node fragmentation: assert on the concatenated textContent.
const readyAnchor = () => screen.findByText(/Review/)

beforeEach(() => { try { localStorage.clear() } catch (e) {} })

describe('ScopeChecklist — scope chips + preview', () => {
  it('renders the three scope chips', () => {
    render(<Harness runDryRun={dryRunOk()} />)
    expect(screen.getByText('All active')).toBeDefined()
    expect(screen.getByText('By project')).toBeDefined()
    expect(screen.getByText('By space')).toBeDefined()
  })

  it('resolves the dry-run and shows the committed headline (3 of 3)', async () => {
    const { container } = render(<Harness runDryRun={dryRunOk()} />)
    await readyAnchor()
    expect(container.textContent).toMatch(/Log\s*watering\s*on\s*3\s*plantings/)
  })

  it('passes an AbortSignal + scope + eventType into runDryRun (race-safety)', async () => {
    const run = dryRunOk()
    render(<Harness runDryRun={run} />)
    await readyAnchor()
    const arg = run.mock.calls[0][0]
    expect(arg.signal).toBeInstanceOf(AbortSignal)
    expect(arg.scope).toEqual({ type: 'all' })
    expect(arg.eventType).toBe('watering')
  })
})

describe('ScopeChecklist — net count (set difference shown, never computed by the user)', () => {
  it('shows no net-count line when nothing is skipped', async () => {
    render(<Harness runDryRun={dryRunOk()} />)
    await readyAnchor()
    expect(screen.queryByTestId('net-count')).toBeNull()
  })

  it('renders "matched − skipped → will be logged" once a planting is excluded', async () => {
    render(<Harness runDryRun={dryRunOk()} />)
    await readyAnchor()
    fireEvent.click(screen.getByText(/Review/))
    fireEvent.click(screen.getByText('Tomato'))
    const net = await screen.findByTestId('net-count')
    expect(net.textContent).toMatch(/3 matched\s*−\s*1 skipped\s*→\s*2 will be logged/)
  })

  it('"Start with everything selected" unchecked excludes all → 0 will be logged', async () => {
    const onSel = vi.fn()
    render(<Harness runDryRun={dryRunOk()} onSelectionChange={onSel} />)
    await readyAnchor()
    fireEvent.click(screen.getByLabelText('Start with everything selected'))
    const net = await screen.findByTestId('net-count')
    expect(net.textContent).toMatch(/3 matched\s*−\s*3 skipped\s*→\s*0 will be logged/)
    await waitFor(() => {
      const last = onSel.mock.calls[onSel.mock.calls.length - 1][0]
      expect(last.committedCount).toBe(0)
      expect([...last.excludedIds].sort()).toEqual(['a', 'b', 'c'])
    })
  })
})

describe('ScopeChecklist — selection lifted to parent', () => {
  it('reports committedCount + excludedIds as rows toggle', async () => {
    const onSel = vi.fn()
    render(<Harness runDryRun={dryRunOk()} onSelectionChange={onSel} />)
    await readyAnchor()
    await waitFor(() => {
      const last = onSel.mock.calls[onSel.mock.calls.length - 1][0]
      expect(last.committedCount).toBe(3)
      expect(last.excludedIds).toEqual([])
    })
    fireEvent.click(screen.getByText(/Review/))
    fireEvent.click(screen.getByText('Basil'))
    await waitFor(() => {
      const last = onSel.mock.calls[onSel.mock.calls.length - 1][0]
      expect(last.committedCount).toBe(2)
      expect(last.excludedIds).toEqual(['b'])
    })
  })
})

describe('ScopeChecklist — warnings + empty + a11y', () => {
  it('shows the 500-cap warning when the preview is capped', async () => {
    render(<Harness runDryRun={dryRunOk(PLANTINGS, true)} />)
    expect(await screen.findByText(/Showing first 500/)).toBeDefined()
  })

  it('handles an empty scope without a Review list', async () => {
    const run = dryRunOk([])
    const { container } = render(<Harness runDryRun={run} />)
    await waitFor(() => expect(run).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toMatch(/on\s*0\s*plantings/))
    expect(screen.queryByText(/Review/)).toBeNull()
    expect(screen.queryByLabelText('Start with everything selected')).toBeNull()
  })

  it('exclusion rows are aria-pressed toggle buttons (selection grammar)', async () => {
    render(<Harness runDryRun={dryRunOk()} />)
    await readyAnchor()
    fireEvent.click(screen.getByText(/Review/))
    const row = screen.getByText('Tomato')
    expect(row.getAttribute('aria-pressed')).toBe('true')   // included
    fireEvent.click(row)
    expect(screen.getByText('Tomato').getAttribute('aria-pressed')).toBe('false') // skipped
  })

  it('surfaces a preview error inline (role=alert) instead of crashing', async () => {
    const run = vi.fn(() => Promise.reject(new Error('scope blew up')))
    render(<Harness runDryRun={run} />)
    expect(await screen.findByText('scope blew up')).toBeDefined()
  })
})
