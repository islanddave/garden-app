// robotoPin.js — lay this harness entry's text out in ROBOTO, the face Dave's Android renders the
// app in, on every machine that measures it (V5-TODAYSHAPECI-001 / OPS-UNDOTOASTGATECI-001).
//
// WHY. A layout gate is only as portable as the glyphs it measured. The app declares
// `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` (src/main.jsx) and the weather
// card its own `Inter, system-ui, sans-serif` (WeatherWidget.jsx). Each machine resolves those to a
// different face: the Mac to San Francisco, CI's ubuntu runner to DejaVu Sans, Dave's phone to
// Roboto, because nothing ahead of it in either stack is installed on Android. The Today gate's
// budget is ABSOLUTE geometry, and a DejaVu-proxy run of it grew the busy page 2.7% and failed
// (_mainsync9_20260924/laneL-todayshape.md). Pinned, the Mac, CI and the phone share one set of glyph
// metrics, so a budget recorded on the Mac describes the page CI measures and the page Dave sees.
//
// HOW — through FONT RESOLUTION, never through the cascade. Every family name the app lists ahead of
// a generic is registered (FontFace API) as an alias of the same Roboto files, so the app's own
// font-family declarations stay exactly as authored and simply resolve to Roboto, the way they do on
// the phone. Overriding font-family instead (`body { font-family: Roboto !important }`) would miss
// every component that declares its own stack: WeatherWidget's inline `Inter, system-ui` would keep
// painting in the host's font. A document font face is matched before any installed font of the same
// name, so this holds on a machine that has SF, Segoe UI, Inter or a system Roboto installed.
// Generic families (system-ui, sans-serif) cannot be aliased; text that falls through to one paints
// in a host font, which is what the gates' platform-font census (scripts/layout-gate/font-census.mjs)
// exists to catch.
//
// STATIC INSTANCES, NOT THE VARIABLE FONT (changed 2026-09-25, measured). The first version loaded
// @fontsource-variable/roboto. On its first CI run every height and position on the Today page
// matched the Mac, but a fixed string's width at weight 600 and 700 did not (Mac 484.781 / 472.531px,
// CI 484.797 / 472.234px) while 400 matched to the thousandth: macOS and Linux compute a variable
// font's advances at a non-default weight differently. No line wrapped differently that day; a bold
// line near its wrap point would. Static per-weight files carry their advances in the file, so both
// machines read the same numbers. The files come from the EXACT-pinned devDependency @fontsource/roboto (Google
// Fonts' Roboto; every weight 100-900, both styles, every subset), fetched from the harness's own
// Vite server — no network, no copied font files. A bump of that package can move glyphs, so a bump
// is a deliberate re-record of the Today budget, never a routine update.
//
// SCOPED, NOT GLOBAL (2026-09-25). Imported FIRST by todaymeasure.jsx and undotap.jsx only — the two
// entries whose gates run in CI with this pin. The shared appGlobalStyle.js is untouched, so every
// other harness entry and every other gate still measures in the host's font exactly as before. A
// global pin would move every layout gate's numbers at once and is its own change.
//
// FAILS LOUD. Every face is fetched and loaded BEFORE the importing entry renders (top-level await:
// the entry's body waits for this module), and the result is published as window.__fontPin. Both
// gates refuse to measure unless `ok` is true, the same way the Today gate refuses an unpinned clock:
// a pin that silently failed would measure the host font while the budget claimed Roboto.
import metadata from '@fontsource/roboto/metadata.json'
import unicode from '@fontsource/roboto/unicode.json'
import fontPkg from '@fontsource/roboto/package.json'
import cssHref from '@fontsource/roboto/index.css?url'

// Every named family ahead of a generic in a stack the Today page or the undo toast declares. Census
// 2026-09-25: src/main.jsx's body stack and WeatherWidget.jsx's inline stack; every other component on
// those two surfaces sets `inherit`. `Roboto` is aliased too, so a host with its own Roboto installed
// still paints this one.
export const ALIASES = ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Inter']

// The package's own inventory, read rather than restated: every subset x weight x style it ships,
// each with the unicode range it declares, at fontsource's file naming. A file that is not there fails
// its fetch or its parse, and the pin reports it rather than quietly skipping it.
const filesBase = new URL('./files/', new URL(cssHref, location.href))
const files = []
for (const subset of metadata.subsets) {
  for (const weight of metadata.weights) {
    for (const style of metadata.styles) {
      const file = `${metadata.id}-${subset}-${weight}-${style}.woff2`
      files.push({ file, url: new URL(file, filesBase).href, style, weight: String(weight), unicodeRange: unicode[subset] })
    }
  }
}

// TEXT RENDERING — the other half of "the same glyphs everywhere" (2026-09-25, measured). With these
// same static files, CI run 36161500926 laid a fixed weight-700 string at 13.6px out 0.219px narrower
// than this Mac (472.234 against 472.453px) while 400 at 16px and 600 at 14px matched to the
// thousandth; that is the Undo label's size and weight, and it moved five undo-toast widths by 0.1px.
// By default Linux Chrome may hint and round glyph advances; `text-rendering: geometricPrecision` asks
// Blink for unhinted, unrounded advances on every platform. On this Mac it changed no number either
// gate prints (measured). Set on <html> so it reaches every element, the census probe included; the
// app sets text-rendering nowhere, so nothing it declares is overridden.
const rendering = document.createElement('style')
rendering.id = 'harness-text-rendering'
rendering.textContent = 'html { text-rendering: geometricPrecision; }'
document.head.appendChild(rendering)

const failed = []
const loadedFaces = await Promise.all(files.map(async (f) => {
  let buf
  try {
    const r = await fetch(f.url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    buf = await r.arrayBuffer()
  } catch (e) { failed.push(`${f.file}: ${e.message}`); return [] }
  return Promise.all(ALIASES.map(async (family) => {
    // display 'block', not the package's 'swap': nothing may ever paint in a fallback face.
    const face = new FontFace(family, buf, { style: f.style, weight: f.weight, unicodeRange: f.unicodeRange, display: 'block' })
    try { await face.load(); return face } catch (e) { failed.push(`${family} ${f.file}: ${e.message}`); return null }
  }))
}))
// Added only once every face has loaded, and in the package's own order: where two faces of one family
// claim a character, the one added later wins, so the order must not depend on which fetch finished
// first.
let faces = 0
for (const face of loadedFaces.flat()) if (face) { document.fonts.add(face); faces++ }
await document.fonts.ready

window.__fontPin = {
  family: 'Roboto',
  source: `${fontPkg.name}@${fontPkg.version}`,
  aliases: ALIASES,
  files: files.length,
  faces,
  failed,
  // Every weight of every style of every subset (9 x 2 x 9 on 5.3.0), registered under every alias.
  ok: files.length >= 162 && failed.length === 0 && faces === files.length * ALIASES.length,
}
