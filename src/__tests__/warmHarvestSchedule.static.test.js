// V4-PERFTHEMEA-001 — main.jsx's harvest-windows warm import must wait for the LOAD event.
//
// THE BUG THIS PINS: the warm was scheduled on a bare requestIdleCallback. rIC measures MAIN-THREAD
// idle, not network idle, and on a cold boot the main thread is idle for most of the time the
// 1.4MB entry chunk is downloading — so the prefetch fired at exactly the wrong moment, a second
// chunk fetch competing with the entry chunk for a cellular radio's bandwidth. Nothing user-visible
// breaks either way, which is precisely why it needs a test: a revert would be invisible.
//
// WHY SOURCE-EXECUTION RATHER THAN AN IMPORT: importing main.jsx boots Clerk, the router and the
// whole app. So the trailing scheduling block is extracted and EXECUTED against fake globals —
// behavioural, not a source-text grep, because the regression here (dropping the load gate) leaves
// every token in the file still present and only changes when they run. Same house pattern as
// bootPaint.static.test.js's inline-script executor.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MAIN = readFileSync(resolve(process.cwd(), 'src/main.jsx'), 'utf8')

// From the warm's declaration to end of file. The dynamic import is swapped for an injected spy —
// `new Function` bodies cannot carry a real `import()`.
function scheduleBlock() {
  const i = MAIN.indexOf('const warmHarvestWindows =')
  if (i === -1) throw new Error('warmHarvestWindows declaration not found in src/main.jsx')
  return MAIN.slice(i).replace(/import\((['"])\.\/lib\/harvestWindows\.js\1\)/, '__import()')
}

function runSchedule({ readyState = 'interactive', body = scheduleBlock() } = {}) {
  const listeners = []
  const doc = { readyState }
  const win = { addEventListener: (type, cb, opts) => listeners.push({ type, cb, opts }) }
  const ric = vi.fn()
  const timeout = vi.fn()
  const imported = vi.fn(() => ({ catch: () => {} }))
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', 'requestIdleCallback', 'setTimeout', '__import', body)(
    doc, win, ric, timeout, imported,
  )
  return { listeners, ric, timeout, imported }
}

describe('main.jsx harvest-windows warm scheduling (V4-PERFTHEMEA-001)', () => {
  it('schedules NOTHING while the page is still loading — it waits for the load event', () => {
    const { ric, timeout, imported, listeners } = runSchedule()
    expect(ric).not.toHaveBeenCalled()
    expect(timeout).not.toHaveBeenCalled()
    expect(imported).not.toHaveBeenCalled()
    expect(listeners.map((l) => l.type)).toEqual(['load'])
  })

  it('registers the load listener as once, so a bfcache restore cannot re-fire it', () => {
    const { listeners } = runSchedule()
    expect(listeners[0].opts).toEqual({ once: true })
  })

  it('schedules on rIC once load fires — bandwidth first, then main-thread idle', () => {
    const { listeners, ric, imported } = runSchedule()
    listeners[0].cb()
    expect(ric).toHaveBeenCalledTimes(1)
    // timeout retained: the warm must be deferrable, never starvable.
    expect(ric.mock.calls[0][1]).toEqual({ timeout: 10000 })
    expect(imported).not.toHaveBeenCalled()
    ric.mock.calls[0][0]()               // idle callback runs
    expect(imported).toHaveBeenCalledTimes(1)
  })

  it('schedules immediately when load has ALREADY fired (fast cached boot)', () => {
    // A `load` that has already happened never fires again; without this branch the warm would be
    // retired silently and permanently on exactly the fastest boots.
    const { listeners, ric } = runSchedule({ readyState: 'complete' })
    expect(listeners).toHaveLength(0)
    expect(ric).toHaveBeenCalledTimes(1)
  })

  it('falls back to setTimeout where requestIdleCallback does not exist', () => {
    const body = scheduleBlock()
    const listeners = []
    const timeout = vi.fn()
    const imported = vi.fn(() => ({ catch: () => {} }))
    // eslint-disable-next-line no-new-func
    new Function('document', 'window', 'requestIdleCallback', 'setTimeout', '__import', body)(
      { readyState: 'interactive' },
      { addEventListener: (type, cb, opts) => listeners.push({ type, cb, opts }) },
      undefined, timeout, imported,
    )
    listeners[0].cb()
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout.mock.calls[0][1]).toBe(3000)
  })

  it('SELF-TEST: the executor flags a block that schedules at module scope (the old shape)', () => {
    // Without this, every assertion above goes vacuous the moment the extractor stops matching.
    const old = "if (typeof requestIdleCallback === 'function') requestIdleCallback(__import, { timeout: 10000 })"
    const { ric, listeners } = runSchedule({ body: old })
    expect(ric).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(0)
  })
})
