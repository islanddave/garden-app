#!/usr/bin/env node
// today-shape.mjs — the Today page's first instrument that can see what a redesign changes.
//
//   node scripts/layout-gate/today-shape.mjs                  # npm run gate:today-shape
//   node scripts/layout-gate/today-shape.mjs --probe-nothing  # prove the instrument fires
//   node scripts/layout-gate/today-shape.mjs --record         # rewrite the budget from this run
//
// THE MEASURED FACT THIS EXISTS FOR. Adding `style={{height:0,overflow:'hidden'}}` to
// `src/components/today/CareNeeded.jsx:202` — the panel holding the entire 70-row care list, 73.2%
// of the page — leaves 9,239 unit tests passing and 0 failing. `display:none` on the IDENTICAL line
// kills 18. jsdom has no layout engine, so the suite can see "removed from the DOM" and cannot see
// "present, mounted, queryable, accessible, and occupying no space." Every density/collapse
// redesign of this page lands in exactly the second shape. Reproduced twice by the crucible boss and
// re-provable on demand: `node scripts/mutate-today-shape-check.mjs`.
//
// WHAT IT ASSERTS, in real Chrome at a TRUE 390x844, across four states of the real Today page:
//   (a) INSTRUMENT — before any invariant. Self-reported viewport, harness ready(), pinned clock in
//       force, weather stubbed, every fixture non-empty, and the region census matching the counts
//       the fixture promises. Each of these is a way this file could print PASS while measuring
//       nothing.
//   (b) VISIBILITY, per care row — `checkVisibility()` AND `getBoundingClientRect().height > 0`.
//       This is the assertion that kills clipRowPanel and that no vitest test can make.
//   (c) FLOOR AND CEILING, in that order. `careRowCount === expected` and `scrollHeight > floor`
//       come FIRST; the ceiling comes after. A density gate that only caps height rewards deleting
//       content, and an empty page scores best on every metric such a gate checks.
//   (d) ORDERED CENSUS, by VISUAL position — each region's measured `top`, sorted. The repo's only
//       composition-order lock (`compareDocumentPosition`) is DOM order, which a CSS reorder
//       (`order:`, `flex-direction: column-reverse`, `position:absolute`) passes unchanged; and it
//       compares against the `noplan` empty state, so the has-plan order is asserted by no test at
//       all. Mutant `reorderStack` is the proof that this half is load-bearing.
//   (e) NO HORIZONTAL OVERFLOW — `scrollWidth === innerWidth`, document and per region.
//
// THE REFUSALS ARE THE BEST PART, and they are carried forward verbatim from the instrument this
// promotes (tests/harness/_todaymeasure/drive.mjs): if the page does not self-report
// `innerWidth === 390`, every coordinate after that is from the wrong layout and the run is VOID,
// not failed-and-informative. macOS Chrome floors an OS window at ~500px, so `--window-size=390`
// silently lays the page out at 500 and crops the capture — a plausible-looking mobile screenshot of
// a desktop-width layout. Geometry comes from Emulation.setDeviceMetricsOverride.
//
// VIEWPORT, STATED HONESTLY. 390x844 is an iPhone preset. Dave is Android-only and the only device
// width the repo records is 412px (auto-memory `dave-android-only`, BOSS-PASS §4.8), so the TARGET
// viewport is an open question this gate does not answer — it pins the width the existing evidence
// base was measured at, so the baseline and the crucible describe the same page. Re-pointing it is
// one edit to VIEWPORT below plus one `--record`; the refusal reads the constant, not a literal.
//
// SCOPE. This measures the Today page MOUNTED ALONE, which is what the harness renders. Production
// adds a 52px in-flow sticky TopChrome and a 56px fixed BottomNav (App.jsx), so the real document is
// ~108px taller and only 736px of the 844px window ever shows page content. Those two constants are
// asserted below so a nav-height change invalidates the budget loudly instead of silently.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// 5319 / 9430: 5311-5318 and 9422-9429 are taken by the sibling gates, and a harness that silently
// attaches to a sibling's server measures a sibling's page.
const PORT = Number(process.env.GATE_HARNESS_PORT || 5319)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9430)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const BUDGET_PATH = join(ROOT, 'tests/harness/_todaymeasure/today-shape-budget.json')

// The width the refusal enforces and the width the budget was recorded at — one constant, read by
// both, so they cannot drift apart.
//
// TARGET DEVICE. This is not a neutral default: a layout gate measures at ONE width, and a defect
// measured at the wrong one can simply not exist on the device it is supposed to describe — the
// four bulk pills wrap onto four lines at 358px of content and sit on two at 380px. The number
// below must track the phone Dave actually uses. It is env-overridable so a correction is a config
// change plus a `--record`, never a code edit, and so CI can pin it explicitly.
//
// A spec sheet is NOT sufficient to set this: Android's system "Display size" setting changes the
// effective CSS width on identical hardware. The authority is the device, which is why the app's
// Debug & smoke panel now reports "Viewport (CSS px)" live — More → Debug & smoke.
//
// ── OPEN, AND DELIBERATELY NOT GUESSED ───────────────────────────────────────────────────────────
// 390x844 is the iPhone 12/13/14 CDP preset. Dave is Android-only, so this is the WRONG TARGET and
// is known to be. It is still the value here, on purpose:
//   · every number in the budget, and every measurement in the Today crucible, was taken at 390 —
//     so 390 is at least self-consistent with the analysis it supports;
//   · the defects this gate exists to catch — a clipped row panel, a CSS reorder, a deleted region —
//     are width-ROBUST and are caught at any width;
//   · what is width-SENSITIVE is design work (does the bulk-pill block wrap? does the group title
//     truncate?), and that is the thing which must not be designed against the wrong number.
// Researched 2026-09-08 for Dave's stated device, a Pixel 10 Pro: Playwright's device registry
// carries an explicit entry at 427x876 @DPR3, Chrome DevTools has NO preset for it, and two
// lower-quality sources say 410 and 412. That is ~80% confidence on a DERIVED figure nobody has read
// off a physical handset — and Display size can move it anywhere from ~320 to ~502. Hardcoding it
// would replace a known-wrong number with a probably-wrong one, and the budget/viewport check below
// cannot save us there: it catches a gate and budget that DISAGREE, not a gate and budget that are
// consistently wrong together.
// TO CLOSE IT: read "Viewport (CSS px)" from More → Debug & smoke on the phone, then
//   GATE_VIEWPORT_W=<w> GATE_VIEWPORT_H=<h> npm run gate:today-shape:record
// and set the defaults above to match. One command, and the width-sensitive findings can then be
// re-measured. Until then, treat every width-sensitive conclusion from this gate as provisional.
const VIEWPORT = {
  w: Number(process.env.GATE_VIEWPORT_W || 390),
  h: Number(process.env.GATE_VIEWPORT_H || 844),
}
// Read from source, not spelled here, in the same spirit as the tap-floor gates: a gate carrying its
// own copy of a constant is a gate that keeps passing after someone changes the real one. These two
// are what turn a harness scroll-height into a production one.
const CHROME_CONST = { barH: 52, bottomNav: 56 }

const RECORD = process.argv.includes('--record')
// THE INSTRUMENT SELF-TEST. Every region selector gains a suffix nothing renders, so no census count
// can be met and the run MUST exit 1 on "matched 0 elements" rather than sailing through on
// vacuously-true invariants. Same idiom, same exit-code discipline, as gate:seeds-saved and
// gate:putup — a third pattern here would be a third thing to keep true.
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`

// ── THE REGION CONTRACT ─────────────────────────────────────────────────────────────────────────
// One row per region of the Today page, keyed by the anchor `data-testid` threaded through
// src/pages/Today.jsx and src/components/today/CareNeeded.jsx (added by V5-TODAYSHAPE-001; they add
// no node, no style, no behaviour). A redesign is expected to carry these forward — dropping one is
// a gate failure BY DESIGN, which is what forces a redesign to declare which region it deleted
// rather than have it disappear into a smaller scroll-height that reads as a win.
//
// `minH` is a per-region FLOOR in px. It is the second, independent killer for every region: a
// region that is present-but-clipped satisfies the count and fails the height, and a region that is
// deleted fails the count. They die to different defects, which is what "independent" has to mean
// here (item 10 of the verification spec).
const REGIONS = [
  { id: 'today-title', label: 'the h1 "Today"' },
  { id: 'today-date', label: 'the date subtitle' },
  { id: 'today-weather', label: 'WeatherWidget' },
  { id: 'today-substrate-note', label: 'the substrate/feeding note' },
  { id: 'today-basis-stamp', label: 'the "Plan from overnight" stamp' },
  { id: 'today-care', label: 'CareNeeded' },
  { id: 'today-watch-band', label: 'HarvestWatchBand' },
  { id: 'compose-harvest-band', label: 'ComposeHarvestBand' },
  { id: 'cultivation-lead', label: 'CultivationLead' },
  { id: 'today-household', label: 'the household toggle' },
  { id: 'today-noplan-card', label: 'the "first daily plan" empty state' },
  { id: 'care-heading', label: 'the "Needs care today" heading' },
  { id: 'care-bulk-chips', label: 'the bulk-action chip block' },
  { id: 'care-rain-note', label: 'the rain-skipped note' },
  { id: 'care-dormant', label: 'the Dormant block' },
  { id: 'care-empty', label: 'the "All caught up" empty state' },
]

const failures = []
const fail = m => failures.push(m)

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  const config = process.env.GATE_HARNESS_CONFIG || 'tests/harness/vite.harness.config.mjs'
  // Spawned through vite's own bin, NOT `npx vite`: npx is a wrapper, so killing it at teardown
  // orphans the real server and hangs any caller that pipes this script's stdout.
  const proc = spawn(process.execPath, [bin, '--config', config, '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  // The mutation proof's `[MUTANT APPLIED]` marker is written by an in-memory vite plugin, so it
  // lands on the CHILD's stderr and would otherwise die in this buffer. Forwarding it is not
  // cosmetic: the runner reads it to tell "the gate went red because the mutant applied" from "the
  // gate went red for some unrelated reason and the mutant never ran", and those are opposite facts.
  const forward = d => { log += d; for (const line of String(d).split('\n')) if (line.includes('[MUTANT APPLIED]')) console.error(line) }
  proc.stdout.on('data', forward)
  proc.stderr.on('data', forward)
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/tests/harness/todaymeasure.html`); if (r.ok) return proc } catch { /* not listening yet */ }
    if (proc.exitCode != null) throw new Error(`harness vite exited (${proc.exitCode}):\n${log}`)
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`harness vite never served :${PORT} within 40s:\n${log}`)
}

async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation, so the
    // window only has to be big enough not to clip it.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
    // A DEAD CHROME IS NOT A SLOW CHROME: one wants a re-run, the other wants a missing library
    // found. Collapsing them costs a CI cycle every time.
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} (code=${proc.exitCode} signal=${proc.signalCode}) — a dead browser, not a slow one; re-running will not help`)
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return { proc, version: await r.json() } } catch { /* not up */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT} within ${CDP_WAIT_TRIES * 250}ms`)
}

async function attach(wsUrl) {
  const WS = await resolveWebSocket()   // CI pins node 20.19.0, which has no global WebSocket
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 120000)
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
  return { ws, send, sessionId, evalIn }
}

// ── The measurement, evaluated in the page itself ────────────────────────────────────────────────
const MEASURE = `(() => {
  const d = document, w = window, de = d.documentElement
  const sy = w.scrollY
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: Math.round(r.top + sy), b: Math.round(r.bottom + sy), l: Math.round(r.left), r: Math.round(r.right),
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } }
  // checkVisibility(), not offsetParent: a collapsed <details>, a zero-opacity ancestor or a
  // content-visibility:hidden subtree all report an offsetParent and read as visible through it.
  // Paired with a non-zero rect because checkVisibility() alone returns true for a height:0 box —
  // which is the exact mutant this gate exists to catch.
  const shown = el => (!el.checkVisibility || el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) && el.getBoundingClientRect().height > 0
  const all = sel => [...d.querySelectorAll(sel)]

  const regions = ${JSON.stringify(REGIONS)}.map(reg => {
    const els = all('[data-testid="' + reg.id + '${SUFFIX}"]')
    return {
      id: reg.id, label: reg.label, count: els.length,
      boxes: els.map(el => { const r = box(el); return {
        ...r, visible: shown(el),
        overflowsX: el.scrollWidth > el.clientWidth + 1,
        display: w.getComputedStyle(el).display,
      } }),
    }
  })

  // Every care row, individually. 70 of them on the busy state; the assertion that kills
  // clipRowPanel is made per row, not on the list container, because a container can be non-zero
  // while its children are clipped and vice versa.
  const rows = all('${tid('care-row')}').map((el, i) => {
    const r = box(el)
    return { i, h: r.h, w: r.w, t: r.t, visible: shown(el),
             text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 34) }
  })
  const panels = all('${tid('care-group-panel')}').map(el => { const r = box(el); return { h: r.h, visible: shown(el), children: el.children.length } })
  const groups = all('${tid('care-group')}').map(el => box(el).h)

  // INK — the whitespace instrument, carried over verbatim from the recorder. A row is ink if any
  // visible text run (from Range.getClientRects, i.e. the real glyph boxes, not element boxes),
  // image, svg or form control paints on it, so normal line-leading is correctly NOT counted as
  // waste. This is the density number a redesign moves, and the one an empty page maximises — hence
  // the floors above it.
  const H = Math.ceil(de.scrollHeight)
  const ink = new Uint8Array(H)
  const mark = (top, bottom) => { for (let y = Math.max(0, Math.floor(top)); y < Math.min(H, Math.ceil(bottom)); y++) ink[y] = 1 }
  const tw = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = tw.nextNode())) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue
    const cs = n.parentElement && w.getComputedStyle(n.parentElement)
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0')) continue
    const range = d.createRange(); range.selectNodeContents(n)
    for (const rc of range.getClientRects()) if (rc.width > 0.5 && rc.height > 0.5) mark(rc.top + sy, rc.bottom + sy)
  }
  for (const el of d.querySelectorAll('img,svg,canvas,video,input,select,textarea')) {
    const rc = el.getBoundingClientRect()
    if (rc.width > 0.5 && rc.height > 0.5) mark(rc.top + sy, rc.bottom + sy)
  }
  let inkPx = 0
  let lastInk = -1
  for (let y = 0; y < H; y++) if (ink[y]) { inkPx++; lastInk = y }

  const controls = all('button, a[href], [role="button"], summary, input, select, textarea').filter(shown)
  const firstControl = controls.reduce((lo, el) => { const t = box(el).t; return (lo == null || t < lo) ? t : lo }, null)

  return {
    vw: w.innerWidth, vh: w.innerHeight, dpr: w.devicePixelRatio,
    scrollHeight: H, scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
    // CONTENT BOTTOM — the y of the LAST row on which anything paints. Not the same number as
    // scrollHeight and not redundant with it: a document is never shorter than the viewport, so on
    // the quiet and noplan states (both exactly 844px) a scroll-height floor is VACUOUS — it is
    // satisfied by a completely blank page. This is the selector-free floor that still bites there.
    contentBottom: lastInk,
    inkPx, inkPct: H ? Math.round((inkPx / H) * 1000) / 10 : 0,
    controls: controls.length, firstControlY: firstControl,
    regions, rows, panels, groups,
    harness: {
      state: w.__h.state(), error: w.__h.error(), clock: w.__h.clock(),
      weatherStubbed: w.__h.weatherStubbed(), fixtures: w.__h.fixtures(),
      requests: w.__h.requests().length,
      // The OBSERVED counterpart to weatherStubbed's declared intent — see todaymeasure.jsx's
      // passthrough arm. Any third-party URL that reached the real network lands here.
      liveRequests: w.__h.requests().filter(r => r.live).map(r => r.path),
    },
  }
})()`

const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i
async function evalSettled(expr, tries = 25) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await cdp.evalIn(expr) } catch (err) {
      // Retried ONLY on the transport race a navigation opens. A gate that swallows page errors as
      // retryable reports a broken page as a slow one.
      if (!CONTEXT_LOST.test(err.message)) throw err
      last = err
      await sleep(200)
    }
  }
  throw new Error(`page never held still long enough to evaluate: ${last?.message}`)
}

// ── budget ───────────────────────────────────────────────────────────────────────────────────────
let budget
try { budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) } catch (e) {
  if (!RECORD) { console.error(`[today-shape] FAIL — no budget at ${BUDGET_PATH} (${e.message}). Run with --record on a known-good tree to capture one.`); process.exit(1) }
  budget = { viewport: VIEWPORT, chrome: CHROME_CONST, states: {} }
}
// WIDTH BINDING. Every floor, ceiling, region top and row height in the budget is a reading taken
// at one specific viewport, so comparing them against a run at a different width is not a stricter
// test or a looser one — it is a meaningless one. Without this check, changing VIEWPORT (or setting
// GATE_VIEWPORT_W) silently re-points every assertion at a baseline that describes a different
// layout, and the gate would report the resulting mismatches as page regressions. Refusing here is
// what makes the width safe to change: the failure names the fix, and `--record` is the fix.
// Skipped under --record, which is precisely the operation that adopts a new width.
if (!RECORD && budget.viewport && (budget.viewport.w !== VIEWPORT.w || budget.viewport.h !== VIEWPORT.h)) {
  console.error(`[today-shape] FAIL — budget/viewport mismatch: this budget was recorded at ${budget.viewport.w}x${budget.viewport.h}, the gate is running at ${VIEWPORT.w}x${VIEWPORT.h}. Every recorded number is width-specific, so none of them describe this run. Re-record at the new width (npm run gate:today-shape:record) or unset GATE_VIEWPORT_W/H.`)
  process.exit(1)
}

const STATES = Object.keys(budget.states || {}).length && !RECORD
  ? Object.keys(budget.states)
  : (process.env.TODAY_SHAPE_STATES || 'busyfull,busy,quiet,noplan').split(',').filter(Boolean)

const recorded = {}
let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-todayshape-'))
try {
  // STEP 0, BEFORE A BROWSER IS EVEN STARTED: the fixture preflight. It costs ~200ms and it is the
  // only check here whose failure cannot be undone by a later commit.
  const pre = spawn(process.execPath, [join(ROOT, 'scripts/layout-gate/todayshape-fixture-preflight.mjs')], { cwd: ROOT, stdio: 'inherit' })
  const preCode = await new Promise(res => pre.on('exit', res))
  if (preCode !== 0) throw new Error('fixture preflight refused the tracked fixtures (see above) — nothing measured')

  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[today-shape] --probe-nothing: every region selector points at a testid nothing renders. This run MUST fail.')

  for (const state of STATES) {
    const at = `${state}@${VIEWPORT.w}x${VIEWPORT.h}`
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
    // TZ and locale are pinned at the browser, not in the page: the clock shim moves the epoch but
    // `toLocaleDateString` and the "as of 5:30 AM" stamp are rendered in the HOST timezone, so a
    // UTC CI runner and a New York laptop would otherwise disagree by four hours of copy — and a
    // different string is a different wrap is a different height.
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }, cdp.sessionId)
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }, cdp.sessionId)
    const url = `http://localhost:${PORT}/tests/harness/todaymeasure.html?state=${state}&badge=0`
    const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
    await sleep(200)
    await evalSettled(`(async()=>{for(let i=0;i<250;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('Today never rendered (${state})')})()`)
    await evalSettled(`new Promise(r=>setTimeout(r,2500))`)   // self-fetching bands + fonts settle
    const m = await evalSettled(MEASURE)

    // ── (a) INSTRUMENT CHECK. Each of these is a way this file prints PASS having measured nothing.
    if (m.vw !== VIEWPORT.w || m.vh !== VIEWPORT.h) {
      // VOID, not merely failed: emulation did not take, so every coordinate below is from a
      // different layout and reporting them as findings would be worse than reporting nothing.
      fail(`${at}: VOID — page self-reports ${m.vw}x${m.vh}. Emulation did not take, so every number in this state is from the wrong layout. (macOS Chrome floors an OS window at ~500px; geometry must come from setDeviceMetricsOverride, never --window-size.)`)
      continue
    }
    if (m.harness.error) fail(`${at}: the page raised "${m.harness.error}" while mounting — measurements taken over a partly-broken render`)
    if (!m.harness.clock.pinned) fail(`${at}: the clock is NOT pinned (${m.harness.clock.now}). Scroll-height and ink-% then drift with the wall clock and this gate becomes flaky by construction.`)
    if (m.harness.clock.tz !== 'America/New_York') fail(`${at}: page timezone is ${m.harness.clock.tz}, expected America/New_York — the date subtitle and the "as of" stamp render different copy, which is a different wrap and a different height`)
    if (!m.harness.weatherStubbed) fail(`${at}: Open-Meteo was NOT stubbed — the rain line is being read from the live network and this budget will drift with the actual weather`)
    // The check above reads a CONFIG FLAG (WX_LIVE); this one reads what actually happened on the
    // wire. They differ exactly when it matters: a moved weather host stops matching the stub arm,
    // falls through the harness passthrough to the real network, and leaves weatherStubbed() saying
    // `true`. Asserted per-URL rather than as a count so the failure names the escaping host.
    // Deliberately NOT written as "the stub must have fired" — a state that legitimately makes no
    // weather call would fail that, and `quiet`/`noplan` may be exactly that state.
    for (const p of (m.harness.liveRequests || [])) fail(`${at}: a third-party request ESCAPED the harness to the live network — ${p}. Determinism is not in force and these numbers drift with whatever that host returned.`)
    // ZERO-BYTE FIXTURE SIBLING of the innerWidth refusal (item 7). A 404 or a truncated dump renders
    // a shorter page that passes every ceiling and scores a perfect ink-%.
    const badFixtures = m.harness.fixtures.filter(f => !f.ok || f.bytes === 0)
    for (const f of badFixtures) fail(`${at}: fixture ${f.name} is unusable (${f.why || 'zero bytes'}) — the page measured below is not the page this gate claims to measure`)
    if (!m.harness.fixtures.length) fail(`${at}: the harness loaded ZERO fixtures`)

    // Under --record the budget comparisons are skipped and the INSTRUMENT checks above are not:
    // re-recording is how a new number is adopted, so comparing against the old one would make it
    // impossible; but recording over a VOID viewport, an unpinned clock, a page that raised while
    // mounting or a missing fixture would bake a lie into the baseline every later run is measured
    // against. That is the split — the instrument must be sound to record, the numbers need not match.
    const b = RECORD ? null : budget.states?.[state]
    if (!b && !RECORD) { fail(`${at}: no budget entry for state '${state}' in ${BUDGET_PATH}`); continue }

    const regionById = Object.fromEntries(m.regions.map(r => [r.id, r]))
    // Set when the region census disagrees with the contract. It gates ONLY the visual-order and
    // region-top checks below, which read per-region data that a broken census makes meaningless.
    // It used to be a `continue` out of the whole state — see the note at the census block.
    let censusBroken = false
    if (b) {
      const mismatch = []
      // BUDGET INTEGRITY, before the budget is used. Every assertion below is generated from the
      // budget file, so DELETING one region's entry silently unguards that region — the same
      // "one careless edit from vacuous" failure the >=2-killers rule exists for, one level up.
      // The gate's own REGIONS list is the contract; the budget must cover all of it.
      const missingFromBudget = REGIONS.map(r => r.id).filter(id => !(id in b.regions))
      if (missingFromBudget.length) mismatch.push(`the budget for this state has no entry for ${missingFromBudget.join(', ')} — those regions are UNGUARDED here, which is not a state this gate may pass in`)

      // FIELD-LEVEL INTEGRITY. The check above catches a deleted region ENTRY; it does not catch an
      // entry that is present but missing the FIELDS the assertions read. Both consumers below are
      // written as a silent skip — `if (b.careRowMinH != null)` and `if (want.top == null) continue`
      // — so a budget recorded by an older gate version disarms the per-row height floor and the
      // rect-ordered position check while every other assertion still passes and the gate reports
      // green. That happened: a budget recorded at 14:22 against a gate rewritten at 14:37 left both
      // dead, which took the reorder class below the >=2-killer bar without a word. A skip is only
      // safe when the thing skipped is genuinely absent, so each field is required exactly where the
      // MEASURED page says it should exist, and nowhere else.
      if (!('careRowMinH' in b)) mismatch.push(`the budget entry predates the per-care-row height floor (no 'careRowMinH' key) — re-record with this gate version; until then a row clamped to a 1px sliver passes`)
      else if (b.careRowMinH == null && m.rows.length > 0) mismatch.push(`the budget records careRowMinH=null but this state measured ${m.rows.length} care rows — the height floor is unarmed for exactly the state that needs it`)
      const topless = REGIONS.map(r => r.id).filter(id => (b.regions[id]?.count > 0) && b.regions[id]?.top == null)
      if (topless.length) mismatch.push(`the budget has region entries for ${topless.join(', ')} with a count but no recorded 'top' — the rect-ordered position check silently skips them, which is the only assertion that can see a pure CSS reorder`)
      // REGION HEADCOUNT — one number that dies to ANY region disappearing. It is the second,
      // independent killer for removal of the small regions (the rain note is 38px; losing it moves
      // scroll-height by less than the 2% band and ink-% by less than a point, so no coarse measure
      // catches it). It cannot be narrowed by deleting a per-region entry the way the loop above can.
      const present = m.regions.filter(r => r.count > 0).length
      if (present !== b.regionsPresent) mismatch.push(`${present} of ${REGIONS.length} regions render in this state, expected exactly ${b.regionsPresent} — a region has appeared or disappeared`)
      for (const [id, want] of Object.entries(b.regions)) {
        const got = regionById[id]
        if (!got) { mismatch.push(`region '${id}' is not in the census at all`); continue }
        if (got.count !== want.count) mismatch.push(`${id} (${got.label}) rendered ${got.count}x, expected ${want.count}x`)
      }
      // (c) THE FLOOR, ASSERTED BEFORE THE CEILING. `careRowCount === expected` is exact, not a
      // minimum: this state's fixture produces exactly this many rows and being told when it stops
      // is the point. A minimum here would let a redesign quietly drop 40 of 70 rows.
      if (m.rows.length !== b.careRowCount) mismatch.push(`${m.rows.length} care rows, expected exactly ${b.careRowCount} — a count that has MOVED is the shape a "denser" redesign takes when it silently drops content`)
      if (m.groups.length !== b.groupCount) mismatch.push(`${m.groups.length} care group cards, expected exactly ${b.groupCount}`)
      // The auto-expand case, pinned as a number. `autoExpandKeys` has an 8-row EXPAND_ROW_BUDGET but
      // the LEAD group always opens even when it alone blows it (careNeeded.js:245-261) — which is
      // why one group of 70 is open and eight are collapsed, and why 55% of this page is one group.
      // Mutant `noLeadExpand` turns that off; without this line the page just gets shorter.
      if (m.panels.length !== b.expandedPanelCount) mismatch.push(`${m.panels.length} EXPANDED group panel(s), expected exactly ${b.expandedPanelCount} — the lead-group auto-expand is the reason this page opens showing rows at all`)
      if (mismatch.length) {
        // A selector that matched nothing is a FAILURE, never a quiet pass. If the page was
        // redesigned, the budget file and the anchors move together, deliberately and visibly.
        //
        // ONE LINE PER MISMATCH, not a joined list. That is not formatting: the mutation runner
        // classifies each failure line into a killer family in order to count INDEPENDENT killers,
        // and a joined line collapses "the region headcount moved" and "this specific region
        // vanished" into one classified hit. Measured — the first full matrix run reported nine
        // mutants as NOT YET GUARDED purely because their two killers shared a line.
        for (const msg of mismatch) fail(`${at}: the census does not match the contract — ${msg}`)
        // WAS `continue`, which skipped the rest of this state entirely — the zero-box detector, the
        // per-care-row visibility assertion, and every floor and ceiling. That silently capped the
        // measurable redundancy of this gate at ONE killer family for any defect the census can see,
        // which is the same failure the note above describes for joined lines, one level up again.
        // Measured: `noLeadExpand` collapses all nine groups to zero visible rows and was reported
        // "NOT YET GUARDED — one killer only (census-count)", while the scroll-height, content-bottom
        // and ink floors would all have caught it and never got to run. The redundancy was real at
        // runtime and invisible to the matrix, which is worse than either — item 10 cannot be
        // verified against a gate that stops at the first failing family.
        // Only the visual-order and region-top checks are genuinely census-dependent, so only those
        // are gated now.
        censusBroken = true
      }
    }

    // The zero-box detector. An unrendered document — or a jsdom-shaped one — hands back a full set
    // of elements whose every box is 0x0, and every assertion below is then vacuously true.
    const heights = m.regions.flatMap(r => r.boxes.map(x => x.h)).concat(m.rows.map(r => r.h))
    if (!heights.length) fail(`${at}: no boxes measured at all`)
    else if (heights.every(h => h === 0)) fail(`${at}: every one of ${heights.length} measured boxes is 0px tall — this is what an unrendered document looks like, not a passing layout`)
    if (m.clientWidth === 0) fail(`${at}: document clientWidth is 0 — nothing was laid out`)

    if (b) {
      // ── (b) THE KILLING ASSERTION — per care row, checkVisibility() AND a non-zero rect.
      const clipped = m.rows.filter(r => !r.visible || r.h <= 0)
      for (const r of clipped.slice(0, 6)) fail(`${at}: care row ${r.i} ("${r.text}") is mounted and queryable but occupies NO SPACE (h=${r.h}px, checkVisibility ${r.visible}). This is the clipRowPanel shape: present, accessible, invisible — and 9,241 unit tests pass over it.`)
      if (clipped.length > 6) fail(`${at}: …and ${clipped.length - 6} further care row(s) in the same state`)
      const clippedPanels = m.panels.filter(p => p.children > 0 && (!p.visible || p.h <= 0))
      for (const p of clippedPanels) fail(`${at}: a care-group panel holding ${p.children} children renders h=${p.h}px (checkVisibility ${p.visible}) — the list is clipped, not collapsed`)
      // PER-ROW HEIGHT FLOOR. `h > 0` alone is not enough: a row clamped to a 1px sliver keeps its
      // count, reports checkVisibility() true and a non-zero rect, and is unreadable.
      //
      // CORRECTED 2026-09-08 — this comment previously cited "the shrinkRows mutant SURVIVED the
      // first full matrix run" as the measurement justifying this floor. That citation was wrong and
      // is worth keeping visible rather than quietly deleting. todayMutants.mjs records what
      // actually happened: the FIRST shrinkRows set minHeight/maxHeight on the row's inner <Link>,
      // but the row container is `display:flex; align-items:stretch` with 48px action buttons, so
      // the row never shrank at all. It survived because it mutated nothing — a mutant that applies
      // cleanly and changes nothing reads exactly like a hole in the gate. So that run is evidence
      // about a bad mutant, NOT evidence that this floor catches something.
      //
      // The floor is still right, on the REWRITTEN mutant, which clamps the row container itself and
      // does produce the sliver. Note what currently kills it: with `careRowMinH` present this
      // assertion fires; without it in the budget, shrinkRows dies only to the page-height floor —
      // one killer, not two. That is the item-10 redundancy bar, and it is why the budget must be
      // re-recorded by the same gate version that reads it.
      //
      // The floor sits at 75% of the measured row height rather than at the 44px tap minimum,
      // because the tap minimum is a different invariant owned by a different gate and pinning it
      // here would freeze a design call this lane did not make.
      if (b.careRowMinH != null) {
        const slivers = m.rows.filter(r => r.h < b.careRowMinH)
        for (const r of slivers.slice(0, 6)) fail(`${at}: care row ${r.i} ("${r.text}") is ${r.h}px tall, under the ${b.careRowMinH}px floor — present, non-zero, and too short to read or tap`)
        if (slivers.length > 6) fail(`${at}: …and ${slivers.length - 6} further care row(s) under the height floor`)
      }
      // Region-level visibility, same oracle, one level up. A region whose count is right and whose
      // box is zero is the same defect at a different altitude.
      for (const [id, want] of Object.entries(b.regions)) {
        const got = regionById[id]
        for (const box of got.boxes) {
          if (want.count > 0 && (!box.visible || box.h <= 0)) fail(`${at}: region '${id}' (${got.label}) is present but renders h=${box.h}px, checkVisibility ${box.visible} — present-and-invisible`)
          if (want.minH != null && box.h < want.minH) fail(`${at}: region '${id}' (${got.label}) is ${box.h}px tall, under its ${want.minH}px floor — it has been clipped or emptied rather than removed, which no count can see`)
          if (box.overflowsX) fail(`${at}: region '${id}' (${got.label}) overflows its own box horizontally — a child is wider than the region, which does NOT show up as document hscroll`)
        }
      }

      // ── (c) FLOOR FIRST, THEN CEILING.
      if (m.contentBottom < b.contentBottomFloor) fail(`${at}: the last painted pixel on the page is at y=${m.contentBottom}, above the ${b.contentBottomFloor}px floor — content below that line has gone. (This is the floor that bites on the short states, where scrollHeight is clamped to the 844px viewport and a blank page would satisfy it.)`)
      if (m.scrollHeight < b.scrollHeightFloor) fail(`${at}: document is ${m.scrollHeight}px, BELOW the ${b.scrollHeightFloor}px floor. On a density gate a floor is the half that matters: deleting content is the cheapest way to score well on every ceiling here.`)
      if (m.scrollHeight > b.scrollHeightCeiling) fail(`${at}: document is ${m.scrollHeight}px, over the ${b.scrollHeightCeiling}px ceiling`)
      if (m.inkPct < b.inkPctFloor) fail(`${at}: whole-page ink is ${m.inkPct}%, under the ${b.inkPctFloor}% floor — the page got emptier, not denser`)
      if (m.controls < b.controlsFloor) fail(`${at}: ${m.controls} visible controls, under the ${b.controlsFloor} floor`)
      if (b.firstControlYCeiling != null && m.firstControlY != null && m.firstControlY > b.firstControlYCeiling) fail(`${at}: the first control on the page is at y=${m.firstControlY}, past the ${b.firstControlYCeiling}px ceiling — the page opens with more inert space above the first action than it did`)

      // ── (d) ORDERED CENSUS, BY VISUAL POSITION. compareDocumentPosition is DOM order and a CSS
      // reorder passes it unchanged; this reads measured `top`.
      const present = censusBroken ? [] : b.order.filter(id => (regionById[id]?.count ?? 0) > 0)
      const tops = present.map(id => ({ id, t: regionById[id].boxes[0].t }))
      for (let i = 0; i < tops.length - 1; i++) {
        if (!(tops[i].t <= tops[i + 1].t)) fail(`${at}: VISUAL order broken — '${tops[i].id}' paints at y=${tops[i].t}, below '${tops[i + 1].id}' at y=${tops[i + 1].t}, but the contract puts it above. (DOM order may well still be correct: a CSS reorder passes compareDocumentPosition, which is why this is measured from rects.)`)
      }
      // WHERE each region paints, as well as in what order — the second, independent killer for a
      // reorder. It is keyed on a different budget field (`topBand`) from the sequence check
      // (`order`), so an edit that quietly re-sorts one does not silence the other; without it a
      // pure CSS reorder had exactly ONE killer and was reported NOT YET GUARDED.
      // The tolerance is deliberately coarse — max(40px, 2% of the page) — because every region
      // below a change shifts by that change's height, and a band tight enough to red on one extra
      // line of copy is a band that gets switched off. It is nowhere near loose enough to tolerate a
      // region moving to the other end of a 6,232px document, which is what a reorder does.
      for (const [id, want] of (censusBroken ? [] : Object.entries(b.regions))) {
        const got = regionById[id]
        if (want.top == null || want.count === 0 || !got.boxes.length) continue
        const tol = Math.max(40, Math.round(m.scrollHeight * 0.02))
        const dy = got.boxes[0].t - want.top
        if (Math.abs(dy) > tol) fail(`${at}: region '${id}' (${got.label}) paints at y=${got.boxes[0].t}, ${dy > 0 ? dy + 'px lower' : (-dy) + 'px higher'} than its recorded y=${want.top} (tolerance ±${tol}px) — the page above it grew or shrank by more than one copy change, or this region moved`)
      }
    }

    // ── (e) NO HORIZONTAL OVERFLOW — the scrollWidth sibling of the innerWidth refusal.
    if (m.scrollWidth > m.clientWidth + 1) fail(`${at}: document scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} — the page scrolls sideways at ${VIEWPORT.w}px`)

    // ── THE RECORD. Printed on pass as well as fail: these are the numbers a redesign has to move,
    //    and a gate that only speaks when it is angry leaves nothing to compare against.
    const usable = VIEWPORT.h - CHROME_CONST.barH - CHROME_CONST.bottomNav
    console.log(`[today-shape] ${at}: ${m.scrollHeight}px = ${(m.scrollHeight / VIEWPORT.h).toFixed(2)} viewports (${((m.scrollHeight + CHROME_CONST.barH + CHROME_CONST.bottomNav) / usable).toFixed(2)} usable-window-heights incl. ${CHROME_CONST.barH}px TopChrome + ${CHROME_CONST.bottomNav}px BottomNav) · content ends y=${m.contentBottom} · ink ${m.inkPct}% · ${m.rows.length} care rows / ${m.groups.length} groups / ${m.panels.length} expanded · ${m.controls} controls, first at y=${m.firstControlY} · hscroll ${m.scrollWidth > m.clientWidth + 1 ? 'YES' : 'no'}`)
    console.log(`[today-shape] ${at}: regions ${m.regions.filter(r => r.count > 0).map(r => `${r.id}×${r.count}@${r.boxes[0].t}(${r.boxes[0].h}px)`).join(' ')}`)

    // RECORD-MODE SOUNDNESS: refuse to bake a clipped page into the baseline.
    // The comment at the top of this loop draws the right line — "the instrument must be sound to
    // record, the numbers need not match" — and then counts only the viewport, clock, weather flag
    // and fixtures as soundness. Clipping is not on that list, and it is the one distortion this
    // gate exists to detect. Recording against a tree with clipRowPanel applied would derive
    // careRowMinH from a 1px row (`Math.max(1, round(0.75 * h))` = 1) and every region minH from a
    // clipped box, producing a baseline that permanently BLESSES the defect: every later run would
    // compare a clipped page against a clipped baseline and pass. The zero-box detector above is not
    // this check — it fires only when EVERY box is 0, so partial clipping records silently.
    // Deliberately fatal rather than a warning: a warning on a command that writes a file people
    // then trust is a warning nobody reads twice.
    if (RECORD) {
      const rec_clipped = m.rows.filter(r => !r.visible || r.h <= 0)
      const rec_clippedPanels = m.panels.filter(p => p.children > 0 && (!p.visible || p.h <= 0))
      if (rec_clipped.length) fail(`${at}: REFUSING TO RECORD — ${rec_clipped.length} of ${m.rows.length} care rows are mounted but occupy no space (first: row ${rec_clipped[0].i}, h=${rec_clipped[0].h}px, checkVisibility ${rec_clipped[0].visible}). Recording now would derive the floors from a clipped page and bless this shape forever. Fix the page, then re-record.`)
      if (rec_clippedPanels.length) fail(`${at}: REFUSING TO RECORD — a care-group panel holding ${rec_clippedPanels[0].children} children renders h=${rec_clippedPanels[0].h}px. Same reason: the baseline would encode the clip.`)
    }

    recorded[state] = {
      careRowCount: m.rows.length,
      groupCount: m.groups.length,
      expandedPanelCount: m.panels.length,
      regionsPresent: m.regions.filter(r => r.count > 0).length,
      // Same 75%-of-measured rule as a region's minH, and for the same reason: it survives a copy or
      // padding change and does not survive a row collapsing into a sliver.
      careRowMinH: m.rows.length ? Math.max(1, Math.round(Math.min(...m.rows.map(r => r.h)) * 0.75)) : null,
      // 1% is tighter than the scroll-height band on purpose: this number is not clamped by the
      // viewport, so it is the one that has to bite on quiet/noplan.
      contentBottomFloor: Math.round(m.contentBottom * 0.99),
      // Floors and ceilings are the measured value with a stated margin, never a bare literal, so a
      // reader can tell which number is evidence and which is tolerance. ±2% absorbs font-metric
      // and sub-pixel variation between a laptop and a CI runner without absorbing a lost region:
      // the smallest region on this page is 15px, and 2% of 6,232 is 125px, so the SCROLL-HEIGHT
      // bounds alone cannot catch a small region. That is exactly what the per-region `minH` floors
      // and the exact `count`s above are for — the coarse bound and the fine bounds are different
      // instruments, deliberately.
      scrollHeightFloor: Math.round(m.scrollHeight * 0.98),
      scrollHeightCeiling: Math.round(m.scrollHeight * 1.02),
      inkPctFloor: Math.round((m.inkPct - 3) * 10) / 10,
      // The `- 2` absorbs a control appearing or vanishing with copy; the `m.controls > 0` arm is
      // what keeps the floor able to FAIL. Previously this was `Math.max(0, m.controls - 2)`, which
      // on `quiet` and `noplan` — 1 measured control — recorded a floor of 0, and `controls < 0` is
      // never true. A page that lost every control passed. That is the wrong way round: those two
      // states are precisely where "did Today keep any door out of it?" is the whole question, and
      // where firstControlYCeiling also stops guarding (it is skipped when firstControlY is null,
      // which is exactly the no-controls case). Floors on an empty state must bite at 1, not 0.
      controlsFloor: m.controls > 0 ? Math.max(1, m.controls - 2) : 0,
      firstControlYCeiling: m.firstControlY == null ? null : Math.round(m.firstControlY + 24),
      measured: { scrollHeight: m.scrollHeight, contentBottom: m.contentBottom, inkPct: m.inkPct, controls: m.controls, firstControlY: m.firstControlY },
      order: m.regions.filter(r => r.count > 0).sort((x, y) => x.boxes[0].t - y.boxes[0].t).map(r => r.id),
      regions: Object.fromEntries(m.regions.map(r => [r.id, {
        count: r.count,
        // A region's floor is its measured height less 25%: enough to survive one line of copy
        // changing, nowhere near enough to survive being clipped to zero or emptied of its list.
        minH: r.count ? Math.max(1, Math.round(r.boxes[0].h * 0.75)) : null,
        top: r.count ? r.boxes[0].t : null,
      }])),
    }
  }
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (RECORD) {
  if (failures.length) {
    console.error('[today-shape] REFUSING TO RECORD — the run had failures, and a baseline captured over a broken run is worse than no baseline:')
    for (const f of failures) console.error('  · ' + f)
    process.exit(1)
  }
  const out = {
    _: `GENERATED by scripts/layout-gate/today-shape.mjs --record. Every number here is a real getBoundingClientRect / Range.getClientRects reading from headless Chrome at a CDP-emulated, page-self-reported ${VIEWPORT.w}x${VIEWPORT.h} mobile viewport, with the clock pinned to 2026-09-08T15:54Z, the timezone forced to America/New_York and Open-Meteo stubbed at the wire. Every number is width-specific: the gate refuses to run this budget at a different viewport rather than comparing across widths. Re-record deliberately, never to make a red run green.`,
    recordedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    chrome: CHROME_CONST,
    states: recorded,
  }
  writeFileSync(BUDGET_PATH, JSON.stringify(out, null, 2) + '\n')
  console.log(`[today-shape] recorded ${Object.keys(recorded).length} state(s) to ${BUDGET_PATH}`)
  process.exit(0)
}

// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner —
// not the code — says which one happened. An arm that exited 0 on a deliberately-broken instrument
// is a switch someone eventually wires into CI, and it would report a KILL as a SURVIVAL.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[today-shape] FAIL — EXPECTED. --probe-nothing pointed every region selector at a testid nothing renders and the census check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[today-shape] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[today-shape] FAIL — and this one is the real defect: every region selector pointed at a testid that does not exist and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[today-shape] PASS')
