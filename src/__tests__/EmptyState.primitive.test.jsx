// V4-EMPTYSTATE-001 — the shared empty-state primitive.
// Seven surfaces route through this one component, and six of them reach it only through a page
// test that asserts on COPY. So the two things this convergence actually decided have no coverage
// there, and both are silently breakable:
//   1. the FLAT child list. Garden.icons.test.jsx finds the medallion via
//      `getByText(title).closest('div')`. Wrapping title+body in a text group would retarget that
//      at a div holding no svg — a green primitive and a red page test, with the cause one file away.
//   2. the icon/emoji FOOTPRINT parity. The whole point of generalising Inventory's tinted tile was
//      that an <Icon> surface and an emoji surface get the same box. Nothing else asserts it.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import EmptyState from '../components/forms/EmptyState.jsx'

afterEach(cleanup)

describe('EmptyState — the shared primitive', () => {
  it('renders an iconName as an SVG inside the medallion, reachable from the title', () => {
    render(<EmptyState iconName="nav.garden" title="Your garden is empty" body="Add something." />)
    const card = screen.getByText('Your garden is empty').closest('div')
    expect(card.querySelector('svg')).not.toBeNull()
  })

  it('gives an emoji the SAME medallion box an icon gets', () => {
    const { container: iconBox } = render(<EmptyState iconName="nav.garden" title="A" body="b" />)
    const iconMedallion = iconBox.firstChild.firstChild
    cleanup()
    const { container: emojiBox } = render(<EmptyState emoji="🌿" title="A" body="b" />)
    const emojiMedallion = emojiBox.firstChild.firstChild
    expect(emojiMedallion.textContent).toBe('🌿')
    expect(emojiMedallion.style.width).toBe(iconMedallion.style.width)
    expect(emojiMedallion.style.height).toBe(iconMedallion.style.height)
    expect(emojiMedallion.style.borderRadius).toBe(iconMedallion.style.borderRadius)
  })

  it('omits the medallion entirely when a surface has no glyph', () => {
    // Locations and ArchivedPlantings are body-only. An empty tinted circle above two lines of
    // prose would read as a failed image, not as a deliberate blank.
    const { container } = render(<EmptyState body="No zones yet." />)
    expect(container.querySelectorAll('div')).toHaveLength(1) // the card, and nothing inside it
    expect(screen.getByText('No zones yet.')).toBeTruthy()
  })

  it('passes the action through untouched so a page keeps its own control styling', () => {
    // RecentlyDeleted's escape link carries a pinned 44px tap target. The primitive supplies the
    // slot's spacing and must not restyle what is put in it.
    render(<EmptyState body="b" action={<a href="/photos" style={{ minHeight: 44 }}>Back to Photos</a>} />)
    const link = screen.getByText('Back to Photos')
    expect(link.style.minHeight).toBe('44px')
    expect(link.getAttribute('href')).toBe('/photos')
  })

  it('marks the glyph decorative — it never carries meaning the copy does not', () => {
    const { container } = render(<EmptyState emoji="🧺" title="No totals yet" body="b" />)
    expect(container.firstChild.firstChild.getAttribute('aria-hidden')).toBe('true')
  })
})
