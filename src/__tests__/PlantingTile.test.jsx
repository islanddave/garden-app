// V4-TAPCARD-001 — the whole planting card is a tap target. A stretched Link (data-testid
// "planting-tile-link") covers the card and carries the sole "Open {name}" accessible name; the
// photo box was retagged from a <Link> to a plain <div>, so there is exactly ONE nav link. The
// interactive controls (favorite / uploader / critters) are mocked out here — this test locks the
// link topology, not their behavior.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <button type="button">fav</button> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <button type="button">up</button> }))
vi.mock('../components/CritterSprite.jsx', () => ({ default: () => <span>sprite</span> }))
vi.mock('../components/PlantStatusBadge.jsx', () => ({ default: ({ status }) => <span>{status}</span> }))
vi.mock('../components/CaretakerBadge.jsx', () => ({ default: ({ caretaker }) => <span>badge:{caretaker?.initial}</span> }))

import PlantingTile from '../components/PlantingTile.jsx'

const pl = { id: 'pl9', project_id: 'pr3', name: 'Bhut Jolokia', status: 'growing', quantity: 1, featured_photo_view_url: null }

describe('V4-TAPCARD-001 — whole-card tap target', () => {
  it('exposes exactly one nav link covering the card, named "Open {name}", to the detail route', () => {
    render(<PlantingTile planting={pl} />)
    const links = screen.getAllByRole('link', { name: 'Open Bhut Jolokia' })
    expect(links.length).toBe(1)
    // Direct, NOT through the /projects/:id/plantings/:id redirect shim. The shim lands in the
    // right place but shows a project id in the address bar for the hop, and the standing
    // "no more Projects" directive is about what Dave sees, not only about controls.
    expect(links[0].getAttribute('href')).toBe('/plantings/pl9')
    expect(links[0].getAttribute('data-testid')).toBe('planting-tile-link')
  })

  it('renders the name inside the card so tapping the body (under the overlay) opens the planting', () => {
    render(<PlantingTile planting={pl} />)
    // the name is a plain span (not its own link) — the stretched overlay handles navigation
    const name = screen.getByText('Bhut Jolokia')
    expect(name.closest('a')).toBeNull()
  })
})
