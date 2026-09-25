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
// THE FILES come from the EXACT-pinned devDependency @fontsource-variable/roboto (Google Fonts'
// Roboto, variable wght axis, every subset, both styles), fetched from the harness's own Vite server.
// No network, no copied font files. Bumping that package can move glyphs, so a bump is a deliberate
// re-record of the Today budget, never a routine update.
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
import normalCss from '@fontsource-variable/roboto/index.css?raw'
import italicCss from '@fontsource-variable/roboto/wght-italic.css?raw'
import cssHref from '@fontsource-variable/roboto/index.css?url'
import fontPkg from '@fontsource-variable/roboto/package.json'

// Every named family ahead of a generic in a stack the Today page or the undo toast declares. Census
// 2026-09-25: src/main.jsx's body stack and WeatherWidget.jsx's inline stack; every other component on
// those two surfaces sets `inherit`. `Roboto` is aliased too, so a host with its own Roboto installed
// still paints this one.
export const ALIASES = ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Inter']

// The package's own @font-face blocks, read rather than restated, so its subsets and unicode ranges
// cannot drift from the files it ships.
const base = new URL(cssHref, location.href)
const files = []
for (const css of [normalCss, italicCss]) {
  for (const block of css.match(/@font-face\s*{[^}]*}/g) || []) {
    const get = (prop) => (block.match(new RegExp(prop + ':\\s*([^;]+);')) || [])[1]
    const rel = ((block.match(/url\(([^)]+)\)/) || [])[1] || '').replace(/['"]/g, '')
    if (!rel) continue
    files.push({ file: rel.split('/').pop(), url: new URL(rel, base).href, style: get('font-style'), weight: get('font-weight'), unicodeRange: get('unicode-range') })
  }
}

const failed = []
let loaded = 0
await Promise.all(files.map(async (f) => {
  let buf
  try {
    const r = await fetch(f.url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    buf = await r.arrayBuffer()
  } catch (e) { failed.push(`${f.file}: ${e.message}`); return }
  await Promise.all(ALIASES.map(async (family) => {
    // display 'block', not the package's 'swap': nothing may ever paint in a fallback face.
    const face = new FontFace(family, buf, { style: f.style, weight: f.weight, unicodeRange: f.unicodeRange, display: 'block' })
    try { await face.load(); document.fonts.add(face); loaded++ } catch (e) { failed.push(`${family} ${f.file}: ${e.message}`) }
  }))
}))
await document.fonts.ready

window.__fontPin = {
  family: 'Roboto',
  source: `${fontPkg.name}@${fontPkg.version}`,
  aliases: ALIASES,
  files: files.length,
  faces: loaded,
  failed,
  // Both styles of every subset parsed (9 + 9 on 5.3.0), every alias registered on every file.
  ok: files.length >= 18 && failed.length === 0 && loaded === files.length * ALIASES.length,
}
