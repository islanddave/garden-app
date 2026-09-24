// v4.148.0 regression-impact review M6 — pins setup.ts's default window.scrollTo.
//
// jsdom implements no scrolling. Its window.scrollTo is a stub that reports "Not implemented:
// window.scrollTo" through the virtual console, which vitest prints to stderr as a full stack trace:
// 183 per full run from InventoryDetail's open-at-top reset alone, 9 more from PlantingDetail, burying real
// errors in CI output. setup.ts installs a quiet mock over that stub, once per file, before the file loads.
// Suites that model scrolling install their own; this only pins the default they start from.
import { describe, it, expect, vi } from 'vitest'

describe('window.scrollTo is a quiet mock by default (setup.ts)', () => {
  it('is a mock, not jsdom\'s not-implemented stub', () => {
    expect(vi.isMockFunction(window.scrollTo)).toBe(true)
  })

  // Listened for at the source. jsdom's default virtual console was bound to the worker's console before
  // vitest swapped in its own, so a spy on console.error never sees these reports (measured: it stayed
  // silent while the trace printed); vitest exposes the JSDOM instance as window.jsdom.
  it('a page that scrolls raises no jsdom "Not implemented" report', () => {
    const vc = window.jsdom?.virtualConsole
    expect(vc, 'vitest no longer exposes window.jsdom — this instrument is blind').toBeTruthy()
    const reports = []
    const onReport = (e) => reports.push(e.message)
    vc.on('jsdomError', onReport)
    try {
      window.scrollTo(0, 0)
      window.scrollTo({ top: 0 })
    } finally {
      vc.off('jsdomError', onReport)
    }
    expect(reports).toEqual([])
  })
})
