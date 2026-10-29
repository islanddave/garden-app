// exit-watchdog.test.mjs — OPS-GATETIMERGUARD-001 part 2. scripts/test_count_ratchets.py holds the gates to
// IMPORTING the watchdog; this holds the watchdog to firing, and to not being the thing that keeps a gate alive.
// Runs in vitest's `node` project (scripts/vitest/vitest-node-project.mjs walks scripts/ for *.test.*).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { armExitWatchdog, EXIT_WATCHDOG_MS } from './exit-watchdog.mjs'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('armExitWatchdog', () => {
  it('calls exit(1) once the delay has passed, and names the script and the wait on stderr', () => {
    vi.useFakeTimers()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.fn()
    armExitWatchdog('some-gate.mjs', 2000, exit)
    vi.advanceTimersByTime(1999)
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls[0][0]).toMatch(/^\[exit-watchdog\] some-gate\.mjs: process still alive 2 s after PASS; active resources: \[/)
  })

  it('does not keep an otherwise idle process alive: the timer is unref\'d', () => {
    expect(EXIT_WATCHDOG_MS).toBe(15000)
    // A real process, not hasRef(): armed with a minute's delay and nothing else to do, node must run off the end
    // and exit 0 at once. A ref'd timer would hold it until execFileSync's timeout kills it, which throws.
    // import.meta.dirname, not new URL(…, import.meta.url): in the one-project run this file is under jsdom, whose
    // URL is not node's and whose import.meta.url is not a file: URL.
    const mod = pathToFileURL(join(import.meta.dirname, 'exit-watchdog.mjs')).href
    const src = `const { armExitWatchdog } = await import(${JSON.stringify(mod)}); armExitWatchdog('idle', 60000); console.log('armed')`
    const t0 = Date.now()
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], { timeout: 10000, encoding: 'utf8' })
    expect(out.trim()).toBe('armed')
    expect(Date.now() - t0).toBeLessThan(10000)
  })
})
