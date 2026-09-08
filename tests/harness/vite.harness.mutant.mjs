// vite.harness.mutant.mjs — the harness config, plus ONE in-memory source mutation.
//
//   TODAY_SHAPE_MUT=clipRowPanel node scripts/layout-gate/today-shape.mjs   (via GATE_HARNESS_CONFIG)
//
// WHY A SEPARATE CONFIG RATHER THAN A FLAG ON THE SHARED ONE. tests/harness/vite.harness.config.mjs
// is loaded by eleven other layout gates and by every manual harness session; a mutation switch
// living there is a switch that can be left on. This file spreads that config and adds exactly one
// plugin, so the shared file is untouched and a run is mutant if and only if it was pointed here.
//
// WHY IN MEMORY RATHER THAN WRITING THE FILE. scripts/mutate-storage-deadlines-check.mjs — the
// repo's existing mutation proof — writes the real data file and restores it in a `finally`. That is
// correct for a JSON file in a solo checkout; it is the wrong shape here, because this worktree sits
// beside ~40 siblings and a SIGKILL between write and restore would leave a mutated
// src/components/today/CareNeeded.jsx on disk looking exactly like intentional work. Transforming in
// the module graph cannot leave a mutated tree behind under any exit path.
//
// EVERY MUTANT THROWS IF ITS PATTERN DOES NOT MATCH. A mutant that silently failed to apply and was
// then scored as SURVIVED is the one result in a mutation run that can lie — it reports a guard as
// present when nothing was ever tested. See seat-qa.md of the 2026-09-08 Today crucible, whose first
// dropRainNote mutant was syntactically invalid and reddened 18 unrelated files.
import base from './vite.harness.config.mjs'
import { MUTANTS } from './todayMutants.mjs'

const MUT = process.env.TODAY_SHAPE_MUT || ''

function mutate() {
  const spec = MUTANTS[MUT]
  if (!spec) throw new Error(`TODAY_SHAPE_MUT='${MUT}' is not a known mutant. Known: ${Object.keys(MUTANTS).join(', ')}`)
  const [file, find, replace] = spec
  let applied = false
  return {
    name: 'today-shape-mutant',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/' + file)) return null
      if (!code.includes(find)) {
        // Hard, not a warning. A mutant that did not apply and was scored SURVIVED is the single
        // result in a mutation matrix that actively misleads.
        throw new Error(`[mutant ${MUT}] pattern not found in ${file}:\n  ${find}\nThe source moved under this mutant; fix the pattern rather than reporting a survival.`)
      }
      applied = true
      process.stderr.write(`[MUTANT APPLIED] ${MUT} -> ${file}\n`)
      return { code: code.split(find).join(replace), map: null }
    },
    buildEnd() {
      if (!applied) throw new Error(`[mutant ${MUT}] ${file} was never transformed — it is not in this entry's module graph, so nothing was mutated.`)
    },
  }
}

export default { ...base, plugins: [...base.plugins, mutate()] }
