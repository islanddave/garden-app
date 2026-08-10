// V4-PROJHIDE-001 — ProjectNew's back/Cancel target with PROJECTS_HIDDEN mocked TRUE.
//
// THE GAP THIS CLOSES. Under the flag, App.jsx redirects /projects -> /garden, but ProjectNew's
// breadcrumb and Cancel link were hardcoded to /projects. So Cancel silently teleported the user to
// the Garden page via a redirect, under a breadcrumb still labelled "Projects". No in-app link
// reaches /projects/new when the flag is on (EventNew's entry point sits inside the !PROJECTS_HIDDEN
// block), so this is the deep-link / bookmark path only — but a Cancel that lands somewhere the user
// did not choose is a rough edge whether or not it is frequent, and it was one of exactly three gaps
// standing between this flag and a flip.
//
// Flag-OFF behavior (both targets /projects, breadcrumb "Projects") is covered by ProjectNew.test.jsx.
// importActual spread so every other flag keeps its real value. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const navigateSpy = vi.fn()

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])) }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useNavigate: () => navigateSpy,
}))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import ProjectNew from '../pages/ProjectNew.jsx'

describe('ProjectNew — back target under PROJECTS_HIDDEN (flag ON)', () => {
  it('Cancel goes to /garden directly, not through the /projects redirect', () => {
    render(<ProjectNew />)
    const cancel = screen.getByText('Cancel')
    expect(cancel.getAttribute('href')).toBe('/garden')
  })

  it('the breadcrumb is labelled for where it actually goes', () => {
    // The label and the destination are the same defect when they disagree: "Projects" pointing at
    // the Garden page is exactly the silent teleport this closes.
    render(<ProjectNew />)
    const crumb = screen.getByText('Garden')
    expect(crumb.getAttribute('href')).toBe('/garden')
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('no link on the page still points at the retired /projects route', () => {
    // Catches a future third link being added against the old hardcoded target rather than the
    // shared const — the drift this fix collapsed two sites into one to prevent.
    const { container } = render(<ProjectNew />)
    const stale = Array.from(container.querySelectorAll('a'))
      .filter(a => a.getAttribute('href') === '/projects')
    expect(stale.length).toBe(0)
  })
})
