// BUG-DETAILPAGESCARRYSCROLL-001 — the unit suite against the ROLLBACK BUILD: SCROLL_MANAGER_ENABLED = false, served
// in memory by tests/harness/flagOffTransform.mjs (qa2-scrollmanager-confirm MINOR-3). `npm run test:flag-off`.
// SCROLL_FLAG_OFF_REHEARSAL tells src/__tests__/scrollFlagOff.rehearsal.test.js to check the flag really was
// served off, so a transform that silently stopped applying fails the run instead of re-running the ON suite.
import base from './vitest.config'
import { scrollManagerFlagOff } from './tests/harness/flagOffTransform.mjs'

export default {
  ...base,
  plugins: [scrollManagerFlagOff(), ...(base.plugins || [])],
  test: { ...base.test, env: { ...(base.test && base.test.env), SCROLL_FLAG_OFF_REHEARSAL: '1' } },
}
