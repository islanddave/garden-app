// vite.harness.v2.mjs — the harness config for the Today gates (gate:today-shape:v2, gate:today-shell:v2).
// V5-TODAYREDESIGN-001 S0, plan-v2 §8 S0.
//
// ONE difference from vite.harness.config.mjs: VITE_API_CRITTERS is a stub origin. fetchNotificationPrefs
// returns null WITHOUT a request when that variable is unset (src/lib/notificationPrefsClient.js), so under the
// base config PrefsProvider would report "loaded, nothing stored" and never read the state's prefs fixture —
// Layer 1 (remembered open/closed, plan §2.1) would be untestable, and silently so. The origin is `.invalid`
// (RFC 2606): the harness fetch stubs answer it, and a request that ever escaped them could not resolve.
//
// (Until S8c this config also served src/lib/featureFlags.js with TODAY_V2_PREVIEW_ROW forced true, so the gates
// reached the redesign through the old per-device chooser. The old page, the chooser and the flag are gone.)
//
// A separate file so every other harness entry keeps the base config and nothing they measure changes. A run
// is on this config iff it was pointed here.
import base from './vite.harness.config.mjs'

export const CRITTER_STUB_ORIGIN = 'https://critters.harness.invalid'

export default {
  ...base,
  define: {
    ...(base.define || {}),
    'import.meta.env.VITE_API_CRITTERS': JSON.stringify(CRITTER_STUB_ORIGIN),
  },
}
