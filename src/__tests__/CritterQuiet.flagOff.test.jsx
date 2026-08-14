// V4-CRITTERQUIET-001 — the flag-OFF arm. CRITTERS_QUIET is a taste call on a shipped reward
// surface, so the loud branch is the rollback lever, not dead code: this file keeps it covered so
// flipping the const back is a one-line revert with proof, not an archaeology exercise.
//
// Mirrors the SaveToDevice.flagOn/flagOff pattern — vi.mock is file-scoped, so the two arms cannot
// share a file. Partial importOriginal (not an enumerated literal) so a future featureFlags export
// does not re-break this file, per the App.routes.test.jsx note.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  CRITTERS_QUIET: false,
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <button type="button">fav</button> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <button type="button">up</button> }))

import PlantingTile from '../components/PlantingTile.jsx'

class MockIO {
  constructor(cb) { this.cb = cb }
  observe(node) { setTimeout(() => this.cb([{ isIntersecting: true, target: node }]), 0) }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IntersectionObserver', MockIO) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const planting = {
  id: 'pl9', project_id: 'pr3', name: 'Bhut Jolokia',
  status: 'growing', quantity: 1, featured_photo_view_url: null,
}
const critter = { id: 'c1', species_id: 3, earned_at: new Date().toISOString(), viewed_at: null, faded_at: null }

describe('V4-CRITTERQUIET-001 — flag OFF restores the sprite exactly', () => {
  it('paints the visible sprite (role=img + species art) and no sentinel', () => {
    render(<PlantingTile planting={planting} critters={[critter]} />)
    const el = screen.getByTestId('critter-sprite')
    expect(el.getAttribute('role')).toBe('img')
    expect(el.getAttribute('aria-label')).toBe('a blue jay')
    expect(el.querySelector('img').getAttribute('src')).toMatch(/^\/critters\//)
    expect(screen.queryByTestId('critter-view-sentinel')).toBeNull()
  })

  it('restores the interactive strip above the card link (z5, pointerEvents auto)', () => {
    render(<PlantingTile planting={planting} critters={[critter]} />)
    const strip = screen.getByTestId('critter-sprite').parentElement
    expect(strip.style.zIndex).toBe('5')
    expect(strip.style.pointerEvents).toBe('auto')
  })

  it('still reports the critter for mark-viewed — identical contract to the quiet arm', () => {
    const onSpriteIntersect = vi.fn()
    render(<PlantingTile planting={planting} critters={[critter]} onSpriteIntersect={onSpriteIntersect} />)
    act(() => { vi.advanceTimersByTime(1) })
    expect(onSpriteIntersect).toHaveBeenCalledTimes(1)
    expect(onSpriteIntersect.mock.calls[0][0].id).toBe('c1')
  })
})
