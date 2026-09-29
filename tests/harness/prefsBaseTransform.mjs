// prefsBaseTransform.mjs — BUG-GARDENGROUPBYRESET-001: let the page-scroll harness's ?prefs= knob reach the prefs
// client (tests/harness/prefsKnob.js has the why).
//
// Served in memory, nothing written to the working tree (flagOffTransform.mjs's seam). ONE module, ONE line: the
// prefs client's base URL reads globalThis.__harnessPrefsBase first and falls back to exactly what it reads today,
// so with the global unset — every harness entry but a page-scroll flow that asked for ?prefs= — the module
// behaves byte-for-byte as served before. The critter client (src/lib/critterClient.js) is NOT touched: the
// flows that use the knob need Garden's prefs read and writes, not its critter traffic.
//
// It does not throw when the line has moved: every other harness gate is served through this config and must not
// break over a prefs-client edit. The page-scroll flows that use the knob check instead that the served grouping
// reached the page, and fail loudly when it did not.
export const BASE_LINE = "const CRITTER_BASE = (import.meta.env.VITE_API_CRITTERS ?? '').replace(/\\/$/, '')"
export const KNOB_LINE = "const CRITTER_BASE = (globalThis.__harnessPrefsBase ?? import.meta.env.VITE_API_CRITTERS ?? '').replace(/\\/$/, '')"

const count = (code, s) => code.split(s).length - 1

export function harnessPrefsBase() {
  let warned = false
  return {
    name: 'harness-prefs-base',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replace(/\\/g, '/').endsWith('/src/lib/notificationPrefsClient.js')) return null
      if (count(code, BASE_LINE) !== 1) {
        if (!warned) process.stderr.write('[harness] src/lib/notificationPrefsClient.js no longer carries its CRITTER_BASE line once: the ?prefs= knob is OFF (the page-scroll flows that need it will say so)\n')
        warned = true
        return null
      }
      return { code: code.replace(BASE_LINE, KNOB_LINE), map: null }
    },
  }
}
