// vite.harness.seedon.mjs — the harness config for the four seed layout gates: gate:save-seed-sheet,
// gate:seed-detail, gate:seeds-saved and gate:seeds-page. V5-SEEDMULTIPARENT-001 release 2b.
//
// ONE difference from vite.harness.config.mjs: src/lib/featureFlags.js is served with SEED_MULTI_PARENT true,
// whichever way it ships (seedFlagTransform.mjs, in memory). Those four gates' fixtures ARE the flag-on screens:
// the sheet's adder and its rows, the jar page's parent rows, the "Mixed seed" chips, the long mix row. The
// release's rollback is a forward build with the flag false (the runbook is on the constant), and on that build
// the base config would have them tap an adder that is not drawn and count chips that are not shown: four red
// required gates on a build that is correct. Here they keep measuring the layout the flag will show again when
// it is turned back on. While the flag ships true this config changes nothing.
//
// V5-SEEDLOTADDITION-001 (seed release 3): SEED_ADD_TO_LOT is served true as well, for the same reason. Its undo
// is also a forward flag-off build, and gate:save-seed-sheet's list and add-form cases, and gate:seed-detail's
// "still says" line, are that flag's screens. All four gates load this file, so all four now see both on.
//
// A separate file for the reason vite.harness.mutant.mjs gives: every other harness entry and every other gate
// keeps the base config, so they go on measuring the build as it ships. A run is on this config iff it was
// pointed here.
import base from './vite.harness.config.mjs'
import { seedMultiParentOn, seedAddToLotOn } from './seedFlagTransform.mjs'

export default { ...base, plugins: [seedMultiParentOn(), seedAddToLotOn(), ...(base.plugins || [])] }
