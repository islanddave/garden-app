// V4-ASSIGNLENS-002 — per-card caretaker badge on the DrG Findings cards. Mirrors the Garden tile
// badge: shown ONLY when a multi-caretaker household is viewing a set that spans >1 caretaker
// (single-caretaker/unassigned sets suppress it). Self-contained mocks (members + auth + path-aware
// api) so it does not perturb the base Findings.test.jsx composition suite.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { findingsState, membersState, profileState } = vi.hoisted(() => ({
  findingsState: { current: { data: { findings: [] }, loading: false, error: null, reload: () => {} } },
  membersState: { current: [] },
  profileState: { current: null },
}))

// Path-aware api fetch: /api/plants + /api/projects feed the caretaker map.
const apiFetch = vi.fn(async (path) => {
  if (path === '/api/plants') return [
    { id: 'p1', project_id: 'pr1', assignee_user_id: 'A' },
    { id: 'p2', project_id: 'pr1', assignee_user_id: 'B' },
  ]
  if (path === '/api/projects') return []
  return {}
})

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  // V4-OVERLAY-001 Slice 2: FindingCard now renders OverlayLink, which calls useLocation().
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'test' }),
}))
vi.mock('../hooks/useFindings.js', () => ({ useFindings: () => findingsState.current }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => ({ data: null, loading: false }) }))
vi.mock('../hooks/useCritterCollection.js', () => ({ useCritterCollection: () => ({ collected: new Map(), loading: false }) }))
vi.mock('../hooks/useMembers.js', () => ({ useMembers: () => ({ members: membersState.current, loading: false }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null, profile: profileState.current, loading: false }) }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))

import Findings from '../pages/Findings.jsx'

const f = (id, plantId) => ({
  finding_id: id, plant_id: plantId, decay_state: 'fresh', trend: 'worsening',
  statement: `S_${id}`, assertion_mode: 'assert', confidence_band: 'low', confidence_basis: '', urgency_level: 'low',
})

beforeEach(() => {
  apiFetch.mockClear()
  membersState.current = [{ id: 'A', display_name: 'Dave' }, { id: 'B', display_name: 'Jen' }]
  profileState.current = { id: 'A' }
  findingsState.current = { data: { findings: [] }, loading: false, error: null, reload: () => {} }
})

describe('V4-ASSIGNLENS-002 — DrG caretaker badges', () => {
  it('renders a caretaker badge per card when the shown set spans >1 caretaker', async () => {
    findingsState.current = { data: { findings: [f('issue:a', 'p1'), f('issue:b', 'p2')] }, loading: false, error: null, reload: () => {} }
    render(<Findings />)
    // badges land after the async /api/plants + /api/projects resolve
    await waitFor(() => {
      expect(screen.getByLabelText('Cared for by you')).toBeTruthy()   // plant p1 -> A (me)
      expect(screen.getByLabelText('Cared for by Jen')).toBeTruthy()   // plant p2 -> B
    })
  })

  it('suppresses badges when every shown finding shares one caretaker (no signal)', async () => {
    // both findings resolve to A -> single-caretaker set
    findingsState.current = { data: { findings: [f('issue:a', 'p1'), f('issue:c', 'p1')] }, loading: false, error: null, reload: () => {} }
    render(<Findings />)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/plants'))
    expect(screen.queryByLabelText(/Cared for by/)).toBeNull()
  })

  it('never loads the caretaker map (no badges) for a single-member household', async () => {
    membersState.current = [{ id: 'A', display_name: 'Dave' }]
    findingsState.current = { data: { findings: [f('issue:a', 'p1'), f('issue:b', 'p2')] }, loading: false, error: null, reload: () => {} }
    render(<Findings />)
    // give any effect a tick; the plants/projects fetch must NOT fire
    await Promise.resolve()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/plants')
    expect(screen.queryByLabelText(/Cared for by/)).toBeNull()
  })
})
