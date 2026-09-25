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
// WHAT IT ASSERTS, in real Chrome at a TRUE 426x836 @ DPR 3 — Dave's handset, read off the phone
// 2026-09-24 — across five states of the real Today page (busyfull, busy, quiet, noplan, and since
// 2026-09-25 storage, the one state pinned a week later — see the REGIONS note on it):
//   (a) INSTRUMENT — before any invariant. Self-reported viewport, harness ready(), pinned clock in
//       force, weather stubbed, every fixture non-empty, the Roboto pin loaded AND painting the page
//       (see FONT below), and the region census matching the counts the fixture promises. Each of
//       these is a way this file could print PASS while measuring nothing.
//   (b) VISIBILITY, per care row and per expanded panel — `checkVisibility()` AND a non-zero rect
//       AND some of that rect surviving every clipping ancestor. The per-row half is the assertion
//       no vitest test can make. CORRECTED 2026-09-24: this line used to say the per-row check was
//       what killed clipRowPanel. Measured, it never fired: a row inside the height:0 panel keeps
//       its own 48px box and checkVisibility() true, so the kill came from the per-PANEL check alone.
//       The ancestor-clip term is what makes the per-row claim true (see `clippedArea` below).
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
// `innerWidth === VIEWPORT.w`, every coordinate after that is from the wrong layout and the run is
// VOID, not failed-and-informative. macOS Chrome floors an OS window at ~500px, so a narrower
// `--window-size` silently lays the page out at 500 and crops the capture — a plausible-looking
// mobile screenshot of a desktop-width layout. Geometry comes from Emulation.setDeviceMetricsOverride.
//
// SCOPE. This measures the Today page MOUNTED ALONE, which is what the harness renders. Production
// adds a 52px in-flow sticky TopChrome and a 56px fixed BottomNav (App.jsx), so the real document is
// ~108px taller and only 728px of Dave's 836px window ever shows page content. Those two constants
// are printed on every run so the usable-window arithmetic is visible rather than assumed.
//
// FONT (V5-TODAYSHAPECI-001, 2026-09-25). The budget is ABSOLUTE geometry, so it is only portable if
// every machine lays the page out in the same glyphs. The harness entry therefore pins its text to
// Roboto — what Dave's Android renders the app in — from the exact-pinned devDependency
// @fontsource-variable/roboto (tests/harness/robotoPin.js). Unpinned, this Mac measured San
// Francisco and CI's ubuntu runner would measure DejaVu Sans; a DejaVu-proxy run grew the busy page
// 2.7% past its ceiling. The gate refuses a run whose pin did not load, a run where Chrome reports any
// glyph painted by a host font other than the allowlisted symbols (scripts/layout-gate/font-census.mjs),
// and a budget recorded in a different font build (FONT BINDING, below).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'
import { fontCensus, fmtCensus, fontProbe } from './font-census.mjs'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// 5323 / 9433: re-picked 2026-09-24. The 09-08 build used 5319 / 9430, which gate:seeds-page took
// in the meantime, and a harness that silently attaches to a sibling's server measures a sibling's
// page. Taken on dev at this writing: 5311-5321 (5321 = phototier's image server) / 9422-9431; the
// Today recorder (tests/harness/_todaymeasure/drive.mjs) holds 5324 / 9434.
const PORT = Number(process.env.GATE_HARNESS_PORT || 5323)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9433)
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
// effective CSS width on identical hardware (~320 to ~502 on one handset). The authority is the
// device, which is why the app's Debug & smoke panel reports "Viewport (CSS px)" live — More →
// Debug & smoke.
//
// ── SETTLED 2026-09-24 (OPS-TODAYVIEWPORTWIDTH-001) ──────────────────────────────────────────────
// Dave read 426x836 CSS px at DPR 3 off that row on his phone. The gate was built on 2026-09-08 at
// 390x844, the iPhone 12/13/14 CDP preset, and said so; that number is gone. What the change does
// and does not buy: the defects in the mutation matrix (a clipped row panel, a CSS reorder, a
// deleted region) are width-ROBUST and were caught at 390 too; what 426 buys is that every
// width-SENSITIVE reading this gate prints (does the bulk-pill block wrap, does a group title
// truncate, how many rows fit the first screen) now describes the phone it is about.
// If the phone's Display size setting changes, re-read the row and re-point:
//   GATE_VIEWPORT_W=<w> GATE_VIEWPORT_H=<h> npm run gate:today-shape:record
// then set the defaults below to match. The budget records the viewport it was captured at and the
// gate refuses a mismatch (see WIDTH BINDING below), so a half-done re-point cannot pass.
const VIEWPORT = {
  w: Number(process.env.GATE_VIEWPORT_W || 426),
  h: Number(process.env.GATE_VIEWPORT_H || 836),
  // Layout is in CSS px, so DPR moves no box; it is pinned anyway so sub-pixel rounding and hairline
  // borders match the handset, and it is part of the width binding for the same reason.
  dpr: Number(process.env.GATE_VIEWPORT_DPR || 3),
}
// Read from source, not spelled here: a gate carrying its own copy of a constant keeps printing a
// number after someone changes the real one. The harness mounts Today WITHOUT app chrome, so these
// two are what turn a harness scroll-height into a production one in the printed record — they are
// reported and recorded, not asserted (nothing here renders the bars to measure).
function topChromeBarH() {
  const src = readFileSync(resolve(ROOT, 'src/components/TopChrome.jsx'), 'utf8')
  const found = [...src.matchAll(/const BAR_H = (\d+)/g)].map(m => Number(m[1]))
  if (found.length !== 1) throw new Error(`TopChrome.jsx declares BAR_H ${found.length} times; expected exactly 1`)
  return found[0]
}
const CHROME_CONST = { barH: topChromeBarH(), bottomNav: BOTTOM_NAV_HEIGHT_PX }

const RECORD = process.argv.includes('--record')
// THE INSTRUMENT SELF-TEST. Every region selector gains a suffix nothing renders, so no census count
// can be met and the run MUST exit 1 on "matched 0 elements" rather than sailing through on
// vacuously-true invariants. Same idiom, same exit-code discipline, as gate:seeds-saved and
// gate:putup — a third pattern here would be a third thing to keep true.
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
// DIAGNOSTIC ONLY — the same hook gate:seeds-page carries, under the same name. CSS injected into
// every state once the page is ready and before it settles, so a stress test can be measured against
// the budget without editing anything: e.g. the wide-font stress test
//   GATE_MUTATE_CSS='*{font-family:Verdana,"DejaVu Sans",sans-serif!important}' npm run gate:today-shape
// which, before the Roboto pin, stood in (pessimistically) for the Linux runner's DejaVu Sans. Under
// the pin it also trips the font census, since it forces every element onto a host font.
// Refused under --record: a mutated page must never become the baseline.
const MUTATE_CSS = process.env.GATE_MUTATE_CSS || ''
if (RECORD && MUTATE_CSS) { console.error('[today-shape] REFUSING TO RECORD with GATE_MUTATE_CSS set — the baseline would encode the injected CSS.'); process.exit(1) }
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
  // 2026-09-24 — the four ambient weather lines Today.jsx mounts under the card. Each renders
  // NOTHING on a quiet day, which is exactly why each needs a census entry: a line that stops
  // rendering reads as "a quiet day" to every other check here.
  { id: 'weather-cue-line', label: 'the engine\'s one-cue-per-day weather line' },
  { id: 'frost-alert-line', label: 'the frost advisory / frost-watch line(s)' },
  { id: 'drought-line', label: 'the garden-wide drought line' },
  { id: 'leaf-wetness-line', label: 'the leaf-wetness scouting line' },
  { id: 'today-substrate-note', label: 'the substrate/feeding note' },
  { id: 'today-basis-stamp', label: 'the "Plan from overnight" stamp' },
  { id: 'today-care', label: 'CareNeeded' },
  { id: 'today-watch-band', label: 'HarvestWatchBand' },
  { id: 'compose-harvest-band', label: 'ComposeHarvestBand' },
  { id: 'cultivation-lead', label: 'CultivationLead' },
  { id: 'today-household', label: 'the household toggle' },
  { id: 'today-noplan-card', label: 'the "first daily plan" empty state' },
  // 2026-09-25 (V5-TODAYSHAPECI-001 item 9) — the two regions that render nothing at the fixtures'
  // own instant. Measured in the `storage` state only, which moves the clock into the sweet-potato
  // check window and serves real stored jars with their window status forced (storage-grafts.json).
  { id: 'storage-deadline-alert', label: 'StorageDeadlineAlert (a storage crop\'s lift deadline)' },
  { id: 'putup-use-soon', label: 'PutUpUseSoonBand ("From your stores — cook these next")' },
  { id: 'care-heading', label: 'the "Needs care today" heading' },
  // The disclosure that rows are being WITHHELD (V5-TODAYCAP-001). Without it the list silently
  // under-reports the garden; it is one 20px line and no coarse measure here can see it go.
  { id: 'care-cap-note', label: 'the "Showing the longest-waiting 20 per group" note' },
  { id: 'care-bulk-chips', label: 'the bulk-action chip block' },
  { id: 'care-rain-note', label: 'the rain-skipped note' },
  { id: 'care-dormant', label: 'the Dormant block' },
  { id: 'care-drought-list', label: 'the "Dry — no deep soak" list' },
  { id: 'care-feed-suppressed', label: 'the "No feed schedule" disclosure' },
  { id: 'care-empty', label: 'the "All caught up" empty state' },
]

// PER-CONTROL CENSUS — controls that repeat, so a REGION count cannot see them. Each is counted as
// VISIBLE instances (checkVisibility + non-zero rect) and pinned EXACTLY per state, like care rows.
//   care-moist     — one per water_due row on screen (BUG-MOISTURECHECKNOBUTTON-001). A predicate
//                    change that drops it leaves every row, every region and every count above intact.
//   care-show-more — the door to the rows the cap withholds. The cap note says rows are hidden; this
//                    is how Dave gets them back, and losing it strands them with no way to reach them.
const CONTROLS = [
  { id: 'care-moist', label: 'the per-row "Moist" button' },
  { id: 'care-show-more', label: 'the "Show N more" door to capped rows' },
]

const failures = []
const fail = m => failures.push(m)

// A port that already answers belongs to somebody else — typically this same gate running in a
// sibling worktree. vite's strictPort makes OUR server exit, but the readiness poll below would
// happily accept the sibling's answer first and measure the sibling's tree. Refuse up front.
async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — another harness or Chrome is running there. Set GATE_HARNESS_PORT / GATE_CDP_PORT to free ports; measuring through it would measure that process's page.`)
}

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
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
  await assertPortFree(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP')
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
    if (m.id != null && pending.has(m.id)) { const { res, rej, timer } = pending.get(m.id); clearTimeout(timer); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
  }
  // The per-call timeout is CLEARED when the reply lands. Measured 2026-09-24: left armed, every
  // answered call kept a 120s timer on the event loop, so a GREEN run finished measuring in ~12s and
  // then sat for two more minutes before node could exit (a red run exits through process.exit and
  // never showed it). In CI that is ~2 minutes of every green build.
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 120000)
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
  //
  // AND with the area left after every CLIPPING ANCESTOR (added 2026-09-24). Neither of the two
  // checks above sees an ancestor's overflow clip: under clipRowPanel every row inside the height:0
  // panel still reports its own 48px box and checkVisibility() true, so per-row "visibility" passed
  // over a list nobody could see and only the panel's own zero height caught it. Intersecting the
  // element's rect with each ancestor that clips (overflow other than visible, per axis) is what
  // lets a row, or a Moist button, report "present and clipped away". display:contents ancestors
  // have no box and are skipped rather than read as a zero-size clip.
  const clippedArea = el => {
    const r = el.getBoundingClientRect()
    let t = r.top, b = r.bottom, l = r.left, rr = r.right
    for (let a = el.parentElement; a && a !== de && a !== d.body; a = a.parentElement) {
      const cs = w.getComputedStyle(a)
      if (cs.display === 'contents') continue
      const cy = cs.overflowY !== 'visible', cx = cs.overflowX !== 'visible'
      if (!cy && !cx) continue
      const ar = a.getBoundingClientRect()
      if (cy) { t = Math.max(t, ar.top); b = Math.min(b, ar.bottom) }
      if (cx) { l = Math.max(l, ar.left); rr = Math.min(rr, ar.right) }
    }
    return Math.max(0, b - t) * Math.max(0, rr - l)
  }
  const shown = el => (!el.checkVisibility || el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) && el.getBoundingClientRect().height > 0 && clippedArea(el) > 0
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
    return { i, h: r.h, w: r.w, t: r.t, visible: shown(el), area: Math.round(clippedArea(el)),
             text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 34) }
  })
  const panels = all('${tid('care-group-panel')}').map(el => { const r = box(el); return { h: r.h, visible: shown(el), children: el.children.length } })
  const groups = all('${tid('care-group')}').map(el => box(el).h)
  const controlCensus = Object.fromEntries(${JSON.stringify(CONTROLS)}.map(c => {
    const els = all('[data-testid="' + c.id + '${SUFFIX}"]')
    return [c.id, { total: els.length, visible: els.filter(shown).length }]
  }))

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
    // the quiet and noplan states (both exactly one viewport tall) a scroll-height floor is VACUOUS — it is
    // satisfied by a completely blank page. This is the selector-free floor that still bites there.
    contentBottom: lastInk,
    inkPx, inkPct: H ? Math.round((inkPx / H) * 1000) / 10 : 0,
    controls: controls.length, firstControlY: firstControl,
    regions, rows, panels, groups, controlCensus,
    harness: {
      state: w.__h.state(), error: w.__h.error(), clock: w.__h.clock(),
      weatherStubbed: w.__h.weatherStubbed(), fixtures: w.__h.fixtures(),
      requests: w.__h.requests().length,
      // The OBSERVED counterpart to weatherStubbed's declared intent — see todaymeasure.jsx's
      // passthrough arm. Any third-party URL that reached the real network lands here.
      liveRequests: w.__h.requests().filter(r => r.live).map(r => r.path),
      // tests/harness/robotoPin.js's own report: which build, how many faces loaded, which failed.
      fontPin: w.__fontPin || null,
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
if (!RECORD && budget.viewport && (budget.viewport.w !== VIEWPORT.w || budget.viewport.h !== VIEWPORT.h || budget.viewport.dpr !== VIEWPORT.dpr)) {
  console.error(`[today-shape] FAIL — budget/viewport mismatch: this budget was recorded at ${budget.viewport.w}x${budget.viewport.h} @ DPR ${budget.viewport.dpr ?? '(unrecorded)'}, the gate is running at ${VIEWPORT.w}x${VIEWPORT.h} @ DPR ${VIEWPORT.dpr}. Every recorded number is viewport-specific, so none of them describe this run. Re-record at the new viewport (npm run gate:today-shape:record) or unset GATE_VIEWPORT_W/H/DPR.`)
  process.exit(1)
}
// FONT BINDING, the glyph-axis twin of the width binding above and the clock binding below. A budget
// with no `font` was recorded in whatever face the recording machine had (San Francisco, before
// 2026-09-25), so its heights and tops describe a page no other machine lays out. The per-run half —
// the pin's build matching the budget's — is checked per state, once the page has said what it loaded.
if (!RECORD && !budget.font) {
  console.error('[today-shape] FAIL — this budget predates the Roboto pin (no \'font\' key): its numbers are host-font geometry from the machine that recorded it. Re-record on a clean tree (npm run gate:today-shape:record).')
  process.exit(1)
}

const STATES = Object.keys(budget.states || {}).length && !RECORD
  ? Object.keys(budget.states)
  : (process.env.TODAY_SHAPE_STATES || 'busyfull,busy,quiet,noplan,storage').split(',').filter(Boolean)

const recorded = {}
let pinnedClockIso = null
let pinnedFont = null
let probed = false
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
  if (MUTATE_CSS) console.log(`[today-shape] MUTATED RUN — GATE_MUTATE_CSS is injected into every state: ${MUTATE_CSS}`)

  for (const state of STATES) {
    const at = `${state}@${VIEWPORT.w}x${VIEWPORT.h}`
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: VIEWPORT.dpr, mobile: true }, cdp.sessionId)
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
    if (MUTATE_CSS) await evalSettled(`(()=>{const s=document.createElement('style');s.setAttribute('data-gate-mutate','1');s.textContent=${JSON.stringify(MUTATE_CSS)};document.head.appendChild(s);return 1})()`)
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
    let stateClock = null
    if (!m.harness.clock.pinned) fail(`${at}: the clock is NOT pinned (${m.harness.clock.now}). Scroll-height and ink-% then drift with the wall clock and this gate becomes flaky by construction.`)
    else { stateClock = m.harness.clock.iso; pinnedClockIso ??= stateClock }
    // CLOCK BINDING, the time-axis twin of the width binding. The fixtures were dumped on one morning
    // and the harness pins the clock to it; every band window, date line and "as of" stamp in the
    // budget was measured at that instant. A harness re-pinned without a re-record would be compared
    // against a page measured at another time. Skipped under --record, which adopts the new instant.
    // PER STATE since 2026-09-25: `storage` is pinned a week later than the rest (todaymeasure.html),
    // so each state entry records its own instant and the top-level `clock` is the default pin.
    const wantClock = budget.states?.[state]?.clock ?? budget.clock
    if (!RECORD && wantClock && m.harness.clock.pinned && m.harness.clock.iso !== wantClock) fail(`${at}: the harness clock is pinned to ${m.harness.clock.iso} but this state was recorded at ${wantClock} — re-record (npm run gate:today-shape:record) after moving the pin, never compare across instants`)
    if (m.harness.clock.tz !== 'America/New_York') fail(`${at}: page timezone is ${m.harness.clock.tz}, expected America/New_York — the date subtitle and the "as of" stamp render different copy, which is a different wrap and a different height`)
    // THE FONT PIN, loaded. Whether it also PAINTED the page is the census after the measurement.
    const pin = m.harness.fontPin
    if (!pin || !pin.ok) fail(`${at}: the Roboto pin is NOT in force (${pin ? `${pin.faces} face(s) loaded, ${pin.failed.length} failed${pin.failed.length ? ': ' + pin.failed.slice(0, 2).join('; ') : ''}` : 'window.__fontPin is missing — tests/harness/robotoPin.js never ran'}). Every length on this page would be the host font's (San Francisco on a Mac, DejaVu Sans on CI), not the Roboto this budget was recorded in.`)
    else pinnedFont = pin.source
    if (!RECORD && pin?.ok && pin.source !== budget.font) fail(`${at}: the harness pins ${pin.source} but this budget was recorded in ${budget.font} — another build of the font can move every glyph; re-record (npm run gate:today-shape:record), never compare across fonts`)
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
      for (const r of clipped.slice(0, 6)) fail(`${at}: care row ${r.i} ("${r.text}") is mounted and queryable but occupies NO SPACE on screen (own box h=${r.h}px, ${r.area}px² left after its clipping ancestors). This is the clipRowPanel shape: present, accessible, invisible — and 9,239 of 9,241 unit tests passed over it when it was measured.`)
      if (clipped.length > 6) fail(`${at}: …and ${clipped.length - 6} further care row(s) in the same state`)
      const clippedPanels = m.panels.filter(p => p.children > 0 && (!p.visible || p.h <= 0))
      for (const p of clippedPanels) fail(`${at}: a care-group panel holding ${p.children} children renders h=${p.h}px (shown ${p.visible}) — the list is clipped, not collapsed`)
      // PANEL STRUCTURE — each expanded panel's exact number of direct children: its rows, any
      // Containers/In-ground sub-headers, and the "Show N more" door. Added 2026-09-24 because the
      // door had exactly ONE killer (the control census): at 44px its loss moves every coarse floor
      // by less than that floor's tolerance. This is a different budget field read through a
      // different selector, so disarming one of the two leaves the other standing.
      if (!('panelChildren' in b)) fail(`${at}: the budget entry predates the panel-structure census (no 'panelChildren' key) — re-record with this gate version; until then the open list can lose its Show-more door and pass`)
      else if (JSON.stringify(m.panels.map(p => p.children)) !== JSON.stringify(b.panelChildren)) fail(`${at}: the expanded group panel(s) hold [${m.panels.map(p => p.children).join(', ')}] direct children, expected exactly [${b.panelChildren.join(', ')}] — a row, a sub-header or the Show-more door has appeared in or gone from the open list`)
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

      // PER-CONTROL CENSUS (see CONTROLS). Exact VISIBLE count per state, and never mounted-but-
      // invisible. Kept OUT of the region census block above on purpose: that block's failure gates
      // the rect-ordered checks, and a control count says nothing about where regions paint.
      if (!('controlCensus' in b)) fail(`${at}: the budget entry predates the per-control census (no 'controlCensus' key) — re-record with this gate version; until then a dropped Moist or Show-more control passes`)
      else {
        for (const c of CONTROLS) {
          const want = b.controlCensus[c.id]
          const got = m.controlCensus[c.id]
          if (want == null) { fail(`${at}: the budget has no controlCensus entry for '${c.id}' — that control is UNGUARDED here`); continue }
          if (got.visible !== want) fail(`${at}: control '${c.id}' (${c.label}): ${got.visible} visible, expected exactly ${want}`)
          if (got.total > got.visible) fail(`${at}: ${got.total - got.visible} of ${got.total} '${c.id}' control(s) are mounted but not visible — present, queryable and untappable`)
        }
      }

      // ── (c) FLOOR FIRST, THEN CEILING.
      if (m.contentBottom < b.contentBottomFloor) fail(`${at}: the last painted pixel on the page is at y=${m.contentBottom}, above the ${b.contentBottomFloor}px floor — content below that line has gone. (This is the floor that bites on the short states, where scrollHeight is clamped to the viewport height and a blank page would satisfy it.)`)
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

    // ── FONT CENSUS, after measuring (it tags elements to address them). The pin loading proves the
    //    faces exist; this is Chrome's own account of which font drew each element's glyphs. A stack
    //    no alias covers, or a glyph Roboto lacks, paints in the host's font — a different width on
    //    every machine — so outside the measured, allowlisted symbols it is a refusal, not a note.
    const census = await fontCensus(cdp, '#root')
    if (!census.glyphs) fail(`${at}: the font census read no glyphs under #root — nothing painted text, or the census could not see it; either way the Roboto pin is unverified`)
    else if (!census.webGlyphs) fail(`${at}: not one glyph under #root was painted by the pinned web font — the page was measured entirely in host fonts (${Object.keys(census.fonts).join(', ')})`)
    for (const v of census.violations.slice(0, 6)) fail(`${at}: a HOST font painted text the Roboto pin should own — ${v}. That text measures differently on every machine; alias its family in tests/harness/robotoPin.js (or, for a symbol Roboto lacks, measure that it moves no box and allowlist it in font-census.mjs)`)
    if (census.violations.length > 6) fail(`${at}: …and ${census.violations.length - 6} further host-font element(s)`)
    if (!probed) {
      probed = true
      console.log(`[today-shape] font: ${pin?.source ?? 'NO PIN'} (${pin?.faces ?? 0} faces) · ${chrome.version.Browser} · probe widths ${JSON.stringify(await fontProbe(cdp.evalIn))}`)
    }

    // ── THE RECORD. Printed on pass as well as fail: these are the numbers a redesign has to move,
    //    and a gate that only speaks when it is angry leaves nothing to compare against.
    const usable = VIEWPORT.h - CHROME_CONST.barH - CHROME_CONST.bottomNav
    console.log(`[today-shape] ${at}: ${m.scrollHeight}px = ${(m.scrollHeight / VIEWPORT.h).toFixed(2)} viewports (${((m.scrollHeight + CHROME_CONST.barH + CHROME_CONST.bottomNav) / usable).toFixed(2)} usable-window-heights incl. ${CHROME_CONST.barH}px TopChrome + ${CHROME_CONST.bottomNav}px BottomNav) · content ends y=${m.contentBottom} · ink ${m.inkPct}% · ${m.rows.length} care rows / ${m.groups.length} groups / ${m.panels.length} expanded · ${m.controls} controls, first at y=${m.firstControlY} · hscroll ${m.scrollWidth > m.clientWidth + 1 ? 'YES' : 'no'}`)
    console.log(`[today-shape] ${at}: regions ${m.regions.filter(r => r.count > 0).map(r => `${r.id}×${r.count}@${r.boxes[0].t}(${r.boxes[0].h}px)`).join(' ')}`)
    console.log(`[today-shape] ${at}: controls ${CONTROLS.map(c => `${c.id} ${m.controlCensus[c.id].visible}/${m.controlCensus[c.id].total}`).join(' · ')}`)
    console.log(`[today-shape] ${at}: fonts ${fmtCensus(census)}`)

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
      for (const c of CONTROLS) {
        const got = m.controlCensus[c.id]
        if (got.total > got.visible) fail(`${at}: REFUSING TO RECORD — ${got.total - got.visible} of ${got.total} '${c.id}' control(s) are mounted but not visible. The census would pin the smaller number and bless the hidden ones.`)
      }
    }

    recorded[state] = {
      // The instant this state was measured at (see CLOCK BINDING).
      clock: stateClock,
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
      // Exact, like careRowCount: this state's fixture produces exactly this many of each.
      controlCensus: Object.fromEntries(CONTROLS.map(c => [c.id, m.controlCensus[c.id].visible])),
      panelChildren: m.panels.map(p => p.children),
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
    _: `GENERATED by scripts/layout-gate/today-shape.mjs --record. Every number here is a real getBoundingClientRect / Range.getClientRects reading from headless Chrome at a CDP-emulated, page-self-reported ${VIEWPORT.w}x${VIEWPORT.h} @ DPR ${VIEWPORT.dpr} mobile viewport (Dave's handset, read 2026-09-24), with the clock pinned to ${pinnedClockIso} (a state entry carrying its own 'clock' was measured at that instant instead), the timezone forced to America/New_York, Open-Meteo stubbed at the wire and the text laid out in ${pinnedFont} (tests/harness/robotoPin.js — the face Dave's Android renders, identical on the Mac and on CI). Every number is viewport-, instant- and font-specific: the gate refuses to run this budget at a different viewport, a different pinned clock or a different font build rather than comparing across them. Re-record deliberately, never to make a red run green.`,
    recordedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    clock: pinnedClockIso,
    font: pinnedFont,
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
process.exit(0)
