#!/usr/bin/env node
// page-scroll.mjs — BUG-DETAILPAGESCARRYSCROLL-001, in real Chrome: a page opened from a scrolled page opens
// at its TOP, and Back returns the page you left to its EXACT place.
//
//   node scripts/layout-gate/page-scroll.mjs [--outdir dir]     # npm run gate:page-scroll
//   node scripts/layout-gate/page-scroll.mjs --probe-nothing    # prove the instrument fires; MUST exit 1
//
// WHY IT EXISTS. BrowserRouter never resets scroll on a push: the arriving page paints a one-screen loading
// shell, Chrome clamps the old offset to it, and scroll ANCHORING re-applies the old offset once the content
// lands — 9 of 10 pages measured opened part-way down (Projects/Gardening/_seedstab12_20260925/
// measure-detailscroll.md). And today's "Back keeps my place" on those pages rides the same carry, so a
// reset alone breaks Back. The fix is the app-level page-scroll manager (src/hooks/usePageScrollManager.js,
// decisions in src/lib/pageScroll.js): a reset when the page tree reaches a different page, a restore on
// POP that re-applies until the target holds, under history.scrollRestoration = 'manual'. None of that —
// the clamp, the anchoring, a traversal's timing, a page that loads in two stages — exists in jsdom.
//
// DRIVES tests/harness/pagescroll.{html,jsx}: the real pages under BrowserRouter in App.jsx's shell, with the
// REAL manager called exactly as AppShell calls it (the drift guard below fails otherwise), the network
// stubbed with a loading phase, inside tests/harness/viewport.html — the IFRAME HOST: headless Chrome floors a
// window near 500px, an iframe is a real layout viewport at any size. Every tap and scroll is real input (CDP
// mouse press/release hit-tested at the target's centre first; mouse-wheel scrolling), and Back is a real
// history traversal (history.back() in the frame: popstate, as the Android back gesture). Each flow opens in
// a FRESH TAB, so its history, storage and module state are its own.
//
// THE FLOWS, at each viewport (426x836 — Dave's handset — and 360x640; GATE_VIEWPORTS overrides). Every page a
// flow PUSHES onto must land at scrollY 0 with its title inside the visible band; every Back must land at the
// exact scrollY the page was left at, with the element tapped at the same viewport top (±1px):
//   eventlog      a planting's Event log, deep → an event → Back. The page loads in TWO stages (header, then
//                 the log): the restore has to outlast both. Shipped app: Back lost the place (4658 → 0).
//   zones         Zones, a row deep in the list → the zone → Back.
//   zones-slow    as zones, every page GET 5 s slow (a cold Lambda): the 4 s prototype landed 56 of 1645.
//   leave-during-load  as zones with every GET 3 s slow, but away by a tab WHILE the Back is still loading, then
//                 Back again: the restore's clamped attempts were never filed (rimpact IMPORTANT-3).
//   more          a long list, deep → More → Achievements (a REPLACE into the Back marker's slot) → Back. Its
//                 Back frames also carry the 'manual' check: until the path changes, the outgoing page must
//                 not move (with 'auto' Chrome applies the popped offset to the still-mounted page first).
//   search        a long list, deep → header Search → a result (a push out of the overlay) → Back: Search
//                 re-opens over the list AT its place → the X → still there.
//   garden-back   Garden, deep → a planting → Back → Garden at its spot (Garden restores itself).
//   garden-tab    Garden, deep → Today tab → Garden tab → Garden at its spot ("back to your spot" on a push).
//   garden-tab-4x as garden-tab with the tab's CPU throttled 4x: Garden's snapshot must not lose the spot to
//                 the reset's scroll event on a slow commit (rimpact MINOR-2).
//   garden-add    Garden, deep → + → "Add a planting" (/garden?add=1, a REPLACE onto the SAME page) → the
//                 editor opens (its ?add strip is another same-page REPLACE) → its X → Garden where it was.
//   putup         Put-Up's Going-now list, deep → a batch (?batch=, a same-page PUSH) → Back → the list's place.
//   seeds-switch  My seeds, a little down → the view switch to Saved seeds (a same-page REPLACE) → no jump.
//   same-replace  a long list, deep → its sort control (a same-page REPLACE) → no jump → a row → Back → the
//                 place, now filed under the new entry.
//   hook-seeded   Saved seeds, deep → a lot → the manager's store EMPTIED (every entry the previous bundle
//                 wrote) → Back → Saved seeds' own restore puts it back (rimpact BLOCKING-2).
//   hook-top      Harvests at the top → a long list, deep → Back → Harvests at the top, not the list's carry.
//   shrink-x      a long list, deep → header Search → the list blanks behind the sheet (a refetch) and is still
//                 short at the close → the X → its rows land → the list where it was (rimpact IMPORTANT-2:
//                 'manual' removed Chrome's restore on the close, so the manager's snapshot must). A list that
//                 grows back while STILL covered is carried back by Chromium itself, snapshot or not (measured),
//                 so that shape is not a flow: it could not fail.
//   shrink-back   as shrink-x, closed by the system Back.
//   shrink-marker as shrink-back under the More sheet (a DismissRegistry Back marker, which the router never
//                 sees until its pop).
//   lot-edit      a seed lot, deep → "Edit sow details →" → the variety editor → its Cancel (navigate(-1)) →
//                 the lot where it was (Dave's "opens at the top unless you arrived from an edit").
//   reload        Zones, deep → the app reloads on that entry (SW post-update reload, a tab restore) → the place.
//   deep25        twenty-five pages deep, each left at its own offset → Back twenty-five times → each place
//                 (the manager keeps 100 entries; useScrollRestore's own store keeps 20).
// Every number is printed on pass as well as fail.
//
// THE INSTRUMENT CHECK comes first in every flow, and a mismatch stops the flow before any invariant is read:
// the frame self-reports the viewport asked for (innerWidth/innerHeight, a clientWidth with no gutter), the
// chrome stand-ins are TopChrome's BAR_H and BOTTOM_NAV_HEIGHT_PX, the harness's latency is the flow's, the
// page raised no error, every source is DEEP (>= DEEP_MIN_PX, past anything a loading shell can hold) or,
// for the same-page switch, far enough down that a jump to 0 is visible, each tap hit-tests to its target IN
// PLACE (the gate never scrolls a target into view: the scroll position IS the measurement), a push really
// wrote a new history entry, Back returned to the very entry the offset was taken on (same react-router key),
// and the frame stayed ONE document (a reload mid-flow — Vite re-optimizing a dependency — is named, never
// measured; the reload flow's own reload is the one exception, checked for instead). A selector that matched
// nothing is a FAILURE. `--probe-nothing` points every app testid at one nothing renders; it MUST exit 1.
//
// NON-VACUITY: see ci.yml's gate:page-scroll step and Projects/Gardening/_seedstab12_20260925/
// scrollmgr-nonvacuity-*.txt: the flag off reds the new flows by name, and each write rule, the snapshot and
// the pathname rule removed in turn (GATE_HARNESS_CONFIG) reds its named flow.
//
// SEAMS (never set in CI; a run with any of them set says so in its first lines, so it cannot pass for clean):
//   HARNESS_BASELINE_SHA — serve src/** from a git object (tests/harness/baselinePlugin.mjs).
//   GATE_HARNESS_CONFIG  — a different Vite config for the harness (a mutant, for the non-vacuity runs).
//   GATE_ONLY            — a comma-separated list of flow keys to run.
//   GATE_CPU_THROTTLE    — CDP CPU throttling for every tab (a slow runner, rehearsed on this tab alone).
//
// SCREENSHOTS: the frame's own rect on each landing and after each Back, to --outdir (artifacts/layout-gate).
//
// TRAPS THE SIBLINGS ALREADY PAID FOR (seeds-scroll.mjs): the macOS window floor (hence the iframe host), a
// backgrounded renderer that never ticks rAF (hence --disable-renderer-backgrounding), node 20.19.0's missing
// global WebSocket (resolveWebSocket), Linux fonts (every position is measured in the run and compared with
// itself), and a port that already answers belonging to somebody else (refused up front).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Read from the source, never spelled here: a gate carrying its own copy keeps passing after someone moves
// the real one.
function readOne(file, re, what) {
  const src = readFileSync(resolve(ROOT, file), 'utf8')
  const found = [...src.matchAll(re)].map((m) => m[1])
  if (found.length !== 1) throw new Error(`${file} carries ${what} ${found.length} times; expected exactly 1 — the gate cannot read it`)
  return found[0]
}
const TOP_CHROME_PX = Number(readOne('src/components/TopChrome.jsx', /const BAR_H = (\d+)/g, 'BAR_H'))

// DRIFT GUARD. The harness must mount the REAL manager exactly as AppShell does, host overlays exactly as
// App.jsx's OverlayHost does, and model BottomNav's two doors (an armed sheet of SheetRowLinks, "Add a
// planting" a page navigation). If any side moves, the flows would keep proving a shell prod no longer has.
function harnessCopyDrift() {
  const src = (f) => readFileSync(resolve(ROOT, f), 'utf8')
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const out = []
  const app = src('src/App.jsx')
  const harness = src('tests/harness/pagescroll.jsx')
  const managerCall = /usePageScrollManager\(\{ pageLocation, location: overlayLocation, navigationType, ready: [^}]*\}\)/
  const managerProvider = /<PageScrollProvider value=\{pageScroll\}>/
  const shell = app.match(/function AppShell\([\s\S]*?\n\}\n/)
  if (!shell || !managerCall.test(shell[0]) || !managerProvider.test(shell[0])) out.push('src/App.jsx AppShell no longer calls usePageScrollManager({ pageLocation, location: overlayLocation, navigationType, ready }) inside <PageScrollProvider value={pageScroll}> — re-model tests/harness/pagescroll.jsx on it')
  if (!/from '\.\.\/\.\.\/src\/hooks\/usePageScrollManager\.js'/.test(harness) || !managerCall.test(harness) || !managerProvider.test(harness)) out.push('tests/harness/pagescroll.jsx no longer mounts the REAL page-scroll manager the way AppShell does — every flow would measure something else')
  // main.jsx's boot line: the browser's restore mode. The harness must make the same call, or it measures
  // Chrome's native restore ('auto'), which prod does not run.
  const bootCall = /\napplyBrowserScrollRestoration\(SCROLL_MANAGER_ENABLED\)\n/
  if (!bootCall.test(src('src/main.jsx'))) out.push('src/main.jsx no longer calls applyBrowserScrollRestoration(SCROLL_MANAGER_ENABLED) at boot — re-model the harness on whatever sets the mode now')
  if (!bootCall.test(harness)) out.push('tests/harness/pagescroll.jsx does not set the browser\'s restore mode as main.jsx does — it would measure the wrong browser')
  const body = (text, name) => {
    const m = text.match(new RegExp(`function ${name}\\(\\{ ariaLabel, size = 'peek', children \\}\\) \\{([\\s\\S]*?)\\n\\}`))
    return m ? norm(m[1]) : null
  }
  const host = body(app, 'OverlayHost')
  const copy = body(harness, 'HarnessOverlayHost')
  if (!host || !copy) out.push(`could not read ${host ? 'HarnessOverlayHost in tests/harness/pagescroll.jsx' : 'OverlayHost in src/App.jsx'} — the drift guard cannot compare them`)
  else if (host !== copy) out.push('tests/harness/pagescroll.jsx HarnessOverlayHost no longer matches src/App.jsx OverlayHost — re-copy it')
  const nav = src('src/components/BottomNav.jsx')
  if (!/\{ to: '\/garden\?add=1'/.test(nav)) out.push('BottomNav\'s + sheet no longer carries "Add a planting" → /garden?add=1 — flow garden-add models a door the app no longer has')
  if (!/<Sheet[^>]*ariaLabel="Create new"[^>]*armsBack/.test(nav) || !/<Sheet[^>]*ariaLabel="More navigation options"[^>]*armsBack/.test(nav)) out.push('BottomNav\'s + or More sheet is no longer an ARMED Sheet — the harness sheets no longer model them')
  if (!/<OverlayLink to="\/search"/.test(src('src/components/TopChrome.jsx'))) out.push('TopChrome no longer opens header Search with <OverlayLink to="/search"> — the harness header link no longer models it')
  return out
}

// 5331 / 9441: clear of every sibling's default (5312-5329 / 9422-9439 are spoken for).
const PORT = Number(process.env.GATE_HARNESS_PORT || 5331)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9441)
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

// What tests/harness/pagescroll.jsx promises. EXACT: the numbers fall out of its fixture.
const FIXTURE = { gardenPlants: 56, going: 12, locations: 33, plantingEvents: 60, chainRows: 50 }
// "Deep": past anything a one-screen loading shell can hold under the app's chrome (a clamp leaves at most
// the chrome, BAR_H + BOTTOM_NAV_HEIGHT_PX = 108 today), so a clobbered offset can never equal the real one.
const DEEP_MIN_PX = 300
// The same-page switch has to happen with its control on screen, so the page cannot be deep; far enough
// down that a jump to 0 cannot pass for "no jump".
const SHALLOW_MIN_PX = 40
// An element's viewport top after Back, against before: sub-pixel layout noise only.
const TOP_TOL_PX = 1
const CHAIN_DEPTH = 25

// ── One tab ─────────────────────────────────────────────────────────────────────────────────────────
// Everything below runs in the HOST page and reaches into the frame, same origin: `f` the iframe element,
// `w` its window, `d` its document — re-read on every call, since the frame's document is replaced when it
// loads (and, in the reload flow, when it reloads).
const FRAME_VARS = `const f = document.getElementById('frame'), w = f && f.contentWindow, d = w && w.document`
const BAND_FN = `const topBar = d.querySelector('header[data-app-chrome="top"]'), navBar = d.querySelector('nav[aria-label="Main navigation"]')
  const bandTop = topBar ? topBar.getBoundingClientRect().bottom : 0, bandBottom = navBar ? navBar.getBoundingClientRect().top : w.innerHeight;`
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i

const SEL = {
  toDeep: `d.querySelector('${tid('harness-to-deep')}')`,
  toPlanting: `d.querySelector('${tid('harness-to-planting')}')`,
  toLocations: `d.querySelector('${tid('harness-to-locations')}')`,
  toPutUp: `d.querySelector('${tid('harness-to-putup')}')`,
  toSaved: `d.querySelector('${tid('harness-to-saved')}')`,
  toMine: `d.querySelector('${tid('harness-to-mine')}')`,
  toLot: `d.querySelector('${tid('harness-to-lot')}')`,
  toChain: `d.querySelector('${tid('harness-to-chain')}')`,
  tabToday: `d.querySelector('${tid('harness-tab-today')}')`,
  tabHarvests: `d.querySelector('${tid('harness-tab-harvests')}')`,
  tabGarden: `d.querySelector('${tid('harness-tab-garden')}')`,
  headerDeep: `d.querySelector('${tid('harness-header-deep')}')`,
  more: `d.querySelector('${tid('harness-more')}')`,
  moreAchievements: `d.querySelector('[role="dialog"][aria-label="More navigation options"] ${tid('harness-more-achievements')}')`,
  plus: `d.querySelector('${tid('harness-plus')}')`,
  createPlanting: `d.querySelector('[role="dialog"][aria-label="Create new"] ${tid('harness-create-planting')}')`,
  openSearch: `d.querySelector('${tid('harness-open-search')}')`,
  searchSheet: `d.querySelector('[role="dialog"][aria-label="Search your garden"]')`,
  searchClose: `d.querySelector('[role="dialog"][aria-label="Search your garden"] [data-sheet-close]')`,
  searchEvent: `d.querySelector('[role="dialog"][aria-label="Search your garden"] ${tid('harness-search-event')}')`,
  moreSheet: `d.querySelector('[role="dialog"][aria-label="More navigation options"]')`,
  deepSort: `d.querySelector('${tid('deep-sort')}')`,
  deepRow: (depthExpr) => `(() => { ${BAND_FN} const mid = (bandTop + bandBottom) / 2; let best = null, bd = Infinity
    for (const r of d.querySelectorAll('${tid('deep-row')}')) { const b = r.getBoundingClientRect(); const c = (b.top + b.bottom) / 2; const dd = Math.abs(c - (${depthExpr})); if (dd < bd) { bd = dd; best = r } }
    return best })()`,
  eventRow: `d.querySelectorAll('a[href^="/events/"]')[44]`,
  blueberry: `d.querySelector('a[href="/locations/loc-blueberry-hedge"]')`,
  tile: (n) => `d.querySelectorAll('${tid('planting-tile')}')[${n}]`,
  tileLink: (n) => `d.querySelectorAll('${tid('planting-tile-link')}')[${n}]`,
  addPlantingDialog: `d.querySelector('[role="dialog"][aria-label="Add planting"]')`,
  addPlantingClose: `d.querySelector('[role="dialog"][aria-label="Add planting"] [data-sheet-close]')`,
  batch: (id) => `d.querySelector('${tid('going-batch')}[data-batch-id="${id}"]')`,
  batchOpen: (id) => `d.querySelector('${tid('going-batch')}[data-batch-id="${id}"] ${tid('going-open-batch')}')`,
  batchDetail: (id) => `d.querySelector('${tid('batch-detail-view')}[data-batch-id="${id}"]')`,
  ristraCard: `d.querySelector('${tid('seed-lot-card')}[data-lot-id="lot-ristra"]')`,
  ristraTitle: `d.querySelector('${tid('seed-lot-card')}[data-lot-id="lot-ristra"] ${tid('seed-lot-title')}')`,
  savedRadio: `[...d.querySelectorAll('[role="radiogroup"][aria-label="Which seeds"] [role="radio"]')].find((b) => b.textContent.trim() === 'Saved seeds') || null`,
  savedView: `d.querySelector('${tid('saved-seeds-view')}')`,
  editSow: `d.querySelector('${tid('edit-sow-details')}')`,
  cancel: `[...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel') || null`,
  chainRow: `(() => { ${BAND_FN} const mid = (bandTop + bandBottom) / 2; let best = null, bd = Infinity
    for (const r of d.querySelectorAll('${tid('chain-row')}')) { const b = r.getBoundingClientRect(); const dd = Math.abs((b.top + b.bottom) / 2 - mid); if (dd < bd) { bd = dd; best = r } }
    return best })()`,
}

const FLOWS = [
  { key: 'eventlog', label: 'a planting\'s Event log, deep → an event → Back' },
  { key: 'zones', label: 'Zones, a row deep → the zone → Back' },
  { key: 'zones-slow', label: 'Zones, a row deep → the zone → Back, every GET 5 s slow', ms: 5000 },
  { key: 'leave-during-load', label: 'Zones, a row deep → the zone → Back, and away again while Zones is still loading → Back', ms: 3000 },
  { key: 'more', label: 'a long list, deep → More → Achievements → Back (and the outgoing page holds still until the path changes)' },
  { key: 'search', label: 'a long list, deep → header Search → a result → Back (Search over the list at its place) → the X' },
  { key: 'garden-back', label: 'Garden, deep → a planting → Back' },
  { key: 'garden-tab', label: 'Garden, deep → Today tab → Garden tab' },
  { key: 'garden-tab-4x', label: 'Garden, deep → Today tab → Garden tab, CPU 4x slower', cpu: 4 },
  { key: 'garden-add', label: 'Garden, deep → + → "Add a planting" (same page) → the editor\'s X' },
  { key: 'putup', label: 'Put-Up\'s Going-now list, deep → a batch (same page) → Back' },
  { key: 'seeds-switch', label: 'My seeds, a little down → the switch to Saved seeds (same page)' },
  { key: 'same-replace', label: 'a long list, deep → its sort control (same page) → a row → Back' },
  { key: 'hook-seeded', label: 'Saved seeds, deep → a lot → the manager\'s store emptied → Back' },
  { key: 'hook-top', label: 'Harvests at the top → a long list, deep → Back' },
  { key: 'shrink-x', label: 'a long list, deep → header Search → the list renders short → the X → the list long again' },
  { key: 'shrink-back', label: 'a long list, deep → header Search → the list renders short → the system Back → the list long again' },
  { key: 'shrink-marker', label: 'a long list, deep → More → the list renders short → the system Back → the list long again' },
  { key: 'lot-edit', label: 'a seed lot, deep → "Edit sow details →" → the variety editor → its Cancel' },
  { key: 'reload', label: 'Zones, deep → the app reloads on that entry' },
  { key: 'deep25', label: `${CHAIN_DEPTH} pages deep, each at its own offset → Back ${CHAIN_DEPTH} times` },
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
  // Spawned through vite's own bin, NOT `npx vite`: npx is a wrapper, so killing it at teardown orphans the
  // real server and hangs any caller that pipes this script's stdout.
  const proc = spawn(process.execPath, [bin, '--config', config, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', (d) => { harnessLog += d })
  proc.stderr.on('data', (d) => { harnessLog += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/pagescroll.html`)
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
    // Larger than any frame under test: the iframe, not the window, sets the device geometry.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
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
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 90000)
    pending.set(mid, { res, rej, timer })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { ws, send }
}

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
  const read = (body) => ev(`(() => { ${FRAME_VARS}; if (!d) return null; ${body} })()`)
  const waitIn = (cond, ms = 15000) => ev(`(async () => {
    const t0 = performance.now()
    while (performance.now() - t0 < ${ms}) {
      ${FRAME_VARS}
      try { if (d && (${cond})) return true } catch { /* not there yet */ }
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  })()`)
  // Waits until the frame's scrollY AND document height have held still for `stableMs`.
  const settle = (stableMs, maxMs) => ev(`(async () => {
    const t0 = performance.now(); let last = null, since = t0
    while (performance.now() - t0 < ${maxMs}) {
      await new Promise((r) => setTimeout(r, 25))
      ${FRAME_VARS}
      if (!w || !d) continue
      const y = Math.round(w.scrollY * 10) + ':' + d.documentElement.scrollHeight
      if (y !== last) { last = y; since = performance.now() }
      else if (performance.now() - since >= ${stableMs}) return { settled: true, ms: Math.round(performance.now() - t0), y: w.scrollY }
    }
    ${FRAME_VARS}
    return { settled: false, ms: ${maxMs}, y: w ? w.scrollY : null }
  })()`)
  const mouse = async (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, sessionId)
  // A REAL tap, IN PLACE: the target must already be in the visible band and its centre must hit-test to it.
  // `chrome: true` admits a control in the bars or a sheet over them. Returns null, or why no tap was made.
  const tap = async (sel, what, { chrome = false } = {}) => {
    const p = await read(`const el = ${sel}; if (!el) return { missing: true }
      ${BAND_FN}
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
  // Real wheel input over the middle of the band until `sel`'s centre sits within 80px of it — or, with
  // `top`, until its top sits just under the top bar (a door high on its page, reached from as deep as the page
  // allows while it stays on screen).
  const wheelTo = async (sel, what, { top = false } = {}) => {
    for (let i = 0; i < 120; i++) {
      const s = await read(`const el = ${sel}; if (!el) return { missing: true }
        ${BAND_FN}
        const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect(), mid = (bandTop + bandBottom) / 2
        return { delta: ${top ? 'r.top - (bandTop + 24)' : '(r.top + r.bottom) / 2 - mid'}, y: w.scrollY, max: d.documentElement.scrollHeight - w.innerHeight,
          x: fr.left + w.innerWidth / 2, py: fr.top + mid }`)
      if (!s || s.missing) return `${what} is not on the page`
      if (Math.abs(s.delta) <= 80) return null
      if (s.delta > 0 && s.y >= s.max - 1) return null
      if (s.delta < 0 && s.y <= 0) return null
      await mouse('mouseWheel', s.x, s.py, { deltaX: 0, deltaY: Math.max(-480, Math.min(480, s.delta)) })
      await settle(120, 3000)
    }
    return `${what} could not be wheeled to the middle of the band in 120 steps`
  }
  // Real wheel input until scrollY reaches `target` (or the page's end).
  const wheelToY = async (target) => {
    for (let i = 0; i < 120; i++) {
      const s = await read(`${BAND_FN}
        const fr = f.getBoundingClientRect()
        return { y: w.scrollY, max: d.documentElement.scrollHeight - w.innerHeight, x: fr.left + w.innerWidth / 2, py: fr.top + (bandTop + bandBottom) / 2 }`)
      const want = Math.min(target, s.max)
      if (Math.abs(s.y - want) <= 40) return null
      await mouse('mouseWheel', s.x, s.py, { deltaX: 0, deltaY: Math.max(-480, Math.min(480, want - s.y)) })
      await settle(120, 3000)
    }
    return `the page could not be wheeled to y${target} in 120 steps`
  }
  const wheelBy = async (deltaY) => {
    const s = await read(`${BAND_FN}
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
  return { ev, read, waitIn, settle, tap, wheelTo, wheelToY, wheelBy, shoot }
}

// The frame's page as it stands. `sel` is the element whose viewport top the flow compares.
const READ_HERE = (sel) => `${BAND_FN}
  const el = ${sel || 'null'}, r = el ? el.getBoundingClientRect() : null
  const h1 = d.querySelector('[data-harness-pages] h1'), hr = h1 ? h1.getBoundingClientRect() : null
  return { path: w.location.pathname, search: w.location.search, key: w.__h ? w.__h.key() : null, page: w.__h ? w.__h.pageKey() : null,
    y: w.scrollY, docH: d.documentElement.scrollHeight, top: r ? r.top : null,
    h1: hr ? { t: hr.top, b: hr.bottom, text: (h1.textContent || '').trim().slice(0, 50) } : null,
    h1InBand: !!hr && hr.height > 0 && hr.top >= bandTop - 0.5 && hr.bottom <= bandBottom + 0.5,
    band: [bandTop, bandBottom], mode: w.__h ? w.__h.mode() : null }`
const DIAG = `return { errors: w.__h ? w.__h.errors() : ['window.__h missing'], unstubbed: w.__h ? w.__h.unstubbed() : [],
  decisions: w.__h ? w.__h.decisions() : [], trace: w.__h ? w.__h.trace() : [], store: w.__h ? w.__h.store() : null,
  leftPage: !!d.querySelector('[data-testid="harness-left-page"]'), fallback: !!d.querySelector('[data-testid="harness-route-fallback"]') }`

const R1 = (n) => (n == null ? 'n/a' : Math.round(n * 10) / 10)
const rowsLine = (decisions) => decisions.slice(-8).map((x) => `${x.path}:${x.row}/${x.action}${x.action === 'RESTORE' ? `→${Math.round(x.y)}` : ''}`).join(' ') || 'none'
const traceLine = (trace) => {
  const out = []
  for (const e of trace) { const p = out[out.length - 1]; if (!p || p.path !== e.path || p.y !== e.y) out.push(e) }
  return out.slice(-12).map((e) => `${e.t}ms ${e.path} y${e.y}`).join(' → ') || 'no scroll events'
}

async function runFlow(cdp, flow, vw, vh) {
  const at = `(${flow.key})@${vw}x${vh}`
  const note = []
  const started = Date.now()
  const firstFailure = failures.length
  let reloaded = async () => ''
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    const cpu = Math.max(CPU_THROTTLE, flow.cpu || 1)
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }, sessionId)
    const t = tab(cdp, sessionId)
    const ms = flow.ms ?? 300
    // A settle long enough to outlast the flow's own latency: the restore re-applies until the content lands.
    const slowMax = Math.max(10000, ms * 3 + 6000)
    const url = `http://localhost:${PORT}/tests/harness/viewport.html?page=pagescroll.html&vw=${vw}&vh=${vh}&topbar=${TOP_CHROME_PX}&ms=${ms}`
    const nav = await cdp.send('Page.navigate', { url }, sessionId)
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
    if (!await t.waitIn(`w.__h && w.__h.ready() && d.readyState === 'complete'`, 30000)) return fail(`${at}: the harness never came up in the frame — nothing to measure`)
    await t.ev(`(async () => { ${FRAME_VARS}; if (d.fonts) await d.fonts.ready; return 1 })()`)
    let boot0 = await t.read(`return w.__h.boot()`)
    reloaded = async () => {
      const b = await t.read(`return w.__h && w.__h.boot ? w.__h.boot() : null`).catch(() => null)
      return b === boot0 ? '' : ' — and the frame RELOADED mid-flow (a new document: Vite re-optimizing a dependency does this), so this run did not measure the flow'
    }

    // ── INSTRUMENT CHECK: the geometry, the chrome, the harness's own settings.
    const g = await t.read(`${BAND_FN}
      const fr = f.getBoundingClientRect()
      return { vw: w.innerWidth, vh: w.innerHeight, cw: d.documentElement.clientWidth, top: topBar ? topBar.getBoundingClientRect().height : null,
        nav: navBar ? navBar.getBoundingClientRect().height : null, frame: { r: fr.right, b: fr.bottom }, host: { w: window.innerWidth, h: window.innerHeight },
        fixture: w.__h.fixture(), mode: w.__h.mode() }`)
    const geo = []
    if (g.vw !== vw || g.vh !== vh) geo.push(`the frame self-reports ${g.vw}x${g.vh}, not ${vw}x${vh} — every coordinate would be from the wrong layout`)
    if (g.cw !== vw) geo.push(`the frame's clientWidth is ${g.cw}, not ${vw} — a scrollbar gutter is taking layout width`)
    if (g.frame.r > g.host.w || g.frame.b > g.host.h) geo.push(`the frame does not fit the ${g.host.w}x${g.host.h} host window — taps outside it go nowhere`)
    if (g.top !== TOP_CHROME_PX) geo.push(`the top-bar stand-in is ${g.top}px, expected TopChrome's BAR_H ${TOP_CHROME_PX}px`)
    if (g.nav !== BOTTOM_NAV_HEIGHT_PX) geo.push(`the bottom-nav stand-in is ${g.nav}px, expected BOTTOM_NAV_HEIGHT_PX ${BOTTOM_NAV_HEIGHT_PX}px`)
    if (g.fixture.ms !== ms) geo.push(`the harness answers every GET after ${g.fixture.ms}ms, the flow asked for ${ms}ms`)
    for (const [key, v] of Object.entries(FIXTURE)) if (g.fixture[key] !== v) geo.push(`the fixture's ${key} is ${g.fixture[key]}, the gate expects ${v}`)
    // The browser's restore mode is the one main.jsx sets for the flag this document was served: 'manual' with
    // the manager on. A harness in any other mode measures a browser prod does not run.
    const wantMode = g.fixture.manager ? 'manual' : 'auto'
    if (g.mode !== wantMode) geo.push(`history.scrollRestoration is '${g.mode}', but with SCROLL_MANAGER_ENABLED=${g.fixture.manager} main.jsx sets '${wantMode}'`)
    if (geo.length) return fail(`${at}: ${geo.join('; ')}`)
    note.push(g.fixture.manager ? `manager on, '${g.mode}'` : `MANAGER OFF (the flag as served), '${g.mode}'`)

    // ── Steps, each a failure message or null.
    const page = (key) => t.waitIn(`w.__h.pageReady('${key}')`, slowMax)
    const diag = async () => {
      const dg = await t.read(DIAG).catch(() => null)
      if (!dg) return ''
      return ` · manager rows: ${rowsLine(dg.decisions)} · scroll trace: ${traceLine(dg.trace)}${dg.errors.length ? ` · errors: ${dg.errors.join(' | ')}` : ''}${dg.leftPage ? ' · the router LEFT for an unexpected route' : ''}${dg.fallback ? ' · a route fell back (the page threw)' : ''}`
    }
    const enter = async (sel, key, what, { chrome = false } = {}) => {
      const why = await t.tap(sel, what, { chrome })
      if (why) return why
      if (!await page(key)) return `${what} was tapped and the ${key} page never finished loading${await diag()}${await reloaded()}`
      await t.settle(400, slowMax)
      return null
    }
    // A push onto `key`: it must write a new history entry and land at 0 with its title in the band.
    const land = async (tapSel, tapWhat, key, { chrome = false, titleSel = null, name = key } = {}) => {
      const k0 = await t.read(`return w.__h.key()`)
      await t.read(`w.__h.mark(); return 1`)
      const why = await t.tap(tapSel, tapWhat, { chrome })
      if (why) return { why }
      if (!await page(key)) return { why: `${tapWhat} was tapped and the ${key} page never finished loading${await diag()}${await reloaded()}` }
      const st = await t.settle(600, slowMax)
      const here = await t.read(READ_HERE(titleSel))
      await t.shoot(join(OUTDIR, `page-scroll-${flow.key}-${name}-${vw}x${vh}.png`))
      if (here.key == null || here.key === k0) return { why: `${tapWhat} did not write a new history entry (key ${here.key}) — this is not a door onto a new page` }
      const title = titleSel ? { t: here.top, ok: here.top != null && here.top >= here.band[0] - 0.5 && here.top <= here.band[1] } : { t: here.h1?.t, ok: here.h1InBand }
      const msgs = []
      if (Math.round(here.y) !== 0) msgs.push(`${name} landed at scrollY ${R1(here.y)}, not 0 — it opened part-way down (the bug)`)
      if (!title.ok) msgs.push(`${name}'s title is at y${R1(title.t)}, not inside the visible band y${R1(here.band[0])}-${R1(here.band[1])}`)
      if (!st.settled) msgs.push(`${name} never held still for 600ms within ${slowMax}ms (last y${R1(st.y)})`)
      note.push(`${name} y${R1(here.y)} (title y${R1(title.t)})`)
      return { here, why: msgs.length ? `${msgs.join('; ')}${await diag()}` : null }
    }
    // Back onto `key`: the very entry `before` was read on, at its exact offset, `sel` at the same viewport top.
    const back = async (before, key, sel, what, { sample = false } = {}) => {
      await t.read(`w.__h.mark(); ${sample ? 'w.__h.startSampling();' : ''} return 1`)
      await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
      if (!await page(key)) return { why: `Back never brought the ${key} page back${await diag()}${await reloaded()}` }
      const st = await t.settle(800, slowMax)
      const samples = sample ? await t.read(`return w.__h.stopSampling()`) : null
      const after = await t.read(READ_HERE(sel))
      await t.shoot(join(OUTDIR, `page-scroll-${flow.key}-back-${key}-${vw}x${vh}.png`))
      const rl = await reloaded()
      if (rl) return { why: `the flow ran across two documents${rl}` }
      if (after.key !== before.key) return { why: `Back landed on history key ${after.key}, not the ${key} page's own ${before.key} — the Back measured is not the one the offset was taken on` }
      const msgs = []
      if (!st.settled) msgs.push(`after Back the ${key} page never held still for 800ms within ${slowMax}ms (last y${R1(st.y)})`)
      if (Math.round(after.y) !== Math.round(before.y)) msgs.push(`${what}: Back landed at scrollY ${R1(after.y)}, the page was left at ${R1(before.y)} — the place was lost`)
      if (sel && (after.top == null || before.top == null || Math.abs(after.top - before.top) > TOP_TOL_PX)) msgs.push(`${what}: after Back the tapped element's top is at y${R1(after.top)}, it was at y${R1(before.top)} (±${TOP_TOL_PX}px)`)
      note.push(`Back y${R1(after.y)} in ${st.ms}ms (left at y${R1(before.y)})`)
      return { after, samples, why: msgs.length ? `${msgs.join('; ')}${await diag()}` : null }
    }
    const deep = (y, min = DEEP_MIN_PX) => (y >= min ? null : `the page is only ${R1(y)}px down before the tap (need >= ${min}) — a clobbered offset could equal it, so the flow proves nothing`)
    const done = (why) => { if (why) fail(`${at}: ${flow.label}: ${why}`) }

    // ── The flows.
    const k = flow.key
    if (k === 'eventlog') {
      let why = await enter(SEL.toPlanting, 'planting', 'the /today link to the planting')
      if (why) return done(why)
      // The Event log pages its rows; the door is its 45th, which must be on the page.
      const rows = await t.read(`return d.querySelectorAll('a[href^="/events/"]').length`)
      if (rows < 45) return done(`the Event log shows ${rows} rows; the door (row 45) is not on the page`)
      why = await t.wheelTo(SEL.eventRow, 'the Event log\'s 45th row')
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(SEL.eventRow))
      if ((why = deep(before.y))) return done(why)
      const l = await land(SEL.eventRow, 'the Event log row', 'event')
      if (l.why) return done(l.why)
      const b = await back(before, 'planting', SEL.eventRow, 'the Event log')
      return done(b.why)
    }
    if (k === 'zones' || k === 'zones-slow' || k === 'reload' || k === 'leave-during-load') {
      let why = await enter(SEL.toLocations, 'locations', 'the /today link to Zones')
      if (why) return done(why)
      why = await t.wheelTo(SEL.blueberry, 'the Blueberry hedge row')
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(SEL.blueberry))
      if ((why = deep(before.y))) return done(why)
      if (k === 'reload') {
        // The app reloads ON this entry: a new document, sessionStorage kept (the manager flushed its mirror on
        // pagehide), history.state kept — the service worker's post-update reload, an Android tab restore.
        await t.ev(`(() => { ${FRAME_VARS}; w.__h.reloadHere(); return 1 })()`)
        if (!await t.waitIn(`w.__h && w.__h.boot() !== '${boot0}' && w.__h.reloadedDoc() && w.__h.pageReady('locations')`, slowMax)) return done(`the reload never came back with Zones loaded${await diag()}`)
        boot0 = await t.read(`return w.__h.boot()`)   // this reload is the one under test
        const st = await t.settle(800, slowMax)
        const after = await t.read(READ_HERE(SEL.blueberry))
        await t.shoot(join(OUTDIR, `page-scroll-${k}-after-${vw}x${vh}.png`))
        if (after.key !== before.key) return done(`after the reload the frame is on key ${after.key}, not Zones' own ${before.key} — the reload did not keep the entry`)
        const msgs = []
        if (!st.settled) msgs.push(`after the reload Zones never held still (last y${R1(st.y)})`)
        if (Math.round(after.y) !== Math.round(before.y)) msgs.push(`after the reload Zones is at scrollY ${R1(after.y)}, it was left at ${R1(before.y)} — the reload lost the place`)
        if (after.top == null || Math.abs(after.top - before.top) > TOP_TOL_PX) msgs.push(`the Blueberry hedge row is at y${R1(after.top)}, it was at y${R1(before.top)}`)
        note.push(`reloaded (mode ${after.mode}): y${R1(after.y)} (left at y${R1(before.y)})`)
        return done(msgs.length ? `${msgs.join('; ')}${await diag()}` : null)
      }
      const l = await land(SEL.blueberry, 'the Blueberry hedge row', 'location')
      if (l.why) return done(l.why)
      if (k === 'leave-during-load') {
        // Back, and away again BEFORE Zones' content lands: the restore is armed and every attempt it makes is
        // clamped to the loading shell. Those clamps must never be filed (rimpact IMPORTANT-3), or the next
        // Back restores the clamp.
        await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
        if (!await t.waitIn(`w.__h.pageKey() === 'locations' && !w.__h.pageReady('locations')`, 8000)) return done('Back never showed Zones loading — the content was already there, so nothing was left mid-restore')
        await t.settle(300, 3000)
        const mid = await t.read(`return w.scrollY`)
        note.push(`Back: Zones loading at y${R1(mid)}`)
        if (!await t.read(`return !w.__h.pageReady('locations')`)) return done('Zones finished loading before the flow could leave — nothing was left mid-restore')
        const away = await land(SEL.tabToday, 'the Today tab, while Zones was still loading', 'today', { chrome: true, name: 'today' })
        if (away.why) return done(away.why)
      }
      const b = await back(before, 'locations', SEL.blueberry, 'Zones')
      return done(b.why)
    }
    if (k === 'more' || k === 'search' || k === 'same-replace' || k.startsWith('shrink')) {
      let why = await enter(SEL.toDeep, 'deep', 'the /today link to the long list')
      if (why) return done(why)
      const row = SEL.deepRow('mid')
      why = await t.wheelToY(3000)
      if (why) return done(why)
      await t.settle(400, 5000)
      let before = await t.read(READ_HERE(row))
      if ((why = deep(before.y))) return done(why)
      if (k === 'more') {
        why = await t.tap(SEL.more, 'More', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`${SEL.moreAchievements} && w.history.state && w.history.state.__backnav`, 8000)) return done('More was tapped and the armed sheet never showed with its Back marker pushed')
        await t.settle(300, 3000)
        const l = await land(SEL.moreAchievements, 'More → Achievements', 'achievements', { chrome: true })
        if (l.why) return done(l.why)
        const b = await back(before, 'deep', row, 'the long list', { sample: true })
        // 'manual': until the path changes, the still-mounted Achievements page must not have moved. With
        // 'auto' Chrome applies the list's popped offset to it first (the measurement saw 2880 → 553).
        const s = b.samples || []
        const out = s.filter((x) => x.page === 'achievements')
        const moved = out.filter((x) => Math.abs(x.y - l.here.y) > 1)
        note.push(`Back frames on Achievements before the swap: ${out.length} (${moved.length} moved)`)
        if (!out.length) note.push('(the swap happened before the first sampled frame)')
        if (moved.length) fail(`${at}: ${flow.label}: before the path changed back, the outgoing Achievements page moved to y${moved[0].y} (it was at y${R1(l.here.y)}) — the browser restored the popped offset onto it: history.scrollRestoration is not 'manual' on this entry`)
        return done(b.why)
      }
      if (k === 'search') {
        why = await t.tap(SEL.openSearch, 'header Search', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`w.location.pathname === '/search' && ${SEL.searchEvent}`, 8000)) return done('header Search never opened with its results')
        await t.settle(300, 3000)
        const under = await t.read(`return w.scrollY`)
        if (Math.round(under) !== Math.round(before.y)) return done(`opening Search moved the list under the sheet: y${R1(before.y)} → y${R1(under)}`)
        const l = await land(SEL.searchEvent, 'Search\'s event result', 'event', { chrome: true })
        if (l.why) return done(l.why)
        // Back re-opens Search over the list: a POP onto Search's own entry, whose page entry is the list's.
        await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
        if (!await t.waitIn(`w.location.pathname === '/search' && ${SEL.searchClose} && w.__h.pageReady('deep')`, slowMax)) return done(`Back from the result never re-opened Search over the list${await diag()}`)
        await t.settle(800, slowMax)
        const re = await t.read(READ_HERE(row))
        note.push(`Search re-opened over the list at y${R1(re.y)}`)
        if (Math.round(re.y) !== Math.round(before.y)) return done(`Back re-opened Search over the list at y${R1(re.y)}, the list was left at y${R1(before.y)}${await diag()}`)
        why = await t.tap(SEL.searchClose, 'Search\'s X', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`w.location.pathname === '/deep' && !${SEL.searchSheet}`, 8000)) return done('the X never closed Search back onto the list')
        await t.settle(600, 6000)
        const after = await t.read(READ_HERE(row))
        note.push(`after the X y${R1(after.y)}`)
        if (after.key !== before.key) return done(`the X landed on key ${after.key}, not the list's own ${before.key}`)
        if (Math.round(after.y) !== Math.round(before.y) || Math.abs(after.top - before.top) > TOP_TOL_PX) return done(`after the X the list is at y${R1(after.y)} (row top y${R1(after.top)}), it was at y${R1(before.y)} (row top y${R1(before.top)})${await diag()}`)
        return
      }
      if (k === 'same-replace') {
        why = await t.tap(SEL.deepSort, 'the list\'s sort control')
        if (why) return done(why)
        if (!await t.waitIn(`/sort=1/.test(w.location.search)`, 5000)) return done('the sort control never wrote /deep?sort=1')
        await t.settle(500, 5000)
        const sw = await t.read(READ_HERE(row))
        if (sw.key == null || sw.key === before.key) return done(`the sort control did not re-key the entry (key ${sw.key}) — this is not the same-page write under test`)
        note.push(`sort: y${R1(before.y)} → y${R1(sw.y)} (a new key)`)
        if (Math.round(sw.y) !== Math.round(before.y)) return done(`the same-page write moved the list: y${R1(before.y)} → y${R1(sw.y)}${await diag()}`)
        before = sw
        const target = await t.read(`const el = ${row}; return el ? el.getAttribute('data-target') : null`)
        if (!target) return done('no list row mid-band to tap')
        const l = await land(row, `the list's ${target} row`, target)
        if (l.why) return done(l.why)
        const b = await back(before, 'deep', row, 'the list after its sort')
        return done(b.why)
      }
      // shrink-x / shrink-back / shrink-marker: the list renders short behind a sheet, then long again.
      if (k === 'shrink-marker') {
        why = await t.tap(SEL.more, 'More', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`${SEL.moreSheet} && w.history.state && w.history.state.__backnav`, 8000)) return done('More was tapped and the armed sheet never showed with its Back marker pushed')
      } else {
        why = await t.tap(SEL.openSearch, 'header Search', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`w.location.pathname === '/search' && ${SEL.searchClose}`, 8000)) return done('header Search never opened')
      }
      // The list blanks behind the sheet (a refetch: every row gone, then re-created) and is STILL SHORT when
      // the sheet closes; the rows land after. That is the case Chrome's own clamp carry does not cover: a list
      // that grows back while still covered is carried back to its offset by Chromium with or without the
      // manager (measured: the manager's snapshot removed, y3000 → y52 → y3000 before the close), so a flow
      // built that way could not fail.
      await t.settle(300, 3000)
      await t.read(`return w.__h.setDeepRows(0, true)`)
      await t.settle(300, 3000)
      const short = await t.read(`return w.scrollY`)
      note.push(`behind the sheet the list blanked: y${R1(before.y)} → y${R1(short)}`)
      if (!(short < before.y - 100)) return done(`the list never rendered short enough behind the sheet to clamp (y${R1(short)}) — the flow would prove nothing`)
      if (k === 'shrink-x') {
        why = await t.tap(SEL.searchClose, 'Search\'s X', { chrome: true })
        if (why) return done(why)
      } else {
        await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
      }
      if (!await t.waitIn(`w.location.pathname === '/deep' && !${SEL.searchSheet} && !${SEL.moreSheet}`, 8000)) return done('the sheet never closed back onto the list')
      await t.settle(300, 3000)
      note.push(`closed while short at y${R1(await t.read(`return w.scrollY`))}`)
      await t.read(`return w.__h.setDeepRows(80, true)`)
      const st = await t.settle(800, 8000)
      const after = await t.read(READ_HERE(row))
      note.push(`after the close y${R1(after.y)}`)
      if (after.key !== before.key) return done(`the close landed on key ${after.key}, not the list's own ${before.key}`)
      if (!st.settled || Math.round(after.y) !== Math.round(before.y) || Math.abs(after.top - before.top) > TOP_TOL_PX) return done(`after the close the list is at y${R1(after.y)} (row top y${R1(after.top)}), it was left at y${R1(before.y)} (row top y${R1(before.top)}) — the close did not put it back${await diag()}`)
      return
    }
    if (k.startsWith('garden')) {
      let why = await enter(SEL.tabGarden, 'garden', 'the Garden tab', { chrome: true })
      if (why) return done(why)
      const tile = SEL.tile(33)
      why = await t.wheelTo(tile, 'the 34th planting tile')
      if (why) return done(why)
      await t.settle(500, 5000)
      const before = await t.read(READ_HERE(tile))
      if ((why = deep(before.y))) return done(why)
      if (k === 'garden-back') {
        const l = await land(SEL.tileLink(33), 'the 34th planting\'s tile', 'planting')
        if (l.why) return done(l.why)
        const b = await back(before, 'garden', tile, 'Garden')
        return done(b.why)
      }
      if (k === 'garden-add') {
        why = await t.tap(SEL.plus, '+', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`${SEL.createPlanting} && w.history.state && w.history.state.__backnav`, 8000)) return done('+ was tapped and the armed Create sheet never showed with its Back marker pushed')
        await t.settle(300, 3000)
        why = await t.tap(SEL.createPlanting, '"Add a planting"', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`${SEL.addPlantingClose} && !/add=1/.test(w.location.search)`, slowMax)) return done(`"Add a planting" never opened the editor with its ?add stripped (on ${await t.read(`return w.location.pathname + w.location.search`)})${await diag()}`)
        await t.settle(500, 5000)
        const k1 = await t.read(`return w.__h.key()`)
        const mid = await t.read(`return w.scrollY`)
        note.push(`the editor opened (entry ${before.key} → ${k1}), Garden under it at y${R1(mid)}`)
        if (k1 === before.key) note.push('(the door did not re-key the entry)')
        why = await t.tap(SEL.addPlantingClose, 'the editor\'s X', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`!${SEL.addPlantingDialog}`, 8000)) return done('the editor\'s X never closed it')
        const st = await t.settle(800, 8000)
        const after = await t.read(READ_HERE(tile))
        note.push(`after the X y${R1(after.y)}`)
        if (after.path !== '/garden') return done(`the X left Garden for ${after.path}`)
        if (!st.settled || Math.round(after.y) !== Math.round(before.y) || Math.abs(after.top - before.top) > TOP_TOL_PX) return done(`after the editor's X Garden is at y${R1(after.y)} (tile top y${R1(after.top)}), it was at y${R1(before.y)} (tile top y${R1(before.top)}) — a same-page write moved it${await diag()}`)
        return
      }
      // garden-tab(-4x): away by a tab, back by a tab — two PUSHes; Garden restores its own spot.
      const l = await land(SEL.tabToday, 'the Today tab', 'today', { chrome: true })
      if (l.why) return done(l.why)
      const k0 = await t.read(`return w.__h.key()`)
      why = await t.tap(SEL.tabGarden, 'the Garden tab', { chrome: true })
      if (why) return done(why)
      if (!await page('garden')) return done(`the Garden tab never brought Garden back${await diag()}`)
      const st = await t.settle(800, slowMax)
      const after = await t.read(READ_HERE(tile))
      await t.shoot(join(OUTDIR, `page-scroll-${k}-back-garden-${vw}x${vh}.png`))
      note.push(`Garden again (a push, key ${after.key === k0 ? 'UNCHANGED' : 'new'}): y${R1(after.y)} (its spot y${R1(before.y)})`)
      if (after.key === k0 || after.key === before.key) return done('the Garden tab did not push a new entry — this is not the push under test')
      if (!st.settled || Math.round(after.y) !== Math.round(before.y) || Math.abs(after.top - before.top) > TOP_TOL_PX) return done(`Garden came back at y${R1(after.y)} (tile top y${R1(after.top)}), its spot is y${R1(before.y)} (tile top y${R1(before.top)}) — "back to your spot" was lost${await diag()}`)
      return
    }
    if (k === 'putup') {
      let why = await enter(SEL.toPutUp, 'putup', 'the /today link to Put-Up')
      if (why) return done(why)
      if (!await t.waitIn(`d.querySelectorAll('${tid('going-batch')}').length === ${FIXTURE.going}`, 8000)) return done(`Put-Up never showed the ${FIXTURE.going} going batches (the Going-now segment)`)
      const card = SEL.batch('kb-9')
      why = await t.wheelTo(card, 'the ninth batch')
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(card))
      if ((why = deep(before.y))) return done(why)
      await t.read(`w.__h.mark(); return 1`)
      why = await t.tap(SEL.batchOpen('kb-9'), 'the ninth batch\'s "Open"')
      if (why) return done(why)
      if (!await t.waitIn(`${SEL.batchDetail('kb-9')} && /batch=kb-9/.test(w.location.search)`, slowMax)) return done(`the batch never opened (on ${await t.read(`return w.location.pathname + w.location.search`)})${await diag()}`)
      await t.settle(500, slowMax)
      const detail = await t.read(READ_HERE(null))
      if (detail.key === before.key) return done('opening the batch did not push a new entry — this is not the same-page push under test')
      note.push(`the batch opened on the same page at y${R1(detail.y)}`)
      const b = await back(before, 'putup', card, 'the Going-now list')
      return done(b.why)
    }
    if (k === 'seeds-switch') {
      let why = await enter(SEL.toMine, 'seeds', 'the /today link to My seeds')
      if (why) return done(why)
      const r0 = await t.read(`const el = ${SEL.savedRadio}; if (!el) return null; ${BAND_FN} return { top: el.getBoundingClientRect().top, bandTop }`)
      if (!r0) return done('the Seeds view switch has no "Saved seeds" option')
      await t.wheelBy(Math.round(r0.top - r0.bandTop - 12))
      const before = await t.read(READ_HERE(SEL.savedRadio))
      if ((why = deep(before.y, SHALLOW_MIN_PX))) return done(why)
      why = await t.tap(SEL.savedRadio, 'the switch\'s "Saved seeds"')
      if (why) return done(why)
      if (!await t.waitIn(`${SEL.savedView} && /view=saved/.test(w.location.search) && ${SEL.ristraCard}`, 8000)) return done(`the switch never showed Saved seeds${await diag()}`)
      const st = await t.settle(600, 6000)
      const after = await t.read(READ_HERE(SEL.savedRadio))
      note.push(`switch: y${R1(before.y)} → y${R1(after.y)} (entry ${after.key === before.key ? 'UNCHANGED' : 'a new key'})`)
      if (after.key === before.key) return done('the switch did not re-key the entry — this is not the same-page write under test')
      if (!st.settled || Math.round(after.y) !== Math.round(before.y)) return done(`the view switch moved the page: y${R1(before.y)} → y${R1(after.y)} — a same-page write jumped${await diag()}`)
      return
    }
    if (k === 'hook-seeded') {
      let why = await enter(SEL.toSaved, 'seeds', 'the /today link to Saved seeds')
      if (why) return done(why)
      why = await t.wheelTo(SEL.ristraCard, 'the Ristra card')
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(SEL.ristraCard))
      if ((why = deep(before.y))) return done(why)
      const l = await land(SEL.ristraTitle, 'the Ristra card\'s title', 'lot')
      if (l.why) return done(l.why)
      await t.read(`return w.__h.forgetPageScroll()`)
      note.push(`the manager's store emptied (mirror now ${JSON.stringify(await t.read(`return w.__h.store()`))})`)
      const b = await back(before, 'seeds', SEL.ristraCard, 'Saved seeds')
      return done(b.why)
    }
    if (k === 'hook-top') {
      let why = await enter(SEL.tabHarvests, 'harvests', 'the Harvests tab', { chrome: true })
      if (why) return done(why)
      const before = await t.read(READ_HERE(null))
      if (Math.round(before.y) !== 0) return done(`Harvests opened at y${R1(before.y)}, not the top — nothing to hold`)
      const l = await land(SEL.headerDeep, 'the header\'s list link', 'deep', { chrome: true })
      if (l.why) return done(l.why)
      why = await t.wheelToY(3000)
      if (why) return done(why)
      await t.settle(400, 5000)
      const listY = await t.read(`return w.scrollY`)
      if ((why = deep(listY))) return done(why)
      note.push(`the list scrolled to y${R1(listY)}`)
      const b = await back(before, 'harvests', null, 'Harvests')
      if (b.why) return done(b.why)
      if (!b.after.h1InBand) return done(`Harvests' h1 is not in the visible band after Back (y${R1(b.after.h1?.t)})`)
      return
    }
    if (k === 'lot-edit') {
      const l0 = await land(SEL.toLot, 'the /today link to the lot', 'lot')
      if (l0.why) return done(l0.why)
      let why = await t.wheelTo(SEL.editSow, '"Edit sow details →"', { top: true })
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(SEL.editSow))
      if ((why = deep(before.y))) return done(why)
      const l = await land(SEL.editSow, '"Edit sow details →"', 'variety', { titleSel: `[...d.querySelectorAll('[data-harness-pages] div')].find((x) => x.childElementCount === 0 && /^Edit Ristra Cayenne II$/.test(x.textContent.trim())) || null` })
      if (l.why) return done(l.why)
      why = await t.wheelTo(SEL.cancel, 'the editor\'s Cancel')
      if (why) return done(why)
      await t.settle(300, 3000)
      await t.read(`w.__h.mark(); return 1`)
      why = await t.tap(SEL.cancel, 'the editor\'s Cancel')
      if (why) return done(why)
      if (!await page('lot')) return done(`Cancel never brought the lot back${await diag()}`)
      const st = await t.settle(800, slowMax)
      const after = await t.read(READ_HERE(SEL.editSow))
      await t.shoot(join(OUTDIR, `page-scroll-${k}-back-lot-${vw}x${vh}.png`))
      if (after.key !== before.key) return done(`Cancel landed on key ${after.key}, not the lot's own ${before.key} — navigate(-1) did not return to it`)
      note.push(`Cancel → the lot at y${R1(after.y)} (left at y${R1(before.y)})`)
      if (!st.settled || Math.round(after.y) !== Math.round(before.y) || Math.abs(after.top - before.top) > TOP_TOL_PX) return done(`after the editor's Cancel the lot is at y${R1(after.y)} (link top y${R1(after.top)}), it was left at y${R1(before.y)} (link top y${R1(before.top)})${await diag()}`)
      return
    }
    if (k === 'deep25') {
      let why = await enter(SEL.toChain, 'chain', 'the /today link to the chain')
      if (why) return done(why)
      const left = []
      for (let n = 1; n <= CHAIN_DEPTH; n++) {
        why = await t.wheelToY(320 + n * 37)
        if (why) return done(`page ${n}: ${why}`)
        await t.settle(150, 3000)
        const here = await t.read(READ_HERE(SEL.chainRow))
        if (here.path !== `/chain/${n}`) return done(`expected /chain/${n}, on ${here.path}`)
        if ((why = deep(here.y))) return done(`page ${n}: ${why}`)
        left.push(here)
        why = await t.tap(SEL.chainRow, `page ${n}'s middle row`)
        if (why) return done(`page ${n}: ${why}`)
        if (!await t.waitIn(`w.location.pathname === '/chain/${n + 1}' && w.__h.pageReady('chain')`, 8000)) return done(`page ${n}'s row never opened page ${n + 1}`)
        const top = await t.settle(150, 3000)
        if (Math.round(top.y) !== 0) return done(`page ${n + 1} landed at y${R1(top.y)}, not 0`)
      }
      const lost = []
      for (let n = CHAIN_DEPTH; n >= 1; n--) {
        await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
        if (!await t.waitIn(`w.location.pathname === '/chain/${n}' && w.__h.pageReady('chain')`, 8000)) return done(`Back never reached page ${n}`)
        await t.settle(400, 6000)
        const got = await t.read(READ_HERE(null))
        const want = left[n - 1]
        if (got.key !== want.key || Math.round(got.y) !== Math.round(want.y)) lost.push(`page ${n}: y${R1(got.y)} of ${R1(want.y)}${got.key !== want.key ? ' (another entry)' : ''}`)
      }
      note.push(`${CHAIN_DEPTH} pages left at y${R1(left[0].y)} … y${R1(left[CHAIN_DEPTH - 1].y)}, ${CHAIN_DEPTH - lost.length} restored exactly`)
      if (lost.length) return done(`Back lost ${lost.length} of ${CHAIN_DEPTH} places: ${lost.join(', ')}${await diag()}`)
      return
    }
    return done(`no such flow ${k}`)
  } finally {
    const rl = failures.length > firstFailure ? await reloaded().catch(() => '') : ''
    if (rl) for (let i = firstFailure; i < failures.length; i++) if (!failures[i].includes('RELOADED')) failures[i] += rl
    if (failures.length === firstFailure) console.log(`[page-scroll] (${flow.key})@${vw}x${vh} ${flow.label}: ${note.join(' · ')} [${((Date.now() - started) / 1000).toFixed(1)}s]`)
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-pagescroll-'))
try {
  if (BASELINE_SHA) console.log(`[page-scroll] BASELINE RUN — HARNESS_BASELINE_SHA=${BASELINE_SHA}: src/** is served from that commit. This is not a clean run.`)
  if (CUSTOM_CONFIG) console.log(`[page-scroll] CUSTOM HARNESS CONFIG — GATE_HARNESS_CONFIG=${HARNESS_CONFIG}. This is not a clean run.`)
  if (ONLY.length) console.log(`[page-scroll] GATE_ONLY=${ONLY.join(',')} — only those flows ran. This is not a clean run.`)
  if (ONLY.some((key) => !FLOWS.some((fl) => fl.key === key))) throw new Error(`GATE_ONLY names a flow that does not exist (${ONLY.join(',')}) — the run would pass over nothing`)
  if (CPU_THROTTLE > 1) console.log(`[page-scroll] CPU THROTTLED — GATE_CPU_THROTTLE=${CPU_THROTTLE}: every tab runs ${CPU_THROTTLE}x slower. This is not a clean run.`)
  if (PROBE_NOTHING) console.log('[page-scroll] --probe-nothing: every app testid points at one nothing renders. This run MUST fail.')
  for (const dr of harnessCopyDrift()) fail(`harness drift: ${dr}`)
  mkdirSync(OUTDIR, { recursive: true })
  harness = await startHarness()
  if (BASELINE_SHA && !/\[harness\] serving src\/\*\* from git [0-9a-f]{40}/.test(harnessLog)) {
    throw new Error('HARNESS_BASELINE_SHA is set but the harness never printed "[harness] serving src/** from git <sha>" — it is serving the working tree, so a baseline result would be a lie')
  }
  chrome = await startChrome(udd)
  cdp = await connect(chrome.version.webSocketDebuggerUrl)
  console.log(`[page-scroll] ${chrome.version.Browser} · harness :${PORT} · CDP :${CDP_PORT}`)
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

// A non-clean run echoes what its harness said it served, so the record names the source it measured.
if (BASELINE_SHA || CUSTOM_CONFIG) {
  for (const line of harnessLog.split('\n').filter((l) => /^\[[a-z][a-z-]*\] /.test(l))) console.log(`[page-scroll] harness said: ${line}`)
}
if (shots.length) console.log(`[page-scroll] screenshots: ${shots.length} in ${OUTDIR.replace(`${ROOT}/`, '')}`)
// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner says which.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[page-scroll] FAIL — EXPECTED. --probe-nothing pointed every app testid at one nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[page-scroll] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[page-scroll] FAIL — and this one is the real defect: every testid pointed at nothing and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[page-scroll] PASS')
