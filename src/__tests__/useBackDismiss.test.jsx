// V4-BACKNAV-001 Slice P — useBackDismiss (the vertical pilot's whole mechanism).
//
// HARNESS NOTE, and it is the point of this file. ~29 of the repo's test files render under
// MemoryRouter, which keeps its own in-memory stack and NEVER touches window.history — so a
// back-nav test written in the house style would never deliver a popstate and would pass
// VACUOUSLY. These tests therefore drive REAL jsdom history directly, and the first test is a
// harness self-test proving a popstate actually arrives (the noBareViewUrlImg.static convention of
// proving the matcher can catch a real offender).
//
// MEASURED jsdom@25 fidelity, not assumed: pushState/replaceState, history.state and history.length
// all behave correctly, and history.back() DOES traverse same-document entries and fire popstate —
// but ASYNCHRONOUSLY, so every assertion after a back() must await a macrotask. A back() at index 0
// is a SILENT no-op (no event, no error), which is exactly why B3's trigger condition is not
// observable here at all and is declared device-only rather than faked.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const flags = { BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))

import { useBackDismiss, readMarker, MARKER_KEY, MARKER_VERSION } from '../hooks/useBackDismiss.js'

// Let jsdom deliver the async popstate, then let React flush. MEASURED, not guessed: a 0ms
// macrotask is NOT enough — jsdom queues the traversal, and a same-tick assertion reads pre-back
// state and false-fails. This harness's self-test below is what caught that.
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 50)) }) }

function Harness({ id = 'pilot' }) {
  const [open, setOpen] = useState(false)
  useBackDismiss({ open, onDismiss: () => setOpen(false), id })
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <button onClick={() => setOpen(false)}>close</button>
      <span data-testid="state">{open ? 'OPEN' : 'SHUT'}</span>
    </>
  )
}

const state = () => screen.getByTestId('state').textContent

describe('useBackDismiss — harness fidelity', () => {
  it('SELF-TEST: real jsdom history delivers popstate to a listener (else every test below is vacuous)', async () => {
    const seen = vi.fn()
    window.addEventListener('popstate', seen)
    window.history.pushState({ probe: 1 }, '')
    window.history.back()
    await settle()
    window.removeEventListener('popstate', seen)
    expect(seen).toHaveBeenCalled()
  })
})

describe('useBackDismiss — flag ON', () => {
  beforeEach(() => {
    flags.BACKNAV_ENABLED = true
    window.history.replaceState({}, '')
  })

  it('pushes exactly one entry on open and closes the surface on Back (B2)', async () => {
    render(<Harness />)
    act(() => { fireEvent.click(screen.getByText('open')) })
    expect(state()).toBe('OPEN')
    // Presence of OUR marker on the current entry is the real signal. history.length is NOT usable
    // as a cross-test assertion: jsdom carries the stack between tests in a file, and a push from a
    // popped position TRUNCATES the forward entry rather than extending — so length legitimately
    // stays flat. Asserting length here would encode the harness's history, not the behaviour.
    expect(readMarker(window.history.state)?.id).toBe('pilot')

    act(() => { window.history.back() })
    await settle()
    expect(state()).toBe('SHUT')
    expect(readMarker(window.history.state)).toBeNull()
  })

  // Without this, the stack grows by one per open/close cycle and the user's Back count drifts
  // further from what they expect on every single interaction.
  it('consumes its own entry when closed by the Close control', async () => {
    render(<Harness />)
    act(() => { fireEvent.click(screen.getByText('open')) })
    expect(readMarker(window.history.state)?.id).toBe('pilot')
    act(() => { fireEvent.click(screen.getByText('close')) })
    await settle()
    expect(state()).toBe('SHUT')
    // The marker is gone: we traversed off our own entry rather than stranding it. NOTE this is
    // asserted via history.state, NOT history.length — back() moves the pointer, it does not shrink
    // the stack, so a length assertion here would be measuring the wrong thing.
    expect(readMarker(window.history.state)).toBeNull()
  })

  it('a Close-driven consume does NOT re-enter onDismiss (the self-pop guard)', async () => {
    const onDismiss = vi.fn()
    function Counted() {
      const [open, setOpen] = useState(false)
      useBackDismiss({ open, onDismiss: () => { onDismiss(); setOpen(false) }, id: 'counted' })
      return (<>
        <button onClick={() => setOpen(true)}>open</button>
        <button onClick={() => setOpen(false)}>close</button>
      </>)
    }
    render(<Counted />)
    act(() => { fireEvent.click(screen.getByText('open')) })
    act(() => { fireEvent.click(screen.getByText('close')) })
    await settle()
    expect(onDismiss).not.toHaveBeenCalled()   // closed by the button, not by Back
  })

  it('repeated open/close is BOUNDED — the stack never grows past one extra entry', async () => {
    render(<Harness />)
    const before = window.history.length
    for (let i = 0; i < 4; i++) {
      act(() => { fireEvent.click(screen.getByText('open')) })
      act(() => { window.history.back() })
      await settle()
      expect(state()).toBe('SHUT')
    }
    // Each open pushes onto the popped position, replacing the previous forward entry rather than
    // stacking. Unbounded growth here is the failure that would make "how many Backs to leave the
    // app" drift further from the user's expectation on every single interaction.
    expect(window.history.length).toBeLessThanOrEqual(before + 1)
  })

  // react-router owns history.state as {usr, key, idx}; @remix-run/router warns that writing it
  // directly "will result in bugs". Clobbering idx desyncs the router's index from the real stack.
  it('MERGES into history.state — never clobbers the router keys', () => {
    window.history.replaceState({ usr: { background: { pathname: '/today' } }, key: 'abc', idx: 4 }, '')
    render(<Harness />)
    act(() => { fireEvent.click(screen.getByText('open')) })
    const s = window.history.state
    expect(s.idx).toBe(4)
    expect(s.key).toBe('abc')
    expect(s.usr.background.pathname).toBe('/today')
    expect(s[MARKER_KEY].v).toBe(MARKER_VERSION)
  })

  it('two instances do not mistake each other\'s marker for their own', async () => {
    render(<><Harness id="a" /><Harness id="b" /></>)
    const [openA, openB] = screen.getAllByText('open')
    act(() => { fireEvent.click(openA) })
    act(() => { fireEvent.click(openB) })
    expect(readMarker(window.history.state)?.id).toBe('b')
    act(() => { window.history.back() })
    await settle()
    // Only B closed; A is still open and still owns the entry beneath.
    const states = screen.getAllByTestId('state').map(n => n.textContent)
    expect(states).toEqual(['OPEN', 'SHUT'])
  })
})

describe('useBackDismiss — marker validation (history.state is untrusted across reload AND deploy)', () => {
  it('rejects a foreign, versionless, or malformed marker rather than acting on it', () => {
    expect(readMarker(null)).toBeNull()
    expect(readMarker({})).toBeNull()
    expect(readMarker({ [MARKER_KEY]: { v: 0, id: 'x' } })).toBeNull()          // older bundle
    expect(readMarker({ [MARKER_KEY]: { v: MARKER_VERSION } })).toBeNull()      // no id
    expect(readMarker({ [MARKER_KEY]: { v: MARKER_VERSION, id: 7 } })).toBeNull() // wrong type
    expect(readMarker({ [MARKER_KEY]: { v: MARKER_VERSION, id: 'ok' } })).toEqual({ v: MARKER_VERSION, id: 'ok' })
  })
})

describe('useBackDismiss — flag OFF is provably inert', () => {
  beforeEach(() => { flags.BACKNAV_ENABLED = false; window.history.replaceState({}, '') })
  afterEach(() => { flags.BACKNAV_ENABLED = true })

  // The boss-pass rollback contract, stated as an assertion: flag off ⇒ zero pushState calls, zero
  // listeners, history.length unchanged. OVERLAY_ROUTES_ENABLED's own note concedes it stopped being
  // a real lever once later slices mutated outside its guard; this pins that this one has not.
  it('pushes nothing, registers nothing, and leaves history untouched', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    render(<Harness />)
    const before = window.history.length
    act(() => { fireEvent.click(screen.getByText('open')) })
    expect(state()).toBe('OPEN')
    expect(pushSpy).not.toHaveBeenCalled()
    expect(addSpy.mock.calls.filter(([evt]) => evt === 'popstate')).toHaveLength(0)
    expect(window.history.length).toBe(before)
    expect(readMarker(window.history.state)).toBeNull()
    addSpy.mockRestore(); pushSpy.mockRestore()
  })
})
