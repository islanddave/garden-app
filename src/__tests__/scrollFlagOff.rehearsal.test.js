// BUG-DETAILPAGESCARRYSCROLL-001 — the flag-off rehearsal must really serve the flag off (qa2-scrollmanager-confirm
// MINOR-3). Under `npm run test:flag-off` (vitest.flagoff.config.ts sets SCROLL_FLAG_OFF_REHEARSAL) the whole suite
// runs against SCROLL_MANAGER_ENABLED = false; if the transform stopped applying, every flag-aware suite would
// quietly run its ON branch and the rehearsal would prove nothing about the rollback build. In an ordinary run it is
// skipped: the shipped value is the flag's own business (a forward flag-off build IS the rollback).
import { describe, it, expect } from 'vitest'
import { SCROLL_MANAGER_ENABLED } from '../lib/featureFlags.js'
import { applyBrowserScrollRestoration } from '../hooks/usePageScrollManager.js'

describe('the flag-off rehearsal', () => {
  it.runIf(process.env.SCROLL_FLAG_OFF_REHEARSAL === '1')('serves SCROLL_MANAGER_ENABLED = false to every module, the manager\'s included', () => {
    expect(SCROLL_MANAGER_ENABLED).toBe(false)
    // applyBrowserScrollRestoration's default is the flag as usePageScrollManager.js imported it.
    window.history.scrollRestoration = 'manual'
    applyBrowserScrollRestoration()
    expect(window.history.scrollRestoration).toBe('auto')
  })
})
