// prefsKnob.js — BUG-GARDENGROUPBYRESET-001: the page-scroll harness's ?prefs= knob, switched on at module load.
//
// Garden reads the signed-in person's prefs row once per mount and, before the fix, ADOPTED its garden_group_by
// over the grouping the user had just picked — after the scroll restore, so every return regrouped the list under
// the spot. No gate saw it: the prefs client returns null WITHOUT a request when VITE_API_CRITTERS is unset
// (src/lib/notificationPrefsClient.js), and the base harness config never sets it, so Garden's prefs hydrate never
// ran in any flow.
//
// With ?prefs=<value>, this points the prefs client at a stub origin, and pagescroll.jsx answers it with a row
// whose garden_group_by is <value>. The prefs client reads its base URL at ITS module load, so this must be the
// harness entry's FIRST import: ES modules evaluate in import order, so this body runs before anything that
// imports the prefs client. The base harness config's prefsBaseTransform.mjs lets that one module read the
// global; without ?prefs= nothing is set and every page is served exactly as before (every other flow).
// `.invalid` (RFC 2606): the harness fetch stub answers it, and a request that ever escaped the stub could not
// resolve.
export const PREFS_ORIGIN = 'https://prefs.harness.invalid'
const q = new URLSearchParams(location.search)
export const PREFS_GROUP_BY = q.get('prefs') || null
if (PREFS_GROUP_BY) globalThis.__harnessPrefsBase = PREFS_ORIGIN
