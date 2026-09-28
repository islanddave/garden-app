// vite.harness.v2mutant.mjs — the v2 harness config, plus ONE in-memory source mutation from todayMutantsV2.mjs.
//
//   TODAY_SHAPE_V2_MUT=prefsClientDark GATE_HARNESS_CONFIG=tests/harness/vite.harness.v2mutant.mjs \
//     node scripts/layout-gate/today-shape-v2.mjs            (what scripts/mutate-today-shape-v2.mjs does)
//
// vite.harness.mutant.mjs's shape and reasons, over vite.harness.v2.mjs instead of the base config: a separate
// file so no switch on a shared config can be left on; in memory so no exit path leaves a mutated src/ file;
// THROWS when the pattern is missing or the file never enters the module graph, because a mutant that did not
// apply and scored SURVIVED is the one result in a matrix that actively misleads.
import base from './vite.harness.v2.mjs'
import { MUTANTS_V2 } from './todayMutantsV2.mjs'

const MUT = process.env.TODAY_SHAPE_V2_MUT || ''

function mutate() {
  const spec = MUTANTS_V2[MUT]
  if (!spec) throw new Error(`TODAY_SHAPE_V2_MUT='${MUT}' is not a known mutant. Known: ${Object.keys(MUTANTS_V2).join(', ')}`)
  if (spec.kind !== 'chrome' || !spec.file || !spec.find) throw new Error(`[mutant ${MUT}] is ${spec.kind === 'chrome' ? `PENDING (arms at ${spec.armedAt}; no source pattern yet)` : 'a unit-table cell, not a served mutant'} — it cannot be applied`)
  let applied = false
  return {
    name: 'today-shape-v2-mutant',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/' + spec.file)) return null
      if (!code.includes(spec.find)) throw new Error(`[mutant ${MUT}] pattern not found in ${spec.file}:\n  ${spec.find}\nThe source moved under this mutant; fix the pattern rather than reporting a survival.`)
      applied = true
      process.stderr.write(`[MUTANT APPLIED] ${MUT} -> ${spec.file}\n`)
      return { code: code.split(spec.find).join(spec.replace), map: null }
    },
    buildEnd() {
      if (!applied) throw new Error(`[mutant ${MUT}] ${spec.file} was never transformed — it is not in this entry's module graph, so nothing was mutated.`)
    },
  }
}

export default { ...base, plugins: [...base.plugins, mutate()] }
