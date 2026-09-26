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
// THE FLOWS, at each viewport (426x836 — Dave's handset — and 360x640; GATE_VIEWPORTS overrides), except the five
// slow ones (eventlog-slow, zones-slow, leave-during-load, reload-skeleton, deep25), which run at the first only:
// they measure time, not layout, and each has a fast sibling at both. Every page a flow PUSHES onto must land at
// scrollY 0 (±1px, LAND_TOL_PX) with its title inside the visible band; every Back must land at the exact scrollY the page was left
// at, with the element tapped at the same viewport top (±1px):
//   eventlog      a planting's Event log, deep → an event → Back. The page loads in TWO stages (header, then
//                 the log): the restore has to outlast both. Shipped app: Back lost the place (4658 → 0).
//   eventlog-slow as eventlog, every GET 3 s slow — each stage 3 s: the 4 s prototype landed 2070 of 4658.
//   eventlog-more the Event log past "Show more" → event 55 → Back. The planting page forgets how many events
//                 it showed, so the place is beyond the page it comes back as: the restore must stop at the
//                 closest point it can reach (the page's end) once the page has settled, not pull for 15 s —
//                 and a "Show more" tap after that must not jump to the old place.
//   eventlog-more-tap  the same Back, with "Show more" TAPPED (a finger: touch pointerdown, then click) while
//                 the restore is still pulling: a tap takes the restore over, so the rows it adds never yank
//                 the page to the old place.
//   zones         Zones, a row mid-list (not the page's end, so an overshoot shows too) → the zone → Back.
//   zones-slow    as zones, every page GET 5 s slow (a cold Lambda): the 4 s prototype landed 56 of 1645.
//   zones-slowtoken  as zones, every request waiting 1.5 s for its Clerk token first (?token=, a cold token cache):
//                 that wait is loading too, so the out-of-reach stop must not read it as a settled page
//                 (qa2-scrollmanager-confirm NEW-1: counted from apiFetch only, it gave up on the shell at 56).
//   leave-during-load  as zones with every GET 3 s slow, but away by a tab WHILE the Back is still loading, then
//                 Back again: the restore's clamped attempts were never filed (rimpact IMPORTANT-3).
//   takeover      as zones, and the wheel turned INSIDE the restore's 1 s hold: the page stays where the user
//                 scrolled it, never pulled back.
//   takeover-touch  the same with a finger, every GET 1.5 s slow: a thumb RESTING on the glass from the Back
//                 through the load does not take over; the same finger MOVING does.
//   top-back      a long list at its TOP → Achievements → down → Back → the list at its top (the zero on a POP
//                 with no record: 'manual' leaves the offset undefined, and Chrome's carry would keep 3000).
//   more          a long list, deep → More → Achievements (a REPLACE into the Back marker's slot) → Back. Its
//                 Back frames are sampled for the outgoing page moving before the path changes — an
//                 OBSERVATION, not the pin: React commits the POP before the next frame, so no frame shows it
//                 in this Chrome with either mode. What pins 'manual' is the instrument check.
//   search        a long list, deep → header Search → a result (a push out of the overlay) → Back: Search
//                 re-opens over the list AT its place → the X → still there.
//   search-peek   a long list, deep → header Search → Peek (a PUSH inside the overlay, Search.jsx's openPeek)
//                 → the system Back (the results again) → the X: the list never moves.
//   garden-back   Garden, deep → a planting → Back → Garden at its spot (Garden restores itself).
//   garden-tab    Garden, deep → Today tab → Garden tab → Garden at its spot ("back to your spot" on a push).
//   garden-tab-4x as garden-tab with the tab's CPU throttled 4x: Garden's snapshot must not lose the spot to
//                 the reset's scroll event on a slow commit (rimpact MINOR-2, both halves).
//   garden-add    Garden, deep → + → "Add a planting" (/garden?add=1, a REPLACE onto the SAME page) → the
//                 editor opens (its ?add strip is another same-page REPLACE) → its X → Garden where it was.
//   putup         Put-Up's Going-now list, deep → a batch (?batch=, a same-page PUSH) → Back → the list's place.
//                 A MUST-NOT-CHANGE guard: Chromium's own clamp carry restores it with or without the manager.
//   putup-top     Put-Up's list at its TOP → the first batch (same page) → down → Back → the list at its top
//                 (rimpact-scrollmanager-built N1: the batch's offset used to come back with it).
//   seeds-switch  My seeds, a little down → the view switch to Saved seeds (a same-page REPLACE) → no jump.
//   same-replace  a long list, deep → its sort control (a same-page REPLACE) → no jump → a row → Back → the
//                 place, now filed under the new entry.
//   hook-seeded   Saved seeds, deep → a lot → Back → Saved seeds' own restore puts it back. A REGRESSION GUARD
//                 for the hook's restore: the page claims its entry, so the manager's store — emptied here, as
//                 for an entry the previous bundle wrote — is never read on that Back (rimpact BLOCKING-2's "no
//                 held zero" rests on the unit table).
//   hook-top      Harvests at the top → a long list, deep → Back → Harvests at the top, not the list's carry.
//   retap-back    Harvests, down → its tab re-tapped (a same-page REPLACE, a new entry, no move) → further down
//                 → header List → Back → the place: claims are per ENTRY, not per page (rimpact IMPORTANT-4).
//   lot-back      Saved seeds opened AT a lot (?lot=: the arrival hint scrolls to it) → up the list, away from it
//                 → header List → the hook's store emptied → Back → the place, not the lot again (IMPORTANT-5).
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
//   lot-refuse    a seed lot → "175-" typed into Seed count → Save at the foot of the form, refused: the field is
//                 brought into the band and focused, and nothing moves it for 1.5 s → header List → Back → the
//                 place ON THE PIXEL (the saved-seed lane's refused Save with the manager; the driver's exactness,
//                 qa2-scrollmanager-confirm MINOR-2/MINOR-7 — within the old 4 px it came back at 972 for 968).
//   reload        Zones, a row mid-list → the app reloads on that entry (SW post-update reload, a tab restore)
//                 → the place. location.reload() fires BOTH visibilitychange→hidden and pagehide, so this proves
//                 one of the two flushes works, not which: the Android discard path (hidden, then no pagehide)
//                 is pinned by the unit suite (usePageScrollManager.test.jsx), not here.
//   reload-skeleton  as reload with the user unresolved for 3 s at the load (?auth=3000: Protected's skeleton,
//                 App.jsx's `ready: !loading`): the restore waits through it and counts no time there.
//   deep25        twenty-five pages deep, each left at its own offset → Back twenty-five times → each place
//                 (the manager keeps 100 entries; useScrollRestore's own store keeps 20).
// Every number is printed on pass as well as fail, and the tightest floor and title checks print their margin
// (the checks CI's Linux fonts could move; a miss there is a hard red, never a false pass).
//
// THE CONTRACT A CHECK HOLDS (rimpact-scrollmanager-built N2): the gate reads SCROLL_MANAGER_ENABLED as the
// harness serves it, so a forward flag-off build — the rollback — is measured against TODAY'S app, not the fix:
//   · with the manager ON, every check is asserted;
//   · with it OFF, the gate prints "manager OFF" and asserts only what the app kept before the manager and must
//     keep with it: history.scrollRestoration back at 'auto', same-page writes and overlays never moving the
//     page, Garden's and the hook pages' own restores, the pages that reset themselves (PlantingDetail,
//     InventoryDetail), and a Back to a page left at its top. The manager's own promises — a door opens at its
//     top, Back puts back the place on a page that cannot, a restore gives way to the user, a reload — are
//     printed as "manager OFF, not asserted", and a flow that is the manager's from its first step is not run.
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
// NON-VACUITY (Projects/Gardening/_seedstab12_20260925/scrollmgr-nonvacuity-*.txt, mutants served through
// GATE_HARNESS_CONFIG=scrollmgr-mutant.config.mjs; ci.yml's step lists which flow each one reds). One rule has
// no flow here: "file only while the entry is still the page's" guards scroll events between a history change
// and the commit, which under 'manual' come only from a user scroll during a pending transition or a native
// restore of an entry still in 'auto' — timing-dependent, so it is pinned by usePageScrollManager.test.jsx.
// The flows that measure a restore mid-flight (takeover, takeover-touch, eventlog-more-tap) read the harness's
// restore log (__h.restores(), the manager's onRestore) to prove the restore was still armed when the user
// acted: a restore that had already finished would make them pass over nothing, and that is a red.
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
  // Search's peek: a swap PUSH carrying the background (flow search-peek's door).
  const peek = /swap\([^,]+, \{ replace: false, state: \{ peekPushed: true \} \}\)/
  if (!peek.test(src('src/pages/Search.jsx'))) out.push('Search.jsx no longer opens its peek with swap(url, { replace: false, state: { peekPushed: true } }) — flow search-peek models a door the app no longer has')
  if (!peek.test(harness)) out.push('tests/harness/pagescroll.jsx\'s Peek no longer opens the way Search.jsx does')
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
// A landing within 1px of the top IS the top. Measured, cause not found: from a mid-list Zones row the zone page
// sometimes ends at y1 — a browser-side 1px scroll ~660 ms after the manager's reset, which depends on the row and
// the viewport, with every JS scroll API wrapped (none called), scroll anchoring off (overflow-anchor: none, still
// y1), the mouse moved off the page and the list positioned without the wheel. Invisible; the bug lands 52px+.
const LAND_TOL_PX = 1
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
  toSavedLot: `d.querySelector('${tid('harness-to-saved-lot')}')`,
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
  searchPeek: `d.querySelector('[role="dialog"][aria-label="Search your garden"] ${tid('harness-search-peek')}')`,
  searchPeeked: `d.querySelector('[role="dialog"][aria-label="Search your garden"] ${tid('harness-search-peeked')}')`,
  moreSheet: `d.querySelector('[role="dialog"][aria-label="More navigation options"]')`,
  deepSort: `d.querySelector('${tid('deep-sort')}')`,
  deepRow: (depthExpr) => `(() => { ${BAND_FN} const mid = (bandTop + bandBottom) / 2; let best = null, bd = Infinity
    for (const r of d.querySelectorAll('${tid('deep-row')}')) { const b = r.getBoundingClientRect(); const c = (b.top + b.bottom) / 2; const dd = Math.abs(c - (${depthExpr})); if (dd < bd) { bd = dd; best = r } }
    return best })()`,
  deepRowN: (n) => `d.querySelector('${tid('deep-row')}[data-row="${n}"]')`,
  eventRow: `d.querySelectorAll('a[href^="/events/"]')[44]`,
  eventRowN: (n) => `d.querySelectorAll('a[href^="/events/"]')[${n}]`,
  eventRows: `d.querySelectorAll('a[href^="/events/"]').length`,
  showMore: `d.querySelector('${tid('event-log-show-more')}')`,
  // Zones' door: a row in the MIDDLE of the list (Garden Beds › Bed 3), so the page is not at its end when
  // left and a restore that overshoots is as visible as one that falls short (qa-scrollmanager-built M6).
  zoneRow: `d.querySelector('a[href="/locations/loc-bed-3"]')`,
  tile: (n) => `d.querySelectorAll('${tid('planting-tile')}')[${n}]`,
  tileLink: (n) => `d.querySelectorAll('${tid('planting-tile-link')}')[${n}]`,
  addPlantingDialog: `d.querySelector('[role="dialog"][aria-label="Add planting"]')`,
  addPlantingClose: `d.querySelector('[role="dialog"][aria-label="Add planting"] [data-sheet-close]')`,
  batch: (id) => `d.querySelector('${tid('going-batch')}[data-batch-id="${id}"]')`,
  batchOpen: (id) => `d.querySelector('${tid('going-batch')}[data-batch-id="${id}"] ${tid('going-open-batch')}')`,
  batchDetail: (id) => `d.querySelector('${tid('batch-detail-view')}[data-batch-id="${id}"]')`,
  ristraCard: `d.querySelector('${tid('seed-lot-card')}[data-lot-id="lot-ristra"]')`,
  lotCard: (id) => `d.querySelector('${tid('seed-lot-card')}[data-lot-id="${id}"]')`,
  lotCardMid: `(() => { ${BAND_FN} const mid = (bandTop + bandBottom) / 2; let best = null, bd = Infinity
    for (const r of d.querySelectorAll('${tid('seed-lot-card')}')) { const b = r.getBoundingClientRect(); const dd = Math.abs((b.top + b.bottom) / 2 - mid); if (dd < bd) { bd = dd; best = r } }
    return best })()`,
  ristraTitle: `d.querySelector('${tid('seed-lot-card')}[data-lot-id="lot-ristra"] ${tid('seed-lot-title')}')`,
  savedRadio: `[...d.querySelectorAll('[role="radiogroup"][aria-label="Which seeds"] [role="radio"]')].find((b) => b.textContent.trim() === 'Saved seeds') || null`,
  savedView: `d.querySelector('${tid('saved-seeds-view')}')`,
  editSow: `d.querySelector('${tid('edit-sow-details')}')`,
  seedCount: `d.querySelector('${tid('inv-seed-count')}')`,
  saveChanges: `[...d.querySelectorAll('button[type="submit"]')].find((b) => b.textContent.trim() === 'Save changes') || null`,
  cancel: `[...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel') || null`,
  chainRow: `(() => { ${BAND_FN} const mid = (bandTop + bandBottom) / 2; let best = null, bd = Infinity
    for (const r of d.querySelectorAll('${tid('chain-row')}')) { const b = r.getBoundingClientRect(); const dd = Math.abs((b.top + b.bottom) / 2 - mid); if (dd < bd) { bd = dd; best = r } }
    return best })()`,
}

// `manager: true` — the flow is the manager's own promise from its first step, so with the manager OFF it is
// not run (see THE CONTRACT above). `ms` — every GET's latency. `auth` — ms the user stays unresolved at each
// document load. `cpu` — CDP CPU throttling for the tab. `once` — the first viewport only: the slow flows measure
// time, not layout, and each has a fast sibling at every viewport (qa-scrollmanager-built §6: every kill was the
// same at both; this saves ~90 s of CI).
const FLOWS = [
  { key: 'eventlog', manager: true, label: 'a planting\'s Event log, deep → an event → Back' },
  { key: 'eventlog-slow', manager: true, once: true, label: 'a planting\'s Event log, deep → an event → Back, every GET 3 s slow (two stages)', ms: 3000 },
  { key: 'eventlog-more', manager: true, label: 'a planting\'s Event log past "Show more" → event 55 → Back (out of reach: the restore stops at the page\'s end) → "Show more" does not jump' },
  { key: 'eventlog-more-tap', manager: true, label: 'a planting\'s Event log past "Show more" → event 55 → Back → a finger taps "Show more" while the restore is still pulling' },
  { key: 'zones', manager: true, label: 'Zones, a row mid-list → the zone → Back' },
  { key: 'zones-slow', manager: true, once: true, label: 'Zones, a row mid-list → the zone → Back, every GET 5 s slow', ms: 5000 },
  { key: 'zones-slowtoken', manager: true, label: 'Zones, a row mid-list → the zone → Back, every request waiting 1.5 s for its sign-in token', token: 1500 },
  { key: 'leave-during-load', manager: true, once: true, label: 'Zones, a row mid-list → the zone → Back, and away again while Zones is still loading → Back', ms: 3000 },
  { key: 'takeover', manager: true, label: 'Zones, a row mid-list → the zone → Back → the wheel turned inside the restore\'s hold' },
  { key: 'takeover-touch', manager: true, label: 'Zones, a row mid-list → the zone → Back with a thumb resting through the load → the thumb moves, every GET 1.5 s slow', ms: 1500 },
  { key: 'top-back', label: 'a long list at its TOP → Achievements → down → Back' },
  { key: 'more', manager: true, label: 'a long list, deep → More → Achievements → Back' },
  { key: 'search', label: 'a long list, deep → header Search → a result → Back (Search over the list at its place) → the X' },
  { key: 'search-peek', label: 'a long list, deep → header Search → Peek → the system Back → the X' },
  { key: 'garden-back', label: 'Garden, deep → a planting → Back' },
  { key: 'garden-tab', label: 'Garden, deep → Today tab → Garden tab' },
  { key: 'garden-tab-4x', label: 'Garden, deep → Today tab → Garden tab, CPU 4x slower', cpu: 4 },
  { key: 'garden-add', label: 'Garden, deep → + → "Add a planting" (same page) → the editor\'s X' },
  { key: 'putup', label: 'Put-Up\'s Going-now list, deep → a batch (same page) → Back (a must-not-change guard)' },
  { key: 'putup-top', label: 'Put-Up\'s Going-now list at its TOP → the first batch (same page) → down → Back' },
  { key: 'seeds-switch', label: 'My seeds, a little down → the switch to Saved seeds (same page)' },
  { key: 'same-replace', label: 'a long list, deep → its sort control (same page) → a row → Back' },
  { key: 'hook-seeded', label: 'Saved seeds, deep → a lot → Back: the hook\'s own restore (a regression guard; the manager\'s store, emptied, is never read)' },
  { key: 'hook-top', label: 'Harvests at the top → a long list, deep → Back' },
  { key: 'retap-back', label: 'Harvests, down → its tab re-tapped (same page, a new entry) → further down → header List → Back' },
  { key: 'lot-back', label: 'Saved seeds opened at a lot (?lot=) → away from it → header List → the hook\'s store emptied → Back' },
  { key: 'shrink-x', manager: true, label: 'a long list, deep → header Search → the list renders short → the X → the list long again' },
  { key: 'shrink-back', manager: true, label: 'a long list, deep → header Search → the list renders short → the system Back → the list long again' },
  { key: 'shrink-marker', manager: true, label: 'a long list, deep → More → the list renders short → the system Back → the list long again' },
  { key: 'lot-edit', manager: true, label: 'a seed lot, deep → "Edit sow details →" → the variety editor → its Cancel' },
  { key: 'lot-refuse', label: 'a seed lot → a typo in Seed count → Save refused (the field brought into view, focused) → header List → Back' },
  { key: 'reload', manager: true, label: 'Zones, a row mid-list → the app reloads on that entry' },
  { key: 'reload-skeleton', manager: true, once: true, label: 'Zones, a row mid-list → the app reloads on that entry, the user unresolved for 3 s', auth: 3000 },
  { key: 'deep25', manager: true, once: true, label: `${CHAIN_DEPTH} pages deep, each at its own offset → Back ${CHAIN_DEPTH} times` },
]

const failures = []
const fail = (m) => failures.push(m)
const shots = []
// The flag as each flow's harness served it ('on' / 'off'): one build, so one value.
const served = new Set()

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
  // A finger: real touch input through the browser's gesture pipeline (touchstart/touchmove/touchend, the touch
  // pointer events, a tap's click, a drag's scroll). `points` is [] for touchEnd.
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y })) }, sessionId)
  // Real typing into the focused field (an input event React sees, as a keyboard's would be).
  const insertText = async (text) => cdp.send('Input.insertText', { text }, sessionId)
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
  // The centre of `sel` in host coordinates, if it sits in the visible band and hit-tests to itself (tap's rule).
  const aim = async (sel, what) => {
    const p = await read(`const el = ${sel}; if (!el) return { missing: true }
      ${BAND_FN}
      const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect()
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
      const inBand = y >= bandTop && y <= bandBottom && x >= 0 && x <= w.innerWidth
      const at = inBand ? d.elementFromPoint(x, y) : null
      return { x: fr.left + x, y: fr.top + y, inBand, hits: !!at && (at === el || el.contains(at)) }`)
    if (!p || p.missing) return { why: `${what} is not on the page` }
    if (!p.inBand) return { why: `${what} is not in the visible band` }
    if (!p.hits) return { why: `${what} does not hit-test at its centre` }
    return { x: p.x, y: p.y }
  }
  // The middle of the visible band, in host coordinates: where a thumb or the wheel goes.
  const bandMid = () => read(`${BAND_FN} const fr = f.getBoundingClientRect(); return { x: fr.left + w.innerWidth / 2, y: fr.top + (bandTop + bandBottom) / 2 }`)
  return { ev, read, waitIn, settle, tap, wheelTo, wheelToY, wheelBy, shoot, mouse, touch, insertText, aim, bandMid }
}

// The frame's page as it stands. `sel` is the element whose viewport top the flow compares.
const READ_HERE = (sel) => `${BAND_FN}
  const el = ${sel || 'null'}, r = el ? el.getBoundingClientRect() : null
  const h1 = d.querySelector('[data-harness-pages] h1'), hr = h1 ? h1.getBoundingClientRect() : null
  return { path: w.location.pathname, search: w.location.search, key: w.__h ? w.__h.key() : null, page: w.__h ? w.__h.pageKey() : null,
    y: w.scrollY, docH: d.documentElement.scrollHeight, max: d.documentElement.scrollHeight - w.innerHeight, top: r ? r.top : null,
    h1: hr ? { t: hr.top, b: hr.bottom, text: (h1.textContent || '').trim().slice(0, 50) } : null,
    h1InBand: !!hr && hr.height > 0 && hr.top >= bandTop - 0.5 && hr.bottom <= bandBottom + 0.5,
    band: [bandTop, bandBottom], mode: w.__h ? w.__h.mode() : null }`
const DIAG = `return { errors: w.__h ? w.__h.errors() : ['window.__h missing'], unstubbed: w.__h ? w.__h.unstubbed() : [],
  decisions: w.__h ? w.__h.decisions() : [], restores: w.__h ? w.__h.restores() : [], trace: w.__h ? w.__h.trace() : [], store: w.__h ? w.__h.store() : null,
  leftPage: !!d.querySelector('[data-testid="harness-left-page"]'), fallback: !!d.querySelector('[data-testid="harness-route-fallback"]'),
  focus: d.activeElement && d.activeElement !== d.body ? (d.activeElement.getAttribute('data-testid') || d.activeElement.tagName.toLowerCase() + (d.activeElement.id ? '#' + d.activeElement.id : '')) : null }`

const R1 = (n) => (n == null ? 'n/a' : Math.round(n * 10) / 10)
const rowsLine = (decisions) => decisions.slice(-8).map((x) => `${x.path}:${x.row}/${x.action}${x.action === 'RESTORE' ? `→${Math.round(x.y)}` : ''}`).join(' ') || 'none'
// How each restore ended: OUTCOME[/reason] at its time, target, where the page was and its max then.
const restoreLine = (r) => `${r.outcome}${r.reason ? `/${r.reason}` : ''} @${r.t}ms (target ${r.target}, y${r.y}, max ${r.max})`
const restoresLine = (restores) => restores.slice(-4).map(restoreLine).join(' ') || 'none'
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
    const auth = flow.auth ?? 0
    const token = flow.token ?? 0
    // A settle long enough to outlast the flow's own latency: the restore re-applies until the content lands.
    const slowMax = Math.max(10000, (ms + token) * 3 + 6000) + auth
    const url = `http://localhost:${PORT}/tests/harness/viewport.html?page=pagescroll.html&vw=${vw}&vh=${vh}&topbar=${TOP_CHROME_PX}&ms=${ms}&auth=${auth}&token=${token}`
    const nav = await cdp.send('Page.navigate', { url }, sessionId)
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
    if (!await t.waitIn(`w.__h && w.__h.ready() && d.readyState === 'complete'`, 30000 + auth)) return fail(`${at}: the harness never came up in the frame — nothing to measure`)
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
    if (g.fixture.auth !== auth) geo.push(`the harness holds the user unresolved for ${g.fixture.auth}ms at each load, the flow asked for ${auth}ms`)
    if (g.fixture.token !== token) geo.push(`the Clerk stub gives a token after ${g.fixture.token}ms, the flow asked for ${token}ms`)
    for (const [key, v] of Object.entries(FIXTURE)) if (g.fixture[key] !== v) geo.push(`the fixture's ${key} is ${g.fixture[key]}, the gate expects ${v}`)
    // The browser's restore mode is the one main.jsx sets for the flag this document was served: 'manual' with
    // the manager on. A harness in any other mode measures a browser prod does not run.
    const wantMode = g.fixture.manager ? 'manual' : 'auto'
    if (g.mode !== wantMode) geo.push(`history.scrollRestoration is '${g.mode}', but with SCROLL_MANAGER_ENABLED=${g.fixture.manager} main.jsx sets '${wantMode}'`)
    if (geo.length) return fail(`${at}: ${geo.join('; ')}`)
    const MANAGER = !!g.fixture.manager
    served.add(MANAGER ? 'on' : 'off')
    note.push(MANAGER ? `manager on, '${g.mode}'` : `manager OFF (the flag as served), '${g.mode}'`)
    if (!MANAGER && flow.manager) {
      note.push('the manager\'s own flow from its first step, nothing in it is today\'s contract: not run')
      return
    }
    // THE CONTRACT (header): `today` — asserted whatever the flag; otherwise the manager's own promise, asserted
    // with it on and, with it OFF, printed and not held against today's app.
    const verdict = (msgs, { today = false } = {}) => {
      if (!msgs.length) return null
      if (today || MANAGER) return msgs.join('; ')
      note.push(`manager OFF, not asserted: ${msgs.join('; ')}`)
      return null
    }

    // ── Steps, each a failure message or null.
    const page = (key) => t.waitIn(`w.__h.pageReady('${key}')`, slowMax)
    const diag = async () => {
      const dg = await t.read(DIAG).catch(() => null)
      if (!dg) return ''
      return ` · manager rows: ${rowsLine(dg.decisions)} · restores: ${restoresLine(dg.restores)} · scroll trace: ${traceLine(dg.trace)}${dg.errors.length ? ` · errors: ${dg.errors.join(' | ')}` : ''}${dg.leftPage ? ' · the router LEFT for an unexpected route' : ''}${dg.fallback ? ' · a route fell back (the page threw)' : ''}${dg.focus ? ` · focus on ${dg.focus}` : ''}`
    }
    const enter = async (sel, key, what, { chrome = false } = {}) => {
      const why = await t.tap(sel, what, { chrome })
      if (why) return why
      if (!await page(key)) return `${what} was tapped and the ${key} page never finished loading${await diag()}${await reloaded()}`
      await t.settle(400, slowMax)
      return null
    }
    // A push onto `key`: it must write a new history entry and land at 0 with its title in the band. `today`: the
    // landing holds without the manager too — the page resets itself (PlantingDetail, InventoryDetail) or the
    // page it came from was at its top, so there was nothing to carry.
    const land = async (tapSel, tapWhat, key, { chrome = false, titleSel = null, name = key, today = false } = {}) => {
      const k0 = await t.read(`return w.__h.key()`)
      await t.read(`w.__h.mark(); return 1`)
      const why = await t.tap(tapSel, tapWhat, { chrome })
      if (why) return { why }
      if (!await page(key)) return { why: `${tapWhat} was tapped and the ${key} page never finished loading${await diag()}${await reloaded()}` }
      const st = await t.settle(600, slowMax)
      const here = await t.read(READ_HERE(titleSel))
      await t.shoot(join(OUTDIR, `page-scroll-${flow.key}-${name}-${vw}x${vh}.png`))
      if (here.key == null || here.key === k0) return { why: `${tapWhat} did not write a new history entry (key ${here.key}) — this is not a door onto a new page` }
      const title = titleSel
        ? { t: here.top, ok: here.top != null && here.top >= here.band[0] - 0.5 && here.top <= here.band[1], margin: here.top == null ? null : Math.min(here.top - here.band[0], here.band[1] - here.top) }
        : { t: here.h1?.t, ok: here.h1InBand, margin: here.h1 ? Math.min(here.h1.t - here.band[0], here.band[1] - here.h1.b) : null }
      const msgs = []
      if (!st.settled) msgs.push(`${name} never held still for 600ms within ${slowMax}ms (last y${R1(st.y)})`)
      const off = []
      if (Math.abs(here.y) > LAND_TOL_PX) off.push(`${name} landed at scrollY ${R1(here.y)}, not 0 — it opened part-way down (the bug)`)
      if (!title.ok) off.push(`${name}'s title is at y${R1(title.t)}, not inside the visible band y${R1(here.band[0])}-${R1(here.band[1])}`)
      const v = verdict(off, { today })
      if (v) msgs.push(v)
      note.push(`${name} y${R1(here.y)} (title y${R1(title.t)}${title.ok ? `, ${R1(title.margin)}px inside the band` : ''})`)
      return { here, why: msgs.length ? `${msgs.join('; ')}${await diag()}` : null }
    }
    // Back onto `key`: the very entry `before` was read on, at its exact offset, `sel` at the same viewport top.
    // `today`: the place comes back without the manager too (Garden's own restore, a hook page's, a page left at
    // its top, a same-page list Chromium's clamp carry restores).
    const back = async (before, key, sel, what, { sample = false, today = false } = {}) => {
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
      const off = []
      if (Math.round(after.y) !== Math.round(before.y)) off.push(`${what}: Back landed at scrollY ${R1(after.y)}, the page was left at ${R1(before.y)} — the place was lost`)
      if (sel && (after.top == null || before.top == null || Math.abs(after.top - before.top) > TOP_TOL_PX)) off.push(`${what}: after Back the tapped element's top is at y${R1(after.top)}, it was at y${R1(before.top)} (±${TOP_TOL_PX}px)`)
      const v = verdict(off, { today })
      if (v) msgs.push(v)
      note.push(`Back y${R1(after.y)} in ${st.ms}ms (left at y${R1(before.y)})`)
      return { after, samples, why: msgs.length ? `${msgs.join('; ')}${await diag()}` : null }
    }
    // The floor on how far down a page is before its tap. `show` prints the margin — the checks nearest their
    // floor are the font-sensitive ones (CI's Linux fonts are not this Mac's).
    const deep = (y, min = DEEP_MIN_PX, { show = false } = {}) => {
      if (y < min) return `the page is only ${R1(y)}px down before the tap (need >= ${min}) — a clobbered offset could equal it, so the flow proves nothing`
      if (show) note.push(`${R1(y - min)}px over the ${min}px floor`)
      return null
    }
    // A mid-list source: the page must not be at its end, or a restore that overshoots would pass.
    const midList = (here, what) => (here.y <= here.max - 40 ? null : `${what} is at the page's end (y${R1(here.y)} of max ${R1(here.max)}) — a restore that overshoots would not show`)
    const restores = () => t.read(`return w.__h.restores()`)
    const done = (why) => { if (why) fail(`${at}: ${flow.label}: ${why}`) }

    // ── The flows.
    const k = flow.key
    if (k === 'eventlog' || k === 'eventlog-slow') {
      let why = await enter(SEL.toPlanting, 'planting', 'the /today link to the planting')
      if (why) return done(why)
      // The Event log pages its rows; the door is its 45th, which must be on the page.
      const rows = await t.read(`return ${SEL.eventRows}`)
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
    if (k === 'eventlog-more' || k === 'eventlog-more-tap') {
      let why = await enter(SEL.toPlanting, 'planting', 'the /today link to the planting')
      if (why) return done(why)
      // The Event log shows 50 rows and "Show more" (PlantingDetail's eventsShown: component state, so a page
      // mounted by Back shows 50 again). The door is a row past them.
      const shown = await t.read(`return ${SEL.eventRows}`)
      if (shown !== 50) return done(`the Event log shows ${shown} rows before "Show more", not 50 — the out-of-reach case needs its second page`)
      why = await t.wheelTo(SEL.showMore, '"Show more"')
      if (why) return done(why)
      await t.settle(300, 3000)
      why = await t.tap(SEL.showMore, '"Show more"')
      if (why) return done(why)
      if (!await t.waitIn(`${SEL.eventRows} === ${FIXTURE.plantingEvents}`, 5000)) return done(`"Show more" never showed all ${FIXTURE.plantingEvents} events`)
      const row = SEL.eventRowN(54)
      why = await t.wheelTo(row, 'the Event log\'s 55th row')
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(row))
      if ((why = deep(before.y))) return done(why)
      const l = await land(row, 'the Event log\'s 55th row', 'event')
      if (l.why) return done(l.why)
      await t.read(`w.__h.mark(); return 1`)
      await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
      if (k === 'eventlog-more-tap') {
        // A finger taps "Show more" the moment it is on screen, while the restore is still pulling toward
        // event 55. Its touch pointerdown is not a takeover (a resting thumb); the click that lifting it makes
        // is — before the page's own handler adds the rows that would bring the old place into reach.
        if (!await t.waitIn(`w.__h.pageReady('planting') && ${SEL.showMore}`, slowMax)) return done(`Back never brought the Event log back with its "Show more"${await diag()}`)
        const p = await t.aim(SEL.showMore, '"Show more"')
        if (p.why) return done(`${p.why} while the restore pulled the page toward event 55${await diag()}`)
        const armed = await restores()
        if (armed.length) return done(`the restore had already ended (${restoresLine(armed)}) before the tap — the flow measured no tap during a restore${await diag()}`)
        const y0 = await t.read(`return w.scrollY`)
        await t.touch('touchStart', [[p.x, p.y]])
        await t.touch('touchEnd', [])
        if (!await t.waitIn(`${SEL.eventRows} === ${FIXTURE.plantingEvents}`, 5000)) return done(`the finger's tap on "Show more" never showed all ${FIXTURE.plantingEvents} events${await diag()}`)
        const st = await t.settle(800, 8000)
        const after = await t.read(READ_HERE(null))
        const r = await restores()
        await t.shoot(join(OUTDIR, `page-scroll-${k}-after-${vw}x${vh}.png`))
        note.push(`"Show more" tapped at y${R1(y0)} with the restore still armed (event 55 was at y${R1(before.y)}) · after it y${R1(after.y)} · restore: ${restoresLine(r)}`)
        const msgs = []
        if (!st.settled) msgs.push(`after the tap the page never held still (last y${R1(st.y)})`)
        if (!r.length || r[0].outcome !== 'TAKEOVER' || r[0].reason !== 'click') msgs.push(`the tap did not take the restore over (${restoresLine(r)})`)
        if (Math.abs(after.y - y0) > 40) msgs.push(`the page jumped from y${R1(y0)} to y${R1(after.y)} after "Show more" — the restore pulled it to the old place (y${R1(before.y)})`)
        return done(msgs.length ? `${msgs.join('; ')}${await diag()}` : null)
      }
      if (!await t.waitIn(`w.__h.pageReady('planting')`, slowMax)) return done(`Back never brought the planting back${await diag()}`)
      // The place is past the end of the page Back brought. Once that page has settled, the restore stops at the
      // closest point it can reach instead of pulling for its whole budget.
      if (!await t.waitIn(`w.__h.restores().length > 0`, 8000)) return done(`8 s after Back the restore was still pulling toward y${R1(before.y)}, past the page's end — an unreachable place is pulled for the whole budget, and a "Show more" tap inside it jumps${await diag()}`)
      const st = await t.settle(800, 8000)
      const r = await restores()
      const after = await t.read(READ_HERE(null))
      await t.shoot(join(OUTDIR, `page-scroll-${k}-back-planting-${vw}x${vh}.png`))
      if (!(before.y > after.max + 4)) return done(`event 55's place (y${R1(before.y)}) is within the page Back brought (max ${R1(after.max)}) — nothing was out of reach, so the flow proves nothing`)
      const msgs = []
      if (!st.settled) msgs.push(`after Back the page never held still (last y${R1(st.y)})`)
      if (r[0].outcome !== 'EXHAUSTED' || r[0].reason !== 'unreachable') msgs.push(`the restore ended ${restoreLine(r[0])}, not EXHAUSTED/unreachable`)
      if (Math.abs(after.y - after.max) > 1) msgs.push(`after Back the page is at y${R1(after.y)}, not the closest point it can reach (its end, y${R1(after.max)})`)
      if (msgs.length) return done(`${msgs.join('; ')}${await diag()}`)
      note.push(`Back: ${restoreLine(r[0])}, the page's end (event 55 was at y${R1(before.y)})`)
      // "Show more" after the stop: the rows it adds bring the old place into reach, and nothing may take the
      // page there.
      why = await t.wheelTo(SEL.showMore, '"Show more"')
      if (why) return done(why)
      await t.settle(300, 3000)
      const y1 = await t.read(`return w.scrollY`)
      why = await t.tap(SEL.showMore, '"Show more"')
      if (why) return done(why)
      if (!await t.waitIn(`${SEL.eventRows} === ${FIXTURE.plantingEvents}`, 5000)) return done(`"Show more" never showed all ${FIXTURE.plantingEvents} events after Back`)
      await t.settle(800, 8000)
      const y2 = await t.read(`return w.scrollY`)
      note.push(`"Show more" after the stop: y${R1(y1)} → y${R1(y2)}`)
      if (Math.abs(y2 - y1) > 40) return done(`"Show more" after the stop moved the page y${R1(y1)} → y${R1(y2)} (event 55 was at y${R1(before.y)}) — the restore came back for it${await diag()}`)
      return
    }
    if (k === 'takeover' || k === 'takeover-touch') {
      let why = await enter(SEL.toLocations, 'locations', 'the /today link to Zones')
      if (why) return done(why)
      why = await t.wheelTo(SEL.zoneRow, 'the Bed 3 row')
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(SEL.zoneRow))
      if ((why = deep(before.y) || midList(before, 'the Bed 3 row'))) return done(why)
      const l = await land(SEL.zoneRow, 'the Bed 3 row', 'location')
      if (l.why) return done(l.why)
      const thumb = await t.bandMid()
      await t.read(`w.__h.mark(); return 1`)
      await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
      // takeover-touch: a thumb lands as Back is made and RESTS there through the load — a touchstart and a touch
      // pointerdown, neither of which is the user taking over (rimpact IMPORTANT-7).
      const lift = async () => { if (k === 'takeover-touch') await t.touch('touchEnd', []).catch(() => {}) }
      if (k === 'takeover-touch') await t.touch('touchStart', [[thumb.x, thumb.y]])
      // The restore puts the row back and holds it for 1 s: inside that hold, the user scrolls.
      if (!await t.waitIn(`w.__h.pageReady('locations') && Math.abs(w.scrollY - ${before.y}) <= 4`, slowMax)) {
        await lift()
        return done(`Back never put Zones back at y${R1(before.y)}${k === 'takeover-touch' ? ' under the resting thumb' : ''}${await diag()}`)
      }
      const r0 = await restores()
      if (r0.length) {
        await lift()
        return done(r0[0].outcome === 'TAKEOVER'
          ? `the restore gave way to a thumb RESTING on the glass (${restoreLine(r0[0])}) — a thumb resting while the page loads must not lose the place${await diag()}`
          : `the restore had already ended (${restoreLine(r0[0])}) before the user could scroll — the flow measured no takeover${await diag()}`)
      }
      if (k === 'takeover') {
        await t.mouse('mouseWheel', thumb.x, thumb.y, { deltaX: 0, deltaY: -400 })
      } else {
        // ...and now the thumb MOVES down the glass, and the page follows it up. It stops before it lifts, so the
        // lift is no fling.
        for (let i = 1; i <= 8; i++) await t.touch('touchMove', [[thumb.x, thumb.y + i * 50]])
        await sleep(250)
        await t.touch('touchEnd', [])
      }
      const st = await t.settle(800, 8000)
      const after = await t.read(READ_HERE(SEL.zoneRow))
      const r = await restores()
      await t.shoot(join(OUTDIR, `page-scroll-${k}-after-${vw}x${vh}.png`))
      const how = k === 'takeover' ? 'wheel' : 'touchmove'
      note.push(`the ${k === 'takeover' ? 'wheel (-400)' : 'thumb, resting then moving 400px'} took Zones from y${R1(before.y)} to y${R1(after.y)} · restore: ${restoresLine(r)}`)
      const msgs = []
      if (!st.settled) msgs.push(`after the ${how} Zones never held still (last y${R1(st.y)})`)
      if (!r.length || r[0].outcome !== 'TAKEOVER' || r[0].reason !== how) msgs.push(`the restore did not give way to the ${how} (${restoresLine(r)})`)
      if (Math.abs(after.y - before.y) <= 4) msgs.push(`the restore pulled the page back to y${R1(after.y)} after the user scrolled up — it fought the user`)
      else if (k === 'takeover' && Math.abs(after.y - (before.y - 400)) > 60) msgs.push(`the page is at y${R1(after.y)}; the wheel left it near y${R1(before.y - 400)}`)
      else if (k === 'takeover-touch' && !(after.y < before.y - 200)) msgs.push(`the page is at y${R1(after.y)}; the finger drew it up from y${R1(before.y)} by about 400px`)
      return done(msgs.length ? `${msgs.join('; ')}${await diag()}` : null)
    }
    if (k === 'zones' || k === 'zones-slow' || k === 'zones-slowtoken' || k === 'reload' || k === 'reload-skeleton' || k === 'leave-during-load') {
      let why = await enter(SEL.toLocations, 'locations', 'the /today link to Zones')
      if (why) return done(why)
      why = await t.wheelTo(SEL.zoneRow, 'the Bed 3 row')
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(SEL.zoneRow))
      if ((why = deep(before.y) || midList(before, 'the Bed 3 row'))) return done(why)
      if (k === 'reload' || k === 'reload-skeleton') {
        // The app reloads ON this entry: a new document, sessionStorage kept (the manager flushed its mirror on
        // hidden and on pagehide — location.reload() fires both), history.state kept — the service worker's
        // post-update reload, an Android tab restore. reload-skeleton: the new document holds the user
        // unresolved for `auth` ms first, so the restore arms under Protected's skeleton and must count no time
        // there (a skeleton holds its height with no request in flight: exactly what "settled" looks like).
        await t.ev(`(() => { ${FRAME_VARS}; w.__h.reloadHere(); return 1 })()`)
        if (!await t.waitIn(`w.__h && w.__h.boot() !== '${boot0}' && w.__h.reloadedDoc() && w.__h.pageReady('locations')`, slowMax)) return done(`the reload never came back with Zones loaded${await diag()}`)
        boot0 = await t.read(`return w.__h.boot()`)   // this reload is the one under test
        const st = await t.settle(800, slowMax)
        // The restore reports once its hold is over, which can be after the page first holds still.
        await t.waitIn(`w.__h.restores().length > 0`, 4000)
        const after = await t.read(READ_HERE(SEL.zoneRow))
        const r = await restores()
        await t.shoot(join(OUTDIR, `page-scroll-${k}-after-${vw}x${vh}.png`))
        if (after.key !== before.key) return done(`after the reload the frame is on key ${after.key}, not Zones' own ${before.key} — the reload did not keep the entry`)
        const msgs = []
        if (!st.settled) msgs.push(`after the reload Zones never held still (last y${R1(st.y)})`)
        if (Math.round(after.y) !== Math.round(before.y)) msgs.push(`after the reload Zones is at scrollY ${R1(after.y)}, it was left at ${R1(before.y)} — the reload lost the place`)
        if (after.top == null || Math.abs(after.top - before.top) > TOP_TOL_PX) msgs.push(`the Bed 3 row is at y${R1(after.top)}, it was at y${R1(before.top)}`)
        if (auth && !msgs.length && !(r.length && r[0].outcome === 'DONE' && r[0].t >= auth)) msgs.push(`the place came back, but not by a restore that finished after the ${auth}ms skeleton (${restoresLine(r)}) — the flow did not measure the wait`)
        note.push(`reloaded (mode ${after.mode}${auth ? `, user unresolved ${auth}ms` : ''}): y${R1(after.y)} (left at y${R1(before.y)}) · restore: ${restoresLine(r)}`)
        return done(msgs.length ? `${msgs.join('; ')}${await diag()}` : null)
      }
      const l = await land(SEL.zoneRow, 'the Bed 3 row', 'location')
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
      const b = await back(before, 'locations', SEL.zoneRow, 'Zones')
      if (token) {
        // zones-slowtoken: every request waited `token` ms for its Clerk token (a cold cache) before it went out —
        // time the out-of-reach stop must count as "still loading", not as a settled page (qa2-confirm NEW-1).
        await t.waitIn(`w.__h.restores().length > 0`, 4000)
        note.push(`${await t.read(`return w.__h.tokenCalls()`)} token waits of ${token}ms · restore: ${restoresLine(await restores())}`)
      }
      return done(b.why)
    }
    if (k === 'top-back') {
      let why = await enter(SEL.toDeep, 'deep', 'the /today link to the long list')
      if (why) return done(why)
      // The list at its TOP: its fourth row is the door (row 3, Achievements).
      const row = SEL.deepRowN(3)
      const before = await t.read(READ_HERE(row))
      if (Math.round(before.y) !== 0) return done(`the list opened at y${R1(before.y)}, not its top — nothing to hold at 0`)
      const l = await land(row, 'the list\'s Achievements row', 'achievements', { today: true })
      if (l.why) return done(l.why)
      why = await t.wheelToY(3000)
      if (why) return done(why)
      await t.settle(400, 5000)
      const down = await t.read(`return w.scrollY`)
      if ((why = deep(down))) return done(`Achievements: ${why}`)
      note.push(`Achievements scrolled to y${R1(down)}`)
      // No record for the list (the store never mints a 0), and 'manual' leaves a POP's offset undefined: the
      // zero on that POP is what keeps Achievements' 3000 from coming back with it.
      const b = await back(before, 'deep', row, 'the list left at its top', { today: true })
      return done(b.why)
    }
    if (k === 'more' || k === 'search' || k === 'search-peek' || k === 'same-replace' || k.startsWith('shrink')) {
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
        // AN OBSERVATION, NOT THE PIN (qa-scrollmanager-built M8): under 'auto' Chrome applies the popped offset
        // to the still-mounted Achievements page before the path changes (the measurement saw 2880 → 553), but
        // React commits the POP before the next frame, so in this Chrome no sampled frame can show it with either
        // mode — the count is 0 on the head. history.scrollRestoration in the instrument check pins 'manual'.
        const s = b.samples || []
        const out = s.filter((x) => x.page === 'achievements')
        const moved = out.filter((x) => Math.abs(x.y - l.here.y) > 1)
        note.push(`observed: ${out.length} Back frame(s) on Achievements before the swap, ${moved.length} moved`)
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
        if ((why = verdict(Math.round(re.y) !== Math.round(before.y) ? [`Back re-opened Search over the list at y${R1(re.y)}, the list was left at y${R1(before.y)}`] : []))) return done(`${why}${await diag()}`)
        why = await t.tap(SEL.searchClose, 'Search\'s X', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`w.location.pathname === '/deep' && !${SEL.searchSheet}`, 8000)) return done('the X never closed Search back onto the list')
        await t.settle(600, 6000)
        const after = await t.read(READ_HERE(row))
        note.push(`after the X y${R1(after.y)}`)
        if (after.key !== before.key) return done(`the X landed on key ${after.key}, not the list's own ${before.key}`)
        if ((why = verdict(Math.round(after.y) !== Math.round(before.y) || Math.abs(after.top - before.top) > TOP_TOL_PX ? [`after the X the list is at y${R1(after.y)} (row top y${R1(after.top)}), it was at y${R1(before.y)} (row top y${R1(before.top)})`] : []))) return done(`${why}${await diag()}`)
        return
      }
      if (k === 'search-peek') {
        // Search.jsx's peek: a swap PUSH inside the overlay, carrying the same background — so every commit here
        // keeps the page entry (rows 0 and, on the peek's Back, covered 0). Nothing may move the list.
        const still = async (when) => {
          const y = await t.read(`return w.scrollY`)
          note.push(`${when} y${R1(y)}`)
          return Math.round(y) !== Math.round(before.y) ? `${when} the list under the sheet is at y${R1(y)}, it was left at y${R1(before.y)}${await diag()}` : null
        }
        why = await t.tap(SEL.openSearch, 'header Search', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`w.location.pathname === '/search' && ${SEL.searchPeek}`, 8000)) return done('header Search never opened with its Peek')
        await t.settle(300, 3000)
        if ((why = await still('Search open:'))) return done(why)
        const k1 = await t.read(`return w.__h.key()`)
        await t.read(`w.__h.mark(); return 1`)
        why = await t.tap(SEL.searchPeek, 'Search\'s Peek', { chrome: true })
        if (why) return done(why)
        if (!await t.waitIn(`/peek=/.test(w.location.search) && ${SEL.searchPeeked}`, 8000)) return done('Peek never opened inside Search')
        await t.settle(400, 4000)
        if (await t.read(`return w.__h.key()`) === k1) return done('Peek did not push a new history entry — this is not the in-overlay push under test')
        if ((why = await still('peeking:'))) return done(why)
        await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
        if (!await t.waitIn(`w.location.pathname === '/search' && !/peek=/.test(w.location.search) && ${SEL.searchPeek} && !${SEL.searchPeeked}`, 8000)) return done(`the system Back never brought Search's results back from the peek${await diag()}`)
        await t.settle(500, 4000)
        if ((why = await still('the peek\'s Back:'))) return done(why)
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
        const l = await land(SEL.tileLink(33), 'the 34th planting\'s tile', 'planting', { today: true })
        if (l.why) return done(l.why)
        const b = await back(before, 'garden', tile, 'Garden', { today: true })
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
      if ((why = deep(before.y, DEEP_MIN_PX, { show: true }))) return done(why)
      await t.read(`w.__h.mark(); return 1`)
      why = await t.tap(SEL.batchOpen('kb-9'), 'the ninth batch\'s "Open"')
      if (why) return done(why)
      if (!await t.waitIn(`${SEL.batchDetail('kb-9')} && /batch=kb-9/.test(w.location.search)`, slowMax)) return done(`the batch never opened (on ${await t.read(`return w.location.pathname + w.location.search`)})${await diag()}`)
      await t.settle(500, slowMax)
      const detail = await t.read(READ_HERE(null))
      if (detail.key === before.key) return done('opening the batch did not push a new entry — this is not the same-page push under test')
      note.push(`the batch opened on the same page at y${R1(detail.y)}`)
      // A must-not-change guard, not the row-6 pin: Chromium's own clamp carry puts this list back with or
      // without the manager (qa-scrollmanager-built M4). putup-top is the flow row 6 can fail.
      const b = await back(before, 'putup', card, 'the Going-now list', { today: true })
      return done(b.why)
    }
    if (k === 'putup-top') {
      let why = await enter(SEL.toPutUp, 'putup', 'the /today link to Put-Up')
      if (why) return done(why)
      if (!await t.waitIn(`d.querySelectorAll('${tid('going-batch')}').length === ${FIXTURE.going}`, 8000)) return done(`Put-Up never showed the ${FIXTURE.going} going batches (the Going-now segment)`)
      // The list's first card (the list orders its batches itself).
      const id = await t.read(`const el = d.querySelector('${tid('going-batch')}'); return el ? el.getAttribute('data-batch-id') : null`)
      if (!id) return done('Put-Up\'s Going-now list has no first batch')
      const card = SEL.batch(id)
      const before = await t.read(READ_HERE(card))
      if (Math.round(before.y) !== 0) return done(`Put-Up opened at y${R1(before.y)}, not its top — nothing to hold at 0`)
      await t.read(`w.__h.mark(); return 1`)
      why = await t.tap(SEL.batchOpen(id), `the first batch's (${id}) "Open"`)
      if (why) return done(why)
      if (!await t.waitIn(`${SEL.batchDetail(id)} && /batch=${id}/.test(w.location.search)`, slowMax)) return done(`the batch never opened (on ${await t.read(`return w.location.pathname + w.location.search`)})${await diag()}`)
      await t.settle(500, slowMax)
      const detail = await t.read(READ_HERE(null))
      if (detail.key === before.key) return done('opening the batch did not push a new entry — this is not the same-page push under test')
      // The batch scrolled to its end: an offset the list must NOT come back with.
      why = await t.wheelToY(3000)
      if (why) return done(why)
      await t.settle(400, 5000)
      const down = await t.read(`return w.scrollY`)
      if ((why = deep(down, SHALLOW_MIN_PX, { show: true }))) return done(`the batch: ${why}`)
      note.push(`the batch opened on the same page, scrolled to y${R1(down)}`)
      // A same-path POP with no record for the list (it was left at 0, and the store never mints a 0): row 6's
      // zero (rimpact-scrollmanager-built N1; with the manager off, Chrome's own restore of 0).
      const b = await back(before, 'putup', card, 'the Going-now list left at its top', { today: true })
      return done(b.why)
    }
    if (k === 'seeds-switch') {
      let why = await enter(SEL.toMine, 'seeds', 'the /today link to My seeds')
      if (why) return done(why)
      const r0 = await t.read(`const el = ${SEL.savedRadio}; if (!el) return null; ${BAND_FN} return { top: el.getBoundingClientRect().top, bandTop }`)
      if (!r0) return done('the Seeds view switch has no "Saved seeds" option')
      await t.wheelBy(Math.round(r0.top - r0.bandTop - 12))
      const before = await t.read(READ_HERE(SEL.savedRadio))
      if ((why = deep(before.y, SHALLOW_MIN_PX, { show: true }))) return done(why)
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
      // InventoryDetail lands at its top either way: its own reset with the manager off, the manager's with it on.
      const l = await land(SEL.ristraTitle, 'the Ristra card\'s title', 'lot', { today: true })
      if (l.why) return done(l.why)
      await t.read(`return w.__h.forgetPageScroll()`)
      note.push(`the manager's store emptied (mirror now ${JSON.stringify(await t.read(`return w.__h.store()`))})`)
      const b = await back(before, 'seeds', SEL.ristraCard, 'Saved seeds', { today: true })
      return done(b.why)
    }
    if (k === 'hook-top') {
      let why = await enter(SEL.tabHarvests, 'harvests', 'the Harvests tab', { chrome: true })
      if (why) return done(why)
      const before = await t.read(READ_HERE(null))
      if (Math.round(before.y) !== 0) return done(`Harvests opened at y${R1(before.y)}, not the top — nothing to hold`)
      const l = await land(SEL.headerDeep, 'the header\'s list link', 'deep', { chrome: true, today: true })
      if (l.why) return done(l.why)
      why = await t.wheelToY(3000)
      if (why) return done(why)
      await t.settle(400, 5000)
      const listY = await t.read(`return w.scrollY`)
      if ((why = deep(listY))) return done(why)
      note.push(`the list scrolled to y${R1(listY)}`)
      const b = await back(before, 'harvests', null, 'Harvests', { today: true })
      if (b.why) return done(b.why)
      if (!b.after.h1InBand) return done(`Harvests' h1 is not in the visible band after Back (y${R1(b.after.h1?.t)})`)
      return
    }
    if (k === 'retap-back') {
      let why = await enter(SEL.tabHarvests, 'harvests', 'the Harvests tab', { chrome: true })
      if (why) return done(why)
      const max0 = await t.read(`return d.documentElement.scrollHeight - w.innerHeight`)
      why = await t.wheelToY(Math.round(0.4 * max0))
      if (why) return done(why)
      await t.settle(400, 5000)
      const mid = await t.read(READ_HERE(null))
      if ((why = deep(mid.y))) return done(why)
      // The tab re-tapped: a Link to the page already showing, which react-router REPLACEs — the same page on a
      // NEW entry. Nothing may move.
      why = await t.tap(SEL.tabHarvests, 'the Harvests tab, again', { chrome: true })
      if (why) return done(why)
      if (!await t.waitIn(`w.__h.key() !== '${mid.key}'`, 5000)) return done('re-tapping the Harvests tab did not re-key the entry — this is not the same-page write under test')
      await t.settle(500, 5000)
      const re = await t.read(READ_HERE(null))
      note.push(`re-tap: y${R1(mid.y)} → y${R1(re.y)} (a new key)`)
      if (Math.round(re.y) !== Math.round(mid.y)) return done(`re-tapping the Harvests tab moved it: y${R1(mid.y)} → y${R1(re.y)}${await diag()}`)
      why = await t.wheelToY(Math.round(0.8 * max0))
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(null))
      if ((why = deep(before.y))) return done(why)
      if (before.key !== re.key) return done(`scrolling re-keyed the entry (${re.key} → ${before.key})`)
      const l = await land(SEL.headerDeep, 'the header\'s list link', 'deep', { chrome: true })
      if (l.why) return done(l.why)
      // Back onto the RE-KEYED entry: Harvests holds no saved value for it, so it claims nothing and the manager
      // restores it. A claim by page rather than by entry would zero it (qa-scrollmanager-built Q17).
      const b = await back(before, 'harvests', null, 'Harvests after its tab was re-tapped')
      return done(b.why)
    }
    if (k === 'lot-back') {
      // Saved seeds opened AT a lot: the ?lot= arrival hint outlines the Ristra card and scrolls it to the centre.
      // (Where it ends up is the hint's business, not this flow's. In this fixture the cards above it grow after
      // the scroll and push it below the fold: every lot is linked to a parent plant, and SavedSeeds fetches the
      // parent names only once the lots have loaded (V4-SEEDLINK-001's picker read). That is the page's own
      // timing, with or without the manager; the line prints where the card was left.)
      let why = await enter(SEL.toSavedLot, 'seeds', 'the /today link to Saved seeds at the Ristra lot')
      if (why) return done(why)
      if (!await t.waitIn(`${SEL.ristraCard} && ${SEL.ristraCard}.getAttribute('data-outlined') === 'true'`, 8000)) return done(`the ?lot= door never outlined the Ristra card${await diag()}`)
      await t.settle(600, 6000)
      const atLot = await t.read(`return w.scrollY`)
      if ((why = deep(atLot))) return done(`the arrival scroll toward the lot: ${why}`)
      note.push(`arrived toward the Ristra lot, y${R1(atLot)} (its card at viewport y${R1(await t.read(`return ${SEL.ristraCard}.getBoundingClientRect().top`))})`)
      // Up the list, away from the lot: that is the place Back must keep.
      why = await t.wheelToY(Math.round(atLot / 3))
      if (why) return done(why)
      await t.settle(400, 5000)
      const cardId = await t.read(`const el = ${SEL.lotCardMid}; return el ? el.getAttribute('data-lot-id') : null`)
      if (!cardId || cardId === 'lot-ristra') return done(`no other lot's card mid-band to hold on (${cardId})`)
      const card = SEL.lotCard(cardId)
      const before = await t.read(READ_HERE(card))
      if ((why = deep(before.y))) return done(why)
      if (Math.abs(before.y - atLot) < DEEP_MIN_PX) return done(`the place (y${R1(before.y)}) is within ${DEEP_MIN_PX}px of the lot's (y${R1(atLot)}) — a jump back to the lot could pass for it`)
      const l = await land(SEL.headerDeep, 'the header\'s list link', 'deep', { chrome: true })
      if (l.why) return done(l.why)
      // The hook's store emptied — an entry evicted past its 20, or written before the hook existed: the hook has
      // no saved value, so only "this mount is a return" (usePageScrollReturnAtMount) keeps the hint from firing.
      await t.read(`return w.__h.forgetScrollRestore()`)
      const b = await back(before, 'seeds', card, 'Saved seeds opened at a lot')
      return done(b.why)
    }
    if (k === 'lot-edit') {
      const l0 = await land(SEL.toLot, 'the /today link to the lot', 'lot')
      if (l0.why) return done(l0.why)
      let why = await t.wheelTo(SEL.editSow, '"Edit sow details →"', { top: true })
      if (why) return done(why)
      await t.settle(400, 5000)
      const before = await t.read(READ_HERE(SEL.editSow))
      if ((why = deep(before.y, DEEP_MIN_PX, { show: true }))) return done(why)
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
    if (k === 'lot-refuse') {
      // The saved-seed lane's refused Save (InventoryDetail, BUG-SAVEDLOTCOUNTHIDDEN-001): a typo in Seed count and
      // Save at the foot of the form bring the refused field to the middle of the screen and focus it. Nothing may
      // fight that scroll, and Back must come back to where the refusal left the page, ON THE PIXEL — the pin for
      // the driver's exactness (qa2-scrollmanager-confirm MINOR-2 and MINOR-7, QA2's qa2-lot-refuse: within the
      // old 4 px it came back at 972 for 968).
      const l0 = await land(SEL.toLot, 'the /today link to the lot', 'lot', { today: true })
      if (l0.why) return done(l0.why)
      let why = await t.wheelTo(SEL.seedCount, 'Seed count')
      if (why) return done(why)
      await t.settle(300, 3000)
      why = await t.tap(SEL.seedCount, 'Seed count')
      if (why) return done(why)
      await t.read(`const el = ${SEL.seedCount}; el.select(); return 1`)
      await t.insertText('175-')
      const typed = await t.read(`return ${SEL.seedCount}.value`)
      if (typed !== '175-') return done(`Seed count reads "${typed}", not "175-" — the typo never reached the field`)
      why = await t.wheelTo(SEL.saveChanges, '"Save changes"')
      if (why) return done(why)
      await t.settle(300, 3000)
      const atSave = await t.read(`return w.scrollY`)
      await t.read(`w.__h.mark(); return 1`)
      why = await t.tap(SEL.saveChanges, '"Save changes"')
      if (why) return done(why)
      if (!await t.waitIn(`d.getElementById('inv-seed-count-error')`, 5000)) return done(`the Save was not refused: no Seed count refusal showed${await diag()}`)
      await t.settle(400, 5000)
      const refused = await t.read(`return w.scrollY`)
      await sleep(1500)
      await t.settle(300, 3000)
      const held = await t.read(`${BAND_FN} const a = d.getElementById('inv-seed-count-error'), r = a ? a.getBoundingClientRect() : null
        return { y: w.scrollY, focused: d.activeElement === ${SEL.seedCount}, alert: r ? [Math.round(r.top), Math.round(r.bottom)] : null,
          inBand: !!r && r.top >= bandTop - 0.5 && r.bottom <= bandBottom + 0.5, band: [Math.round(bandTop), Math.round(bandBottom)], restores: w.__h.restores() }`)
      await t.shoot(join(OUTDIR, `page-scroll-${k}-refused-${vw}x${vh}.png`))
      note.push(`Save at y${R1(atSave)} → refused: Seed count brought to y${R1(refused)}, the refusal at y${held.alert} in the band y${held.band[0]}-${held.band[1]}${held.focused ? ', focused' : ''}; y${R1(held.y)} 1.5 s later`)
      const msgs = []
      if (Math.abs(atSave - refused) < 100) msgs.push(`the refused Save did not bring Seed count into view (the page went y${R1(atSave)} → y${R1(refused)})`)
      if (!held.inBand) msgs.push(`the refusal is at y${held.alert}, not inside the visible band y${held.band[0]}-${held.band[1]}`)
      if (!held.focused) msgs.push('Seed count is not focused after the refused Save')
      if (Math.round(held.y) !== Math.round(refused)) msgs.push(`the page moved y${R1(refused)} → y${R1(held.y)} in the 1.5 s after the refusal — something fought it`)
      if (held.restores.length) msgs.push(`a restore ran after the refused Save (${restoresLine(held.restores)})`)
      if (msgs.length) return done(`${msgs.join('; ')}${await diag()}`)
      const before = await t.read(READ_HERE(SEL.seedCount))
      const l = await land(SEL.headerDeep, 'the header\'s list link', 'deep', { chrome: true })
      if (l.why) return done(l.why)
      const b = await back(before, 'lot', SEL.seedCount, 'the lot after a refused Save')
      return done(b.why)
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
        if (Math.abs(top.y) > LAND_TOL_PX) return done(`page ${n + 1} landed at y${R1(top.y)}, not 0`)
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
  for (const [vi, [vw, vh]] of VIEWPORTS.entries()) {
    for (const flow of FLOWS.filter((fl) => (!ONLY.length || ONLY.includes(fl.key)) && (!fl.once || vi === 0))) {
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
if (served.size > 1) fail(`the harness served the flag both ways in one run (${[...served].join(', ')}) — one build, one flag`)
if (served.has('off')) console.log('[page-scroll] manager OFF — SCROLL_MANAGER_ENABLED=false as served: TODAY\'S contract was asserted (the rollback build); the manager\'s own checks were printed, not asserted, and its own flows were not run.')
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
