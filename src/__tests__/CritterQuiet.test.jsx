// V4-CRITTERQUIET-001 (BD0806-24) — critters demoted VISUALLY on the two work surfaces.
//
// What this file pins, in the order the risk runs:
//   1. The flag is a shipped literal (flipping it is a deliberate, RED-going change).
//   2. The Stage-2 tile sprite paints NOTHING under quiet — no <img>, no role=img, no aria name.
//   3. THE ACTUAL HAZARD: the per-critter mark-viewed contract survives the hiding. onIntersect
//      still fires once per critter, so Garden.jsx's seenIdsRef still fills and
//      markCrittersViewed still sends actually_seen_critter_ids. A naive `return null` in the
//      quiet arm would empty that array, which makes Garden pass null, which makes the Lambda
//      fall back to the legacy BULK mark-viewed path — a durable viewed_at write on a DIFFERENT
//      row set, with no visual symptom. Tests 3-6 exist so that regression cannot ship green.
//   4. The gating parity cases (null critter / unknown species / faded) — a critter that would not
//      have fired onIntersect loudly must still not fire it quietly.
//   5. The App-level arrival animation is gated at its mount site.
//
// The flag-OFF arm (sprites return) is pinned in CritterQuiet.flagOff.test.jsx — both branches stay
// live and covered, per the SAVE_TO_DEVICE_HIDDEN idiom.
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

// Router + the tile's unrelated interactive leaves are mocked (same shape PlantingTile.test.jsx
// uses). CritterSprite is deliberately NOT mocked — it is the subject.
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <button type="button">fav</button> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <button type="button">up</button> }))

import CritterSprite from '../components/CritterSprite.jsx'
import PlantingTile from '../components/PlantingTile.jsx'
import { CRITTERS_QUIET } from '../lib/featureFlags.js'

// IntersectionObserver stub — reports intersecting=true on the next macrotask after observe(),
// mirroring CritterSprite.test.jsx so both arms are exercised through the same seam.
class MockIO {
  constructor(cb) { this.cb = cb }
  observe(node) { setTimeout(() => this.cb([{ isIntersecting: true, target: node }]), 0) }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IntersectionObserver', MockIO) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function critter(over = {}) {
  return {
    id: 'c1',
    species_id: 3,
    earned_at: new Date().toISOString(),
    viewed_at: null,
    faded_at: null,
    dot_visible_after: new Date().toISOString(),
    ...over,
  }
}

const planting = {
  id: 'pl9', project_id: 'pr3', name: 'Bhut Jolokia',
  status: 'growing', quantity: 1, featured_photo_view_url: null,
}

// Flush the IO stub's setTimeout(…, 0) and the effect it schedules.
function flushIO() { act(() => { vi.advanceTimersByTime(1) }) }

describe('V4-CRITTERQUIET-001 — the flag', () => {
  it('CRITTERS_QUIET ships true as a literal boolean (not an env passthrough)', () => {
    expect(CRITTERS_QUIET).toBe(true)
    expect(typeof CRITTERS_QUIET).toBe('boolean')
  })
})

describe('V4-CRITTERQUIET-001 — CritterSprite quiet arm paints nothing', () => {
  it('renders no sprite image, no role=img and no species aria name', () => {
    render(<CritterSprite critter={critter({ species_id: 3 })} quiet prefersReducedMotion={true} />)
    expect(screen.queryByTestId('critter-sprite')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByLabelText('a blue jay')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('renders a hidden, non-interactive sentinel that still occupies the sprite geometry', () => {
    render(<CritterSprite critter={critter()} quiet spriteSize={22} prefersReducedMotion={true} />)
    const el = screen.getByTestId('critter-view-sentinel')
    expect(el.style.opacity).toBe('0')
    expect(el.style.pointerEvents).toBe('none')
    expect(el.getAttribute('aria-hidden')).toBe('true')
    // Geometry is load-bearing: IntersectionObserver reads layout boxes, so the sentinel must be
    // the same size/position as the sprite it replaces or the threshold(0.1) gate shifts.
    // display:none would zero the box and stop IO reporting entirely — pin against it.
    expect(el.style.display).toBe('inline-block')
    expect(el.style.width).toBe('22px')
    expect(el.style.height).toBe('22px')
  })

  it('does not fire the long-press handler — there is no visible target to press', () => {
    const onLongPress = vi.fn()
    render(<CritterSprite critter={critter()} quiet onLongPress={onLongPress} prefersReducedMotion={true} />)
    const el = screen.getByTestId('critter-view-sentinel')
    fireEvent.pointerDown(el)
    act(() => { vi.advanceTimersByTime(2000) })
    fireEvent.pointerUp(el)
    expect(onLongPress).not.toHaveBeenCalled()
  })
})

describe('V4-CRITTERQUIET-001 — mark-viewed contract survives the hiding', () => {
  it('still fires onIntersect exactly once, with the critter, when the sentinel enters viewport', () => {
    const onIntersect = vi.fn()
    render(<CritterSprite critter={critter({ id: 'c-abc' })} quiet onIntersect={onIntersect} prefersReducedMotion={true} />)
    expect(onIntersect).not.toHaveBeenCalled()
    flushIO()
    expect(onIntersect).toHaveBeenCalledTimes(1)
    expect(onIntersect.mock.calls[0][0].id).toBe('c-abc')
    // Idempotent: a second intersection callback must not double-count.
    flushIO()
    expect(onIntersect).toHaveBeenCalledTimes(1)
  })

  it('PlantingTile reports EVERY critter on the tile — an empty seen-set is what triggers the bulk fallback', () => {
    const onSpriteIntersect = vi.fn()
    render(
      <PlantingTile
        planting={planting}
        critters={[critter({ id: 'c1' }), critter({ id: 'c2', species_id: 4 })]}
        onSpriteIntersect={onSpriteIntersect}
      />
    )
    // Nothing visible on the tile…
    expect(screen.queryByTestId('critter-sprite')).toBeNull()
    expect(document.querySelector('img[src^="/critters/"]')).toBeNull()
    // …but both sentinels are mounted and both report.
    expect(screen.getAllByTestId('critter-view-sentinel')).toHaveLength(2)
    flushIO()
    expect(onSpriteIntersect).toHaveBeenCalledTimes(2)
    expect(onSpriteIntersect.mock.calls.map(c => c[0].id).sort()).toEqual(['c1', 'c2'])
  })

  it('the invisible strip cannot steal a tap from the stretched card link', () => {
    render(<PlantingTile planting={planting} critters={[critter()]} />)
    const strip = screen.getByTestId('critter-view-sentinel').parentElement
    expect(strip.style.pointerEvents).toBe('none')
    // z0, below the stretched card link at z1 — an invisible band must not sit over the tap target.
    expect(strip.style.zIndex).toBe('0')
  })

  it('does NOT report a critter that would not have reported loudly (null / unknown species / faded)', () => {
    const onIntersect = vi.fn()
    const { rerender } = render(<CritterSprite critter={null} quiet onIntersect={onIntersect} />)
    flushIO()
    rerender(<CritterSprite critter={critter({ species_id: 255 })} quiet onIntersect={onIntersect} />)
    flushIO()
    expect(onIntersect).not.toHaveBeenCalled()
    // A faded critter clears (300ms) and unmounts in both arms.
    rerender(<CritterSprite critter={critter({ id: 'c9', faded_at: new Date().toISOString() })} quiet onIntersect={onIntersect} />)
    act(() => { vi.advanceTimersByTime(400) })
    expect(screen.queryByTestId('critter-view-sentinel')).toBeNull()
  })
})

describe('V4-CRITTERQUIET-001 — the arrival animation is gated at its mount site', () => {
  // No test in this repo renders the App shell (App.routes.test.jsx inspects the route table only),
  // so the mount site is pinned statically. This proves the gate EXISTS in source; it does not
  // execute it. Stated as such in the lane report.
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../App.jsx'), 'utf8')

  it('mounts CritterArrivalController exactly once, and only behind !CRITTERS_QUIET', () => {
    const mounts = appSrc.match(/<CritterArrivalController\s*\/>/g) || []
    expect(mounts).toHaveLength(1)
    expect(appSrc).toContain('{user && !CRITTERS_QUIET && <CritterArrivalController />}')
  })

  it('imports the flag it gates on', () => {
    expect(/import \{[^}]*CRITTERS_QUIET[^}]*\} from '\.\/lib\/featureFlags\.js'/.test(appSrc)).toBe(true)
  })
})
