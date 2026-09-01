// The app's runtime global stylesheet, for the harness.
//
// WHY THIS FILE EXISTS (BUG-HARNESSGLOBALCSS-001). The app has no .css file — but it is NOT
// style-free. `src/main.jsx:10-24` BUILDS a <style> element in JavaScript and appends it to
// document.head on boot. Because it is constructed at runtime rather than authored as a stylesheet,
// it is invisible to any grep for CSS, and `tests/harness/index.html` asserted for months that "no
// app-level global CSS exists". No harness entry loaded it. Every measurement the harness produced
// between its creation and 2026-09-01 was therefore taken under the WRONG box model and the WRONG
// font.
//
// Measured cost, on the run that found it: `/seeds/saved`'s sheet inputs are `width:100%` with 12px
// padding and a 1px border. Under the UA default `content-box` they computed to 416px inside a
// 390px sheet — a 26px overflow that looked exactly like a real shipped defect and was one keystroke
// from being reported as one. Under the app's real `border-box` they are 390px and fit exactly.
// The font swap matters just as much and is quieter: the UA serif has different metrics from
// `-apple-system`, so every wrap point, line count and element height shifts with it — which is the
// entire class of thing this harness is built to measure.
//
// Injected into every harness HTML entry by a `transformIndexHtml` hook in vite.harness.config.mjs,
// rather than imported per-entry, because entries do NOT share a root module: each .html loads its
// own .jsx, so patching harness/main.jsx would have fixed index.html alone and left the other twenty
// entries silently wrong — the same partial fix that would have re-created this bug.
//
// COPIED, NOT IMPORTED, from src/main.jsx. That module also boots Clerk, registers the service
// worker and fires warmApiOrigins() at import time, none of which can run here. The duplication is
// the cost of that, so: IF THE BLOCK IN src/main.jsx CHANGES, CHANGE IT HERE TOO. This is the same
// hazard the README already documents for the viewport meta, and it is guarded the same way —
// src/__tests__/harnessGlobalStyle.test.js pins the two copies together.
import { iconCssVars } from '../../src/lib/tokens.js'

// Idempotent: `seedssaved.jsx` injected its own copy before this file existed, and a future entry
// may reasonably do the same. Two identical style blocks would not change the cascade, but a marked
// singleton makes the harness state legible to anyone inspecting document.head mid-measurement.
if (!document.getElementById('harness-app-global-style')) {
  const globalStyle = document.createElement('style')
  globalStyle.id = 'harness-app-global-style'
  globalStyle.textContent = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  a { color: inherit; }
  input, button, textarea, select { font: inherit; }
  :root { --bottom-nav-height: 0px; }
  ${iconCssVars()}
`
  document.head.appendChild(globalStyle)
}
