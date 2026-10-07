// seedFlagTransform.mjs — V5-SEEDMULTIPARENT-001 release 2b: src/lib/featureFlags.js served IN MEMORY with
// SEED_MULTI_PARENT one way or the other, and nothing written to the working tree. The sibling of
// flagOffTransform.mjs, which is the scroll manager's and stays hard-wired to that flag; in memory for the reason
// that file gives (a SIGKILL between a write and its restore would leave a flipped flag on disk looking exactly
// like intentional work).
//
//   seedMultiParentOff()   THE UNDO BUILD. Release 2b's rollback is a forward flag-off build, and
//                          scripts/forward-undo.py's flag_off() writes exactly FLAG_OFF below and edits no test.
//                          Used by vitest.seedflagoff.config.ts — `npm run test:flag-off:seed` — so anyone can
//                          prove from a checkout that such a build is green, before it is needed.
//   seedMultiParentOn()    THE FOUR SEED LAYOUT GATES. Their fixtures are the flag-on screens (the adder, the
//                          parent rows, the mix chips), so on an undo build they would measure pages the flag
//                          hides and go red on a build that is correct. tests/harness/vite.harness.seedon.mjs
//                          serves the module with the flag on whichever way it ships: a no-op while it ships
//                          true.
//
// A transform, not a vi.mock: it reaches every module, including the ones the unit setup file loads before any
// test file's mocks exist. Each REFUSES when the flag line is not there to read — a rehearsal, or a gate, that
// silently served the flag as it stands would prove nothing.
export const FLAG_ON = 'export const SEED_MULTI_PARENT = true'
export const FLAG_OFF = 'export const SEED_MULTI_PARENT = false'

const count = (code, s) => code.split(s).length - 1
const isFlagsModule = (id) => id.split('?')[0].replace(/\\/g, '/').endsWith('/src/lib/featureFlags.js')

function serve({ name, from, to, word }) {
  return {
    name,
    enforce: 'pre',
    transform(code, id) {
      if (!isFlagsModule(id)) return null
      if (count(code, from) === 0 && count(code, to) === 1) {
        if (word === 'false') process.stderr.write('[seed-flag] src/lib/featureFlags.js already reads SEED_MULTI_PARENT = false: served as it stands\n')
        return null
      }
      if (count(code, from) !== 1) {
        throw new Error(`[seed-flag] "${from}" is not in src/lib/featureFlags.js exactly once — the flag moved; fix this transform rather than run against a build it no longer describes`)
      }
      process.stderr.write(`[seed-flag] serving src/lib/featureFlags.js with SEED_MULTI_PARENT = ${word}\n`)
      return { code: code.replace(from, to), map: null }
    },
  }
}

export function seedMultiParentOff() {
  return serve({ name: 'seed-multi-parent-off', from: FLAG_ON, to: FLAG_OFF, word: 'false' })
}

export function seedMultiParentOn() {
  return serve({ name: 'seed-multi-parent-on', from: FLAG_OFF, to: FLAG_ON, word: 'true' })
}
