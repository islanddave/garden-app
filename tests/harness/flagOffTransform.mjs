// flagOffTransform.mjs — BUG-DETAILPAGESCARRYSCROLL-001: the ROLLBACK BUILD, served in memory.
//
// src/lib/featureFlags.js with SCROLL_MANAGER_ENABLED = false, and nothing written to the working tree — the
// in-memory seam of tests/harness/vite.harness.mutant.mjs, for the same reason (a SIGKILL between a write and its
// restore would leave a flipped flag on disk looking exactly like intentional work). Used by:
//   tests/harness/vite.harness.flagoff.mjs   the real-Chrome gates   npm run gate:page-scroll:flag-off
//                                                                    npm run gate:seeds-scroll:flag-off
//   vitest.flagoff.config.ts                 the unit suite          npm run test:flag-off
//
// WHY IT IS IN THE REPO (qa2-scrollmanager-confirm MINOR-3). The rollback runbook (featureFlags.js, above the
// flag) says: roll back with a forward flag-off build. The only proof such a build is green was a manual
// rehearsal whose configs lived outside the repo; a change that broke the flag-off contract would have been found
// during an emergency rollback. Now anyone can run it from a checkout.
//
// A transform, not a vi.mock: it reaches every module, including the ones the unit setup file loads before any
// test file's mocks exist. It REFUSES when the flag line is not there to flip — a rehearsal that silently served
// the flag as it stands would prove nothing about the rollback. On a real flag-off build the line already reads
// false and the transform passes the file through.
export const FLAG_ON = 'export const SCROLL_MANAGER_ENABLED = true'
export const FLAG_OFF = 'export const SCROLL_MANAGER_ENABLED = false'

const count = (code, s) => code.split(s).length - 1

export function scrollManagerFlagOff() {
  return {
    name: 'scroll-manager-flag-off',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replace(/\\/g, '/').endsWith('/src/lib/featureFlags.js')) return null
      if (count(code, FLAG_ON) === 0 && count(code, FLAG_OFF) === 1) {
        process.stderr.write('[flag-off] src/lib/featureFlags.js already reads SCROLL_MANAGER_ENABLED = false: served as it stands\n')
        return null
      }
      if (count(code, FLAG_ON) !== 1) {
        throw new Error(`[flag-off] "${FLAG_ON}" is not in src/lib/featureFlags.js exactly once — the flag moved; fix this transform rather than rehearse a build it no longer describes`)
      }
      process.stderr.write('[flag-off] serving src/lib/featureFlags.js with SCROLL_MANAGER_ENABLED = false\n')
      return { code: code.replace(FLAG_ON, FLAG_OFF), map: null }
    },
  }
}
