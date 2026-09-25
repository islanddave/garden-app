#!/usr/bin/env node
// seeds-scroll.mjs — BUG-SAVEDSEEDSBACKTOP-001 + BUG-SEEDLOTOPENSATFORM-001 (v4.148.0), in real Chrome:
// Back keeps your place on the Seeds page, and a seed lot's page opens at its top.
//
//   node scripts/layout-gate/seeds-scroll.mjs [--outdir dir]     # npm run gate:seeds-scroll
//   node scripts/layout-gate/seeds-scroll.mjs --probe-nothing    # prove the instrument fires; MUST exit 1
//
// WHY IT EXISTS (qa-v4148 IMPORTANT 1). Both fixes live in behaviour jsdom cannot produce:
//   1. useScrollRestore's unmount save read window.scrollY after React had swapped in the next page, when
//      Chrome had already CLAMPED the offset to that page's one-screen loading shell. Back from a lot page
//      or a planting landed near the top of the list (measured: stored 108, not 3101).
//   2. BrowserRouter never resets scroll on a push. The lot page's loading shell carried the list's offset
//      and Chrome's SCROLL ANCHORING re-applied it when the lot landed, on the edit form (1742, not 0).
// The unit suites (useScrollRestore.test.jsx, SavedSeeds.notStarted.test.jsx, InventoryDetail.opensAtTop.
// test.jsx) pin both contracts with MODELS — a clamp written into a layout effect, a scrollTo spy — and
// gate:seed-detail mounts InventoryDetail directly in a MemoryRouter. Nothing else runs the real clamp,
// the real anchoring and a real history traversal, so without this a regression of either fix passes CI.
//
// DRIVES tests/harness/seedsscroll.{html,jsx} — the real Seeds page (Saved seeds, My seeds, their real
// useScrollRestore) and the real InventoryDetail under BrowserRouter, in App.jsx's shell with the top-bar
// and bottom-nav stand-ins at their real heights, the network stubbed with a loading phase — inside
// tests/harness/viewport.html, the IFRAME HOST: headless Chrome floors a window near 500px wide, and an
// iframe is a real layout viewport at any size. Every tap and scroll is real input through the browser's
// pipeline (CDP mouse press/release, hit-tested at the target's centre first; mouse-wheel scrolling), and
// Back is a real history traversal (history.back() in the frame: popstate, as the Android back gesture).
// Each flow opens in a FRESH TAB, so its history, sessionStorage and module state are its own.
//
// NINE FLOWS, at each viewport (426x836 — Dave's handset — and 360x640; GATE_VIEWPORTS overrides):
//   (a) Saved seeds, scrolled deep (the Ristra card wheeled to the middle of the visible band) → tap the
//       card's title → the lot page lands at scrollY 0 with its h1 inside the visible band; then Back →
//       scrollY equals the pre-tap value exactly and the card's viewport top is unchanged (±1px).
//   (b) Saved seeds, deep → the card's "Saved from <planting> →" → the planting → Back → as (a)'s Back.
//   (c) My seeds: Pepper opened, the Ristra row wheeled mid-band and opened, then its "Open details →" →
//       the lot page lands at 0 with its h1 in the band; Back → the same scrollY, the row's viewport top
//       unchanged (±1px), and the row still open.
//   (d) BUG-OVERLAYDISMISSREKEY-001: Saved seeds scrolled deep → header Search → the sheet's X (the list
//       must hold still through the close, which is a history traversal now) → then (a)'s tap and Back.
//       Closing the sheet used to replace its history entry with a new copy of the Seeds entry, whose key
//       the mounted page had never opened on, so nothing was saved for the rest of the visit and Back
//       landed near the top. The same invariants as (a).
//   (e) BUG-OVERLAYDISMISSREKEY-001: Saved seeds → header Search → the sheet's X → Back → /today. The
//       replace also left the Seeds entry in the stack twice, so this Back stayed on Seeds: a dead press.
//   (f) As (e) through BottomNav's +LOG door: the armed "Create new" sheet pushes a Back marker and its
//       row REPLACE-opens the overlay into that marker's slot (SheetRowLink), so the overlay sits one
//       entry above Seeds while carrying Seeds' idx — the case a distance read off idx alone gets wrong.
//   (g) As (e) with the X DOUBLE-tapped: the second press lands after history is back on Seeds' entry
//       but before React has taken the sheet down (BrowserRouter commits in a transition). The close must
//       land on Seeds' own key — a replace in that window overwrites it — and one Back must still leave.
//   (h) BUG-OVERLAYRELOADKEY-001: Saved seeds deep → header Search → its result (a plain push, as Search's
//       are) → Back, which re-opens Search over a Seeds page that has re-MOUNTED under the sheet → the X →
//       the list back where it was; then scrolled on (a real wheel) → (a)'s tap and Back, which must land on
//       the NEW place. A page that mounts under an overlay used to key its offsets by the OVERLAY's entry:
//       it read nothing on the way in and, once the X had walked it home, saved nothing, so Back landed on
//       the offset saved before Search.
//   (i) BUG-OVERLAYRELOADKEY-001, the other half: Saved seeds deep → header Search → the app RELOADS under
//       it (a new document on Search's own entry, sessionStorage kept: the service worker's post-update
//       reload, an Android tab restore) → the X, which must REPLACE now that it cannot walk across
//       documents → the list back where it was; then scrolled on → (a)'s tap and Back onto the new place.
//       Red with either half of the fix removed: the page keying by the overlay's entry, or the replace
//       leaving an entry the page cannot claim.
// Every number is printed on pass as well as fail.
//
// THE INSTRUMENT CHECK comes first in every flow, and a mismatch stops that flow before any invariant is
// read: the frame must self-report the viewport it was asked for (innerWidth/innerHeight, and a
// clientWidth with no scrollbar gutter), the chrome stand-ins must be exactly TopChrome's BAR_H and
// BOTTOM_NAV_HEIGHT_PX, the page must have raised no error, the Seeds view must be the one asked for with
// the fixture's count of cards / Pepper rows, the pre-tap offset must be DEEP (>= DEEP_MIN_PX: past
// anything a one-screen loading shell can hold, so a clobbered offset cannot coincide with the real
// one), each tap must hit-test to its target in place — the gate never scrolls a target into view, since
// the scroll position IS the measurement — the tap must push a NEW history entry onto the expected
// route, and Back must return to the very entry the offset was taken on (same react-router key). The
// frame must stay ONE document from the first tap to the last read: a reload mid-flow (Vite
// re-optimizing a dependency reloads the frame at whatever router URL it is on) is named, never measured.
// A selector that matched nothing is a FAILURE, never a quiet pass. `--probe-nothing` points every app
// testid at one nothing renders; it MUST exit 1.
//
// NON-VACUITY: see ci.yml's gate:seeds-scroll step for the measured runs — the whole pre-fix tree
// (HARNESS_BASELINE_SHA=c016dcde…) and each fix reverted alone (GATE_HARNESS_CONFIG, a config that serves
// one file from the base commit) — each red by name with the base numbers. Flows (d) and (e) were measured
// the same way against the tree before BUG-OVERLAYDISMISSREKEY-001 (HARNESS_BASELINE_SHA=2e576239…): see
// Projects/Gardening/_seedstab11_20260925/ in the gardening-docs repo for the recorded runs. Flows (h) and
// (i) against the tree before BUG-OVERLAYRELOADKEY-001 (HARNESS_BASELINE_SHA=73686a22…) and with each half
// of that fix reverted alone (h reds without the page-entry key and passes without the replace stamp; i
// reds without either): Projects/Gardening/_seedstab12_20260925/gate-flowi-*.txt.
//
// SEAMS (never set in CI; a run with any of them set says so in its first lines, so it cannot pass for
// clean):
//   HARNESS_BASELINE_SHA — serve src/** from a git object (tests/harness/baselinePlugin.mjs). The gate
//     refuses a baseline run whose Vite never printed that it is serving the object.
//   GATE_HARNESS_CONFIG — a different Vite config for the harness (repo-relative or absolute).
//   GATE_ONLY — a comma-separated list of flow keys to run (e.g. h,i), for a quick re-run of one flow.
//   GATE_CPU_THROTTLE — CDP CPU throttling for each tab (e.g. 6 = six times slower): a slow CI runner,
//     rehearsed on this tab alone rather than by loading the machine other sessions share.
//
// SCREENSHOTS: the frame's own rect (so exactly the device viewport, never a cropped window) on arrival
// at the lot page / planting and again after Back, to --outdir (artifacts/layout-gate by default,
// gitignored).
//
// TRAPS THE SIBLINGS ALREADY PAID FOR:
//   1. macOS Chrome floors an OS window at ~500px — hence the iframe host, and a frame whose innerWidth/
//      innerHeight is not the one requested is REFUSED.
//   2. The in-app browser pane reports visibilityState 'hidden' and rAF never fires; hence headless Chrome
//      with --disable-renderer-backgrounding.
//   3. CI pins node 20.19.0, which has no global WebSocket — resolveWebSocket(), never a bare global.
//   4. Fonts differ on the Linux runner, so every position is measured in the run and compared with
//      itself; no pixel value is spelled here except the chrome heights, which are read from the source.
//   5. A port that already answers belongs to somebody else (today-shape.mjs) — refused up front.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Read from the source, never spelled here: a gate carrying its own copy keeps passing after someone
// moves the real one.
function readOne(file, re, what) {
  const src = readFileSync(resolve(ROOT, file), 'utf8')
  const found = [...src.matchAll(re)].map((m) => m[1])
  if (found.length !== 1) throw new Error(`${file} carries ${what} ${found.length} times; expected exactly 1 — the gate cannot read it`)
  return found[0]
}
const TOP_CHROME_PX = Number(readOne('src/components/TopChrome.jsx', /const BAR_H = (\d+)/g, 'BAR_H'))

// DRIFT GUARD for what the harness copies rather than imports (flows d to h): App.jsx's OverlayHost
// (copied because importing App.jsx pulls in every page), the header Search door (an OverlayLink to
// /search in TopChrome) and the +LOG door (BottomNav's armed "Create new" sheet whose rows are
// SheetRowLinks with `overlay`). If any of them changes, the flows would keep proving the copy. Read
// from source, like BAR_H above.
function harnessCopyDrift() {
  const src = (f) => readFileSync(resolve(ROOT, f), 'utf8')
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const body = (text, name) => {
    const m = text.match(new RegExp(`function ${name}\\(\\{ ariaLabel, size = 'peek', children \\}\\) \\{([\\s\\S]*?)\\n\\}`))
    return m ? norm(m[1]) : null
  }
  const out = []
  const app = body(src('src/App.jsx'), 'OverlayHost')
  const copy = body(src('tests/harness/seedsscroll.jsx'), 'HarnessOverlayHost')
  if (!app || !copy) out.push(`could not read ${app ? 'HarnessOverlayHost in tests/harness/seedsscroll.jsx' : 'OverlayHost in src/App.jsx'} — the drift guard cannot compare them`)
  else if (app !== copy) out.push('tests/harness/seedsscroll.jsx HarnessOverlayHost no longer matches src/App.jsx OverlayHost — re-copy it, or flows d to h prove a host the app no longer has')
  if (!/<OverlayLink to="\/search"/.test(src('src/components/TopChrome.jsx'))) out.push('TopChrome no longer opens header Search with <OverlayLink to="/search"> — the harness header link no longer models it')
  const nav = src('src/components/BottomNav.jsx')
  if (!/<Sheet[^>]*ariaLabel="Create new"[^>]*armsBack/.test(nav) || !/<SheetRowLink[\s\S]{0,200}overlay=/.test(nav)) out.push('BottomNav\'s +LOG door is no longer an armed "Create new" sheet of overlay SheetRowLinks — the harness +LOG door (flow f) no longer models it')
  return out
}

// 5322 / 9432: clear of every sibling's default (5311-5326 less 5322 / 9422-9431, 9433, 9434 are taken).
const PORT = Number(process.env.GATE_HARNESS_PORT || 5322)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9432)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI passes --no-sandbox. Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const HARNESS_CONFIG = process.env.GATE_HARNESS_CONFIG || 'tests/harness/vite.harness.config.mjs'
const CUSTOM_CONFIG = HARNESS_CONFIG !== 'tests/harness/vite.harness.config.mjs'
const BASELINE_SHA = process.env.HARNESS_BASELINE_SHA || ''
const CPU_THROTTLE = Number(process.env.GATE_CPU_THROTTLE || 1)
const ONLY = (process.env.GATE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
if (!(CPU_THROTTLE >= 1)) throw new Error(`GATE_CPU_THROTTLE="${process.env.GATE_CPU_THROTTLE}" is not a rate >= 1`)
const outArg = process.argv.indexOf('--outdir')
const OUTDIR = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(ROOT, 'artifacts/layout-gate')

const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`

const VIEWPORTS = process.env.GATE_VIEWPORTS
  ? process.env.GATE_VIEWPORTS.split(',').map((s) => s.trim().split('x').map(Number))
  : [[426, 836], [360, 640]]
if (!VIEWPORTS.length || VIEWPORTS.some((v) => v.length !== 2 || !v.every((x) => Number.isInteger(x) && x > 0))) {
  throw new Error(`GATE_VIEWPORTS="${process.env.GATE_VIEWPORTS}" is not a list of WxH`)
}

// What tests/harness/seedsscroll.jsx promises. EXACT: the numbers fall straight out of the fixture, and
// the two files move together.
const LOT_ID = 'lot-ristra'
const LOT_PATH = `/inventory/${LOT_ID}`
const LOT_TITLE = 'Ristra Cayenne II Saved seed 2026'
const PLANTING_PATH = '/plantings/pl-ristra'
const SAVED_CARDS = 20        // 16 saved lots, Ristra, 3 stored after it; the two bought packets are not lots
const PEPPER_ROWS = 13        // 11 pepper lots, Ristra, the Serrano packet
// "Deep": past anything a one-screen loading shell can hold under the app's chrome. The lot page's Shell
// and PlantingDetail's are 100dvh-tall first paints, so the most a clamp can leave is the chrome itself
// (BAR_H + BOTTOM_NAV_HEIGHT_PX = 108 today); 300 keeps a clobbered offset from ever equalling the real
// one, at every viewport.
const DEEP_MIN_PX = 300
// The card's / row's viewport top after Back, against before: sub-pixel layout noise only.
const TOP_TOL_PX = 1
// Flow h scrolls the list on after the X (real wheel input, UP so the card stays in the band at every
// viewport) and must then find it there after Back. The move has to be large enough that the offset saved
// before Search can never pass for the new one.
const NUDGE_PX = 160
const NUDGE_MIN_PX = 100

const SEL = {
  toSaved: `d.querySelector('[data-testid="harness-to-saved"]')`,
  toMine: `d.querySelector('[data-testid="harness-to-mine"]')`,
  savedView: `d.querySelector('${tid('saved-seeds-view')}')`,
  mineView: `d.querySelector('${tid('my-seeds-view')}')`,
  savedCards: `d.querySelectorAll('${tid('seed-lot-card')}')`,
  card: `d.querySelector('${tid('seed-lot-card')}[data-lot-id="${LOT_ID}"]')`,
  cardTitle: `d.querySelector('${tid('seed-lot-card')}[data-lot-id="${LOT_ID}"] ${tid('seed-lot-title')}')`,
  savedFrom: `d.querySelector('${tid('seed-lot-card')}[data-lot-id="${LOT_ID}"] ${tid('lot-source-plant')}')`,
  pepperHeader: `d.querySelector('${tid('my-seeds-group')}[data-group-slug="pepper"] ${tid('facet-group-header')}')`,
  pepperRows: `d.querySelectorAll('${tid('my-seeds-group')}[data-group-slug="pepper"] ${tid('my-seed-row')}')`,
  row: `d.querySelector('${tid('my-seed-row')}[data-lot-id="${LOT_ID}"]')`,
  rowButton: `d.querySelector('${tid('my-seed-row')}[data-lot-id="${LOT_ID}"] > button')`,
  rowDetails: `d.querySelector('${tid('my-seed-row')}[data-lot-id="${LOT_ID}"] ${tid('my-seed-details')}')`,
  rowOpen: `(() => { const r = d.querySelector('${tid('my-seed-row')}[data-lot-id="${LOT_ID}"]'); return !!r && !!r.querySelector('${tid('my-seed-expanded')}') && !!r.querySelector(':scope > button[aria-expanded="true"]') })()`,
  stageHistory: `d.querySelector('${tid('seed-stage-history')}')`,
  // Header Search and the sheet it opens: the harness's link, and the real Sheet's dialog and X.
  openSearch: `d.querySelector('[data-testid="harness-open-search"]')`,
  searchSheet: `d.querySelector('[role="dialog"][aria-label="Search your garden"]')`,
  sheetClose: `d.querySelector('[role="dialog"][aria-label="Search your garden"] [data-sheet-close]')`,
  // BottomNav's +LOG door: the nav's button, and the row in the armed "Create new" sheet it opens.
  plusLog: `d.querySelector('[data-testid="harness-plus-log"]')`,
  createRow: `d.querySelector('[role="dialog"][aria-label="Create new"] [data-testid="harness-create-log"]')`,
  // Search's one result (flow h): a plain link to the planting, inside the sheet.
  searchResult: `d.querySelector('[role="dialog"][aria-label="Search your garden"] [data-testid="harness-search-result"]')`,
}

const FLOWS = [
  { key: 'a', name: 'saved-title', label: 'Saved seeds → the card\'s title → Back', entry: 'toSaved', view: 'saved', dest: 'lot' },
  { key: 'b', name: 'saved-from', label: 'Saved seeds → "Saved from <planting> →" → Back', entry: 'toSaved', view: 'saved', dest: 'planting' },
  { key: 'c', name: 'mine-details', label: 'My seeds → open row → "Open details →" → Back', entry: 'toMine', view: 'mine', dest: 'lot' },
  { key: 'd', name: 'saved-after-search', label: 'Saved seeds deep → header Search → its X → the card\'s title → Back', entry: 'toSaved', view: 'saved', dest: 'lot', search: 'header', searchAtDepth: true },
  { key: 'e', name: 'search-close-back', label: 'Saved seeds → header Search → its X → Back leaves Seeds', entry: 'toSaved', view: 'saved', dest: 'leave', search: 'header' },
  { key: 'f', name: 'pluslog-close-back', label: 'Saved seeds → +LOG → "Log an event" → its X → Back leaves Seeds', entry: 'toSaved', view: 'saved', dest: 'leave', search: 'pluslog' },
  { key: 'g', name: 'search-double-x', label: 'Saved seeds → header Search → its X double-tapped → Back leaves Seeds', entry: 'toSaved', view: 'saved', dest: 'leave', search: 'header', doubleTap: true },
  { key: 'h', name: 'search-result-back-x', label: 'Saved seeds deep → header Search → a result → Back → its X → scrolled on → the card\'s title → Back', entry: 'toSaved', view: 'saved', dest: 'lot', search: 'header', searchAtDepth: true, viaResult: true, nudge: true },
  { key: 'i', name: 'search-reload-x', label: 'Saved seeds deep → header Search → the app reloads under it → its X → scrolled on → the card\'s title → Back', entry: 'toSaved', view: 'saved', dest: 'lot', search: 'header', searchAtDepth: true, reloadUnder: true, nudge: true },
]

const failures = []
const fail = (m) => failures.push(m)
const shots = []

async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — another harness or Chrome is running there. Set GATE_HARNESS_PORT / GATE_CDP_PORT to free ports; measuring through it would measure that process's page.`)
}

let harnessLog = ''
async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  const config = isAbsolute(HARNESS_CONFIG) ? HARNESS_CONFIG : resolve(ROOT, HARNESS_CONFIG)
  if (!existsSync(config)) throw new Error(`harness config ${config} does not exist`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
  // Spawned through vite's own bin, NOT `npx vite`: npx is a wrapper, so killing it at teardown orphans
  // the real server and hangs any caller that pipes this script's stdout.
  const proc = spawn(process.execPath, [bin, '--config', config, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (d) => { harnessLog += d })
  proc.stderr.on('data', (d) => { harnessLog += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/seedsscroll.html`)
      if (r.ok) return proc
    } catch { /* not listening yet */ }
    if (proc.exitCode != null) throw new Error(`harness vite exited (${proc.exitCode}):\n${harnessLog}`)
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`harness vite never served :${PORT} within 30s:\n${harnessLog}`)
}

async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  await assertPortFree(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP')
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    // Larger than any frame under test: the iframe, not the window, sets the device geometry (trap 1).
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  // 60s by default, as the siblings: 15s was marginal on a loaded GitHub runner. CDP_WAIT_MS overrides.
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
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

// One browser-level socket; each flow gets its own tab (target) and flattened session on it.
async function connect(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) {
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id)
      clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  // Each call's timeout is CLEARED when its answer lands, so a passing run exits as soon as it is done.
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 90000)
    pending.set(mid, { res, rej, timer })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { ws, send }
}

// ── One tab ─────────────────────────────────────────────────────────────────────────────────────────
// Everything below runs in the HOST page and reaches into the frame, same origin: `f` the iframe element,
// `w` its window, `d` its document — re-read on every call, since the frame's document is replaced once
// when it loads the harness.
const FRAME_VARS = `const f = document.getElementById('frame'), w = f && f.contentWindow, d = w && w.document`
const BAND = `const topBar = d.querySelector('header[data-app-chrome="top"]'), nav = d.querySelector('nav[aria-label="Main navigation"]')
  const bandTop = topBar ? topBar.getBoundingClientRect().bottom : 0, bandBottom = nav ? nav.getBoundingClientRect().top : w.innerHeight`
// Navigations race Runtime.evaluate: dispatched a beat early, the execution context is torn down under it.
// Retried ONLY on that class of transport error; anything else still throws.
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i

function tab(cdp, sessionId) {
  const evalIn = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  const ev = async (expr, tries = 25) => {
    let last
    for (let i = 0; i < tries; i++) {
      try { return await evalIn(expr) } catch (err) {
        if (!CONTEXT_LOST.test(err.message)) throw err
        last = err
        await sleep(200)
      }
    }
    throw new Error(`page never held still long enough to evaluate: ${last?.message}`)
  }
  // A synchronous read in the frame: `body` is a function body that returns a value.
  const read = (body) => ev(`(() => { ${FRAME_VARS}; if (!d) return null; ${body} })()`)
  // Polls `cond` (an expression over f/w/d) until true; false on timeout.
  const waitIn = (cond, ms = 15000) => ev(`(async () => {
    const t0 = performance.now()
    while (performance.now() - t0 < ${ms}) {
      ${FRAME_VARS}
      try { if (d && (${cond})) return true } catch { /* not there yet */ }
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  })()`)
  // Waits until the frame's scrollY has held still for `stableMs`. Returns { settled, ms, y }.
  const settle = (stableMs, maxMs) => ev(`(async () => {
    ${FRAME_VARS}
    const t0 = performance.now(); let last = null, since = t0
    while (performance.now() - t0 < ${maxMs}) {
      await new Promise((r) => setTimeout(r, 25))
      const y = Math.round(w.scrollY * 10)
      if (y !== last) { last = y; since = performance.now() }
      else if (performance.now() - since >= ${stableMs}) return { settled: true, ms: Math.round(performance.now() - t0), y: w.scrollY }
    }
    return { settled: false, ms: ${maxMs}, y: w.scrollY }
  })()`)
  const mouse = async (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, sessionId)
  // A REAL tap, IN PLACE: the target must already be in the visible band (the scroll position is the
  // measurement, so nothing is scrolled into view), and its centre must hit-test to it — a tap that would
  // land on something else is reported, never dispatched. Returns null, or why the tap was not made.
  // `chrome: true` admits a control in the bars or a sheet over them (header Search, +LOG, a sheet's row
  // or X), which sit outside the page's band by definition; the hit-test still has to land on it.
  const tap = async (sel, what, { chrome = false } = {}) => {
    const p = await read(`const el = ${sel}; if (!el) return { missing: true }
      ${BAND}
      const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect()
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
      const inBand = y >= ${chrome ? '0' : 'bandTop'} && y <= ${chrome ? 'w.innerHeight' : 'bandBottom'} && x >= 0 && x <= w.innerWidth
      const at = inBand ? d.elementFromPoint(x, y) : null
      return { x: fr.left + x, y: fr.top + y, inBand, hits: !!at && (at === el || el.contains(at)),
        at: at ? (at.getAttribute('data-testid') || at.tagName.toLowerCase()) : 'nothing',
        box: [Math.round(r.top), Math.round(r.bottom)], band: [Math.round(bandTop), Math.round(bandBottom)] }`)
    if (!p || p.missing) return `${what} is not on the page`
    if (!p.inBand) return `${what} is not in the visible band (y${p.box[0]}-${p.box[1]}, band y${p.band[0]}-${p.band[1]})`
    if (!p.hits) return `${what} does not hit-test at its centre (lands on ${p.at})`
    await mouse('mouseMoved', p.x, p.y)
    await mouse('mousePressed', p.x, p.y, { button: 'left', clickCount: 1 })
    await mouse('mouseReleased', p.x, p.y, { button: 'left', clickCount: 1 })
    return null
  }
  // Real wheel input over the middle of the band until `sel`'s centre sits within 80px of it. Returns
  // null, or why it could not.
  const wheelTo = async (sel, what) => {
    for (let i = 0; i < 80; i++) {
      const s = await read(`const el = ${sel}; if (!el) return { missing: true }
        ${BAND}
        const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect(), mid = (bandTop + bandBottom) / 2
        return { delta: (r.top + r.bottom) / 2 - mid, y: w.scrollY, max: d.documentElement.scrollHeight - w.innerHeight,
          x: fr.left + w.innerWidth / 2, py: fr.top + mid }`)
      if (!s || s.missing) return `${what} is not on the page`
      if (Math.abs(s.delta) <= 80) return null
      if (s.delta > 0 && s.y >= s.max - 1) return null   // the page's end: as high as it will ever sit
      if (s.delta < 0 && s.y <= 0) return null
      await mouse('mouseWheel', s.x, s.py, { deltaX: 0, deltaY: Math.max(-480, Math.min(480, s.delta)) })
      await settle(120, 3000)
    }
    return `${what} could not be wheeled to the middle of the band in 80 steps`
  }
  // One real wheel of `deltaY` over the middle of the band, then held still. Returns the settle result.
  const wheelBy = async (deltaY) => {
    const s = await read(`${BAND}
      const fr = f.getBoundingClientRect()
      return { x: fr.left + w.innerWidth / 2, py: fr.top + (bandTop + bandBottom) / 2 }`)
    await mouse('mouseWheel', s.x, s.py, { deltaX: 0, deltaY })
    return settle(300, 5000)
  }
  const shoot = async (path) => {
    const c = await read(`const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }`)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...c, scale: 1 } }, sessionId)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    shots.push(path)
  }
  return { ev, read, waitIn, settle, tap, wheelTo, wheelBy, shoot }
}

// The frame's page as it stands: where it is, what the gate compares.
const READ_PAGE = (targetSel) => `${BAND}
  const el = ${targetSel}
  const r = el ? el.getBoundingClientRect() : null
  return { path: w.location.pathname, search: w.location.search, key: w.__h ? w.__h.key() : null,
    y: w.scrollY, docH: d.documentElement.scrollHeight, top: r ? r.top : null, bottom: r ? r.bottom : null,
    band: [bandTop, bandBottom] }`
const READ_LOT = `${BAND}
  const h1 = d.querySelector('h1'), r = h1 ? h1.getBoundingClientRect() : null
  const form = d.querySelector('form')
  return { path: w.location.pathname, key: w.__h ? w.__h.key() : null, y: w.scrollY, docH: d.documentElement.scrollHeight,
    h1: r ? { t: r.top, b: r.bottom, text: (h1.textContent || '').trim() } : null,
    h1InBand: !!r && r.height > 0 && r.top >= bandTop - 0.5 && r.bottom <= bandBottom + 0.5,
    formTop: form ? form.getBoundingClientRect().top : null, band: [bandTop, bandBottom] }`
const DIAG = `return { store: w.__h ? w.__h.store() : null, trace: w.__h ? w.__h.trace() : [], errors: w.__h ? w.__h.errors() : ['window.__h missing'],
  unstubbed: w.__h ? w.__h.unstubbed() : [], leftPage: !!d.querySelector('[data-testid="harness-left-page"]'),
  fallback: !!d.querySelector('[data-testid="harness-route-fallback"]') }`

const R1 = (n) => (n == null ? 'n/a' : Math.round(n * 10) / 10)
// The scroll trace, compacted to its route changes and runs of one offset.
const compactTrace = (trace) => {
  const out = []
  for (const e of trace) { const p = out[out.length - 1]; if (!p || p.path !== e.path || p.y !== e.y) out.push(e) }
  return out.slice(-16).map((e) => `${e.t}ms ${e.path} y${e.y}`).join(' → ') || 'no scroll events'
}
const storeLine = (store) => (store ? Object.entries(store).map(([k, v]) => `${k.split('|')[0]} y${R1(v?.y)}`).join(', ') : 'empty')

async function runFlow(cdp, flow, vw, vh) {
  const at = `(${flow.key})@${vw}x${vh}`
  const firstFailure = failures.length
  let reloaded = async () => ''
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    if (CPU_THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE }, sessionId)
    const t = tab(cdp, sessionId)
    const url = `http://localhost:${PORT}/tests/harness/viewport.html?page=seedsscroll.html&vw=${vw}&vh=${vh}&topbar=${TOP_CHROME_PX}`
    const nav = await cdp.send('Page.navigate', { url }, sessionId)
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
    if (!await t.waitIn(`w.__h && w.__h.ready() && d.readyState === 'complete'`, 30000)) return fail(`${at}: the harness never came up in the frame — nothing to measure`)
    await t.ev(`(async () => { ${FRAME_VARS}; if (d.fonts) await d.fonts.ready; return 1 })()`)
    // The frame's document id. A reload mid-flow (Vite re-optimizing a dependency reloads the frame at
    // whatever router URL it is on) would make every later wait time out for a reason that is not the
    // page's; say so by name.
    let boot0 = await t.read(`return w.__h.boot()`)
    reloaded = async () => {
      const b = await t.read(`return w.__h && w.__h.boot ? w.__h.boot() : null`).catch(() => null)
      return b === boot0 ? '' : ' — and the frame RELOADED mid-flow (a new document: Vite re-optimizing a dependency does this), so this run did not measure the flow'
    }

    // ── INSTRUMENT CHECK: the geometry and the chrome.
    const g = await t.read(`${BAND}
      const fr = f.getBoundingClientRect()
      return { vw: w.innerWidth, vh: w.innerHeight, cw: d.documentElement.clientWidth, top: topBar ? topBar.getBoundingClientRect().height : null,
        nav: nav ? nav.getBoundingClientRect().height : null, frame: { l: fr.left, t: fr.top, r: fr.right, b: fr.bottom },
        host: { w: window.innerWidth, h: window.innerHeight } }`)
    const geo = []
    if (g.vw !== vw || g.vh !== vh) geo.push(`the frame self-reports ${g.vw}x${g.vh}, not ${vw}x${vh} — every coordinate would be from the wrong layout`)
    if (g.cw !== vw) geo.push(`the frame's clientWidth is ${g.cw}, not ${vw} — a scrollbar gutter is taking layout width`)
    if (g.frame.r > g.host.w || g.frame.b > g.host.h) geo.push(`the frame (${g.frame.r}x${g.frame.b}) does not fit the ${g.host.w}x${g.host.h} host window — taps outside it go nowhere`)
    if (g.top !== TOP_CHROME_PX) geo.push(`the top-bar stand-in is ${g.top}px, expected TopChrome's BAR_H ${TOP_CHROME_PX}px`)
    if (g.nav !== BOTTOM_NAV_HEIGHT_PX) geo.push(`the bottom-nav stand-in is ${g.nav}px, expected BOTTOM_NAV_HEIGHT_PX ${BOTTOM_NAV_HEIGHT_PX}px`)
    if (geo.length) return fail(`${at}: ${geo.join('; ')}`)

    // ── Into the Seeds page: a real tap on the /today stand-in's link, a PUSH.
    const why0 = await t.tap(SEL[flow.entry], `the /today link to ${flow.view === 'saved' ? 'Saved seeds' : 'My seeds'}`)
    if (why0) return fail(`${at}: ${why0}`)
    const viewSel = flow.view === 'saved' ? SEL.savedView : SEL.mineView
    const arrived = flow.view === 'saved' ? `${viewSel} && ${SEL.card}` : `${viewSel} && ${SEL.pepperHeader}`
    if (!await t.waitIn(`w.location.pathname === '/seeds' && (${arrived})`, 15000)) {
      const dg = await t.read(DIAG)
      return fail(`${at}: the Seeds page never showed ${flow.view === 'saved' ? 'Saved seeds with the Ristra card' : 'My seeds with the Pepper header'} (errors: ${dg?.errors?.join(' | ') || 'none'})${await reloaded()}`)
    }
    await t.settle(300, 5000)

    // ── An overlay over Seeds, opened and closed by its X (flows d to h): real taps on a real OverlayLink or
    // the real +LOG door, and the real Sheet's close. Instrument checks only — the close's consequences are
    // read by the invariants. Returns a failure message, or null.
    let searchNote = ''
    const openAndClose = async () => {
      const k0 = await t.read(`return w.__h.key()`)
      const idx0 = await t.read(`return w.history.state ? w.history.state.idx : null`)
      if (flow.search === 'pluslog') {
        // +LOG: the armed sheet must really push its Back marker, or the row opens by push and this flow
        // is header Search again.
        const whyP = await t.tap(SEL.plusLog, '+LOG', { chrome: true })
        if (whyP) return `${at}: ${whyP}`
        if (!await t.waitIn(`${SEL.createRow} && w.history.state && w.history.state.__backnav`, 8000)) return `${at}: +LOG was tapped and the armed "Create new" sheet never showed with its Back marker pushed${await reloaded()}`
        await t.settle(200, 3000)
        const whyR = await t.tap(SEL.createRow, 'the "Log an event" row', { chrome: true })
        if (whyR) return `${at}: ${whyR}`
      } else {
        const whyS = await t.tap(SEL.openSearch, 'header Search', { chrome: true })
        if (whyS) return `${at}: ${whyS}`
      }
      if (!await t.waitIn(`w.location.pathname === '/search' && ${SEL.sheetClose}`, 8000)) return `${at}: the overlay never opened on /search${await reloaded()}`
      const kOpen = await t.read(`return w.__h.key()`)
      if (kOpen == null || kOpen === k0) return `${at}: opening the overlay did not write a new history entry (key ${kOpen}; Seeds was on ${k0})`
      if (flow.search === 'pluslog') {
        const o = await t.read(`return { idx: w.history.state ? w.history.state.idx : null, marker: !!(w.history.state && w.history.state.__backnav) }`)
        if (o.idx !== idx0 || o.marker) return `${at}: the +LOG row did not open the overlay by REPLACE into the marker's slot (overlay idx ${o.idx}, Seeds idx ${idx0}, marker still current: ${o.marker}) — this is not the door under test`
      }
      await t.settle(200, 3000)
      if (flow.reloadUnder) {
        // (i) The app reloads with Search open (the service worker's post-update reload, an Android tab
        // restore): a NEW document on Search's own entry, sessionStorage kept. Seeds re-mounts under the
        // sheet, and the X can no longer walk back across documents, so it must REPLACE.
        const bootA = await t.read(`return w.__h.boot()`)
        await t.ev(`(() => { ${FRAME_VARS}; w.__h.reloadHere(); return 1 })()`)
        if (!await t.waitIn(`w.__h && w.__h.boot() !== '${bootA}' && w.__h.reloadedDoc() && w.location.pathname === '/search' && ${SEL.sheetClose} && ${SEL.card}`, 30000)) {
          return `${at}: the reload under Search never came back with Search open over the Seeds page (on ${await t.read(`return w.location.pathname`).catch(() => 'an unreadable frame')})`
        }
        boot0 = await t.read(`return w.__h.boot()`)   // this reload is the one under test, not a Vite one
        const kR = await t.read(`return w.__h.key()`)
        if (kR !== kOpen) return `${at}: after the reload the frame is on key ${kR}, not Search's own ${kOpen} — the reload did not keep the history entry`
        await t.settle(500, 8000)
        const underR = await t.read(`return w.scrollY`)
        searchNote += ` · the app reloaded under Search: Seeds re-mounted at y${R1(underR)}`
      }
      if (flow.viaResult) {
        // (h) Out to a result and Back: Search re-opens on its own entry over a Seeds page that has just
        // re-MOUNTED under the sheet — the precondition, checked by the harness's mount count, not assumed.
        const m0 = await t.read(`return w.__h.seedsMounts()`)
        const whyR = await t.tap(SEL.searchResult, 'Search\'s result', { chrome: true })
        if (whyR) return `${at}: ${whyR}`
        if (!await t.waitIn(`w.location.pathname === '${PLANTING_PATH}' && d.querySelector('[data-testid="harness-planting"]')`, 15000)) return `${at}: Search's result was tapped and the planting (${PLANTING_PATH}) never arrived${await reloaded()}`
        const kRes = await t.read(`return w.__h.key()`)
        if (kRes == null || kRes === kOpen) return `${at}: Search's result did not PUSH a new entry (key ${kRes}; Search was on ${kOpen})`
        await t.settle(300, 5000)
        await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
        if (!await t.waitIn(`w.location.pathname === '/search' && ${SEL.sheetClose} && ${SEL.card}`, 15000)) return `${at}: Back from the result never re-opened Search over the Seeds page${await reloaded()}`
        const kBack = await t.read(`return w.__h.key()`)
        if (kBack !== kOpen) return `${at}: Back from the result landed on key ${kBack}, not Search's own ${kOpen}`
        const m1 = await t.read(`return w.__h.seedsMounts()`)
        if (!(m1 > m0)) return `${at}: the Seeds page did not re-mount under Search after Back (mounts ${m0} → ${m1}) — this is not the path under test`
        await t.settle(500, 8000)
        const under = await t.read(`return w.scrollY`)
        searchNote += ` · out to the result and Back: Seeds re-mounted under Search at y${R1(under)}`
      }
      let goCalls = null
      if (flow.doubleTap) {
        // Two presses on the X's centre back to back, the second landing while the first close is still in
        // flight. history.go is counted (not replaced) so the note says how many walks were started.
        const p = await t.read(`const el = ${SEL.sheetClose}; if (!el) return null; const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect()
          w.__goCalls = []; const og = w.history.go.bind(w.history); w.history.go = (n) => { w.__goCalls.push(n); return og(n) }
          return { x: fr.left + (r.left + r.right) / 2, y: fr.top + (r.top + r.bottom) / 2 }`)
        if (!p) return `${at}: the overlay sheet's X is not on the page`
        for (let i = 0; i < 2; i++) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sessionId)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sessionId)
        }
      } else {
        const whyC = await t.tap(SEL.sheetClose, 'the overlay sheet\'s X', { chrome: true })
        if (whyC) return `${at}: ${whyC}`
      }
      if (!await t.waitIn(`w.location.pathname === '/seeds' && !${SEL.searchSheet} && ${SEL.card}`, 8000)) return `${at}: the overlay sheet's X was tapped and the sheet never closed back onto Seeds${await reloaded()}`
      await t.settle(300, 5000)
      const kClosed = await t.read(`return w.__h.key()`)
      if (flow.doubleTap) goCalls = await t.read(`return w.__goCalls || null`)
      if (flow.reloadUnder) {
        // The precondition of (i): a close after a reload cannot prove where Seeds' entry is, so it replaces.
        if (kClosed === k0) return `${at}: ${flow.label}: after the reload the X walked back onto Seeds' own entry instead of replacing — not the path under test`
        const stamp = await t.read(`return w.history.state && w.history.state.usr ? (w.history.state.usr.continuesEntry ?? null) : null`)
        searchNote += ` · the X replaced (stamped to continue ${stamp})`
      }
      searchNote += ` · the overlay closed onto key ${kClosed} (Seeds' own entry ${k0}: ${kClosed === k0 ? 'the same' : 'A NEW ONE'})${goCalls ? ` · history.go calls ${JSON.stringify(goCalls)}` : ''}`
      // A double-tapped X must not re-key the page: the second press lands in the window where history
      // is already back on Seeds' entry but the sheet is still on screen, and a replace there overwrites it.
      if (flow.doubleTap && kClosed !== k0) return `${at}: ${flow.label}: the double-tapped X re-keyed Seeds${searchNote}`
      return null
    }
    if (flow.search && !flow.searchAtDepth) {
      const why = await openAndClose()
      if (why) return fail(why)
    }

    if (flow.dest === 'leave') {
      // ── The first Back after the close must leave Seeds for /today, the entry before it.
      await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
      const left = await t.waitIn(`w.location.pathname === '/today' && d.querySelector('[data-testid="harness-to-saved"]')`, 5000)
      const where = await t.read(`return w.location.pathname + w.location.search`)
      const rl = await reloaded()
      if (rl) return fail(`${at}: the flow ran across two documents${rl}`)
      if (!left) return fail(`${at}: ${flow.label}: the first Back after closing the overlay stayed on ${where} — the close left a second copy of the Seeds entry behind it, so this Back did nothing${searchNote}`)
      console.log(`[seeds-scroll] ${at} ${flow.label}: Back landed on ${where}${searchNote}`)
      return
    }

    let targetSel, tapSel, tapWhat
    if (flow.view === 'saved') {
      const n = await t.read(`return ${SEL.savedCards}.length`)
      if (n !== SAVED_CARDS) return fail(`${at}: Saved seeds shows ${n} lot cards, the fixture promises ${SAVED_CARDS} — this is not the list the flow is built on`)
      const whyW = await t.wheelTo(SEL.card, 'the Ristra card')
      if (whyW) return fail(`${at}: ${whyW}`)
      if (flow.searchAtDepth) {
        // (d) The overlay opens and closes with the list DEEP, so the close itself is measured: it is a
        // history traversal now, and Chrome restores the entry's offset on it. The list must hold still.
        await t.settle(400, 5000)
        const pre = await t.read(READ_PAGE(SEL.card))
        const why = await openAndClose()
        if (why) return fail(why)
        const post = await t.read(READ_PAGE(SEL.card))
        if (Math.round(post.y) !== Math.round(pre.y) || Math.abs(post.top - pre.top) > TOP_TOL_PX) {
          const what = flow.viaResult ? 'after a result and Back, the X did not bring the list back where it was'
            : flow.reloadUnder ? 'after the app reloaded under Search, the X did not bring the list back where it was'
            : 'closing the overlay moved the list'
          return fail(`${at}: ${flow.label}: ${what}: scrollY ${R1(pre.y)} → ${R1(post.y)}, the card's top y${R1(pre.top)} → y${R1(post.top)}${searchNote}`)
        }
        searchNote += ` · the list ${flow.viaResult || flow.reloadUnder ? 'was back' : 'held'} at y${R1(post.y)} through the close`
      }
      if (flow.nudge) {
        // (h) Scrolled on after the X, the new place must be what Back from the lot restores. A page that
        // could not save after the close lands on the offset it saved before Search instead.
        const n0 = await t.read(READ_PAGE(SEL.card))
        const moved = await t.wheelBy(-NUDGE_PX)
        const n1 = await t.read(READ_PAGE(SEL.card))
        if (!moved.settled) return fail(`${at}: after the nudge the list never held still for 300ms within 5s (last y${R1(moved.y)})`)
        if (Math.abs(n1.y - n0.y) < NUDGE_MIN_PX) return fail(`${at}: the wheel after the close moved the list ${R1(n1.y - n0.y)}px (need >= ${NUDGE_MIN_PX}) — the offset saved before Search could pass for the new one, so the flow would prove nothing`)
        searchNote += ` · scrolled on after the close: y${R1(n0.y)} → y${R1(n1.y)}`
      }
      targetSel = SEL.card
      tapSel = flow.dest === 'planting' ? SEL.savedFrom : SEL.cardTitle
      tapWhat = flow.dest === 'planting' ? 'the Ristra card\'s "Saved from <planting> →"' : 'the Ristra card\'s title'
    } else {
      // My seeds opens FOLDED: open Pepper, then the Ristra row, each a real tap.
      const whyH = await t.tap(SEL.pepperHeader, 'the Pepper group header')
      if (whyH) return fail(`${at}: ${whyH}`)
      if (!await t.waitIn(`${SEL.rowButton}`, 8000)) return fail(`${at}: the Pepper header was tapped and the Ristra row never showed`)
      await t.settle(200, 3000)
      const n = await t.read(`return ${SEL.pepperRows}.length`)
      if (n !== PEPPER_ROWS) return fail(`${at}: the Pepper group shows ${n} rows, the fixture promises ${PEPPER_ROWS}`)
      const whyW = await t.wheelTo(SEL.row, 'the Ristra row')
      if (whyW) return fail(`${at}: ${whyW}`)
      const whyR = await t.tap(SEL.rowButton, 'the Ristra row')
      if (whyR) return fail(`${at}: ${whyR}`)
      if (!await t.waitIn(`${SEL.rowDetails}`, 8000)) return fail(`${at}: the Ristra row was tapped and did not open ("Open details →" never showed)`)
      await t.settle(200, 3000)
      // "Open details →" sits under the row's facts; bring it into the band if the opening pushed it out.
      const inBand = await t.read(`const el = ${SEL.rowDetails}; ${BAND}; const r = el.getBoundingClientRect(); return r.top >= bandTop && r.bottom <= bandBottom`)
      if (!inBand) {
        const whyD = await t.wheelTo(SEL.rowDetails, '"Open details →"')
        if (whyD) return fail(`${at}: ${whyD}`)
      }
      targetSel = SEL.row
      tapSel = SEL.rowDetails
      tapWhat = 'the Ristra row\'s "Open details →"'
    }
    await t.settle(400, 5000)
    const before = await t.read(READ_PAGE(targetSel))
    const rlList = await reloaded()
    if (rlList) return fail(`${at}: the list is not the document the flow started on${rlList}`)
    if (!before || before.top == null) return fail(`${at}: the flow's card/row is gone before the tap`)
    if (before.y < DEEP_MIN_PX) return fail(`${at}: the list is only ${R1(before.y)}px down before the tap (need >= ${DEEP_MIN_PX}) — a clobbered offset could equal it, so the flow proves nothing`)
    if (flow.view === 'mine' && !await t.read(`return ${SEL.rowOpen}`)) return fail(`${at}: the Ristra row is not open before the tap`)
    await t.ev(`(() => { ${FRAME_VARS}; return w.__h.mark() })()`)

    // ── The tap out: a PUSH onto the lot page or the planting.
    const why = await t.tap(tapSel, tapWhat)
    if (why) return fail(`${at}: ${why}`)
    let lot = null
    if (flow.dest === 'lot') {
      const ok = await t.waitIn(`w.location.pathname === '${LOT_PATH}' && d.querySelector('form') && d.querySelector('h1') && ${SEL.stageHistory} && !/Loading/.test(${SEL.stageHistory}.textContent || '')`, 15000)
      if (!ok) {
        const dg = await t.read(DIAG)
        return fail(`${at}: ${tapWhat} was tapped and the lot page never arrived (form, h1, stage history)${dg?.leftPage ? ' — the router LEFT for an unexpected route' : ''}${dg?.errors?.length ? ` · errors: ${dg.errors.join(' | ')}` : ''}${await reloaded()}`)
      }
      await t.settle(500, 6000)
      lot = await t.read(READ_LOT)
      await t.shoot(join(OUTDIR, `seeds-scroll-${flow.key}-lot-${vw}x${vh}.png`))
      const rl = await reloaded()
      if (rl) return fail(`${at}: the lot page is not the document the list was on${rl}`)
      if (lot.key == null || lot.key === before.key) return fail(`${at}: the lot page is on history key ${lot.key}, the list was on ${before.key} — the tap did not PUSH a new entry, so Back has nothing to return from`)
      if (!lot.h1 || !lot.h1.text.includes(LOT_TITLE)) return fail(`${at}: the lot page's h1 reads "${lot.h1?.text}", expected it to name "${LOT_TITLE}" — the wrong lot opened`)
    } else {
      const ok = await t.waitIn(`w.location.pathname === '${PLANTING_PATH}' && d.querySelector('[data-testid="harness-planting"]')`, 15000)
      if (!ok) return fail(`${at}: ${tapWhat} was tapped and the planting (${PLANTING_PATH}) never arrived${await reloaded()}`)
      await t.settle(400, 6000)
      const p = await t.read(READ_PAGE('null'))
      await t.shoot(join(OUTDIR, `seeds-scroll-${flow.key}-planting-${vw}x${vh}.png`))
      const rl = await reloaded()
      if (rl) return fail(`${at}: the planting is not the document the list was on${rl}`)
      if (p.key == null || p.key === before.key) return fail(`${at}: the planting is on history key ${p.key}, the list was on ${before.key} — the tap did not PUSH a new entry`)
    }
    const away = await t.read(DIAG)

    // ── Back: a real history traversal onto the list's own entry.
    await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
    const backSel = flow.view === 'saved' ? SEL.card : SEL.row
    if (!await t.waitIn(`w.location.pathname === '/seeds' && ${backSel}`, 15000)) return fail(`${at}: Back never brought the Seeds page back with the ${flow.view === 'saved' ? 'Ristra card' : 'Ristra row'} on it${await reloaded()}`)
    const st = await t.settle(800, 10000)
    const after = await t.read(READ_PAGE(backSel))
    const open = flow.view === 'mine' ? await t.read(`return ${SEL.rowOpen}`) : null
    const dg = await t.read(DIAG)
    await t.shoot(join(OUTDIR, `seeds-scroll-${flow.key}-back-${vw}x${vh}.png`))
    const rl = await reloaded()
    if (rl) return fail(`${at}: the flow ran across two documents${rl}`)
    if (dg.errors.length) return fail(`${at}: the page raised ${dg.errors.length} error(s): ${dg.errors.join(' | ')}`)
    if (after.key !== before.key) return fail(`${at}: Back landed on history key ${after.key}, not the list's own ${before.key} — the Back measured is not the one the offset was taken on`)
    if (`${after.path}${after.search}` !== `${before.path}${before.search}`) return fail(`${at}: Back landed on ${after.path}${after.search}, the list was ${before.path}${before.search}`)

    // ── THE INVARIANTS.
    const lotMsg = lot ? `lot page y${R1(lot.y)} (h1 y${R1(lot.h1.t)}-${R1(lot.h1.b)}, band y${R1(lot.band[0])}-${R1(lot.band[1])}, form top y${R1(lot.formTop)})` : 'planting reached'
    if (lot) {
      if (Math.round(lot.y) !== 0) fail(`${at}: ${flow.label}: the lot page landed at scrollY ${R1(lot.y)}, not 0 — it opened scrolled down, h1 at y${R1(lot.h1.t)}, form top at y${R1(lot.formTop)} (BUG-SEEDLOTOPENSATFORM-001) · scroll trace since the tap: ${compactTrace(away.trace)}`)
      if (!lot.h1InBand) fail(`${at}: ${flow.label}: the lot page's h1 is at y${R1(lot.h1.t)}-${R1(lot.h1.b)}, not inside the visible band y${R1(lot.band[0])}-${R1(lot.band[1])}`)
    }
    if (!st.settled) fail(`${at}: ${flow.label}: after Back the list never held still for 800ms within 10s (last y${R1(st.y)})`)
    if (Math.round(after.y) !== Math.round(before.y)) {
      fail(`${at}: ${flow.label}: Back landed at scrollY ${R1(after.y)}, the list was at ${R1(before.y)} — the place was lost (${flow.viaResult || flow.reloadUnder ? 'BUG-OVERLAYRELOADKEY-001' : 'BUG-SAVEDSEEDSBACKTOP-001'}) · stored offsets when the tap had left: ${storeLine(away.store)}`)
    }
    if (Math.abs(after.top - before.top) > TOP_TOL_PX) fail(`${at}: ${flow.label}: after Back the ${flow.view === 'saved' ? 'card' : 'row'}'s top is at y${R1(after.top)}, it was at y${R1(before.top)} (±${TOP_TOL_PX}px) — not where the finger left it${after.top > after.band[1] ? ', OFF SCREEN below the band' : ''}`)
    if (flow.view === 'mine' && !open) fail(`${at}: ${flow.label}: after Back the Ristra row is CLOSED — it was open when the finger left`)

    console.log(`[seeds-scroll] ${at} ${flow.label}: before y${R1(before.y)} (${flow.view === 'saved' ? 'card' : 'row'} top y${R1(before.top)}, page ${Math.round(before.docH)}px) · ${lotMsg} · stored ${storeLine(away.store)} · Back y${R1(after.y)} in ${st.ms}ms, ${flow.view === 'saved' ? 'card' : 'row'} top y${R1(after.top)}${open != null ? `, row ${open ? 'open' : 'CLOSED'}` : ''}${searchNote}${dg.unstubbed.length ? ` · unstubbed: ${[...new Set(dg.unstubbed)].join(', ')}` : ''}`)
  } finally {
    // Whatever this flow failed on, a reload in the middle of it is the first thing to know.
    if (failures.length > firstFailure) {
      const rl = await reloaded().catch(() => '')
      if (rl) for (let i = firstFailure; i < failures.length; i++) if (!failures[i].includes('RELOADED')) failures[i] += rl
    }
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-seedsscroll-'))
try {
  if (BASELINE_SHA) console.log(`[seeds-scroll] BASELINE RUN — HARNESS_BASELINE_SHA=${BASELINE_SHA}: src/** is served from that commit. This is not a clean run.`)
  if (CUSTOM_CONFIG) console.log(`[seeds-scroll] CUSTOM HARNESS CONFIG — GATE_HARNESS_CONFIG=${HARNESS_CONFIG}. This is not a clean run.`)
  if (ONLY.length) console.log(`[seeds-scroll] GATE_ONLY=${ONLY.join(',')} — only those flows ran. This is not a clean run.`)
  if (ONLY.some((k) => !FLOWS.some((fl) => fl.key === k))) throw new Error(`GATE_ONLY names a flow that does not exist (${ONLY.join(',')}) — the run would pass over nothing`)
  if (CPU_THROTTLE > 1) console.log(`[seeds-scroll] CPU THROTTLED — GATE_CPU_THROTTLE=${CPU_THROTTLE}: every tab runs ${CPU_THROTTLE}x slower. This is not a clean run.`)
  if (PROBE_NOTHING) console.log('[seeds-scroll] --probe-nothing: every app testid points at one nothing renders. This run MUST fail.')
  for (const d of harnessCopyDrift()) fail(`harness drift: ${d}`)
  mkdirSync(OUTDIR, { recursive: true })
  harness = await startHarness()
  if (BASELINE_SHA && !/\[harness\] serving src\/\*\* from git [0-9a-f]{40}/.test(harnessLog)) {
    throw new Error(`HARNESS_BASELINE_SHA is set but the harness never printed "[harness] serving src/** from git <sha>" — it is serving the working tree, so a baseline result would be a lie`)
  }
  chrome = await startChrome(udd)
  cdp = await connect(chrome.version.webSocketDebuggerUrl)
  for (const [vw, vh] of VIEWPORTS) {
    for (const flow of FLOWS.filter((fl) => !ONLY.length || ONLY.includes(fl.key))) {
      try { await runFlow(cdp, flow, vw, vh) } catch (err) { fail(`(${flow.key})@${vw}x${vh}: the flow could not complete: ${err.message}`) }
    }
  }
} catch (err) {
  fail(`gate could not complete: ${err.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

// A non-clean run echoes what its harness said it served ("[harness] serving src/** from git …", or a
// custom config's own tagged lines), so the record names the source it measured.
if (BASELINE_SHA || CUSTOM_CONFIG) {
  for (const line of harnessLog.split('\n').filter((l) => /^\[[a-z][a-z-]*\] /.test(l))) console.log(`[seeds-scroll] harness said: ${line}`)
}
if (shots.length) console.log(`[seeds-scroll] screenshots: ${shots.map((p) => p.replace(`${ROOT}/`, '')).join(', ')}`)
// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner says which.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[seeds-scroll] FAIL — EXPECTED. --probe-nothing pointed every app testid at one nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[seeds-scroll] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[seeds-scroll] FAIL — and this one is the real defect: every testid pointed at nothing and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[seeds-scroll] PASS')
