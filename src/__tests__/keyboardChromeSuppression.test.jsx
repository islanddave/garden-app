// keyboardChromeSuppression.test.jsx — V4-KBCHROME-001.
//
// WHAT THIS CAN PROVE. jsdom has no soft keyboard, no visualViewport, and no layout — so the
// device-facing halves (does the nav actually vanish above a real keyboard; is there truly no
// frame where the var and the pixels disagree) are the device pass's job. What IS deterministic:
//   1. the pure detector arithmetic (thresholds, the pinch guard, the baseline protocol);
//   2. with a FAKE visualViewport installed, the full wiring — one predicate driving BOTH each
//      component's visibility AND its CSS inset var, asserted after a single act() (one React
//      commit: style prop in the mutation pass + var in useLayoutEffect, pre-paint by
//      construction);
//   3. the integration the pre-rule demanded: once suppression fires, readChromeInsets sees the
//      suppressed chrome as 0px — pinned here by bridging jsdom's one gap (getComputedStyle does
//      not resolve CSS custom properties) with a mock that reads the same inline styles the
//      components write.
//   4. no visualViewport at all (jsdom default, pre-vv browsers) => permanently inert.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const { navigateSpy, locationRef, fetchSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/garden' },
  fetchSpy: vi.fn((url) => Promise.resolve(url === '/api/dashboard' ? { water_due: [], harvest_ready: [], heads_up: [] } : null)),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => locationRef,
  useNavigate: () => navigateSpy,
}))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: { display_name: 'Dave' }, signOut: vi.fn() }),
}))
vi.mock('../components/CatchUpBadge.jsx', () => ({ default: () => null }))
vi.mock('../components/BottomNavDot.jsx', () => ({ default: () => null }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve(null) }),
}))
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

import BottomNav, { BOTTOM_NAV_HEIGHT_PX } from '../components/BottomNav.jsx'
import TodayBand from '../components/TodayBand.jsx'
import { readChromeInsets } from '../components/forms/PlantingSelect.jsx'
import {
  isTextEntryElement, nextBaseline, settledBaseline, computeKeyboardOpen,
  KB_SHRINK_MIN_PX, KB_SCALE_MAX,
} from '../lib/keyboardChrome.js'

// ── 1. Pure detector ─────────────────────────────────────────────────────────

describe('detector pieces (pure)', () => {
  it('isTextEntryElement: text-summoning elements only', () => {
    expect(isTextEntryElement({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTextEntryElement({ tagName: 'INPUT' })).toBe(true)               // type defaults text
    expect(isTextEntryElement({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEntryElement({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTextEntryElement({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTextEntryElement({ tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(isTextEntryElement({ tagName: 'SELECT' })).toBe(false)             // native picker, no kb
    expect(isTextEntryElement({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntryElement(null)).toBe(false)                              // jsdom body/undefined
  })

  it('computeKeyboardOpen: focus AND >150px shrink AND unpinched — all three or nothing', () => {
    const base = { textEntryFocused: true, vvHeight: 500, baselineHeight: 800, vvScale: 1 }
    expect(computeKeyboardOpen(base)).toBe(true)
    expect(computeKeyboardOpen({ ...base, textEntryFocused: false })).toBe(false)
    expect(computeKeyboardOpen({ ...base, vvHeight: 700 })).toBe(false)       // 100px < threshold
    expect(computeKeyboardOpen({ ...base, vvHeight: 800 - KB_SHRINK_MIN_PX })).toBe(false) // exact = not open
    expect(computeKeyboardOpen({ ...base, vvScale: 2 })).toBe(false)          // THE pinch guard
    expect(computeKeyboardOpen({ ...base, vvScale: KB_SCALE_MAX })).toBe(true)
    // jsdom shape: no visualViewport => no finite numbers => false, never a throw.
    expect(computeKeyboardOpen({ textEntryFocused: true, vvHeight: undefined, baselineHeight: undefined, vvScale: undefined })).toBe(false)
  })

  it('nextBaseline: seeds, grows instantly, never shrinks, ignores pinched readings', () => {
    expect(nextBaseline({ baseline: null, vvHeight: 800, vvScale: 1 })).toBe(800)      // seed
    expect(nextBaseline({ baseline: 800, vvHeight: 900, vvScale: 1 })).toBe(900)       // grow (kb closed / URL bar gone)
    expect(nextBaseline({ baseline: 900, vvHeight: 500, vvScale: 1 })).toBe(900)       // never instant-shrink
    expect(nextBaseline({ baseline: 900, vvHeight: 2000, vvScale: 2 })).toBe(900)      // pinched reading ignored
    expect(nextBaseline({ baseline: 900, vvHeight: NaN, vvScale: 1 })).toBe(900)
  })

  it('settledBaseline: adopts a smaller resting height only unfocused + unpinched', () => {
    expect(settledBaseline({ baseline: 900, vvHeight: 600, vvScale: 1, textEntryFocused: false })).toBe(600)
    expect(settledBaseline({ baseline: 900, vvHeight: 600, vvScale: 1, textEntryFocused: true })).toBe(900)  // kb may be up
    expect(settledBaseline({ baseline: 900, vvHeight: 450, vvScale: 2, textEntryFocused: false })).toBe(900) // pinched
  })
})

// ── 2 + 3. Component wiring with a fake visualViewport ───────────────────────

class FakeVV extends EventTarget {
  constructor(height = 800) { super(); this.height = height; this.width = 400; this.scale = 1; this.offsetTop = 0 }
}

const navEl = () => screen.getByLabelText('Main navigation')
const navVar = () => document.documentElement.style.getPropertyValue('--bottom-nav-height')
const bandVar = () => document.documentElement.style.getPropertyValue('--today-band-height')
// DOM query, not getByRole: once suppressed, `visibility: hidden` removes the band from the
// accessibility tree (by design — that removal is asserted below), which getByRole honors.
const bandRoot = () => {
  let n = document.querySelector('button[data-tier]')
  while (n && n.style.position !== 'fixed') n = n.parentElement
  return n
}

function Harness() {
  return (
    <>
      <BottomNav />
      <TodayBand />
      <input type="text" aria-label="probe" />
    </>
  )
}

async function mountSuppressible(vv) {
  window.visualViewport = vv
  render(<Harness />)
  await act(async () => { await Promise.resolve() })            // dashboard fetch settles
  await act(async () => { screen.getByLabelText('probe').focus() })
}

async function shrinkTo(vv, height, scale = 1) {
  await act(async () => {
    vv.height = height
    vv.scale = scale
    vv.dispatchEvent(new Event('resize'))
  })
}

describe('suppression wiring (fake visualViewport)', () => {
  beforeEach(() => {
    locationRef.pathname = '/garden'
    document.documentElement.style.removeProperty('--bottom-nav-height')
    document.documentElement.style.removeProperty('--today-band-height')
  })
  afterEach(() => { delete window.visualViewport })

  it('keyboard-open reading hides BOTH chrome components AND zeroes BOTH vars in one commit', async () => {
    const vv = new FakeVV(800)
    await mountSuppressible(vv)
    expect(navVar()).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
    expect(bandVar()).toBe('56px')

    await shrinkTo(vv, 500)                                     // 300px shrink, focused, unpinched
    // All four surfaces of the predicate, asserted after ONE act = one React commit each side.
    expect(navEl().style.visibility).toBe('hidden')
    expect(navVar()).toBe('0px')
    expect(bandRoot().style.visibility).toBe('hidden')
    expect(bandVar()).toBe('0px')
    // visibility:hidden also removes the suppressed chrome from the a11y tree + tab order —
    // a screen reader must not be offered nav tabs that are not on screen.
    expect(screen.queryByRole('button', { name: /Today:/ })).toBeNull()
  })

  it('readChromeInsets sees the suppressed chrome as 0px through the same vars (integration)', async () => {
    // Bridge jsdom's one gap: getComputedStyle does not resolve custom properties, so read the
    // inline styles the components actually write. Position passthrough keeps hasFixedAncestor honest.
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => ({
      getPropertyValue: (p) => el.style.getPropertyValue(p),
      position: el.style.position,
    }))
    try {
      const vv = new FakeVV(800)
      await mountSuppressible(vv)
      expect(readChromeInsets().bottom).toBe(BOTTOM_NAV_HEIGHT_PX + 56)  // nav + band, pre-keyboard
      await shrinkTo(vv, 500)
      expect(readChromeInsets().bottom).toBe(0)                          // suppressed chrome = no inset
    } finally { spy.mockRestore() }
  })

  it('restores visibility and vars together after the ~300ms debounce once the keyboard closes', async () => {
    const vv = new FakeVV(800)
    await mountSuppressible(vv)
    await shrinkTo(vv, 500)
    expect(navEl().style.visibility).toBe('hidden')

    await shrinkTo(vv, 800)                                     // keyboard closed, focus retained
    expect(navEl().style.visibility).toBe('hidden')             // instant restore would flicker
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    expect(navEl().style.visibility).toBe('visible')
    expect(navVar()).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
    expect(bandRoot().style.visibility).toBe('visible')
    expect(bandVar()).toBe('56px')
  })

  it('a 2x pinch is NOT a keyboard — chrome stays put (the guard that makes restore possible)', async () => {
    const vv = new FakeVV(800)
    await mountSuppressible(vv)
    await shrinkTo(vv, 400, 2)                                  // zoomed: height halves, scale 2
    expect(navEl().style.visibility).toBe('visible')
    expect(navVar()).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
  })

  it('sub-threshold shrink (URL bar churn) never suppresses', async () => {
    const vv = new FakeVV(800)
    await mountSuppressible(vv)
    await shrinkTo(vv, 700)                                     // 100px < 150px
    expect(navEl().style.visibility).toBe('visible')
  })

  it('baseline grows instantly: a viewport that got TALLER re-arms detection at the new height', async () => {
    const vv = new FakeVV(800)
    window.visualViewport = vv
    render(<Harness />)
    await act(async () => { await Promise.resolve() })
    await shrinkTo(vv, 900)                                     // unfocused growth (URL bar collapsed)
    await act(async () => { screen.getByLabelText('probe').focus() })
    await shrinkTo(vv, 730)                                     // 170 vs 900 — only the RECAPTURED baseline trips
    expect(navEl().style.visibility).toBe('hidden')
  })

  it('baseline shrinks only once SETTLED: a smaller resting viewport is not read as keyboard-open', async () => {
    const vv = new FakeVV(800)
    window.visualViewport = vv
    render(<Harness />)
    await act(async () => { await Promise.resolve() })
    await shrinkTo(vv, 600)                                     // unfocused: viewport genuinely smaller now
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })  // settle window
    await act(async () => { screen.getByLabelText('probe').focus() })
    await shrinkTo(vv, 600)                                     // focus at the SAME height
    // Against a stale 800 baseline this would be a 200px "shrink" => false suppression.
    expect(navEl().style.visibility).toBe('visible')
  })

  it('orientationchange resets the baseline — fail-open to visible chrome at the new geometry (QA-G5)', async () => {
    const vv = new FakeVV(800)
    await mountSuppressible(vv)
    await shrinkTo(vv, 500)                                     // keyboard open in portrait
    expect(navEl().style.visibility).toBe('hidden')

    // Rotate: every landscape height is smaller than the 800px portrait baseline. WITHOUT the
    // reset, 800 - 350 = 450px reads as keyboard-open forever and the chrome stays hidden with
    // no keyboard — the harmful direction. The reset re-seeds from current geometry and
    // fail-opens to visible chrome.
    await act(async () => {
      vv.height = 350
      window.dispatchEvent(new Event('orientationchange'))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })  // restore debounce
    expect(navEl().style.visibility).toBe('visible')
    expect(navVar()).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
    expect(bandVar()).toBe('56px')
  })

  it('without visualViewport (jsdom default) the whole feature is inert', async () => {
    render(<Harness />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { screen.getByLabelText('probe').focus() })
    expect(navEl().style.visibility).toBe('visible')
    expect(navVar()).toBe(`${BOTTOM_NAV_HEIGHT_PX}px`)
    expect(bandVar()).toBe('56px')
  })
})
