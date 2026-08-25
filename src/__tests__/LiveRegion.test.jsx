// LiveRegion — V4-HAPTICVOCAB-001.
//
// WHAT THIS CAN AND CANNOT PROVE. jsdom has no accessibility tree and no screen reader, so nothing
// here proves TalkBack SPEAKS. What it does prove is the property TalkBack requires and that this
// app has already got wrong once (PlantingSelect.jsx:886-896, a live region deleted because it
// "could never announce anything"): the region is present and EMPTY at mount, and every announce —
// including a repeat of an identical string — produces an observable DOM MUTATION inside it. A
// region that mounts holding its text, or a write that no-ops on equal text, has nothing for an AT
// to observe, and that is exactly the failure that ships looking like coverage.
//
// The MutationObserver assertions use takeRecords() rather than awaiting the observer callback, so
// they are synchronous and deterministic — the records are queued by the DOM write itself.
import React, { useEffect } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import LiveRegion, { useLiveRegion } from '../components/LiveRegion.jsx'

// A minimal host that exposes announce() to the test without rendering anything else.
function Host({ onReady, children }) {
  const { ref, announce } = useLiveRegion()
  useEffect(() => { onReady(announce) }, [onReady, announce])
  return <LiveRegion regionRef={ref} testId="live" label="Harvest status">{children}</LiveRegion>
}

function mount(children) {
  let announce = null
  const utils = render(<Host onReady={(fn) => { announce = fn }}>{children}</Host>)
  const region = utils.getByTestId('live')
  return { ...utils, region, announce: (msg) => { let r; act(() => { r = announce(msg) }); return r } }
}

describe('mount-empty invariant', () => {
  it('renders the region with NO children at mount', () => {
    // The whole reason this is a component. If content can arrive in the same commit as the region,
    // the region is decorative.
    const { region } = mount()
    expect(region).toBeTruthy()
    expect(region.childNodes).toHaveLength(0)
    expect(region.textContent).toBe('')
  })

  it('ignores children entirely — there is no route by which text arrives at mount', () => {
    // A mutant that adds {children} to the component passes every other test in this file and
    // fails this one. That is the point of it.
    const { region } = mount('Saved. Cayenne, 4 fruit.')
    expect(region.textContent).toBe('')
  })

  it('carries role=status, aria-live=polite and aria-atomic', () => {
    const { region } = mount()
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    // Atomic because the save sentence carries five facts; half of it is worse than none.
    expect(region.getAttribute('aria-atomic')).toBe('true')
  })

  it('is visually hidden rather than a second visible copy of the session strip', () => {
    const { region } = mount()
    expect(region.style.position).toBe('absolute')
    expect(region.style.overflow).toBe('hidden')
    expect(region.style.width).toBe('1px')
  })
})

describe('mutation proof', () => {
  function observe(el) {
    const obs = new MutationObserver(() => {})
    obs.observe(el, { childList: true, characterData: true, subtree: true })
    return obs
  }

  it('produces a DOM mutation inside the region on announce', () => {
    const { region, announce } = mount()
    const obs = observe(region)
    announce('Saved. Cayenne #1, 4 fruit, 320 grams. 1 harvest this session, 320 grams total.')
    const records = obs.takeRecords()
    obs.disconnect()
    expect(records.length).toBeGreaterThan(0)
    expect(records.some(r => r.type === 'childList' && r.addedNodes.length > 0)).toBe(true)
    expect(region.textContent).toContain('4 fruit')
  })

  it('produces a mutation AGAIN for an IDENTICAL repeat message', () => {
    // The non-vacuous half. Two identical picks off the same plant at the same weight is a normal
    // bench sequence, and a value-equality write (or React-owned children) would announce the first
    // and silently drop the second — the user would be told about one of two saves. textContent's
    // setter replaces the child Text node unconditionally, which is why this holds.
    const { region, announce } = mount()
    const msg = 'Saved. Cayenne #1, 4 fruit, 320 grams. 2 harvests this session, 640 grams total.'
    announce(msg)
    const obs = observe(region)
    announce(msg)
    const records = obs.takeRecords()
    obs.disconnect()
    expect(records.some(r => r.type === 'childList' && r.addedNodes.length > 0)).toBe(true)
    expect(region.textContent).toBe(msg)
  })

  it('clears to empty on a null announcement without inserting the string "null"', () => {
    const { region, announce } = mount()
    announce('Cayenne #1 harvest removed.')
    announce(null)
    expect(region.textContent).toBe('')
    expect(region.childNodes).toHaveLength(0)
  })
})

describe('announce() reports whether a region was there to write to', () => {
  it('returns true once mounted', () => {
    const { announce } = mount()
    expect(announce('anything')).toBe(true)
  })

  it('returns false when the ref was never attached', () => {
    // A region mounted in the wrong render branch is otherwise a silent no-op — the same class of
    // "coverage that does not exist" this file is about, one level up.
    let announce = null
    function Orphan({ onReady }) {
      const { announce: fn } = useLiveRegion()
      useEffect(() => { onReady(fn) }, [onReady, fn])
      return null
    }
    render(<Orphan onReady={(fn) => { announce = fn }} />)
    expect(announce('nowhere')).toBe(false)
  })

  it('keeps a stable announce identity across re-renders', () => {
    // Call sites will list it in effect dep arrays (CareNeeded.jsx:525 already does with its own).
    // An unstable identity would re-run those effects on every render.
    const seen = []
    const onReady = vi.fn((fn) => seen.push(fn))
    const { rerender } = render(<Host onReady={onReady} />)
    rerender(<Host onReady={onReady} />)
    expect(new Set(seen).size).toBe(1)
  })
})
