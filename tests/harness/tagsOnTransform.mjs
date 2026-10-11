// tagsOnTransform.mjs — BUG-GARDENTAGGROUPREPAINT-001: let the page-scroll harness's ?tags= knob switch the tags
// API on (tests/harness/pagescroll.jsx has the knob and the why).
//
// Garden's tag groupings (Heat, Determinacy, …) exist only while src/hooks/useTags.js reads VITE_API_TAGS as set,
// and the base harness config never sets it: useEntityTagsBulk is inert, the control offers no tag facet, and no
// flow could ever store one — which is why no gate saw Garden paint the Type fallback on every return and regroup
// under the spot once the tag map landed.
//
// Served in memory, nothing written to the working tree (prefsBaseTransform.mjs's seam). ONE module, ONE line:
// tagsEnabled() reads globalThis.__harnessTagsOn first and falls back to exactly what it reads today, so with the
// global unset — every harness entry but a page-scroll flow that asked for ?tags= — the module behaves
// byte-for-byte as served before. The switch is read on every call, so the knob only has to be set before Garden
// mounts. src/lib/api.js is NOT touched: with VITE_API_TAGS unset the tags routes resolve to a relative
// /api/entity-tags, which the harness's fetch stub answers like every other route.
//
// It does not throw when the line has moved: every other harness gate is served through this config and must not
// break over a tags-hook edit. The page-scroll flow that uses the knob checks instead that the tag facet reached
// Garden's control, and fails loudly when it did not.
export const BASE_LINE = 'const tagsEnabled = () => Boolean(import.meta.env.VITE_API_TAGS)'
export const KNOB_LINE = 'const tagsEnabled = () => Boolean(globalThis.__harnessTagsOn ?? import.meta.env.VITE_API_TAGS)'

const count = (code, s) => code.split(s).length - 1

export function harnessTagsOn() {
  let warned = false
  return {
    name: 'harness-tags-on',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replace(/\\/g, '/').endsWith('/src/hooks/useTags.js')) return null
      if (count(code, BASE_LINE) !== 1) {
        if (!warned) process.stderr.write('[harness] src/hooks/useTags.js no longer carries its tagsEnabled line once: the ?tags= knob is OFF (the page-scroll flow that needs it will say so)\n')
        warned = true
        return null
      }
      return { code: code.replace(BASE_LINE, KNOB_LINE), map: null }
    },
  }
}
