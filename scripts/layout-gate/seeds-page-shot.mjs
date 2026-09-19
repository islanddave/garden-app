#!/usr/bin/env node
// seeds-page-shot.mjs — V5-SEEDSTAB-001, reworked for V5-SEEDCARDS-001. The whole Seeds page, in real
// Chrome, at the two phone geometries it is built for, on all three of its views.
//
//   node scripts/layout-gate/seeds-page-shot.mjs [--outdir dir]     # npm run gate:seeds-page
//   node scripts/layout-gate/seeds-page-shot.mjs --probe-nothing    # prove the instrument fires
//
// MEASURES /seeds?view=mine, ?view=saved and ?view=sow at a TRUE 360x640 and 390x844, mounted by
// tests/harness/seeds.{html,jsx} with the app's top bar and bottom nav in place, and asserts:
//   (a) THE VIEW SWITCH IS ONE LINE — its three radios share a top within SAME_TOP_PX, and the
//       control sits inside the viewport.
//   (b) THE HEADER IS ONE LINE — the title and every action button share a row (vertical centres
//       within SAME_TOP_PX), actions do not overlap the title or run past the header, and neither
//       the header, the action slot nor the title overflows its own box.
//   (c) NO SIDEWAYS SCROLL — documentElement.scrollWidth <= clientWidth (on My seeds, again with every
//       group open). Mobile emulation adds a second shape: Chrome WIDENS the layout viewport to fit a
//       document wider than the device (and scales it down), so innerWidth reads the content width.
//       That arrives at the viewport refusal, which recognises it by the preserved aspect ratio and
//       names it (c).
//   (d) TAP FLOOR — every visible button, link, radio, form control and role=button is >=
//       T.tapMinHeight, as a census rather than a named list, EXCEPT the frozen SegmentedControl's
//       radios (drawn at 40px): ONE named exemption, shared with gate:seeds-saved
//       (segmented-control-exemption.mjs), held to the primitive's own floor and printed on every run.
//       Controls inside the visible band also hit-test to themselves; controls under the fixed nav
//       are not probed (that is what a scrolling page under fixed chrome looks like at scrollTop 0 —
//       putup-close-clearance.mjs's lesson). On My seeds the census runs twice — on the folded first
//       screen, and with every group open and one row expanded — so it meets the folding crop headers
//       (44px since they became taps), the supplier chips, Expand all and an expanded row's links; it
//       must count all nine headers (eight crops + Sowed previously) or the view is refused.
//
// MY SEEDS STARTS FOLDED (V5-SEEDCARDS-001): a fresh session is crop HEADERS, no rows. So it is
// measured in three states, in this order — each reached by a real, hit-tested tap, never by
// element.click(), and each read only once the page has stopped scrolling:
//   (e) THE FIRST SCREEN, folded, fresh session, scrollTop 0 — the search line, the crop chip row and
//       the supplier chip row are FULLY inside the visible band (below the top bar, above the bottom
//       nav: what the phone actually shows) and each chip row is ONE line (its chips share a top
//       within SAME_TOP_PX); every header is folded (aria-expanded=false) and no seed row is in the
//       band; the first two headers are the crops pinned in the chip row; and at 360x640 at least
//       FIRST_SCREEN.minHeaders headers are fully in the band. The count at 390x844 is PRINTED, not
//       asserted.
//   (e2) ONE GROUP OPENED — the Pepper header is tapped: its top does not move (±HEADER_STILL_PX), its
//       first row is fully in the band and its second row's top is in the band. That is the honest
//       floor on a day a ferment is due (UX spec §4.7, §10); two full rows is the number for a day
//       without one.
//   EVERY GROUP OPEN — Expand all is tapped, then one row (the saved lot with the most controls):
//   (f) ONE-LINE ROWS — every row's line 1 (title, ordinal, chevron) and line 2 ([data-testid=
//       "my-seed-line"]) is ONE line: its height <= ONE_LINE_RATIO x its one-line height, AND its text
//       runs share one horizontal band. The title is one line too, and the fixture's 44-character
//       name is TRUNCATED with an ellipsis rather than wrapped.
//   (g) THE AMOUNT IS NEVER CUT — every row that states an amount ([data-testid="my-seed-amount"])
//       shows ALL of it: the span is inside its line's box, has width, and its text is not
//       ellipsised. Promoted from a REPORTED finding (2026-09-18: at 360px the 44-char row's two
//       chips squeezed a single facts span to 0px, and the amount went with it).
//   (i) THE ORDINAL IS NEVER CUT — on each row of an identical pair, "1 of 2 identical"
//       ([data-testid="my-seed-ordinal"], on LINE 1 since V5-SEEDCARDS-001) shows whole, like (g): it
//       is the only fact that tells the two apart, and the title beside it has to give way instead.
//   (j) THE SUPPLIER CHIP IS WHOLE — every [data-testid="my-seed-supplier"] sits inside its line, has
//       width and is not ellipsised (scrollWidth <= clientWidth + 1): it leads the line and carries
//       the supplier's name, the cue that never depends on colour.
//   (k) THE HEAT IS WHOLE — every [data-testid="my-seed-heat"] sits inside its line and is not
//       ellipsised: a cut Scoville number is a wrong number.
//   (l) THE THUMBNAIL BOX HOLDS — every row's [data-testid="my-seed-thumb"] is THUMB_PX x THUMB_PX
//       (±BOX_TOL_PX) at one left x (±BOX_TOL_PX), striped (a supplier) or not — measured BEFORE any
//       packet image has landed and AGAIN after every one has loaded or failed. "Before" is made, not
//       hoped for: the packet-image requests are HELD at the network layer (CDP Fetch) until the
//       first measurement is read, and every mounted <img> must still be loading when it is; "after"
//       releases them, scrolls the image window open to the last row, and waits for each image to
//       load or to end on its placeholder (the fixture's broken URL).
//   (h) SOW NOW NAMES ARE NOT SQUEEZED — every open Sow now card's title column is at least
//       SowNow.jsx's TITLE_COL_MIN_PX (read from the source); wider action pairs wrap under the name.
//       Promoted from a REPORTED finding (a needs-profile card left its name 76px, five lines).
//
// "ITS LINE-HEIGHT", MADE PRECISE, because the literal reading is wrong for this element. The second
// line is a flex row of Badges and facts spans; its own computed line-height is `normal` at 12px
// (~14px), but a Badge is 22px tall by construction (0.72rem x 1.4 + 2px padding + border) — so
// "height <= 1.5 x its line-height" would fail every row that carries a chip while it sits on one
// line. The one-line height used here is the TALLEST ONE-LINE BOX AMONG ITS ITEMS (each item's used
// line-height — `normal` resolved to the height of its own text run — plus its padding and border).
// And because a two-line wrap INSIDE a facts span takes a chip row only from 22px to 30px (x1.36,
// under 1.5), the ratio is paired with a direct count of visual lines: text runs clustered by vertical
// overlap. Either one alone has a hole; together they catch a flex-wrap and a text wrap.
//
// WHY IT CANNOT BE A VITEST TEST: jsdom returns 0 from every getBoundingClientRect() and never loads
// an image. The Seeds suites are green about content and structurally cannot see a wrap, an overflow,
// a fold or a box that grows when its picture arrives.
//
// THE INSTRUMENT CHECK comes first on every view and every My seeds state, and a mismatch stops that
// view before any invariant is read: the page must self-report the viewport it was asked for (else
// REFUSED — trap 1 below), must have raised no error, must be the Seeds page on the requested view
// (switch checked, view body mounted, no view-error fallback), the chrome stand-ins must be exactly
// TopChrome's BAR_H and BOTTOM_NAV_HEIGHT_PX, the ferment line the fixture guarantees must be there,
// and every count the fixture promises must match — including, on My seeds, that each tap took. A
// selector that matched nothing is a FAILURE, never a quiet pass. `--probe-nothing` points every
// selector at a testid nothing renders; it MUST exit 1, and that red is the proof the non-vacuity
// half is load-bearing.
//
// SCREENSHOTS: PNGs of each view and viewport, written to --outdir (repo-relative artifacts/layout-gate
// by default, gitignored) — viewport-only on purpose: captureBeyondViewport resizes the viewport and
// reflows the page it is photographing. My seeds adds the Pepper-open and every-group-open states.
//
// TRAPS THE SIBLINGS ALREADY PAID FOR:
//   1. macOS Chrome floors an OS window at ~500px, so --window-size=360 lays the page out at ~500
//      and CROPS the capture. Geometry comes from Emulation.setDeviceMetricsOverride, and a view whose
//      innerWidth/innerHeight is not the one requested is REFUSED, never measured.
//   2. The in-app browser pane reports visibilityState 'hidden' and rAF never fires; hence headless
//      Chrome with --disable-renderer-backgrounding (log-chooser-clearance.mjs).
//   3. CI pins node 20.19.0, which has no global WebSocket — resolveWebSocket(), never a bare global.
//   4. Fonts differ on the Linux runner (no -apple-system; the stack falls to a wider sans), so a
//      width that passes by a few pixels here can fail there. The record prints every margin.
//   5. Identical image URLs collapse in the HTTP cache and a same-URL image can land synchronously
//      from memory; the harness makes every packet URL distinct per photo AND per page load, so the
//      held "before" state is real on every viewport.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { T } from '../../src/components/forms/formStyles.js'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { resolveWebSocket } from './cdp-socket.mjs'
import { segmentedRadioFloorPx, isExemptSegmentedRadio } from './segmented-control-exemption.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Read from the token / the sources, never spelled here: a gate carrying its own copy of a floor keeps
// passing after someone moves the real one.
const TAP_MIN_HEIGHT_PX = T.tapMinHeight
const SEGMENTED_RADIO_MIN_PX = segmentedRadioFloorPx(ROOT)
function topChromeHeightPx() {
  const src = readFileSync(resolve(ROOT, 'src/components/TopChrome.jsx'), 'utf8')
  const found = [...src.matchAll(/const BAR_H = (\d+)/g)].map(m => Number(m[1]))
  if (found.length !== 1) throw new Error(`TopChrome.jsx declares BAR_H ${found.length} times; expected exactly 1 — the top-bar stand-in cannot be sized`)
  return found[0]
}
const TOP_CHROME_PX = topChromeHeightPx()
function sowTitleColMinPx() {
  const src = readFileSync(resolve(ROOT, 'src/pages/SowNow.jsx'), 'utf8')
  const found = [...src.matchAll(/const TITLE_COL_MIN_PX = (\d+)/g)].map(m => Number(m[1]))
  if (found.length !== 1) throw new Error(`SowNow.jsx declares TITLE_COL_MIN_PX ${found.length} times; expected exactly 1 — (h) has no floor to hold the cards to`)
  return found[0]
}
const SOW_TITLE_COL_MIN_PX = sowTitleColMinPx()

// Tolerances. 2px is "the same line" for boxes whose centres a flex row aligns exactly; 1.5 is the
// brief's own one-line ratio (a second line of any of this text at least doubles the box).
const SAME_TOP_PX = 2
const ONE_LINE_RATIO = 1.5
// (e): the first screen of My seeds at the narrowest phone.
const FIRST_SCREEN = { view: 'mine', vw: 360, vh: 640, minHeaders: 3 }
// (e2): "the header's top does not move", to a pixel either way.
const HEADER_STILL_PX = 1
// (l): the app's ROW thumbnail (Garden tree rows, ProjectDetail planting rows; UX spec §1). This is
// the contract the box is held to, so it is spelled from the spec rather than read back from
// MySeeds.jsx — a gate that read it would pass whatever size the page drew.
const THUMB_PX = 40
const BOX_TOL_PX = 0.5

const PORT = Number(process.env.GATE_HARNESS_PORT || 5319)   // 5312-5318 / 9422-9429 are sibling gates'
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9430)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI passes --no-sandbox. Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const outArg = process.argv.indexOf('--outdir')
const OUTDIR = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(ROOT, 'artifacts/layout-gate')

// MUTATION HOOKS — how each assertion below was shown able to fire WITHOUT touching src/**. Never set
// in CI; a run with either set says so in its first lines, so its output cannot pass for a clean one.
//   GATE_MUTATE_CSS — CSS injected into the page after it is ready and before anything is read (e.g.
//     '[data-testid="my-seed-line"]{flex-wrap:wrap!important}' must red (f)).
//   GATE_MUTATE_JS — the body of an async function run in the page right after that CSS, on every
//     view, for the two (e) assertions no stylesheet can reach: that every header starts folded and
//     that no row is on the first screen (e.g. open the Pepper group, wait, scroll back to the top).
//     Write it defensively (`?.click()`): it runs on Saved seeds and Sow now too.
const MUTATE_CSS = process.env.GATE_MUTATE_CSS || ''
const MUTATE_JS = process.env.GATE_MUTATE_JS || ''

const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`
const tidPrefix = (name) => `[data-testid^="${name}${SUFFIX}"]`

// What tests/harness/seeds.jsx promises, per view. EXACT where the number falls straight out of the
// fixture rows (the two files move together); a FLOOR only on Sow now, whose timed buckets move with
// the calendar — its floor counts only the date-independent cards (3 with no sow profile: Add sow
// details + Archive; 2 in process: Archive) and the two collapsed review sections' toggles.
const LONG_NAME = 'Money Plant (self-saved, variety unrecorded)'
// The row opened with every group open: the drying saved pepper, the only fixture row whose expanded
// panel carries all three kinds of control — a link out ("About this variety ↗"), "Change stage in
// Saved seeds →" and "Open details →" — and it is the first row of the first group, so it is in the
// band at scrollTop 0.
const EXPAND_ROW = 'Aji Charapita'
const VIEWS = [
  { view: 'mine', label: 'My seeds', body: 'my-seeds-view', expect: {
    actions: 2,
    // Folded, fresh session: the fixture's eight crops, Sowed previously (the used-up Salad Bowl Blend),
    // the two most-counted crops and suppliers pinned in their chip rows.
    cropHeaders: 8, sowedHeaders: 1, pinnedCrops: ['Pepper', 'Tomato'], pinnedSuppliers: ['Botanical', 'Bentley'],
    // Every group open: 28 rows. The amount shows on 8 (every "1 packet" row prints none: Hot Portugal,
    // Shishito and Amish Paste's 2-3 packets, the Reaper's 25 seeds, the bean's 2 oz, the used-up 0
    // packets, and the two COUNTED saved lots — 1884's 185 and the Money Plant's approx. 120).
    rows: 28, longRowChips: 2, ordinalRows: 2, amountRows: 8, stripeless: 5, expandedControls: 3,
    // One chip per bought packet, by short label — Fedco is the one supplier the palette does not know.
    suppliers: { Botanical: 8, Bentley: 6, "Johnny's": 4, Fedco: 4, Sandia: 1 },
    // Ten of the eleven peppers carry heat (Lemon Drop has no figure on record); these four labels are
    // the shapes that have to be on screen: sweet, the longest, a single bound, the saved lot's estimate.
    heatRows: 10, heatLabels: ['Sweet · 0 SHU', '1.2M–2M SHU', '23K SHU', 'est. 30K–50K SHU'],
    // 13 rows carry a packet photo (one of them the broken URL). 11 fall inside the first image-window
    // page (useImageWindow, 24 rows); the two tail photos mount only once the page is scrolled.
    photoRows: 13, brokenPhotos: 1, firstPagePhotos: 11,
  } },
  { view: 'saved', label: 'Saved seeds', body: 'saved-seeds-view', expect: { actions: 1, cards: 4, sections: 3 } },
  { view: 'sow', label: 'Sow now', body: 'sow-now-view', expect: { actions: 0, minSowButtons: 10, minSowHeadings: 2 } },
]
const VIEWPORTS = [[360, 640], [390, 844]]

const failures = []
const fail = m => failures.push(m)
const R1 = n => Math.round(n * 10) / 10

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  // Spawned through vite's own bin, NOT `npx vite`: npx is a wrapper, so killing it at teardown
  // orphans the real server and hangs any caller that pipes this script's stdout.
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/seeds.html`)
      if (r.ok) return proc
    } catch { /* not listening yet */ }
    if (proc.exitCode != null) throw new Error(`harness vite exited (${proc.exitCode}):\n${log}`)
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`harness vite never served :${PORT} within 30s:\n${log}`)
}

async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation, so the
    // window only has to be big enough not to clip it. See trap 1 in the header.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  // 60s by default, as the siblings: 15s was marginal on a loaded GitHub runner. CDP_WAIT_MS overrides.
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
    // A DEAD CHROME IS NOT A SLOW CHROME — say which one this is instead of waiting out the clock.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} (code=${proc.exitCode} signal=${proc.signalCode}) - a dead browser, not a slow one; re-running will not help`)
    }
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return { proc, version: await r.json() }
    } catch { /* not listening yet */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT} within ${CDP_WAIT_TRIES * 250}ms`)
}

async function attach(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  // Events (Fetch.requestPaused, for the held packet images) go to every listener; answers to the
  // gate's own calls resolve their promise.
  const listeners = new Set()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) {
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id)
      clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    } else if (m.method) {
      for (const fn of listeners) fn(m)
    }
  }
  // Each call's 90s timeout is CLEARED when its answer lands. The siblings leave theirs armed, so a
  // PASSING run (which exits naturally rather than through process.exit) idles until the last one
  // fires — measured on gate:seeds-saved: ~90 of its ~99 s are that wait, after PASS is printed.
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 90000)
    pending.set(mid, { res, rej, timer })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  const evalIn = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn, on: fn => listeners.add(fn) }
}

// ── The measurement, evaluated in the page itself ───────────────────────────────────────────────
// Nothing is tapped, scrolled or restyled by the measurement: every number is read from the live
// document as it stands. The first call per view is at scrollTop 0, which is the first screen (e) is
// about; My seeds' later states are reached by the taps below, and read by this same function.
const MEASURE = (v) => `(() => {
  const d = document, w = window, de = d.documentElement
  const R = n => Math.round(n * 10) / 10
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: R(r.top), l: R(r.left), r: R(r.right), b: R(r.bottom), w: R(r.width), h: R(r.height) } }
  // A folding crop header's own words: FacetGroupHeader draws [chevron (aria-hidden)] [label] [count].
  const headerParts = h => [...h.children].filter(c => c.getAttribute('aria-hidden') !== 'true').map(c => (c.textContent || '').trim())
  const name = el => el.getAttribute('aria-label') ||
    (el.matches('${tid('facet-group-header')}') ? 'header ' + (headerParts(el)[0] || '?') : '') ||
    el.getAttribute('data-testid') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40) ||
    ('<' + el.tagName.toLowerCase() + ' ' + (el.type || '') + '>')
  // checkVisibility(), not offsetParent: a collapsed <details> or a zero-opacity ancestor reports a
  // parent and reads as visible through offsetParent.
  const shown = el => (!el.checkVisibility || el.checkVisibility()) && el.getBoundingClientRect().height > 0
  const px = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0 }
  // Text runs, one rect per line fragment per TEXT NODE, from a Range over each live text node. No
  // clone and no style mutation: a gate that edits the document to measure it measures its own
  // instrument. Per text node and not one Range over the element, because a Range's rects include
  // the BORDER BOX of every element it selects — a two-line facts span's own 30px box then spans both
  // of its lines and merges them into one (measured: a GATE_MUTATE_CSS wrap read "1 visual line").
  const textRects = el => { const out = [], tw = d.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!t.textContent.trim()) continue
      const rg = d.createRange(); rg.selectNodeContents(t)
      for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) out.push(r)
    }
    return out }
  // VISUAL LINES: text runs clustered by vertical OVERLAP. A chip's text sits a few px lower than the
  // facts beside it on the same line, so counting distinct tops (right for one text node, as in
  // seeds-saved-clearance.mjs) would call a one-line row three lines.
  // Each band keeps its widest run: an ellipsized text node hands back TWO rects on its one line (the
  // full run and the painted one — measured 327px + 270px for the 44-char name), so a sum of rects
  // double-counts and a per-band max does not.
  const bandsOf = el => { const rs = textRects(el).sort((a, b) => a.top - b.top); const out = []
    for (const r of rs) { const last = out[out.length - 1]
      if (last && r.top < last.bottom - 1) { last.bottom = Math.max(last.bottom, r.bottom); last.w = Math.max(last.w, r.width) }
      else out.push({ top: r.top, bottom: r.bottom, w: r.width }) }
    return out }
  const lines = el => bandsOf(el).length
  // ONE LINE of an element's own content: its used line-height (px; 'normal' resolved to the height
  // of its own text run, which is what normal means for that font) + vertical padding + border.
  const oneLine = el => { const cs = w.getComputedStyle(el); let lh = parseFloat(cs.lineHeight)
    if (!Number.isFinite(lh)) { const rs = textRects(el); lh = rs.length ? Math.min(...rs.map(r => r.height)) : px(cs.fontSize) * 1.2 }
    return lh + px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth) }
  // A never-cut item, read against the line that holds it: inside its box, with width, not ellipsised.
  const whole = (el, lb) => { const b = el.getBoundingClientRect(); return { text: (el.textContent || '').trim(),
    w: R(b.width), l: R(b.left), r: R(b.right), inLine: b.left >= lb.left - 0.5 && b.right <= lb.right + 0.5,
    cut: el.scrollWidth > el.clientWidth + 1 } }

  const topBar = d.querySelector('header[data-app-chrome="top"]')
  const nav = d.querySelector('nav[aria-label="Main navigation"]')
  // The VISIBLE BAND: under the sticky top bar, above the fixed nav.
  const bandTop = topBar ? topBar.getBoundingClientRect().bottom : 0
  const bandBottom = nav ? nav.getBoundingClientRect().top : w.innerHeight
  const hitsSelf = (el, r) => {
    const x = (r.l + r.r) / 2, y = (r.t + r.b) / 2
    if (x < 0 || x > w.innerWidth || y < bandTop || y > bandBottom) return null   // never probed != not occluded
    const at = d.elementFromPoint(x, y)
    return at === el || (at != null && (el.contains(at) || at.contains(el)))
  }

  const page = d.querySelector('${tid('seeds-page')}')
  const sw = d.querySelector('${tid('seeds-view-switch')}')
  const radios = sw ? [...sw.querySelectorAll('[role="radio"]')] : []
  const checked = radios.find(r => r.getAttribute('aria-checked') === 'true')
  const h1 = page ? page.querySelector('h1') : null
  const header = h1 ? h1.parentElement : null
  const actionsEl = d.querySelector('${tid('seeds-actions')}')
  const actions = actionsEl ? [...actionsEl.children].filter(shown) : []
  const ferment = d.querySelector('${tid('seeds-ferment-line')}')
  const body = d.querySelector('${tid(v.body)}')

  // (d) the census: every visible control on the page, chrome stand-ins excluded (they carry none).
  // Tagged with what it is on My seeds, so the gate can prove the census met the new controls.
  const inChrome = el => (topBar && topBar.contains(el)) || (nav && nav.contains(el))
  const taps = [...d.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="radio"]')]
    .filter(shown).filter(el => !inChrome(el)).map(el => {
      const r = box(el), parent = el.parentElement
      return { label: name(el), tag: el.tagName.toLowerCase(), w: r.w, h: r.h, t: r.t,
        hitIsSelf: hitsSelf(el, r), fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5,
        role: el.getAttribute('role'),
        group: parent && parent.getAttribute('role') === 'radiogroup' ? parent.getAttribute('data-testid') : null,
        header: el.matches('${tid('facet-group-header')}'),
        supplierChip: !!el.closest('${tid('my-seeds-supplier-filter')}'),
        expandAll: el.matches('${tid('my-seeds-expand-all')}'),
        inExpanded: !!el.closest('${tid('my-seed-expanded')}') }
    })

  // My seeds' controls and folding headers — (e), (e2) and the census's non-vacuity.
  const myView = d.querySelector('${tid('my-seeds-view')}')
  const chipRow = el => el ? { ...box(el), buttons: [...el.querySelectorAll('button')].filter(shown).map(b => ({
    label: (b.textContent || '').trim(), pressed: b.getAttribute('aria-pressed'), ...box(b) })) } : null
  const search = d.querySelector('${tid('my-seeds-search')}')
  const expandAll = d.querySelector('${tid('my-seeds-expand-all')}')
  const mine = myView ? {
    // The search line is the flex row holding the search box and the Sort select.
    search: search && search.parentElement ? box(search.parentElement) : null,
    crops: chipRow(d.querySelector('${tid('my-seeds-crop-filter')}')),
    suppliers: chipRow(d.querySelector('${tid('my-seeds-supplier-filter')}')),
    expandAll: expandAll ? { label: (expandAll.textContent || '').trim(), ...box(expandAll) } : null,
    headers: [...myView.querySelectorAll('${tid('facet-group-header')}')].filter(shown).map(h => {
      const parts = headerParts(h), sec = h.closest('[data-group-slug]')
      return { label: parts[0] || '', count: parts[1] || '', expanded: h.getAttribute('aria-expanded'),
        slug: sec ? sec.getAttribute('data-group-slug') : null, sowed: !!h.closest('${tid('my-seeds-sowed')}'), ...box(h) }
    }).sort((a, b) => a.t - b.t),
  } : null

  // My seeds rows: line 1 (title, ordinal, chevron), line 2 (supplier, chips, amount, heat, the tail),
  // the thumbnail box and what is in it.
  const rows = [...d.querySelectorAll('${tid('my-seed-row')}')].map(row => {
    const rb = box(row)
    const sec = row.closest('[data-group-slug]')
    const line = row.querySelector('${tid('my-seed-line')}')
    // Line 1 is the flex row line 2 follows; the title is its first child (it carries no testid).
    const line1 = line ? line.previousElementSibling : null
    const title = line1 ? line1.firstElementChild : null
    let L = null, L1 = null, TT = null, TH = null
    if (line) {
      const items = [...line.children]
      const chips = [...line.querySelectorAll('${tid('my-seed-chip')}')]
      const amount = line.querySelector('${tid('my-seed-amount')}')
      const supplier = line.querySelector('${tid('my-seed-supplier')}')
      const heat = line.querySelector('${tid('my-seed-heat')}')
      const rest = line.querySelector('${tid('my-seed-rest')}')
      const lb = line.getBoundingClientRect()
      // The chips count as items even though they now sit one level down, in their own shrinking box:
      // measured against the direct children only, a 22px Badge row read as x1.58 of a 14px line on
      // CI's fonts (x1.47 on the Mac) — a one-line row failing (f) because of where its chips live.
      const one = Math.max(oneLine(line), ...items.map(oneLine), ...chips.map(oneLine))
      // THE LINE'S MARGIN: from the right edge of the last item that never gives way (the supplier,
      // a live state chip, the amount, the heat) to the line's own right edge. Printed, because CI's
      // wider fonts spend it first.
      const fixed = [supplier, amount, heat, chips[0]].filter(Boolean).map(e => e.getBoundingClientRect().right)
      L = { text: (line.textContent || '').trim().replace(/\\s+/g, ' '), h: R(lb.height), oneLineH: R(one),
        ratio: Math.round(lb.height / one * 100) / 100, lines: lines(line), chips: chips.length,
        chipLabels: chips.map(c => (c.textContent || '').trim()),
        amount: amount ? whole(amount, lb) : null,
        supplier: supplier ? { ...whole(supplier, lb), name: supplier.getAttribute('data-supplier') } : null,
        heat: heat ? whole(heat, lb) : null,
        lineL: R(lb.left), lineR: R(lb.right), slack: fixed.length ? R(lb.right - Math.max(...fixed)) : null,
        // REPORTED: what gives way on a crowded line, by design — chips ellipsised, then where-from/how-old.
        chipsCut: chips.filter(c => c.scrollWidth > c.clientWidth + 1 || c.getBoundingClientRect().right > lb.right + 0.5).length,
        restW: rest ? R(rest.getBoundingClientRect().width) : null,
        restInkW: rest ? R(rest.scrollWidth) : null,
        clipsContent: line.scrollWidth > line.clientWidth + 1 }
    }
    if (line1) {
      const l1b = line1.getBoundingClientRect()
      const ordinal = line1.querySelector('${tid('my-seed-ordinal')}')
      const one1 = Math.max(oneLine(line1), ...[...line1.children].map(oneLine))
      L1 = { h: R(l1b.height), oneLineH: R(one1), ratio: Math.round(l1b.height / one1 * 100) / 100, lines: lines(line1),
        l: R(l1b.left), r: R(l1b.right), ordinal: ordinal ? whole(ordinal, l1b) : null,
        slack: ordinal ? R(l1b.right - ordinal.getBoundingClientRect().right) : null }
    }
    if (title) {
      const tb = title.getBoundingClientRect()
      TT = { text: (title.textContent || '').trim(), h: R(tb.height), oneLineH: R(oneLine(title)), lines: lines(title),
        truncated: title.scrollWidth > title.clientWidth + 1,
        ellipsis: w.getComputedStyle(title).textOverflow === 'ellipsis', w: R(tb.width),
        // The name's full ink width, wrapped or not: the widest run on each of its lines, summed.
        // Whether the name NEEDS truncating is a property of the fixture; whether it IS is (f).
        inkW: R(bandsOf(title).reduce((s, b) => s + b.w, 0)) }
    }
    const thumb = row.querySelector('${tid('my-seed-thumb')}')
    if (thumb) {
      const ph = thumb.querySelector('${tid('my-seed-photo')}')
      TH = { ...box(thumb), photo: ph ? (ph.tagName === 'IMG'
        ? { img: true, complete: ph.complete, nw: ph.naturalWidth, nh: ph.naturalHeight }
        : { img: false }) : null }
    }
    return { id: row.getAttribute('data-lot-id'), slug: sec ? sec.getAttribute('data-group-slug') : null,
      t: rb.t, b: rb.b, h: rb.h, stripe: R(px(w.getComputedStyle(row).borderLeftWidth)),
      line: L, line1: L1, title: TT, thumb: TH, expanded: !!row.querySelector('${tid('my-seed-expanded')}'),
      inBand: rb.t >= bandTop - 0.5 && rb.b <= bandBottom + 0.5,
      touchesBand: rb.h > 0 && rb.b > bandTop + 0.5 && rb.t < bandBottom - 0.5,
      inViewport: rb.t >= -0.5 && rb.b <= w.innerHeight + 0.5 }
  })

  // Sow now: the date-independent floor, and — REPORTED — each open card's title column, which is
  // what the card's action column leaves for the name.
  const sowView = d.querySelector('${tid('sow-now-view')}')
  const sowCards = sowView ? [...sowView.querySelectorAll('button[aria-label^="Archive "], button[aria-label^="Un-archive "]')]
    .filter(shown).map(b => b.parentElement && b.parentElement.parentElement).filter(Boolean).map(card => {
      const col = card.firstElementChild, titleEl = col && col.querySelector('span')
      return { title: titleEl ? (titleEl.textContent || '').trim() : '?', colW: col ? R(col.getBoundingClientRect().width) : null,
        titleLines: titleEl ? lines(titleEl) : null, cardH: R(card.getBoundingClientRect().height),
        hasProfileBtn: !!card.querySelector('button[aria-label^="Add sow details for "]') }
    }) : []

  const hb = header ? box(header) : null, tb = h1 ? box(h1) : null
  return {
    vw: w.innerWidth, vh: w.innerHeight,
    scroll: { x: Math.round(w.scrollX), y: Math.round(w.scrollY) },
    errors: w.__h && w.__h.errors ? w.__h.errors() : ['harness never exposed __h'],
    arrived: !!(w.__h && w.__h.arrived && w.__h.arrived()),
    hits: w.__h && w.__h.hits ? w.__h.hits() : {},
    chrome: { top: topBar ? R(topBar.getBoundingClientRect().height) : null, nav: nav ? R(nav.getBoundingClientRect().height) : null,
      bandTop: R(bandTop), bandBottom: R(bandBottom) },
    doc: { scrollW: de.scrollWidth, clientW: de.clientWidth, scrollH: de.scrollHeight },
    surface: { page: !!page, body: !!body, viewError: !!d.querySelector('${tid('seeds-view-error')}'),
      radios: radios.length, checked: checked ? (checked.textContent || '').trim() : null,
      h1: h1 ? (h1.textContent || '').trim() : null },
    sw: sw ? { ...box(sw), tops: radios.map(r => R(r.getBoundingClientRect().top)), heights: radios.map(r => R(r.getBoundingClientRect().height)),
      overflow: sw.scrollWidth > sw.clientWidth + 1 } : null,
    header: header ? { ...hb, overflow: header.scrollWidth > header.clientWidth + 1,
      title: { ...tb, clipped: h1.scrollWidth > h1.clientWidth + 1 },
      slotOverflow: actionsEl ? actionsEl.scrollWidth > actionsEl.clientWidth + 1 : false,
      actions: actions.map(a => ({ label: name(a), ...box(a) })) } : null,
    ferment: ferment ? { ...box(ferment), level: ferment.getAttribute('data-level'), lines: lines(ferment),
      text: (ferment.textContent || '').trim().replace(/\\s+/g, ' ') } : null,
    taps, rows, mine,
    cards: d.querySelectorAll('${tid('seed-lot-card')}').length,
    sections: d.querySelectorAll('${tidPrefix('stage-section-')}').length,
    sow: sowView ? { buttons: [...sowView.querySelectorAll('button')].filter(shown).length,
      headings: sowView.querySelectorAll('h2').length, cards: sowCards } : null,
  }
})()`

// Six navigations on one target, and Runtime.evaluate races the commit: dispatched a beat too early
// the context is torn down under it. Retried ONLY on that transport class (seeds-saved's lesson);
// anything else still throws, because a page error is not a slow page.
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i
async function evalSettled(expr, tries = 25) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await cdp.evalIn(expr) } catch (err) {
      if (!CONTEXT_LOST.test(err.message)) throw err
      last = err
      await sleep(200)
    }
  }
  throw new Error(`page never held still long enough to evaluate: ${last?.message}`)
}

// ── Packet images, HELD at the network layer ────────────────────────────────────────────────────
// (l) asks for the thumbnail box BEFORE any image has landed. A local image lands in a millisecond,
// so "before" is not a moment the gate can wait for — it is a state it has to make: every request for
// a harness packet image is paused (CDP Fetch) until holdImages' caller releases it. Only the packet
// images match the pattern; the page, its modules and its API stubs are untouched.
const PACKET_URL_PATTERN = '*/tests/harness/seeds-packets/*'
const imageHold = { enabled: false, holding: false, held: [], seen: 0 }
function onImageRequest(m) {
  if (m.method !== 'Fetch.requestPaused') return
  imageHold.seen++
  if (imageHold.holding) imageHold.held.push(m.params.requestId)
  else cdp.send('Fetch.continueRequest', { requestId: m.params.requestId }, cdp.sessionId).catch(() => { /* the <img> is gone */ })
}
async function holdImages() {
  Object.assign(imageHold, { enabled: true, holding: true, held: [], seen: 0 })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: PACKET_URL_PATTERN, requestStage: 'Request' }] }, cdp.sessionId)
}
async function releaseImages() {
  imageHold.holding = false
  for (const requestId of imageHold.held.splice(0)) {
    await cdp.send('Fetch.continueRequest', { requestId }, cdp.sessionId).catch(() => { /* the <img> is gone */ })
  }
}
async function stopImageHold() {
  if (!imageHold.enabled) return
  await releaseImages()
  await cdp.send('Fetch.disable', {}, cdp.sessionId).catch(() => { /* target gone */ })
  imageHold.enabled = false
}

// ── Taps ─────────────────────────────────────────────────────────────────────────────────────────
// A REAL tap: the element's centre is hit-tested first — a tap that would land on something else is
// reported, never dispatched — then a press and release at that point go through the browser's own
// input pipeline, the path a finger's click takes. element.click() would open a group that no thumb
// could reach. Returns null, or why the tap could not be made.
async function tap(expr, what) {
  const p = await evalSettled(`(() => { const el = ${expr}; if (!el) return null
    const r = el.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
    const at = document.elementFromPoint(x, y)
    return { x, y, hits: at === el || (at != null && el.contains(at)),
      at: at ? (at.getAttribute('data-testid') || at.tagName.toLowerCase()) : 'nothing' } })()`)
  if (!p) return `${what} is not on the page`
  if (!p.hits) return `${what} does not hit-test at its centre (x${Math.round(p.x)} y${Math.round(p.y)} lands on ${p.at})`
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  return null
}
// Waits in the page for `cond` (a JS expression) and then for the scroll position to hold still for
// 400ms: MySeeds scrolls after a group opens (smoothly unless reduced motion), and a number read
// mid-glide is from a frame nobody rests on. False on timeout.
const waitSettled = (cond, ms = 6000) => evalSettled(`(async () => {
  const t0 = performance.now(); let y = null, still = 0
  while (performance.now() - t0 < ${ms}) {
    await new Promise(r => setTimeout(r, 50))
    if (!(${cond})) { y = null; still = 0; continue }
    const now = Math.round(window.scrollY * 10)
    if (now === y) { still += 50; if (still >= 400) return true } else { y = now; still = 0 }
  }
  return false
})()`)
const shoot = async (path) => {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  return path
}

const headerSel = (slug) => `${tid('my-seeds-group')}[data-group-slug="${slug}"] ${tid('facet-group-header')}`
const rowByTitle = (title) => `[...document.querySelectorAll('${tid('my-seed-row')}')].find(r => {
  const l = r.querySelector('${tid('my-seed-line')}'), t = l && l.previousElementSibling && l.previousElementSibling.firstElementChild
  return !!t && (t.textContent || '').trim() === ${JSON.stringify(title)} })`

// ── (e2): ONE GROUP OPENED ──────────────────────────────────────────────────────────────────────────
// What the tap moved, read once the page is still: the Pepper header, its first two rows, the scroll.
const E2_MEASURE = `(() => {
  const R = n => Math.round(n * 10) / 10
  const box = el => { const r = el.getBoundingClientRect(); return { t: R(r.top), b: R(r.bottom), h: R(r.height) } }
  const top = document.querySelector('header[data-app-chrome="top"]'), nav = document.querySelector('nav[aria-label="Main navigation"]')
  const sec = document.querySelector('${tid('my-seeds-group')}[data-group-slug="pepper"]')
  const h = sec && sec.querySelector('${tid('facet-group-header')}')
  return { scrollY: R(window.scrollY), bandTop: R(top ? top.getBoundingClientRect().bottom : 0),
    bandBottom: R(nav ? nav.getBoundingClientRect().top : window.innerHeight),
    header: h ? { ...box(h), expanded: h.getAttribute('aria-expanded') } : null,
    rows: sec ? [...sec.querySelectorAll('${tid('my-seed-row')}')].slice(0, 2).map(box) : [] }
})()`

async function pepperOpened(at, vw, vh, m0) {
  const P = `[seeds-page] ${at}`
  const H0 = m0.mine.headers.find(h => h.slug === 'pepper')
  if (!H0) { fail(`${at}: (e2) no Pepper header on the first screen — there is no group to open`); return }
  const why = await tap(`document.querySelector('${headerSel('pepper')}')`, 'the Pepper header')
  if (why) { fail(`${at}: (e2) ${why}`); return }
  const settled = await waitSettled(`(() => { const s = document.querySelector('${tid('my-seeds-group')}[data-group-slug="pepper"]'); return !!s && s.querySelectorAll('${tid('my-seed-row')}').length >= 2 })()`)
  const E = await evalSettled(E2_MEASURE)
  // Instrument: the tap took, and the group has the two rows (e2) is about.
  if (!settled || !E.header || E.header.expanded !== 'true' || E.rows.length < 2) {
    fail(`${at}: (e2) the tap on the Pepper header did not open it into two rows it can be measured by (settled ${settled}, aria-expanded ${E.header ? E.header.expanded : 'no header'}, ${E.rows.length} row(s))`)
    return
  }
  const band = { t: E.bandTop, b: E.bandBottom }
  const moved = R1(E.header.t - H0.t)
  const [r1, r2] = E.rows
  if (Math.abs(moved) > HEADER_STILL_PX) fail(`${at}: (e2) the Pepper header moved ${moved}px when it was tapped (y${H0.t} → y${E.header.t}; the page scrolled to ${E.scrollY}px) — the header a thumb just tapped must stay under it (±${HEADER_STILL_PX}px)`)
  if (!(r1.t >= band.t - 0.5 && r1.b <= band.b + 0.5)) fail(`${at}: (e2) the first Pepper row spans y${r1.t}-${r1.b}, not fully inside the visible band y${band.t}-${band.b}`)
  if (!(r2.t >= band.t - 0.5 && r2.t < band.b)) fail(`${at}: (e2) the second Pepper row starts at y${r2.t}, outside the visible band y${band.t}-${band.b}`)
  console.log(`${P}: (e2) tapped Pepper: header y${H0.t} → y${E.header.t} (${moved >= 0 ? '+' : ''}${moved}px, page scrolled ${E.scrollY}px) · row 1 y${r1.t}-${r1.b} (${R1(band.b - r1.b)}px above the nav) · row 2 y${r2.t}-${r2.b}, ${R1(Math.max(0, Math.min(r2.b, band.b) - r2.t))} of ${r2.h}px in the band y${band.t}-${band.b}`)
  console.log(`${P}: screenshot ${await shoot(join(OUTDIR, `seeds-page-mine-${vw}x${vh}-pepper-open.png`))}`)
}

// ── EVERY GROUP OPEN: (c), (d), (f), (g), (i), (j), (k), (l) ─────────────────────────────────────────
async function allOpened(v, at, vw, vh) {
  const e = v.expect
  const P = `[seeds-page] ${at}`
  await evalSettled('(() => { window.scrollTo(0, 0); return 1 })()')
  if (!(await waitSettled('window.scrollY === 0'))) { fail(`${at}: the page would not return to scrollTop 0 after (e2) — every group open is measured from the top`); return }
  let why = await tap(`document.querySelector('${tid('my-seeds-expand-all')}')`, 'Expand all')
  if (why) { fail(`${at}: ${why} — no way to open every group`); return }
  const opened = await waitSettled(`(() => { const hs = [...document.querySelectorAll('${tid('my-seeds-view')} ${tid('facet-group-header')}')]
    return hs.length > 0 && hs.every(h => h.getAttribute('aria-expanded') === 'true') && document.querySelectorAll('${tid('my-seed-row')}').length === ${e.rows} })()`)
  // The row is brought to the middle of the band before it is tapped — a thumb scrolls to a row it
  // wants — and the page goes back to the top after, so the census below runs at scrollTop 0 with no
  // header stuck over the rows.
  let expandedRow = false
  if (opened) {
    await evalSettled(`(() => { const r = ${rowByTitle(EXPAND_ROW)}; if (r) r.scrollIntoView({ block: 'center' }); return 1 })()`)
    await waitSettled('true')
    why = await tap(`(${rowByTitle(EXPAND_ROW)})?.querySelector('button')`, `the "${EXPAND_ROW}" row`)
    expandedRow = !why && await waitSettled(`!!document.querySelector('${tid('my-seed-expanded')}')`)
    await evalSettled('(() => { window.scrollTo(0, 0); return 1 })()')
    await waitSettled('window.scrollY === 0')
  }
  const m = await evalSettled(MEASURE(v))

  // ── INSTRUMENT CHECK for this state. Every count here falls out of the fixture.
  const mismatch = []
  if (m.vw !== vw || m.vh !== vh) mismatch.push(`(c) with every group open the page self-reports ${m.vw}x${m.vh}, not ${vw}x${vh} — mobile Chrome widened the layout viewport to fit a ${m.doc.scrollW}px document, so a row overflows sideways`)
  if (m.scroll.x !== 0 || m.scroll.y !== 0) mismatch.push(`the page is scrolled to ${m.scroll.x},${m.scroll.y} — the census is read at 0,0`)
  if (m.errors.length) mismatch.push(`the page raised ${m.errors.length} error(s): ${m.errors.join(' | ')}`)
  if (!opened) mismatch.push(`tapping Expand all did not open every group into ${e.rows} rows (${m.rows.length} rows, headers ${m.mine ? m.mine.headers.map(h => `${h.label}=${h.expanded}`).join(' ') : 'none'})`)
  if (why) mismatch.push(`${why} — no expanded row for the census`)
  else if (opened && !expandedRow) mismatch.push(`tapping the "${EXPAND_ROW}" row did not expand it`)
  if (m.rows.length !== e.rows) mismatch.push(`${m.rows.length} seed rows, expected ${e.rows} (27 in their crop groups + the used-up packet under Sowed previously)`)
  const long = m.rows.find(r => r.title && r.title.text === LONG_NAME)
  if (!long) mismatch.push(`the 44-character row ("${LONG_NAME}") is not on the page`)
  else {
    if (!long.line || long.line.chips !== e.longRowChips) mismatch.push(`the 44-character row carries ${long.line ? long.line.chips : 0} chip(s), expected ${e.longRowChips} — the worst case for its second line is not on screen`)
    // Non-vacuity for (f)'s ellipsis half: a name whose ink FITS its column proves nothing about
    // truncation. Ink, not scrollWidth — a name that wrapped fits by scrollWidth, and that is
    // (f)'s failure to report, not this check's.
    if (!(long.title.inkW > long.title.w + 1)) mismatch.push(`the 44-character title's ink (${long.title.inkW}px) fits its ${long.title.w}px column at ${vw}px, so the ellipsis path is exercised by nothing`)
    // Non-vacuity for (g): the worst row must state an amount, or (g) holds it to nothing.
    if (!long.line || !long.line.amount) mismatch.push('the 44-character row states no amount — (g) would be checking nothing on the one row that crowds it')
  }
  const withAmount = m.rows.filter(r => r.line && r.line.amount).length
  if (withAmount !== e.amountRows) mismatch.push(`${withAmount} of ${m.rows.length} rows state an amount, expected ${e.amountRows} ("1 packet" is not printed)`)
  // Non-vacuity for (i): the ordinal, in its own span on LINE 1, on exactly the identical pair.
  const ordinals = m.rows.filter(r => r.line1 && r.line1.ordinal)
  if (ordinals.length !== e.ordinalRows || !ordinals.every(r => /^\d+ of \d+ identical$/.test(r.line1.ordinal.text))) mismatch.push(`${ordinals.length} row(s) carry the identical-pair ordinal on line 1 (${ordinals.map(r => `"${r.line1.ordinal.text}"`).join(', ') || 'none'}), expected ${e.ordinalRows} reading "N of 2 identical" — (i) would be checking nothing`)
  // Non-vacuity for (j): every bought packet's chip, by the label the palette gives it.
  const chipCount = {}
  for (const r of m.rows) if (r.line && r.line.supplier) chipCount[r.line.supplier.text] = (chipCount[r.line.supplier.text] ?? 0) + 1
  const wantChips = JSON.stringify(Object.entries(e.suppliers).sort()), gotChips = JSON.stringify(Object.entries(chipCount).sort())
  if (wantChips !== gotChips) mismatch.push(`the rows' supplier chips read ${gotChips}, expected ${wantChips}`)
  // Non-vacuity for (k): the heat spans, and the four label shapes that have to be among them.
  const heats = m.rows.filter(r => r.line && r.line.heat).map(r => r.line.heat.text.replace(/^·\s*/, ''))
  if (heats.length !== e.heatRows) mismatch.push(`${heats.length} row(s) show a heat figure, expected ${e.heatRows} (every pepper but the one with no figure on record)`)
  const missingHeat = e.heatLabels.filter(h => !heats.includes(h))
  if (missingHeat.length) mismatch.push(`no row shows the heat label(s) ${missingHeat.map(h => `"${h}"`).join(', ')} (shown: ${heats.join(' | ')})`)
  // Non-vacuity for (l): a box on every row, both kinds of row edge, and images that are still loading.
  const thumbs = m.rows.filter(r => r.thumb)
  if (thumbs.length !== m.rows.length) mismatch.push(`${thumbs.length} of ${m.rows.length} rows have a thumbnail box`)
  const stripeless = m.rows.filter(r => r.stripe < 2).length
  if (stripeless !== e.stripeless) mismatch.push(`${stripeless} row(s) without a supplier stripe, expected ${e.stripeless} — (l)'s "with or without a stripe" needs both`)
  const mounted = thumbs.filter(r => r.thumb.photo && r.thumb.photo.img)
  if (mounted.length !== e.firstPagePhotos) mismatch.push(`${mounted.length} packet image(s) mounted on the first image-window page, expected ${e.firstPagePhotos}`)
  const landed = mounted.filter(r => r.thumb.photo.complete || r.thumb.photo.nw > 0)
  if (landed.length) mismatch.push(`${landed.length} packet image(s) had already landed when the boxes were first measured (held ${imageHold.held.length}, requested ${imageHold.seen}) — the "before images load" state was not before`)
  // (d)'s non-vacuity with everything open: every header, and the expanded row's controls.
  const censusHeaders = m.taps.filter(t => t.header).length
  if (censusHeaders !== e.cropHeaders + e.sowedHeaders) mismatch.push(`the tap census met ${censusHeaders} header(s), expected ${e.cropHeaders + e.sowedHeaders}`)
  const censusExpanded = m.taps.filter(t => t.inExpanded).length
  if (censusExpanded !== e.expandedControls) mismatch.push(`the tap census met ${censusExpanded} control(s) in the expanded row, expected ${e.expandedControls} (About this variety, Change stage, Open details)`)
  if (mismatch.length) { fail(`${at}: with every group open, the harness did not produce what this gate measures — ${mismatch.join('; ')}`); return }

  // ── (c) NO SIDEWAYS SCROLL, with every row on the page.
  if (m.doc.scrollW > m.doc.clientW) fail(`${at}: (c) with every group open, document scrollWidth ${m.doc.scrollW} > clientWidth ${m.doc.clientW} — the page scrolls sideways`)

  // ── (d) TAP FLOOR, with every group open and one row expanded.
  censusFloor(at, m, vw, 'with every group open')

  // ── (f) ONE-LINE ROWS. An EMPTY second line is not a wrap: a packet with no supplier, no date and no
  // heat, holding exactly one packet, has nothing left to print there (absent facts are dropped and
  // "1 packet" is not printed) — it is reported below, not failed. A line that HAS text must read as
  // exactly one band of it; text with no measurable band is an instrument fault, and fails too.
  for (const r of m.rows) {
    const L = r.line, L1 = r.line1, TT = r.title
    const name = TT ? TT.text : r.id
    if (L && L.text && (L.ratio > ONE_LINE_RATIO || L.lines !== 1)) fail(`${at}: (f) "${name}": its second line is ${L.h}px against a one-line ${L.oneLineH}px (x${L.ratio}) across ${L.lines} visual line(s) — ${L.lines ? 'it wrapped' : 'it has text and no measurable line'}`)
    if (L1 && (L1.ratio > ONE_LINE_RATIO || L1.lines !== 1)) fail(`${at}: (f) "${name}": its first line is ${L1.h}px against a one-line ${L1.oneLineH}px (x${L1.ratio}) across ${L1.lines} visual line(s) — ${L1.lines ? 'it wrapped' : 'it has no measurable line'}`)
    if (TT && (TT.lines !== 1 || TT.h > ONE_LINE_RATIO * TT.oneLineH)) fail(`${at}: (f) title "${TT.text}" occupies ${TT.lines} line(s), ${TT.h}px against a one-line ${TT.oneLineH}px — it wrapped instead of truncating`)
    if (TT && TT.truncated && !TT.ellipsis) fail(`${at}: (f) title "${TT.text}" is cut off without an ellipsis`)
  }
  // The brief's own words for (f): the long name truncates with an ellipsis instead of wrapping.
  if (!(long.title.truncated && long.title.ellipsis)) fail(`${at}: (f) the 44-character name is not truncated with an ellipsis (truncated ${long.title.truncated}, ellipsis ${long.title.ellipsis}, ${long.title.lines} line(s))`)

  // ── (g) THE AMOUNT, (i) THE ORDINAL, (j) THE SUPPLIER CHIP, (k) THE HEAT — each whole.
  const cutMsg = (X, lineL, lineR) => `${X.w}px wide at x${X.l}-${X.r} in a line spanning x${lineL}-${lineR}${X.cut ? ', ellipsised' : ''}`
  for (const r of m.rows) {
    const L = r.line, L1 = r.line1, name = r.title ? r.title.text : r.id
    if (L && L.amount && (!(L.amount.w > 0) || !L.amount.inLine || L.amount.cut)) fail(`${at}: (g) "${name}": its amount "${L.amount.text}" is cut — ${cutMsg(L.amount, L.lineL, L.lineR)}`)
    if (L1 && L1.ordinal && (!(L1.ordinal.w > 0) || !L1.ordinal.inLine || L1.ordinal.cut)) fail(`${at}: (i) "${name}": its ordinal "${L1.ordinal.text}" is cut — ${cutMsg(L1.ordinal, L1.l, L1.r)}`)
    if (L && L.supplier && (!(L.supplier.w > 0) || !L.supplier.inLine || L.supplier.cut)) fail(`${at}: (j) "${name}": its supplier chip "${L.supplier.text}" is not whole — ${cutMsg(L.supplier, L.lineL, L.lineR)}`)
    if (L && L.heat && (!(L.heat.w > 0) || !L.heat.inLine || L.heat.cut)) fail(`${at}: (k) "${name}": its heat "${L.heat.text}" is not whole — ${cutMsg(L.heat, L.lineL, L.lineR)}`)
  }

  // ── (l) THE THUMBNAIL BOX — before any image has landed.
  const before = thumbBoxes(at, m, 'before any packet image landed')

  // ── The record. Printed on pass as well as fail: the numbers a redesign has to move.
  const lr = m.rows.filter(r => r.line), l1r = m.rows.filter(r => r.line1)
  const tight = (list, pick) => list.filter(pick).sort((a, b) => pick(a) - pick(b))[0]
  const line2Tight = tight(lr, r => r.line.slack), line1Tight = tight(l1r, r => r.line1.slack)
  const emptyLine2 = lr.filter(r => !r.line.text)
  console.log(`${P}: EVERY GROUP OPEN — ${m.rows.length} rows under ${m.mine.headers.length} headers · row heights ${[...new Set(m.rows.filter(r => !r.expanded).map(r => r.h))].join('/')}px · pageH ${m.doc.scrollH}px · doc ${m.doc.scrollW}/${m.doc.clientW}`)
  console.log(`${P}: ${m.taps.length} controls in the census (${censusHeaders} headers, ${m.taps.filter(t => t.supplierChip).length} supplier-row chips, ${censusExpanded} in the expanded row), shortest ${Math.min(...m.taps.filter(t => !isExemptSegmentedRadio(t)).map(t => t.h))}px (floor ${TAP_MIN_HEIGHT_PX}px)`)
  console.log(`${P}: line 2 max x${Math.max(...lr.map(r => r.line.ratio))} / line 1 max x${Math.max(...l1r.map(r => r.line1.ratio))} of one line (limit ${ONE_LINE_RATIO}), ${lr.filter(r => r.line.lines > 1).length + l1r.filter(r => r.line1.lines > 1).length} multi-line · titles truncated ${m.rows.filter(r => r.title && r.title.truncated).length}/${m.rows.length} · [REPORTED] ${emptyLine2.length} row(s) with nothing to print on line 2: ${emptyLine2.map(r => `"${r.title.text}"`).join(', ') || 'none'}`)
  console.log(`${P}: MARGINS — tightest line 2: "${line2Tight ? line2Tight.title.text : '—'}" ${line2Tight ? line2Tight.line.slack : '—'}px between its last never-cut item and the line's end ("${line2Tight ? line2Tight.line.text : ''}") · line 1: the ordinal ends ${line1Tight ? line1Tight.line1.slack : '—'}px before the line's end (the chevron's room; the title gives way, "${line1Tight ? line1Tight.title.text : '—'}" shows ${line1Tight ? line1Tight.title.w : '—'}px of ${line1Tight ? line1Tight.title.inkW : '—'}px)`)
  console.log(`${P}: (j) supplier chips ${Object.entries(chipCount).map(([k, n]) => `${k}×${n}`).join(', ')}, widths ${[...new Set(lr.filter(r => r.line.supplier).map(r => `${r.line.supplier.text} ${r.line.supplier.w}px`))].join(', ')} · (k) heat ${lr.filter(r => r.line.heat).map(r => `"${r.line.heat.text.replace(/^·\s*/, '')}" ${r.line.heat.w}px`).join(', ')} · (i) ordinals ${ordinals.map(r => `"${r.line1.ordinal.text}" ${r.line1.ordinal.w}px beside a ${r.title.w}px title`).join(', ')}`)
  console.log(`${P}: the 44-char row: title ${long.title.w}px column, ink ${long.title.inkW}px, ellipsis ${long.title.ellipsis} · line "${long.line.text}" ${long.line.h}px/${long.line.oneLineH}px, chips [${long.line.chipLabels.join(' | ')}], amount "${long.line.amount.text}" ${long.line.amount.w}px (whole: ${!!(long.line.amount.inLine && !long.line.amount.cut)}), rest ${long.line.restW}px of ${long.line.restInkW}px ink`)
  const gave = lr.filter(r => r.line.chipsCut > 0 || (r.line.restW != null && r.line.restInkW > r.line.restW + 1))
  console.log(`${P}: [REPORTED — gives way by design, the never-cut items asserted whole in (g)(i)(j)(k)] ${gave.length} row(s) whose chips or where-from/how-old are ellipsised at this width: ${gave.map(r => `"${r.title.text}" (${r.line.chipsCut} chip(s) cut, rest ${r.line.restW}px of ${r.line.restInkW}px)`).join('; ') || 'none'}`)

  // ── (l) again — once every packet image has loaded or failed. Released, then the page is scrolled
  // to its end so the image window (24 rows a page) mounts the tail's photos too.
  const heldCount = imageHold.held.length
  await releaseImages()
  const loaded = await evalSettled(`(async () => {
    const t0 = performance.now(); let s = null
    while (performance.now() - t0 < 12000) {
      window.scrollTo(0, document.documentElement.scrollHeight)
      await new Promise(r => setTimeout(r, 120))
      const ph = [...document.querySelectorAll('${tid('my-seed-thumb')} ${tid('my-seed-photo')}')]
      const imgs = ph.filter(p => p.tagName === 'IMG')
      s = { photos: ph.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
        pending: imgs.filter(i => !i.complete).length, broken: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
        placeholders: ph.length - imgs.length,
        shapes: [...new Set(imgs.filter(i => i.naturalWidth > 0).map(i => i.naturalWidth + 'x' + i.naturalHeight))] }
      if (s.photos === ${e.photoRows} && s.pending === 0 && s.broken === 0 && s.placeholders === ${e.brokenPhotos}) return { ok: true, ...s }
    }
    return { ok: false, ...s }
  })()`)
  if (!loaded.ok || loaded.loaded !== e.photoRows - e.brokenPhotos) {
    fail(`${at}: (l) the packet images never settled — ${loaded.photos} photo element(s) (expected ${e.photoRows}), ${loaded.loaded} loaded, ${loaded.pending} still loading, ${loaded.broken} broken <img>, ${loaded.placeholders} placeholder(s) (expected ${e.brokenPhotos}, the broken URL) — the "after images load" half measures nothing`)
  } else {
    const m2 = await evalSettled(MEASURE(v))
    // Non-vacuity: the images that landed are not square, so a box that followed its image would move.
    const shapes = loaded.shapes.map(s => s.split('x').map(Number))
    if (!shapes.some(([w, h]) => h > w) || !shapes.some(([w, h]) => w > h)) fail(`${at}: (l) the loaded packet images are ${loaded.shapes.join(', ')} — a tall and a wide one are needed, or a box that took its image's shape would still read square`)
    const after = thumbBoxes(at, m2, 'after every packet image loaded or failed')
    const byId = new Map(before.map(b => [b.id, b]))
    const drift = after.map(a => { const b = byId.get(a.id); return b ? Math.max(Math.abs(a.w - b.w), Math.abs(a.h - b.h), Math.abs(a.l - b.l)) : Infinity })
    const broken = m2.rows.find(r => r.thumb && r.thumb.photo && !r.thumb.photo.img)
    console.log(`${P}: (l) before: ${before.length} boxes, ${heldCount} packet image request(s) held, every mounted <img> still loading · after: ${loaded.loaded} loaded (${loaded.shapes.join(', ')}), ${loaded.placeholders} placeholder (${broken && broken.title ? `"${broken.title.text}"` : '?'}, box ${broken ? `${broken.thumb.w}x${broken.thumb.h}` : '?'}) · largest per-row change ${R1(Math.max(...drift))}px`)
  }
  await evalSettled('(() => { window.scrollTo(0, 0); return 1 })()')
  await waitSettled('window.scrollY === 0', 3000)
  console.log(`${P}: screenshot ${await shoot(join(OUTDIR, `seeds-page-mine-${vw}x${vh}-all-open.png`))}`)
}

// (l)'s invariant over one measurement; returns the boxes, keyed by row, for the before/after compare.
function thumbBoxes(at, m, when) {
  const out = m.rows.filter(r => r.thumb).map(r => ({ id: r.id, name: r.title ? r.title.text : r.id, stripe: r.stripe, ...r.thumb }))
  const ref = out.find(b => b.stripe >= 2) || out[0]
  for (const b of out) {
    if (Math.abs(b.w - THUMB_PX) > BOX_TOL_PX || Math.abs(b.h - THUMB_PX) > BOX_TOL_PX) fail(`${at}: (l) "${b.name}": its thumbnail box is ${b.w}x${b.h} ${when}, not ${THUMB_PX}x${THUMB_PX}`)
    if (ref && Math.abs(b.l - ref.l) > BOX_TOL_PX) fail(`${at}: (l) "${b.name}" (${b.stripe >= 2 ? 'striped' : 'no stripe'}): its thumbnail starts at x${b.l} ${when}, the rows' is x${ref.l}`)
  }
  const xs = out.map(b => b.l)
  console.log(`[seeds-page] ${at}: (l) ${when}: ${out.length} boxes, ${[...new Set(out.map(b => `${b.w}x${b.h}`))].join('/')}px at x${R1(Math.min(...xs))}-${R1(Math.max(...xs))} (${out.filter(b => b.stripe >= 2).length} striped, ${out.filter(b => b.stripe < 2).length} not)`)
  return out
}

// (d) over one measurement.
function censusFloor(at, m, vw, where = '') {
  const exempt = m.taps.filter(isExemptSegmentedRadio)
  const floored = m.taps.filter(t => !isExemptSegmentedRadio(t))
  const kind = t => (t.tag === 'a' ? 'link' : t.role === 'radio' ? 'radio' : t.role === 'button' && t.tag !== 'button' ? 'role=button' : t.tag)
  const w = where ? ` ${where}` : ''
  for (const t of floored.filter(t => t.h < TAP_MIN_HEIGHT_PX)) fail(`${at}: (d)${w} ${kind(t)} "${t.label}" renders ${t.w}x${t.h}, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
  for (const t of exempt.filter(t => t.h < SEGMENTED_RADIO_MIN_PX)) fail(`${at}: (d)${w} SegmentedControl radio "${t.label}" (${t.group}) renders ${t.w}x${t.h}, under even the primitive's own ${SEGMENTED_RADIO_MIN_PX}px`)
  for (const t of m.taps) {
    if (t.hitIsSelf === false) fail(`${at}: (d)${w} ${kind(t)} "${t.label}" does not hit-test to itself — occluded`)
    if (!t.fitsX) fail(`${at}: (d)${w} ${kind(t)} "${t.label}" sits outside the ${vw}px viewport`)
  }
  return { exempt, floored }
}

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-seedspage-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  cdp.on(onImageRequest)
  if (PROBE_NOTHING) console.log('[seeds-page] --probe-nothing: every selector points at a testid nothing renders. This run MUST fail.')
  if (MUTATE_CSS) console.log(`[seeds-page] MUTATED RUN — GATE_MUTATE_CSS is injected into every view: ${MUTATE_CSS}`)
  if (MUTATE_JS) console.log(`[seeds-page] MUTATED RUN — GATE_MUTATE_JS runs in every view: ${MUTATE_JS}`)
  mkdirSync(OUTDIR, { recursive: true })

  for (const v of VIEWS) {
    for (const [vw, vh] of VIEWPORTS) {
      const at = `${v.view}@${vw}x${vh}`
      await stopImageHold()
      if (v.view === 'mine') await holdImages()
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
      // verdict=0 strips the harness's fixed instrument bar — z-index 99999 over the header, it
      // would make elementFromPoint report the bar and this gate would be measuring its own instrument.
      // `vp` makes every navigation a NEW url: navigating to the url already loaded restores its scroll.
      const url = `http://localhost:${PORT}/tests/harness/seeds.html?view=${v.view}&topbar=${TOP_CHROME_PX}&vp=${vw}x${vh}&verdict=0`
      const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
      await sleep(200)
      await evalSettled(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('harness never reached ready() on view=${v.view}')})()`)
      await evalSettled('new Promise(r=>setTimeout(r,400))')   // let fonts settle
      if (MUTATE_CSS) {
        await evalSettled(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(MUTATE_CSS)}; document.head.appendChild(s); return 1 })()`)
        await evalSettled('new Promise(r=>setTimeout(r,200))')
      }
      if (MUTATE_JS) {
        await evalSettled(`(async () => { ${MUTATE_JS}\n; return 1 })()`)
        await evalSettled('new Promise(r=>setTimeout(r,200))')
      }
      const m = await evalSettled(MEASURE(v))

      // The artifact first, so a view that fails below still leaves its picture behind.
      const shotPath = await shoot(join(OUTDIR, `seeds-page-${v.view}-${vw}x${vh}.png`))

      // ── INSTRUMENT CHECK, before any invariant. A mismatch stops this view: every number below it
      //    would be about the wrong layout, the wrong surface, or nothing at all.
      if (m.vw !== vw || m.vh !== vh) {
        // TWO causes, told apart by the aspect ratio. Mobile Chrome WIDENS the layout viewport to fit a
        // document wider than the device and scales it down, KEEPING the device's aspect (measured: a
        // page forced to 480px at 360x640 self-reports 480x854, and visualViewport.scale still reads 1)
        // — so a sideways overflow arrives here, not at (c). An emulation that did not take reports the
        // OS window instead, whose aspect is unrelated.
        const grewToFit = m.vw > vw && Math.abs(m.vw * vh - m.vh * vw) <= vh
        fail(grewToFit
          ? `${at}: (c) REFUSED — the page is wider than the ${vw}px viewport: mobile Chrome widened the layout viewport to ${m.vw}x${m.vh} to fit a ${m.doc.scrollW}px document and scaled it down, so the page overflows sideways and every other coordinate is from the scaled layout`
          : `${at}: REFUSED — the page self-reports ${m.vw}x${m.vh}; emulation did not take, so every coordinate would be from the wrong layout`)
        continue
      }
      const e = v.expect
      const mismatch = []
      // The first screen is measured at scrollTop 0 or not at all. A same-URL navigation restores the
      // previous scroll (measured: an evidence scroll on one viewport carried into the next one's
      // measurement, radio tops -457), which is why every URL above carries its viewport too.
      if (m.scroll.x !== 0 || m.scroll.y !== 0) mismatch.push(`the page is scrolled to ${m.scroll.x},${m.scroll.y} — the first screen is only measurable at 0,0`)
      if (m.errors.length) mismatch.push(`the page raised ${m.errors.length} error(s) while mounting: ${m.errors.join(' | ')}`)
      if (!m.arrived) mismatch.push(`the ${v.label} body never arrived in the harness`)
      if (m.chrome.top !== TOP_CHROME_PX) mismatch.push(`top-bar stand-in is ${m.chrome.top}px, TopChrome's BAR_H is ${TOP_CHROME_PX}px`)
      if (m.chrome.nav !== BOTTOM_NAV_HEIGHT_PX) mismatch.push(`bottom-nav stand-in is ${m.chrome.nav}px, BOTTOM_NAV_HEIGHT_PX is ${BOTTOM_NAV_HEIGHT_PX}px`)
      if (!m.surface.page) mismatch.push('no Seeds page in the document')
      if (m.surface.radios !== 3) mismatch.push(`the view switch has ${m.surface.radios} radios, expected 3`)
      if (m.surface.checked !== v.label) mismatch.push(`the switch reports "${m.surface.checked}" as checked, expected "${v.label}" — ?view=${v.view} did not resolve`)
      if (m.surface.h1 !== 'Seeds') mismatch.push(`the page title reads "${m.surface.h1}", expected "Seeds"`)
      if (!m.surface.body) mismatch.push(`the ${v.label} view body (${v.body}) is not mounted`)
      if (m.surface.viewError) mismatch.push(`the ${v.label} view rendered its error fallback`)
      if (!m.ferment) mismatch.push('no ferment line — the fixture carries a lot 5 days into its ferment, so the line under the switch must show')
      else if (m.ferment.level !== 'alarm') mismatch.push(`the ferment line is at level "${m.ferment.level}", the fixture's day-5 lot is "alarm"`)
      if (m.header && m.header.actions.length !== e.actions) mismatch.push(`${m.header.actions.length} header action(s), expected ${e.actions}`)
      if (v.view === 'mine') {
        const M = m.mine
        if (!M) mismatch.push('no My seeds view body to measure')
        else {
          const crop = M.headers.filter(h => !h.sowed), sowed = M.headers.filter(h => h.sowed)
          if (crop.length !== e.cropHeaders) mismatch.push(`${crop.length} crop group header(s), expected ${e.cropHeaders} (the fixture's eight crops)`)
          if (sowed.length !== e.sowedHeaders) mismatch.push(`${sowed.length} "Sowed previously" header(s), expected ${e.sowedHeaders} (the used-up packet)`)
          if (!M.search) mismatch.push('no search line')
          const pinned = (row) => (row ? row.buttons.filter(b => b.pressed != null).map(b => b.label) : [])
          if (pinned(M.crops).join('|') !== e.pinnedCrops.join('|')) mismatch.push(`the crop chip row shows [${pinned(M.crops).join(', ')}], expected the pinned [${e.pinnedCrops.join(', ')}] — the two most-counted fixture crops`)
          if (pinned(M.suppliers).join('|') !== e.pinnedSuppliers.join('|')) mismatch.push(`the supplier chip row shows [${pinned(M.suppliers).join(', ')}], expected the pinned [${e.pinnedSuppliers.join(', ')}] — the two most-counted fixture suppliers`)
          if (!M.expandAll || M.expandAll.label !== 'Expand all') mismatch.push(`no "Expand all" on the question line (${M.expandAll ? `"${M.expandAll.label}"` : 'absent'})`)
          // (d)'s non-vacuity on the folded screen: the census must meet every header and the new controls.
          const censusHeaders = m.taps.filter(t => t.header).length
          if (censusHeaders !== e.cropHeaders + e.sowedHeaders) mismatch.push(`the tap census met ${censusHeaders} header(s), expected ${e.cropHeaders + e.sowedHeaders}`)
          if (m.taps.filter(t => t.supplierChip).length < e.pinnedSuppliers.length + 1) mismatch.push(`the tap census met ${m.taps.filter(t => t.supplierChip).length} supplier-row control(s), expected the ${e.pinnedSuppliers.length} pinned chips and More`)
          if (m.taps.filter(t => t.expandAll).length !== 1) mismatch.push('the tap census did not meet Expand all')
        }
      }
      if (v.view === 'saved') {
        if (m.cards !== e.cards) mismatch.push(`${m.cards} seed-lot cards, expected ${e.cards}`)
        if (m.sections !== e.sections) mismatch.push(`${m.sections} stage sections, expected ${e.sections}`)
      }
      if (v.view === 'sow') {
        if (!m.sow || m.sow.buttons < e.minSowButtons) mismatch.push(`${m.sow ? m.sow.buttons : 0} buttons in Sow now, expected >=${e.minSowButtons} (the date-independent cards and toggles alone)`)
        if (!m.sow || m.sow.headings < e.minSowHeadings) mismatch.push(`${m.sow ? m.sow.headings : 0} open Sow now sections, expected >=${e.minSowHeadings} (Needs a sow profile, Still in process)`)
        // Non-vacuity for (h): the widest action pair must be on screen, or (h) measures only the easy cards.
        if (!m.sow || !m.sow.cards.some(c => c.hasProfileBtn)) mismatch.push('no open Sow now card carries "Add sow details" — (h) would never meet the action pair that squeezed the name')
      }
      if (mismatch.length) {
        // A selector that matched nothing is a FAILURE, never a quiet pass. If the page was
        // redesigned, tests/harness/seeds.jsx and VIEWS here move together.
        fail(`${at}: the harness did not produce what this gate measures — ${mismatch.join('; ')}`)
        continue
      }
      // The zero-box detector: an unrendered (or jsdom-shaped) document hands back real elements
      // whose every box is 0x0, and every floor below would then be vacuously met.
      const heights = m.taps.map(t => t.h).concat(m.rows.map(r => r.h))
      if (!heights.length) { fail(`${at}: no boxes measured at all`); continue }
      if (heights.every(h => h === 0)) { fail(`${at}: every one of ${heights.length} measured boxes is 0px tall — an unrendered document, not a passing layout`); continue }

      // ── (a) THE VIEW SWITCH IS ONE LINE.
      const spread = Math.round((Math.max(...m.sw.tops) - Math.min(...m.sw.tops)) * 10) / 10
      if (spread > SAME_TOP_PX) fail(`${at}: (a) the view switch wraps — its radios' tops span ${spread}px (${m.sw.tops.join('/')}), over ${SAME_TOP_PX}px`)
      if (m.sw.overflow) fail(`${at}: (a) the view switch overflows its own box`)
      if (m.sw.l < -0.5 || m.sw.r > vw + 0.5) fail(`${at}: (a) the view switch spans x${m.sw.l}-${m.sw.r}, outside the ${vw}px viewport`)

      // ── (b) THE HEADER IS ONE LINE.
      const H = m.header
      const titleMid = (H.title.t + H.title.b) / 2
      for (const a of H.actions) {
        const mid = (a.t + a.b) / 2
        if (Math.abs(mid - titleMid) > SAME_TOP_PX) fail(`${at}: (b) header action "${a.label}" is not on the title's line — centres ${Math.round(mid)} vs ${Math.round(titleMid)}`)
        if (a.l < H.title.r - 0.5) fail(`${at}: (b) header action "${a.label}" (x${a.l}) overlaps the title (ends x${H.title.r})`)
        if (a.r > H.r + 0.5) fail(`${at}: (b) header action "${a.label}" runs past the header (x${a.r} > ${H.r})`)
      }
      if (H.actions.length > 1) {
        const aSpread = Math.max(...H.actions.map(a => a.t)) - Math.min(...H.actions.map(a => a.t))
        if (aSpread > SAME_TOP_PX) fail(`${at}: (b) the header actions do not share a row — tops span ${Math.round(aSpread)}px`)
      }
      if (H.overflow) fail(`${at}: (b) the header overflows its own box`)
      if (H.slotOverflow) fail(`${at}: (b) the header's action slot overflows its own box`)
      if (H.title.clipped) fail(`${at}: (b) the page title is clipped`)

      // ── (c) NO SIDEWAYS SCROLL.
      if (m.doc.scrollW > m.doc.clientW) fail(`${at}: (c) document scrollWidth ${m.doc.scrollW} > clientWidth ${m.doc.clientW} — the page scrolls sideways`)

      // ── (d) TAP FLOOR — census; ONE named exemption.
      const { exempt, floored } = censusFloor(at, m, vw)

      // ── (e) THE FIRST SCREEN — folded.
      let firstScreen = ''
      if (v.view === 'mine') {
        const M = m.mine, band = { t: m.chrome.bandTop, b: m.chrome.bandBottom }
        const inBand = b => b.t >= band.t - 0.5 && b.b <= band.b + 0.5
        for (const [what, b] of [['the search line', M.search], ['the crop chip row', M.crops], ['the supplier chip row', M.suppliers]]) {
          if (!inBand(b)) fail(`${at}: (e) ${what} spans y${b.t}-${b.b}, not fully inside the visible band y${band.t}-${band.b}`)
        }
        // Each chip row's MARGIN: from its last chip's right edge to the row's own right edge — what
        // CI's wider fonts spend before the row wraps to a second 48px line.
        const rowSpread = {}, rowSlack = {}
        for (const [what, row] of [['crop', M.crops], ['supplier', M.suppliers]]) {
          const tops = row.buttons.map(c => c.t)
          rowSpread[what] = R1(Math.max(...tops) - Math.min(...tops))
          rowSlack[what] = R1(row.r - Math.max(...row.buttons.map(c => c.r)))
          if (rowSpread[what] > SAME_TOP_PX) fail(`${at}: (e) the ${what} chip row is not one line — its chips' tops span ${rowSpread[what]}px (${row.buttons.map(c => `"${c.label}" y${c.t}`).join(', ')})`)
        }
        const open = M.headers.filter(h => h.expanded !== 'false')
        if (open.length) fail(`${at}: (e) ${open.length} header(s) are not folded on a fresh session: ${open.map(h => `"${h.label}" aria-expanded=${h.expanded}`).join(', ')} — My seeds starts folded`)
        const rowsInBand = m.rows.filter(r => r.touchesBand)
        if (rowsInBand.length) fail(`${at}: (e) ${rowsInBand.length} seed row(s) are in the visible band on a fresh session (the first at y${rowsInBand[0].t}-${rowsInBand[0].b}) — the first screen is the overview`)
        const firstTwo = M.headers.slice(0, 2).map(h => h.label)
        const pinned = M.crops.buttons.filter(b => b.pressed != null).map(b => b.label)
        if (firstTwo.join('|') !== pinned.slice(0, 2).join('|')) fail(`${at}: (e) the first two headers are [${firstTwo.join(', ')}], but the crops pinned in the chip row are [${pinned.join(', ')}] — pinned crops lead the list`)
        const headersIn = M.headers.filter(inBand)
        const at360 = v.view === FIRST_SCREEN.view && vw === FIRST_SCREEN.vw && vh === FIRST_SCREEN.vh
        const next = M.headers.find(h => !inBand(h))
        if (at360 && headersIn.length < FIRST_SCREEN.minHeaders) fail(`${at}: (e) only ${headersIn.length} header(s) fully in the visible band y${band.t}-${band.b}, need >=${FIRST_SCREEN.minHeaders} — the first header starts at y${M.headers[0] ? M.headers[0].t : '?'}`)
        const lastIn = headersIn[headersIn.length - 1]
        firstScreen = `(e) FOLDED FIRST SCREEN — search line y${M.search.t}-${M.search.b}, crop chips y${M.crops.t}-${M.crops.b} (${M.crops.buttons.map(c => `"${c.label}"`).join(' ')} on one line, spread ${rowSpread.crop}px, ${rowSlack.crop}px to spare), supplier chips y${M.suppliers.t}-${M.suppliers.b} (${M.suppliers.buttons.map(c => `"${c.label}"`).join(' ')}, spread ${rowSpread.supplier}px, ${rowSlack.supplier}px to spare) · ${headersIn.length} of ${M.headers.length} headers fully in the band y${band.t}-${band.b}${at360 ? ` (need >=${FIRST_SCREEN.minHeaders})` : ' [PRINTED, not asserted]'}: ${headersIn.map(h => `${h.label} y${h.t}-${h.b}`).join(', ')}${lastIn ? ` (the last ${R1(band.b - lastIn.b)}px above the nav)` : ''}${next ? `; next "${next.label}" at y${next.t} (${R1(band.b - next.t)}px of it above the nav)` : ''} · ${m.rows.length} rows rendered, ${rowsInBand.length} in the band`
      }

      // ── (h) SOW NOW NAMES ARE NOT SQUEEZED.
      if (m.sow) {
        for (const c of m.sow.cards) {
          if (!(c.colW >= SOW_TITLE_COL_MIN_PX - 0.5)) fail(`${at}: (h) Sow now card "${c.title}": its title column is ${c.colW}px, under SowNow.jsx's TITLE_COL_MIN_PX ${SOW_TITLE_COL_MIN_PX}px — the actions squeezed the name onto ${c.titleLines} line(s)`)
        }
      }

      // ── The record. Printed on pass as well as fail: the numbers a redesign has to move.
      const P = `[seeds-page] ${at}`
      const minFloored = floored.length ? Math.min(...floored.map(t => t.h)) : 0
      console.log(`${P}: switch ${m.sw.w}px wide at x${m.sw.l}-${m.sw.r}, radio tops ${m.sw.tops.join('/')} (spread ${spread}px) · header ${H.w}px: title ${H.title.w}px + actions ${H.actions.map(a => `"${a.label}" ${a.w}px`).join(', ') || 'none'} · doc ${m.doc.scrollW}/${m.doc.clientW} · pageH ${m.doc.scrollH}px`)
      console.log(`${P}: ${m.taps.length} controls, shortest floored ${minFloored}px (floor ${TAP_MIN_HEIGHT_PX}px) · NAMED EXEMPTION ${exempt.length} SegmentedControl radio(s) at ${[...new Set(exempt.map(t => t.h))].join('/')}px (floor ${SEGMENTED_RADIO_MIN_PX}px): ${[...new Set(exempt.map(t => t.group))].join(', ')}${exempt.length && exempt.every(t => t.h >= TAP_MIN_HEIGHT_PX) ? ' — INERT, every one clears the real floor: delete it' : ''}`)
      console.log(`${P}: ferment line ${m.ferment.h}px, ${m.ferment.lines} line(s): "${m.ferment.text}"`)
      if (firstScreen) console.log(`${P}: ${firstScreen}`)
      if (v.view === 'saved') console.log(`${P}: ${m.cards} lot cards in ${m.sections} stage sections`)
      if (v.view === 'sow') {
        const squeezed = m.sow.cards.filter(c => c.titleLines > 2)
        console.log(`${P}: ${m.sow.buttons} buttons, ${m.sow.headings} open sections, ${m.sow.cards.length} open cards · (h) title column widths ${m.sow.cards.map(c => c.colW).join('/')}px (floor ${SOW_TITLE_COL_MIN_PX}px); [REPORTED] ${squeezed.length} card title(s) over 2 lines: ${squeezed.map(c => `"${c.title}" ${c.titleLines}L in ${c.colW}px`).join('; ') || 'none'}`)
      }
      console.log(`${P}: seed-row fetches ${m.hits['seed-rows'] ?? 0} · screenshot ${shotPath}`)

      // My seeds' two opened states — AFTER every first-screen number above was read, since a tap
      // moves the first screen (e) is about.
      if (v.view === 'mine') {
        await pepperOpened(at, vw, vh, m)
        await allOpened(v, at, vw, vh)
      }

      // EVIDENCE for the below-the-fold findings the record reports, captured last — scrolling moves
      // the first screen. The 44-char row on My seeds (every group is open by now); on Sow now, the
      // card whose title column the action column squeezes hardest.
      const evidence = v.view === 'mine'
        ? `(${rowByTitle(LONG_NAME)})`
        : v.view === 'sow'
          ? `(() => { const b = document.querySelector('[data-testid="sow-now-view"] button[aria-label="Add sow details for Red Mustard (heirloom, unspecified variety)"]'); return b && b.parentElement && b.parentElement.parentElement })()`
          : null
      if (evidence && await evalSettled(`(() => { const el = ${evidence}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)) {
        await evalSettled('new Promise(r=>setTimeout(r,250))')
        const extraPath = await shoot(join(OUTDIR, `seeds-page-${v.view}-${vw}x${vh}-${v.view === 'mine' ? 'longrow' : 'squeezed'}.png`))
        console.log(`${P}: evidence screenshot ${extraPath}`)
      }
    }
  }
  await stopImageHold()
} catch (err) {
  fail(`gate could not complete: ${err.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner says
// which one happened. An arm that exited 0 on a deliberately-broken instrument would report a KILL as
// a SURVIVAL the day someone wires it into CI.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[seeds-page] FAIL — EXPECTED. --probe-nothing pointed every selector at a testid nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[seeds-page] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[seeds-page] FAIL — and this one is the real defect: every selector pointed at a testid that does not exist and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[seeds-page] PASS')
