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
// V5-SEEDLOTADDITION-001 (seed release 3) — the same two, for SEED_ADD_TO_LOT, whose undo is also a forward
// flag-off build:
//   seedAddToLotOff()      vitest.seedaddflagoff.config.ts, `npm run test:flag-off:seedadd` (release 3 undone,
//                          release 2b still on). Both off transforms together are `npm run test:flag-off:seedboth`,
//                          the build after both releases are undone.
//   seedAddToLotOn()       beside seedMultiParentOn() in vite.harness.seedon.mjs: the four gates' harness serves
//                          BOTH flags on. The add-to-lot link, list and form need both to draw.
//
// A transform, not a vi.mock: it reaches every module, including the ones the unit setup file loads before any
// test file's mocks exist. Each REFUSES when the flag line is not there to read — a rehearsal, or a gate, that
// silently served the flag as it stands would prove nothing.
const line = (flag, word) => `export const ${flag} = ${word}`
export const FLAG_ON = line('SEED_MULTI_PARENT', 'true')
export const FLAG_OFF = line('SEED_MULTI_PARENT', 'false')
export const ADD_FLAG_ON = line('SEED_ADD_TO_LOT', 'true')
export const ADD_FLAG_OFF = line('SEED_ADD_TO_LOT', 'false')

const count = (code, s) => code.split(s).length - 1
const isFlagsModule = (id) => id.split('?')[0].replace(/\\/g, '/').endsWith('/src/lib/featureFlags.js')

// `flag` is the constant's name, `word` the value to serve. Two of these in one config each rewrite their own
// line of the one module, in plugin order.
function serve({ name, flag, word }) {
  const to = line(flag, word)
  const from = line(flag, word === 'true' ? 'false' : 'true')
  return {
    name,
    enforce: 'pre',
    transform(code, id) {
      if (!isFlagsModule(id)) return null
      if (count(code, from) === 0 && count(code, to) === 1) {
        if (word === 'false') process.stderr.write(`[seed-flag] src/lib/featureFlags.js already reads ${flag} = false: served as it stands\n`)
        return null
      }
      if (count(code, from) !== 1) {
        throw new Error(`[seed-flag] "${from}" is not in src/lib/featureFlags.js exactly once — the flag moved; fix this transform rather than run against a build it no longer describes`)
      }
      process.stderr.write(`[seed-flag] serving src/lib/featureFlags.js with ${flag} = ${word}\n`)
      return { code: code.replace(from, to), map: null }
    },
  }
}

export function seedMultiParentOff() {
  return serve({ name: 'seed-multi-parent-off', flag: 'SEED_MULTI_PARENT', word: 'false' })
}

export function seedMultiParentOn() {
  return serve({ name: 'seed-multi-parent-on', flag: 'SEED_MULTI_PARENT', word: 'true' })
}

export function seedAddToLotOff() {
  return serve({ name: 'seed-add-to-lot-off', flag: 'SEED_ADD_TO_LOT', word: 'false' })
}

export function seedAddToLotOn() {
  return serve({ name: 'seed-add-to-lot-on', flag: 'SEED_ADD_TO_LOT', word: 'true' })
}
