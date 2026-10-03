// Put-Up R2a, lane P — the completion line holds the page's reload while it is on screen (D11; MOB 8).
//
// THE DEFECT. The door holds the reload while it is dirty and releases it when it unmounts on Save. The
// completion line — what was saved, and its Undo — is set by that same handler, and nothing held the reload
// for it: a deploy that landed during the save reloaded the page within a frame, and the row was in the list
// with no line and no Undo.
//
// EVERYTHING HERE IS REAL: the real lib/reloadGate.js, the real lib/registerSW.js, the real line. A test that
// asserted on a spied setReloadBlocked would be green with the hold wired to nothing.
//   • held while the line is mounted and not undone; released when it goes;
//   • released when its Undo LANDS, kept when the Undo fails;
//   • released when the page is hidden (a line has no timer: it must not park an update for good), and
//     held again when the page is back;
//   • two lines hold separately: one going does not release the other's;
//   • end to end: a new service worker takes the page while the line shows -> no reload; the line is
//     closed -> the reload fires, once.
// MUTATIONS (run, see the lane report): never hold -> "a completion line holds the reload" reds; never
// release -> the same test reds at its second half; hold through hidden -> the hidden test reds; keep the
// hold after a landed Undo -> the Undo test reds.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import CompletionLine from '../components/pantry/CompletionLine.jsx'
import PantryView from '../components/pantry/PantryView.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

const JAR_DONE = { route: 'jar', saved: { id: 'jar-new-1', label: 'Sungold cherry' }, place: PLACES[0],
  text: 'Sungold cherry — put up · Chest Freezer 1 · discard by Oct 2, 2027' }
const ITEM_DONE = { route: 'item', saved: { id: 'item-new-1', name: 'Oat milk' }, place: PLACES[2], text: 'Oat milk — in the pantry · Kitchen fridge' }

let fake
function line(completion = JAR_DONE, props = {}) {
  return <CompletionLine completion={completion} fetch={fake} onDone={() => {}} onChanged={() => {}} {...props} />
}
function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
const flush = () => new Promise((r) => setTimeout(r, 0))

// registerSW.test.js's env, with a prior controller: a controllerchange is an UPDATE (the reload path).
function makeSwEnv() {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = {}
  sw.register = vi.fn().mockResolvedValue(registration)
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' })
  return { nav: { serviceWorker: sw }, sw, win, doc, reload: vi.fn() }
}

beforeEach(() => { fake = pantryFetch(); clearReloadBlocks(); localStorage.clear() })
afterEach(() => { delete document.visibilityState; clearReloadBlocks() })

describe('the completion line and the page\'s reload', () => {
  it('a completion line holds the reload; when it goes the hold goes', () => {
    expect(isReloadBlocked()).toBe(false)
    const view = render(line())
    expect(screen.getByTestId('pantry-completion').textContent).toContain('Sungold cherry — put up')
    expect(isReloadBlocked()).toBe(true)
    view.unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  it('on the Pantry: the line the door left holds the reload, and closing it lets go', () => {
    function Host() {
      const [completion, setCompletion] = React.useState(JAR_DONE)
      return (
        <PantryView fetch={fake} group="place" onGroupChange={() => {}} rows={[]} loading={false} error={false} onReload={() => {}}
          recent={{}} onRecent={() => {}} completion={completion} onCompletionDone={() => setCompletion(null)} />
      )
    }
    render(<Host />)
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByTestId('pantry-completion-close'))
    expect(screen.queryByTestId('pantry-completion')).toBeNull()
    expect(isReloadBlocked()).toBe(false)
  })

  it('a landed Undo lets go: nothing is left to lose, and the line stays to say "Undone"', async () => {
    const onChanged = vi.fn()
    render(line(JAR_DONE, { onChanged }))
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(screen.getByTestId('pantry-completion').textContent).toContain('Undone — Sungold cherry'))
    expect(fake.calls('DELETE').map(c => c.path)).toEqual(['/api/preservation/jar-new-1'])
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(isReloadBlocked()).toBe(false)
  })

  it('an Undo that fails keeps the hold: the line and its Undo are still what there is to lose', async () => {
    fake = pantryFetch({ overrides: { 'DELETE /api/pantry/items/item-new-1': () => { throw apiError(500, { error: 'boom' }) } } })
    render(line(ITEM_DONE))
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    expect((await screen.findByTestId('pantry-completion-error')).textContent).toBe("Couldn't undo that — try again.")
    expect(screen.getByTestId('pantry-completion-undo')).toBeTruthy()
    expect(isReloadBlocked()).toBe(true)
  })

  it('a hidden page lets go, and the page back on screen holds again', () => {
    render(line())
    expect(isReloadBlocked()).toBe(true)
    setVisibility('hidden')
    expect(isReloadBlocked()).toBe(false)
    setVisibility('visible')
    expect(isReloadBlocked()).toBe(true)
  })

  it('a line that appears on a hidden page holds nothing until the page is seen', () => {
    setVisibility('hidden')
    render(line())
    expect(isReloadBlocked()).toBe(false)
    setVisibility('visible')
    expect(isReloadBlocked()).toBe(true)
  })

  it('after a landed Undo the page coming back does not take the hold again', async () => {
    render(line())
    fireEvent.click(screen.getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
    setVisibility('hidden')
    setVisibility('visible')
    expect(isReloadBlocked()).toBe(false)
  })

  it('two lines hold separately: one going does not release the other\'s', () => {
    const a = render(line(JAR_DONE))
    const b = render(line(ITEM_DONE))
    expect(isReloadBlocked()).toBe(true)
    a.unmount()
    expect(isReloadBlocked()).toBe(true)
    b.unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  it('END TO END: a new service worker takes the page while the line shows — no reload; the line goes — one reload', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    const view = render(line())
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()
    view.unmount()
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('END TO END: with no line on screen the same service worker change reloads at once (the control)', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })
})

describe('the line itself is unchanged', () => {
  it('keeps its testids, its Undo for an item and a put-up, and How it was made → only when handed in', () => {
    const jar = render(line(JAR_DONE, { onHowItWasMade: vi.fn() }))
    for (const id of ['pantry-completion', 'pantry-completion-undo', 'pantry-completion-how', 'pantry-completion-close']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }
    expect(screen.getByTestId('pantry-completion').getAttribute('role')).toBe('status')
    jar.unmount()
    render(line(ITEM_DONE, { onHowItWasMade: vi.fn() }))
    expect(screen.queryByTestId('pantry-completion-how')).toBeNull()
    expect(screen.getByTestId('pantry-completion-undo')).toBeTruthy()
  })
})
