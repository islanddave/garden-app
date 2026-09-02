// GardenArrival.reducedMotion.test.jsx — BUG-GARDENARRIVALMOTION-001 (design V101 §3 item 5).
//
// THE DEFECT WAS A FALSE CLAIM IN THE SOURCE, not a conformance argument. The header comment
// asserted that prefers-reduced-motion was handled; nothing in the component read the preference,
// and eight concurrent animations shipped behind that sentence — several 6000ms, one infinite, none
// pausable. So the criterion here is that the component itself honours it.
//
// The last test is the one that matters over time: it derives the animated classes FROM THE
// RENDERED SHEET and requires each to appear in the neutraliser. A ninth animation added to the
// sheet without being covered reds it — which is the failure mode this component already had once.
//
// jsdom runs no animations and does not evaluate prefers-reduced-motion inside a <style>, so the
// media-query arm is asserted as emitted text and the JS arm as the class it puts on the root.
//
// RENDER assertions only. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render } from '@testing-library/react'

import GardenArrival from '../components/GardenArrival.jsx'

const ART = '/critters/C001-honeybee.svg'

function stubMatchMedia(reduce) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q) => ({
      matches: reduce && q === '(prefers-reduced-motion: reduce)',
      media: q, addEventListener() {}, removeEventListener() {},
    }),
  })
}

afterEach(() => { delete window.matchMedia })

const root = (c) => c.querySelector('.ga-root')
const sheet = (c) => c.querySelector('style').textContent

describe('GardenArrival — prefers-reduced-motion', () => {
  it('renders the full garden when motion is fine (guards the file from going vacuous)', () => {
    // Without this, every "is it reduced" assertion below could pass on a component that rendered
    // nothing at all.
    stubMatchMedia(false)
    const { container } = render(<GardenArrival imageUrl={ART} />)
    expect(root(container).className).toBe('ga-root')
    expect(container.querySelectorAll('.ga-veg')).toHaveLength(8)
    expect(container.querySelectorAll('.ga-blade')).toHaveLength(10)
    expect(container.querySelector('.ga-flier')).toBeTruthy()
  })

  it('marks the root reduced when the media query matches', () => {
    stubMatchMedia(true)
    const { container } = render(<GardenArrival imageUrl={ART} />)
    expect(root(container).className).toBe('ga-root ga-reduced')
  })

  it('the prop overrides detection in both directions (the test seam CritterSprite uses)', () => {
    stubMatchMedia(false)
    const on = render(<GardenArrival imageUrl={ART} prefersReducedMotion />)
    expect(root(on.container).className).toBe('ga-root ga-reduced')

    stubMatchMedia(true)
    const off = render(<GardenArrival imageUrl={ART} prefersReducedMotion={false} />)
    expect(root(off.container).className).toBe('ga-root')
  })

  it('survives a browser with no matchMedia at all rather than throwing', () => {
    delete window.matchMedia
    const { container } = render(<GardenArrival imageUrl={ART} />)
    expect(root(container).className).toBe('ga-root')
  })

  it('ships the @media arm too, so the preference is honoured with no JS detection', () => {
    // The reactive half: JS detection is render-time only, and this is what covers a preference
    // flipped while the ~6s arrival is on screen.
    stubMatchMedia(false)
    const { container } = render(<GardenArrival imageUrl={ART} />)
    expect(sheet(container)).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('EVERY animated class in the sheet is neutralised — no animation escapes the override', () => {
    stubMatchMedia(false)
    const { container } = render(<GardenArrival imageUrl={ART} />)
    const css = sheet(container)

    // Brace-free rule bodies only, which is what excludes @keyframes and @media wrappers; the
    // keyframe steps inside them survive the scan but are dropped by the leading-dot filter.
    const animated = new Set()
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = selector.trim()
      if (!sel.startsWith('.ga-') || sel.includes(' ')) continue
      if (!/animation:/.test(body) || /animation:none/.test(body)) continue
      for (const s of sel.split(',')) animated.add(s.trim())
    }

    // The count is asserted so a regex that silently stops matching cannot pass this as "nothing
    // to cover". Eight is the number named in the defect.
    expect(animated.size).toBe(8)

    // Both arms are checked per class, because covering one and not the other is exactly the shape
    // of a half-fix. Reported as lists so a miss NAMES the class that escaped.
    const mediaAt = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(mediaAt).toBeGreaterThan(-1)
    const media = css.slice(mediaAt)
    expect([...animated].filter(c => !css.includes(`.ga-reduced ${c}`))).toEqual([])
    expect([...animated].filter(c => !new RegExp(`\\${c}[,{]`).test(media))).toEqual([])
  })

  it('the override kills motion without adding any other channel (Reward UX: ambient only)', () => {
    // Reducing is the whole remedy. No sound, no haptic, no interrupt, no substitute signal — and
    // opacity:1 lands the elements on their own 100% frame, so the reduced view is the settled
    // garden rather than an empty card.
    stubMatchMedia(true)
    const { container } = render(<GardenArrival imageUrl={ART} />)
    expect(sheet(container)).toContain('animation:none!important;opacity:1!important')
    expect(container.querySelector('audio')).toBeNull()
    expect(container.querySelectorAll('.ga-veg')).toHaveLength(8)
    expect(root(container).getAttribute('aria-hidden')).toBe('true')
  })
})
