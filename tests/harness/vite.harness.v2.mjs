// vite.harness.v2.mjs — the harness config for the Today V2 gates (gate:today-shape:v2, gate:today-shell:v2).
// V5-TODAYREDESIGN-001 S0, plan-v2 §8 S0.
//
// ONE difference from vite.harness.config.mjs: VITE_API_CRITTERS is a stub origin. fetchNotificationPrefs
// returns null WITHOUT a request when that variable is unset (src/lib/notificationPrefsClient.js), so under the
// base config PrefsProvider would report "loaded, nothing stored" and never read the state's prefs fixture —
// Layer 1 (remembered open/closed, plan §2.1) would be untestable, and silently so. The origin is `.invalid`
// (RFC 2606): the harness fetch stubs answer it, and a request that ever escaped them could not resolve.
//
// A SECOND, since the S3 + S4 integration: src/lib/featureFlags.js's TODAY_V2_PREVIEW_ROW, when false, hides the
// Debug row and makes TodayRoute ignore a stored garden.todayV2. The V2 gates measure the redesign through that
// same chooser, so this config serves the module with the constant TRUE: a no-op while it ships true (Dave's D14,
// 2026-09-29), a rewrite if it is ever flipped back. It THROWS when neither declaration is in the file: a renamed
// constant must not quietly put the harness back on V1.
//
// A separate file for the reason vite.harness.mutant.mjs gives: every other harness entry and the v1 gate
// keep the base config, so nothing they measure changes. A run is on this config iff it was pointed here.
import base from './vite.harness.config.mjs'

export const CRITTER_STUB_ORIGIN = 'https://critters.harness.invalid'

const PREVIEW_OFF = 'export const TODAY_V2_PREVIEW_ROW = false'
const PREVIEW_ON = 'export const TODAY_V2_PREVIEW_ROW = true'
function todayV2PreviewOn() {
  return {
    name: 'today-v2-preview-on',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/lib/featureFlags.js')) return null
      if (code.includes(PREVIEW_ON)) return null
      if (!code.includes(PREVIEW_OFF)) throw new Error(`[vite.harness.v2] neither '${PREVIEW_OFF}' nor '${PREVIEW_ON}' is in src/lib/featureFlags.js — the V2 harness cannot switch the preview on, so it would measure V1`)
      return { code: code.split(PREVIEW_OFF).join(PREVIEW_ON), map: null }
    },
  }
}

export default {
  ...base,
  define: {
    ...(base.define || {}),
    'import.meta.env.VITE_API_CRITTERS': JSON.stringify(CRITTER_STUB_ORIGIN),
  },
  plugins: [...(base.plugins || []), todayV2PreviewOn()],
}
