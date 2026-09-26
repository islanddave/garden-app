// vite.harness.flagoff.mjs — the harness config, serving the ROLLBACK BUILD: SCROLL_MANAGER_ENABLED = false, in
// memory (flagOffTransform.mjs). BUG-DETAILPAGESCARRYSCROLL-001, qa2-scrollmanager-confirm MINOR-3.
//
//   npm run gate:page-scroll:flag-off     (page-scroll.mjs --flag-off, which also checks the flag WAS served off)
//   npm run gate:seeds-scroll:flag-off    (seeds-scroll.mjs with GATE_HARNESS_CONFIG pointed here)
//
// A separate config for the reason vite.harness.mutant.mjs gives: a switch on the shared config is a switch that
// can be left on. A run serves the rollback build if and only if it was pointed here.
import base from './vite.harness.config.mjs'
import { scrollManagerFlagOff } from './flagOffTransform.mjs'

export default { ...base, plugins: [scrollManagerFlagOff(), ...(base.plugins || [])] }
