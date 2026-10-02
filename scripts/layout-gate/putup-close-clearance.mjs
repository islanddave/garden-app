#!/usr/bin/env node
// putup-close-clearance.mjs — the first observable the kitchen-batch close-out has ever had.
//
//   node scripts/layout-gate/putup-close-clearance.mjs                  # npm run gate:putup
//   node scripts/layout-gate/putup-close-clearance.mjs --probe-nothing  # prove the instrument fires
//
// Modelled on scripts/layout-gate/seeds-saved-clearance.mjs, deliberately and structurally: the same
// Chrome resolution, the same Emulation-not-window-size geometry, the same instrument-check-before-
// any-invariant order, the same census-not-named-list tap floor, the same --probe-nothing arm and the
// same exit-code discipline. Consistency with the eleven layout gates already in CI is the point; a
// second pattern here would be a second thing to keep true.
//
// MEASURES, in real Chrome at a TRUE 390x844 (and 390x667 for the two step-2 sheet cases), across the
// six states tests/harness/putupclose.jsx renders — empty archive / populated archive / batch detail /
// close sheet step 1 / step 2 kept / step 2 not-kept:
//   (a) TAP HEIGHT — every visible button and form control, as a census rather than a named list,
//       against T.tapMinHeight read from the token file. A gate that re-checks four named controls
//       passes the day a fifth is authored short.
//   (b) ROW INTEGRITY — no closed-batch row overflows its own box, its title column does not clip,
//       and the Reopen button's rect does not intersect that column. The row is a wrapping flex with
//       a `flex: 1 1 60%` title column and a `minWidth: 96` Reopen (ClosedBatchesView.jsx:162-186),
//       so at 390px with a long label the two are genuinely close. Plus: the document does not
//       scroll sideways.
//   (c) ACTION CLEARANCE — in the three sheet states the primary action hit-tests to itself, sits
//       inside the 390px viewport, and is reachable: either painted within the panel or inside a
//       panel that genuinely scrolls. A "Record it" clipped out of a non-scrolling panel is
//       unreachable, and that is the state this half exists to refuse.
//   (d) BAND CLEARANCE — the half seeds-saved has no reason to check and this surface does. App.jsx
//       renders a 56px fixed <BottomNav> on every signed-in route, and /put-up does NOT suppress it
//       outside the freezer walk. So the page is re-measured SCROLLED TO ITS END and no interactive
//       control's box may intersect the nav's box, nor may any probed control fail to hit-test to
//       itself. Today PutUp's container reserves 80px of bottom padding (PutUp.jsx:400) against a
//       56px bar — 24px of margin, which is a number a redesign can spend without noticing.
//
// WHY IT CANNOT BE A VITEST TEST. jsdom returns 0 from every getBoundingClientRect
// (tests/harness/README.md), so nothing under src/__tests__/** can tell "the 51-character batch label
// fits beside the Reopen button" from "it does not". PutUpBatchClose.test.jsx,
// PutUpClosedBatches.test.jsx and PutUpBatchDetail.test.jsx are green about CONTENT — the outcome
// labels, the ordering, the food-safety sweep — and are green on this geometry whatever it looks
// like. The close-out shipped to prod in v4.115.0 with ZERO measured 390px observability; its own
// promote handoff flagged that as the gap this file closes.
//
// SCOPE, said out loud. This measures LAYOUT at the fixture's scale — 9 closed batches across 4
// month groups, one open batch with 3 inputs and 2 log rows, 4 put-ups in the jar picker. It says
// nothing about the archive at a hundred rows (that is a pagination question, and this surface has
// no pagination to measure), and nothing about the close POST, which the harness stubs. It also does
// not measure the freezer walk: tests/harness/putupwalk.jsx owns that surface and its band is a
// different band, built by the walk itself rather than by App.jsx.
//
// THE INSTRUMENT CHECK, and why it is not optional. A layout gate that measures nothing scores a
// perfect pass — every "all targets clear the floor" is trivially true of a page with no targets. So,
// before any invariant is evaluated: the page must self-report the viewport it was asked for, must
// have reached harness ready(), every selector this gate depends on must match the count the fixture
// promises, and the boxes read back must not be uniformly zero (which is exactly what an unrendered
// document, or a jsdom-shaped one, looks like). `--probe-nothing` points every selector at a testid
// that does not exist; it MUST exit 1. It is a permanent, runnable proof that this file can go red,
// kept because a gate whose failure path has never been executed is a claim, not a guard.
//
// TRAPS THESE SIBLINGS ALREADY PAID FOR:
//   1. macOS Chrome floors an OS window at ~500px, so --window-size=390 lays the page out at ~500
//      and CROPS the capture. Geometry comes from Emulation.setDeviceMetricsOverride and the run
//      REFUSES TO PASS unless the page self-reports innerWidth 390 (inventory-list-shot.mjs).
//   2. The in-app browser pane reports visibilityState 'hidden', so rAF never fires and a React page
//      can sit half-mounted forever. Hence headless Chrome with --disable-renderer-backgrounding
//      rather than that pane (log-chooser-clearance.mjs).
//   3. CI pins node 20.19.0, which has no global WebSocket — attach through resolveWebSocket(),
//      never a bare global (cdp-socket.mjs).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { T } from '../../src/components/forms/formStyles.js'
import { resolveWebSocket } from './cdp-socket.mjs'

// Read from the token, never spelled here: a gate carrying its own copy of the floor is a gate that
// keeps passing after someone lowers the real one.
const TAP_MIN_HEIGHT_PX = T.tapMinHeight

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// 5318 / 9429: every other gate's default is taken (5312-5317, 5321 / 9422-9428), and a harness that
// silently attaches to a sibling's server measures a sibling's page.
const PORT = Number(process.env.GATE_HARNESS_PORT || 5318)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9429)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI passes --no-sandbox and resolves CHROME_PATH in its own step.
// Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)

// THE INSTRUMENT SELF-TEST. Not a debug switch: it is the demonstration that the non-vacuity half of
// this gate is load-bearing. Every testid below gains a suffix nothing renders, so the fixture counts
// cannot be met and the run must exit 1 on "matched 0 elements" rather than sailing through on
// vacuously-true invariants.
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`
const tidPrefix = (name) => `[data-testid^="${name}${SUFFIX}"]`

// The six states the harness entry can render, and what each one must produce before it is measured.
// Nothing here may be silently satisfied by an empty page: a selector that matches nothing FAILS this
// gate rather than passing it.
//
// EXACT vs MINIMUM is a deliberate split, not sloppiness:
//   · closedRows / monthHeadings / reopenBtns / outcomeChips / jarRows are EXACT because they fall
//     straight out of the fixture in tests/harness/putupclose.jsx, which this gate owns — 9 closed
//     batches whose closed_at land in Sep 2026 / Aug 2026 / Jul 2026 / Nov 2025, so 4 groups and 9
//     Reopens; and the two-step split offers exactly 2 outcomes after Yes and exactly 4 after No
//     (batchClose.js outcomesForKept). If a redesign changes that the two files move together, and
//     being told so is the point.
//   · outcomeChips is set on EVERY case with no `!= null` escape, unlike `primary`: a case authored
//     without it must fail loudly, because "this case measures no outcome chip" is exactly the state
//     that would leave the widest label on this surface — "Put it up — but not what I set out to
//     make" — unmeasured while the run printed PASS.
//   · minControls is a FLOOR because the detail surface hangs BatchInputsField's own controls off it
//     and that component belongs to another lane; pinning its count would freeze a decision this
//     lane did not make. What must never happen is zero.
// 667 is the same phone with the keyboard up and is the tighter geometry; it is run for the two
// step-2 cases, where the sheet's 100dvh cap is what bites.
// `band` marks the cases measured a second time SCROLLED TO THE END, against the fixed 56px nav. It
// is off for the sheet cases on purpose: the Sheet's backdrop is z-index 190 over a 100 nav, so the
// page behind it is correctly unreachable and asserting there would red the modal working as designed.
// ── Put-Up 1a item 8 (V4 §6.7) ────────────────────────────────────────────────────────────────────
// The Going-now cards, Check on it and the shared Start sheet, at Dave's measured 426×836 and with
// the keyboard up at 426×492 (V4 §6.7's default until his own keyboard-up height is measured). The
// batch detail — whose actions this release changed (pause and the start-date door moved onto it) —
// gains 426×836 beside its shipped 390×844. Every shipped case, viewport, count and assertion above
// the `scope`/`panel` flags is untouched.
//
// `scope` — the new cases measure their tap census and hit-test over THEIR surface (the Going-now view
// and any open sheet) rather than the whole page: on a bare /put-up the page's own header (the walk
// door, the segmented view control) renders too, and it belongs to another lane's file. Those
// out-of-scope controls are still measured and PRINTED, never silently dropped (see REPORT below).
// `panel` — the new panel assertions, scoped to the new sheets (V4 §6.7): the primary fully visible at
// the panel's FIRST and LAST scroll positions; min(width, height) ≥ the tap floor for every control
// inside the panel, with the selector widened to role=radio / checkbox / switch / option; and the
// focused field (the one the harness focused, nearest the pinned footer) under neither the sticky
// footer nor the viewport edge.
const NONE = { closedRows: 0, monthHeadings: 0, reopenBtns: 0, outcomeChips: 0, jarRows: 0, closedEmpty: false, detail: false, door: false, sheet: false }
const KEYBOARD_UP = [426, 492]
const CASES = [
  { name: 'closed-empty', viewports: [[390, 844]], expect: { closedRows: 0, monthHeadings: 0, reopenBtns: 0, outcomeChips: 0, jarRows: 0, minControls: 1, closedEmpty: true, detail: false, door: false, sheet: false, band: true } },
  { name: 'closed',       viewports: [[390, 844], [426, 836]], expect: { closedRows: 9, monthHeadings: 4, reopenBtns: 9, outcomeChips: 0, jarRows: 0, minControls: 19, closedEmpty: false, detail: false, door: false, sheet: false, band: true } },
  { name: 'detail',       viewports: [[390, 844], [426, 836]], expect: { closedRows: 0, monthHeadings: 0, reopenBtns: 0, outcomeChips: 0, jarRows: 0, minControls: 2, closedEmpty: false, detail: true,  door: true,  sheet: false, band: true } },
  { name: 'close-kept',   viewports: [[390, 844]], expect: { closedRows: 0, monthHeadings: 0, reopenBtns: 0, outcomeChips: 0, jarRows: 0, minControls: 3, closedEmpty: false, detail: true,  door: false, sheet: true, band: false, keptChips: 2 } },
  { name: 'close-yes',    viewports: [[390, 844], [390, 667]], expect: { closedRows: 0, monthHeadings: 0, reopenBtns: 0, outcomeChips: 2, jarRows: 4, minControls: 8, closedEmpty: false, detail: true, door: false, sheet: true, band: false, primary: 'batch-close-submit' } },
  { name: 'close-no',     viewports: [[390, 844], [390, 667]], expect: { closedRows: 0, monthHeadings: 0, reopenBtns: 0, outcomeChips: 4, jarRows: 0, minControls: 8, closedEmpty: false, detail: true, door: false, sheet: true, band: false, primary: 'batch-close-submit' } },
  // Four cards, each holding at most one question; the stalled ferment carries the longest label AND
  // the tallest question (the stall question plus its attribution note).
  { name: 'going',        viewports: [[426, 836]], expect: { ...NONE, goingCards: 4, minControls: 11, band: true, scope: 'going-now-view' } },
  { name: 'going-kind',   viewports: [[426, 836]], expect: { ...NONE, goingCards: 4, kindChips: 6, minControls: 18, band: true, scope: 'going-now-view' } },
  { name: 'checkin',      viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, sheet: true, band: false, minControls: 8, scope: 'going-now-view', primary: 'checkin-save', panel: { footer: 'checkin-footer', focus: 'checkin-ph-input' } } },
  { name: 'checkin-dry',  viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, sheet: true, band: false, minControls: 8, scope: 'going-now-view', primary: 'checkin-save', panel: { footer: 'checkin-footer', focus: 'checkin-note' } } },
  { name: 'start',        viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, sheet: true, band: false, minControls: 8, scope: 'going-now-view', primary: 'start-submit', panel: { footer: 'start-footer', focus: 'start-label' } } },
  { name: 'start-full',   viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, kindChips: 6, sheet: true, band: false, minControls: 16, scope: 'going-now-view', primary: 'start-submit', panel: { footer: 'start-footer', focus: 'start-kind-other-text' } } },
  // lane A additions go directly under this line
  // Put-Up UX pass R1 (PLAN-V3 D10): the Start sheet's "Start from" row, at both heights. Each case opens the
  // row through its real buttons and focuses the name, the field directly above it. `startFrom` is EXACT,
  // like the fixture counts above: the harness stubs answer 8 recipes in 3 groups and 6 past batches, and a
  // case that measured a list that never opened (or a pick that never landed) must fail, not pass.
  //   start-from-recipe  the recipe rows open        start-from-batch  the past batches open
  //   start-from-picked  a recipe AND a past batch picked, lists closed: the two picked lines, their undo
  //                      links, and the kind row the recipe pick opened
  { name: 'start-from-recipe', viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, sheet: true, band: false, minControls: 20, scope: 'going-now-view', primary: 'start-submit', panel: { footer: 'start-footer', focus: 'start-label' }, startFrom: { recipes: 8, groups: 3, batches: 0, picked: 0 } } },
  { name: 'start-from-batch',  viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, sheet: true, band: false, minControls: 18, scope: 'going-now-view', primary: 'start-submit', panel: { footer: 'start-footer', focus: 'start-label' }, startFrom: { recipes: 0, groups: 0, batches: 6, picked: 0 } } },
  { name: 'start-from-picked', viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, kindChips: 6, sheet: true, band: false, minControls: 20, scope: 'going-now-view', primary: 'start-submit', panel: { footer: 'start-footer', focus: 'start-label' }, startFrom: { recipes: 0, groups: 0, batches: 0, picked: 2 } } },
  // lane B additions go directly under this line
  // lane E additions go directly under this line
  // Put-Up release 1b (V4 §6.7): Put it up with two rows, the first one's disclosure open and its pH
  // focused; and with the sitting's More open and Next time… focused. Same panel assertions.
  { name: 'putup',         viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, sheet: true, band: false, minControls: 30, scope: 'going-now-view', primary: 'putup-finish', panel: { footer: 'putup-footer', focus: 'putup-row-0-ph-input' } } },
  { name: 'putup-sitting', viewports: [[426, 836], KEYBOARD_UP], expect: { ...NONE, goingCards: 4, sheet: true, band: false, minControls: 20, scope: 'going-now-view', primary: 'putup-finish', panel: { footer: 'putup-footer', focus: 'putup-nexttime' } } },
]

const failures = []
const fail = m => failures.push(m)

// A port something else is already serving is REFUSED, never measured through (OPS-PUTUPGATEPORTREFUSAL-001):
// Vite without --strictPort moves to the next free port, and this script would then read whatever the
// other process serves on the port it asked for — a sibling worktree's harness, or a sibling's Chrome.
async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — another harness or Chrome is running there. Set GATE_HARNESS_PORT / GATE_CDP_PORT to free ports; measuring through it would measure that process's page.`)
}

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
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
      const r = await fetch(`http://localhost:${PORT}/tests/harness/putupclose.html`)
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
  await assertPortFree(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP')
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation, so the
    // window only has to be big enough not to clip it. See trap 1 in the header.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  // CDP wait: 240 x 250ms = 60s, the value its siblings settled on after 15s failed two dev commits
  // on a loaded GitHub runner with nothing wrong in the tree. Nothing about the success path changes.
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
    // A DEAD CHROME IS NOT A SLOW CHROME, and the two need different responses: one is "re-run the
    // job", the other is "go find the missing shared library".
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
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 90000)
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

// ── The measurement, evaluated in the page itself ───────────────────────────────────────────────
// Nothing is tapped here: the harness entry has already driven the real controls (it CLICKS
// batch-close-open then Yes/No rather than forcing state, so "is this surface reachable" is answered
// before "does it fit"). Every number below is read from the live document.
const MEASURE = (c) => `(() => {
  const d = document, w = window
  const de = d.documentElement
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: Math.round(r.top), l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom),
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } }
  const name = el => el.getAttribute('aria-label') || el.getAttribute('data-testid') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34) ||
    ('<' + el.tagName.toLowerCase() + ' ' + (el.type || '') + '>')
  // checkVisibility(), not offsetParent: a collapsed <details> or a zero-opacity ancestor reports a
  // parent and reads as visible through offsetParent.
  const shown = el => (!el.checkVisibility || el.checkVisibility()) && el.getBoundingClientRect().height > 0
  const hitsSelf = (el, r) => {
    const x = (r.l + r.r) / 2, y = (r.t + r.b) / 2
    // BOUNDS ARE EXCLUSIVE AT THE FAR EDGE. Addressable coordinates run 0..innerHeight-1, so a
    // centre landing exactly ON innerHeight is OUTSIDE the document — elementFromPoint returns null
    // there, which is "nothing to probe", not "something is on top". With \`>\` this gate reported a
    // control straddling the bottom edge as OCCLUDED: measured on the closed list at 390x860, where
    // "Reopen Blackberry shrub" spans y836-884 so its centre is exactly y860, hit nothing, and was
    // failed as "something is painted over it". Nothing was. It reproduced at 860 and 870 and not at
    // 844, because whether a centre lands on the edge depends on row heights, which depend on FONT
    // METRICS — which is why it fired on CI and never locally, and why it looked like a real defect.
    if (x < 0 || y < 0 || x >= w.innerWidth || y >= w.innerHeight) return null
    const at = d.elementFromPoint(x, y)
    // A null result is NEVER evidence of occlusion. It means the point addressed no element at all
    // (outside the layout viewport, or a gap). Occlusion is a DIFFERENT element on top, so it needs
    // a non-null \`at\` that is not this element and not in its ancestry. Folding null into "false"
    // is what turned an unprobeable point into a defect report.
    if (at == null) return null
    return at === el || el.contains(at) || at.contains(el)
  }
  const overlap = (a, b) => (a && b) ? Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t)) : 0

  const rows = [...d.querySelectorAll('${tid('closed-batch')}')]
  const headings = [...d.querySelectorAll('${tid('closed-month-heading')}')]
  const jars = [...d.querySelectorAll('${tid('jar-picker-row')}')]
  const panel = d.querySelector('[role="dialog"]')
  const nav = d.querySelector('nav[aria-label="Main navigation"]')
  const navR = nav ? box(nav) : null
  const primary = ${c.expect.primary ? `d.querySelector('${tid(c.expect.primary)}')` : 'null'}

  // SCOPE (Put-Up 1a cases only): measure the case's own surface and any open sheet; everything else
  // on the page is still measured and returned as outOfScope, so it is printed rather than dropped.
  const scoped = ${c.expect.scope ? 'true' : 'false'}
  const scopeRoot = scoped ? d.querySelector('${c.expect.scope ? tid(c.expect.scope) : ''}') : null
  const allControls = [...d.querySelectorAll('button, input, select, textarea, [role="button"]')].filter(shown)
  const controls = scoped
    ? allControls.filter(el => (scopeRoot && scopeRoot.contains(el)) || (panel && panel.contains(el)))
    : allControls
  const outOfScope = scoped
    ? allControls.filter(el => !controls.includes(el)).map(el => ({ label: name(el), h: box(el).h, w: box(el).w }))
    : []
  const taps = controls.map(el => {
    const r = box(el)
    // A control BEHIND an open modal correctly fails to hit-test — the backdrop is over it, by
    // design. Recording which layer each control is on keeps that from reading as an occlusion bug.
    return { label: name(el), w: r.w, h: r.h, top: r.t, bottom: r.b, hitIsSelf: hitsSelf(el, r),
             inDialog: panel ? panel.contains(el) : true,
             // Is the control's BOX inside the fixed bottom nav's box? A centre that still hit-tests
             // while two thirds of the target is under an opaque bar is not a passing tap target.
             navOverlapPx: nav && !(panel && panel.contains(el)) ? overlap(r, navR) : 0,
             fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5 }
  })
  // REPORTED, not asserted. WCAG 2.5.8 exempts a link inline in a block of text, and asserting a 44px
  // floor on one would freeze a design call this lane did not make. The heights are printed so a
  // redesign has a number to move.
  const links = [...d.querySelectorAll('a[href]')].filter(shown).map(el => ({ label: name(el), h: box(el).h }))

  // The closed-batch row: a wrapping flex whose title column is \`flex: 1 1 60%\` and whose Reopen is
  // \`minWidth: 96; marginLeft: auto\`. colToReopenPx is POSITIVE when there is clear air between them.
  const rowMetrics = rows.map(row => {
    const r = box(row)
    const col = row.firstElementChild
    const btn = row.querySelector('${tid('closed-batch-reopen')}')
    const title = row.querySelector('${tid('closed-batch-title')}')
    const cr = col ? box(col) : null, br = btn ? box(btn) : null
    return {
      label: title ? (title.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34) : name(row),
      h: r.h, w: r.w,
      overflowX: row.scrollWidth > row.clientWidth + 1,
      overflowY: row.scrollHeight > row.clientHeight + 1,
      colClips: col ? col.scrollWidth > col.clientWidth + 1 : null,
      titleClips: title ? title.scrollWidth > title.clientWidth + 1 : null,
      hasReopen: !!btn,
      colToReopenPx: (cr && br) ? Math.round(br.l - cr.r) : null,
      overlaps: (cr && br) ? !(br.l >= cr.r || br.r <= cr.l || br.t >= cr.b || br.b <= cr.t) : false,
      fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5,
    }
  })

  let sheet = null
  if (panel) {
    const pr = box(panel)
    const cs = w.getComputedStyle(panel)
    sheet = {
      top: pr.t, bottom: pr.b, height: pr.h, left: pr.l, right: pr.r,
      overflowY: cs.overflowY, position: cs.position, visibility: cs.visibility,
      overflowsX: panel.scrollWidth > panel.clientWidth + 1,
      scrollable: panel.scrollHeight > panel.clientHeight + 1,
      hiddenBelowPx: Math.max(0, panel.scrollHeight - panel.clientHeight),
      // Does the panel clear the fixed nav, or is it painted over it? Above the nav in z-order it
      // legitimately may overlap; reported so a redesign that lowers the sheet's z-index shows up.
      zIndex: cs.zIndex,
    }
  }
  let action = null
  if (primary) {
    const r = box(primary)
    action = {
      label: name(primary), h: r.h, top: r.t, bottom: r.b, left: r.l, right: r.r,
      hitIsSelf: hitsSelf(primary, r), fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5,
      // Painted inside the panel's visible box? If not, it is only reachable by scrolling, which is
      // acceptable ONLY while the panel genuinely scrolls.
      insidePanel: panel ? (r.b <= box(panel).b + 0.5 && r.t >= box(panel).t - 0.5) : null,
    }
  }

  return {
    vw: w.innerWidth, vh: w.innerHeight, dpr: w.devicePixelRatio,
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    sidewaysScroll: de.scrollWidth > de.clientWidth + 1,
    pageH: Math.round(de.scrollHeight),
    scrollTop: Math.round(w.scrollY), maxScrollTop: Math.max(0, Math.round(de.scrollHeight - w.innerHeight)),
    nav: navR, navPresent: !!nav,
    closedEmpty: !!d.querySelector('${tid('closed-empty')}'),
    detail: !!d.querySelector('${tid('batch-detail-view')}'),
    door: !!d.querySelector('${tid('batch-close-open')}'),
    counts: { closedRows: rows.length, monthHeadings: headings.length, jarRows: jars.length,
              controls: taps.length, links: links.length,
              reopenBtns: d.querySelectorAll('${tid('closed-batch-reopen')}').length,
              keptChips: d.querySelectorAll('${tid('batch-close-kept-yes')}, ${tid('batch-close-kept-no')}').length,
              outcomeChips: d.querySelectorAll('${tidPrefix('batch-close-outcome-')}').length,
              goingCards: d.querySelectorAll('${tid('going-batch')}').length,
              kindChips: d.querySelectorAll('${tid('going-kind-chips')} [role="group"] button, ${tid('start-kind-chips')} [role="group"] button').length },
    taps, links, rowMetrics, sheet, action, outOfScope,
    // lane A (R1): the Start sheet's "Start from" row — its recipe rows and their groups, its past-batch chips, its picked lines.
    startFrom: { recipes: d.querySelectorAll('${tid('start-from-recipe-row')}').length,
                 groups: d.querySelectorAll('${tid('start-from-recipe-group')}').length,
                 batches: d.querySelectorAll('${tidPrefix('start-like-batch-')}').length,
                 picked: d.querySelectorAll('${tid('start-from-recipe-picked')}, ${tid('start-like-picked')}').length },
  }
})()`

// ── Put-Up 1a: the PANEL measurement, run only for cases carrying `panel` ─────────────────────────
// `where` = 'initial' (as the harness left it: the focused field already scrolled into view by the
// browser), 'top' or 'bottom' (the panel's first and last scroll positions), or 'reach' (below). Read-
// only apart from the scrollTop it is asked to set, which 'reach' restores before it returns.
//
// 'reach' — REACHABILITY, and why it replaces the census's at-rest hit-test for these panels only. The
// new sheets pin their primary in a STICKY footer inside a panel that scrolls with the keyboard up, so
// at any one scroll position some controls sit behind that footer — exactly the "scrollable page under
// fixed chrome" the census already refuses to call occlusion for the bottom nav (see (a)). So each
// panel control is brought to the middle of the band between the panel's top and the footer's top,
// and hit-tested THERE: a control that still does not hit-test to itself (clamped under the footer at
// the last scroll position, or painted over) genuinely cannot be tapped. The shipped cases carry no
// `panel` flag and keep the at-rest hit-test unchanged.
const PANEL_MEASURE = (c, where) => `(() => {
  const d = document, w = window
  const panel = d.querySelector('[role="dialog"]')
  if (!panel) return { panel: false }
  if (${JSON.stringify(where)} === 'top') panel.scrollTop = 0
  if (${JSON.stringify(where)} === 'bottom') panel.scrollTop = panel.scrollHeight
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: Math.round(r.top), l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom),
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } }
  const name = el => el.getAttribute('aria-label') || el.getAttribute('data-testid') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34) || ('<' + el.tagName.toLowerCase() + '>')
  const shown = el => (!el.checkVisibility || el.checkVisibility()) && el.getBoundingClientRect().height > 0
  const hitsSelf = (el, r) => {
    const x = (r.l + r.r) / 2, y = (r.t + r.b) / 2
    if (x < 0 || y < 0 || x >= w.innerWidth || y >= w.innerHeight) return null
    const at = d.elementFromPoint(x, y)
    if (at == null) return null
    return at === el || el.contains(at) || at.contains(el)
  }
  const primary = d.querySelector('${tid(c.expect.primary)}')
  const footer = d.querySelector('${tid(c.expect.panel.footer)}')
  const wanted = d.querySelector('${tid(c.expect.panel.focus)}')
  // The widened selector (V4 §6.7): radios, checkboxes, switches and options are targets too.
  const controls = [...panel.querySelectorAll('button, input, select, textarea, [role="button"], [role="radio"], [role="checkbox"], [role="switch"], [role="option"]')].filter(shown)
  if (${JSON.stringify(where)} === 'reach') {
    const start = panel.scrollTop
    const unreachable = []
    for (const el of controls) {
      if (!(footer && footer.contains(el))) {
        const r = el.getBoundingClientRect()
        const bandTop = panel.getBoundingClientRect().top
        const bandBottom = footer ? footer.getBoundingClientRect().top : panel.getBoundingClientRect().bottom
        panel.scrollTop += (r.top + r.bottom) / 2 - (bandTop + bandBottom) / 2
      }
      const rb = box(el)
      const hs = hitsSelf(el, rb)
      if (hs !== true) unreachable.push({ label: name(el), hitIsSelf: hs, t: rb.t, b: rb.b, scrollTop: Math.round(panel.scrollTop) })
    }
    panel.scrollTop = start
    return { panel: true, reach: true, checked: controls.length, unreachable }
  }
  const pb = box(panel)
  return {
    panel: true, vw: w.innerWidth, vh: w.innerHeight, panelBox: pb,
    scrollTop: Math.round(panel.scrollTop), scrollMax: Math.max(0, Math.round(panel.scrollHeight - panel.clientHeight)),
    primary: primary ? (() => { const r = box(primary); return { ...r, hitIsSelf: hitsSelf(primary, r) } })() : null,
    footer: footer ? box(footer) : null,
    focus: { found: !!wanted, active: !!wanted && d.activeElement === wanted, box: wanted ? box(wanted) : null },
    controls: controls.length,
    small: controls.map(el => { const r = box(el); return { label: name(el), w: r.w, h: r.h } })
      .filter(t => Math.min(t.w, t.h) < ${TAP_MIN_HEIGHT_PX}),
  }
})()`

// Ten navigations on one target, and Runtime.evaluate races the commit: dispatched a beat too early
// the execution context is torn down under it and CDP answers "Inspected target navigated or closed".
// Retried ONLY on that one class of transport error; anything else still throws, because a gate that
// swallows page errors as retryable is a gate that reports a broken page as a slow one.
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

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-putupclose-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[putup] --probe-nothing: every selector points at a testid nothing renders. This run MUST fail.')

  for (const c of CASES) {
    for (const [vw, vh] of c.viewports) {
      const at = `${c.name}@${vw}x${vh}`
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
      // verdict=0 strips the harness's fixed instrument bar. It is z-index 99999 and would sit on top
      // of the page's own h1 — elementFromPoint would then report the bar, and this gate would be
      // measuring its own instrument.
      const url = `http://localhost:${PORT}/tests/harness/putupclose.html?case=${c.name}&verdict=0`
      const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
      await sleep(200)
      await evalSettled(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('harness never reached ready() on case=${c.name}')})()`)
      await evalSettled(`new Promise(r=>setTimeout(r,400))`)   // let fonts and the sheet transition settle
      const m = await evalSettled(MEASURE(c))

      // ── INSTRUMENT CHECK, before any invariant. Each of these is a way this gate could report a
      //    perfect pass while telling us nothing at all.
      if (m.vw !== vw || m.vh !== vh) {
        fail(`${at}: page self-reports ${m.vw}x${m.vh} — emulation did not take, every coordinate below is from the wrong layout`)
        continue
      }
      const e = c.expect
      const mismatch = []
      if (m.counts.closedRows !== e.closedRows) mismatch.push(`closed batch rows ${m.counts.closedRows} != ${e.closedRows}`)
      if (m.counts.monthHeadings !== e.monthHeadings) mismatch.push(`month headings ${m.counts.monthHeadings} != ${e.monthHeadings}`)
      if (m.counts.reopenBtns !== e.reopenBtns) mismatch.push(`reopen buttons ${m.counts.reopenBtns} != ${e.reopenBtns}`)
      if (m.counts.outcomeChips !== e.outcomeChips) mismatch.push(`outcome chips ${m.counts.outcomeChips} != ${e.outcomeChips} — the two-step split offers 2 after Yes and 4 after No, so this case is measuring a step it did not reach`)
      if (m.counts.jarRows !== e.jarRows) mismatch.push(`jar picker rows ${m.counts.jarRows} != ${e.jarRows}`)
      if (e.goingCards != null && m.counts.goingCards !== e.goingCards) mismatch.push(`Going-now cards ${m.counts.goingCards} != ${e.goingCards}`)
      if (e.kindChips != null && m.counts.kindChips !== e.kindChips) mismatch.push(`kind chips ${m.counts.kindChips} != ${e.kindChips} — the kind row this case exists to measure did not open`)
      if (e.keptChips != null && m.counts.keptChips !== e.keptChips) mismatch.push(`kept chips ${m.counts.keptChips} != ${e.keptChips}`)
      for (const [what, want] of Object.entries(e.startFrom ?? {})) if (m.startFrom[what] !== want) mismatch.push(`Start-from ${what} ${m.startFrom[what]} != ${want} — the Start-from row this case exists to measure is not in the state it names`)
      if (m.counts.controls < e.minControls) mismatch.push(`${m.counts.controls} interactive controls, expected >=${e.minControls}`)
      if (m.closedEmpty !== e.closedEmpty) mismatch.push(`closed empty state ${m.closedEmpty}, expected ${e.closedEmpty}`)
      if (m.detail !== e.detail) mismatch.push(`batch detail surface ${m.detail}, expected ${e.detail}`)
      // The door is the whole entry to this feature. A fixture whose batch carries closed_at renders
      // NO door (BatchCloseField.jsx:142) and every sheet case would then measure an untouched page.
      if (m.door !== e.door) mismatch.push(`batch-close-open door ${m.door}, expected ${e.door}`)
      if (e.sheet && !m.sheet) mismatch.push('no [role="dialog"] — the close sheet this case exists to measure never opened')
      if (!e.sheet && m.sheet) mismatch.push('a sheet is open on a case that should have none')
      if (e.primary && !m.action) mismatch.push(`no ${e.primary} control — the primary action this case measures did not render`)
      // The nav is the thing (d) measures against. Absent, every band assertion below is vacuously
      // true — which is precisely how a fixed-bar occlusion ships unseen.
      if (!m.navPresent) mismatch.push('no <nav aria-label="Main navigation"> — the 56px fixed band this gate measures clearance against is not in the document')
      if (mismatch.length) {
        // A selector that matched nothing is a FAILURE, never a quiet pass. If the page was
        // redesigned, tests/harness/putupclose.jsx and the CASES table here move together.
        fail(`${at}: the fixture did not produce what this gate measures — ${mismatch.join('; ')}`)
        continue
      }
      // The zero-box detector. An unrendered document — or a jsdom-shaped one — hands back a full set
      // of elements whose every box is 0x0, and every "clears the floor" assertion below is then
      // vacuously true. Demand at least one real box.
      const heights = m.taps.map(t => t.h).concat(m.rowMetrics.map(r => r.h))
      if (!heights.length) fail(`${at}: no boxes measured at all`)
      else if (heights.every(h => h === 0)) fail(`${at}: every one of ${heights.length} measured boxes is 0px tall — this is what an unrendered document looks like, not a passing layout`)
      else if (m.docScrollW === 0 || m.docClientW === 0) fail(`${at}: document reports scrollWidth ${m.docScrollW} / clientWidth ${m.docClientW} — nothing was laid out`)

      // ── (a) TAP HEIGHT — census, not a named list.
      const short = m.taps.filter(t => t.h < TAP_MIN_HEIGHT_PX)
      for (const t of short) fail(`${at}: control "${t.label}" renders ${t.w}x${t.h}, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
      for (const t of m.taps) {
        // Hit-testing is asserted on the TOP layer only. With a sheet open the backdrop covers the
        // page behind it and every background control correctly fails to hit-test; asserting there
        // would red this gate on the modal working exactly as designed.
        // THE FIXED BOTTOM NAV IS NOT AN OCCLUSION DEFECT AT scrollTop 0. This census runs before the
        // page is scrolled, so on a list taller than the viewport the controls near the fold sit
        // BEHIND the 56px bar simply because the reader has not scrolled yet. That is what a
        // scrollable page under fixed chrome looks like; it is not a layout fault, and the user
        // reaches those controls by scrolling. Nav clearance is owned by (d), which re-measures at the
        // END of the scroll — where "under the bar" genuinely means unreachable — and asserts BOTH
        // navOverlapPx and hit-testing there. Measured: at 390x870 this line failed "Reopen Blackberry
        // shrub" with elementFromPoint returning the nav itself and navOverlapPx 34, while (d) passed
        // the same surface with 47px of clear air. Whether it fires at all depends on row heights and
        // therefore on FONT METRICS, so it reproduced on CI and not locally — an environment-shaped
        // false positive that reads exactly like a real defect.
        // Put-Up 1a panel cases replace this at-rest hit-test with the REACHABILITY pass in the panel
        // block below (PANEL_MEASURE 'reach'); every other case is unchanged.
        if (t.inDialog && !e.panel && t.hitIsSelf === false && !(t.navOverlapPx > 0)) fail(`${at}: control "${t.label}" does not hit-test to itself — occluded`)
        if (!t.fitsX) fail(`${at}: control "${t.label}" sits outside the ${vw}px viewport — unreachable`)
      }

      // ── (b) ROW INTEGRITY.
      for (const r of m.rowMetrics) {
        if (r.overflowX) fail(`${at}: closed row "${r.label}" overflows its own box horizontally (scrollWidth > clientWidth)`)
        if (r.overflowY) fail(`${at}: closed row "${r.label}" clips its own content vertically`)
        if (r.colClips) fail(`${at}: closed row "${r.label}" clips its text column — the label and its meta line do not fit beside the Reopen button`)
        if (r.titleClips) fail(`${at}: closed row "${r.label}": the batch label clips its own box`)
        if (r.overlaps) fail(`${at}: closed row "${r.label}": the Reopen button's rect intersects the title column`)
        if (!r.fitsX) fail(`${at}: closed row "${r.label}" sits outside the ${vw}px viewport`)
      }
      if (m.sidewaysScroll) fail(`${at}: document scrollWidth ${m.docScrollW} > clientWidth ${m.docClientW} — the page scrolls sideways`)

      // ── (c) ACTION CLEARANCE.
      if (m.sheet) {
        if (m.sheet.visibility !== 'visible') fail(`${at}: sheet visibility is '${m.sheet.visibility}' — an invisible panel makes every measurement below vacuous`)
        if (m.sheet.height <= 0) fail(`${at}: sheet panel has zero height`)
        if (m.sheet.overflowsX) fail(`${at}: sheet panel overflows horizontally — a field is wider than the panel, which does NOT show up as document hscroll`)
        if (m.sheet.left < -0.5 || m.sheet.right > vw + 0.5) fail(`${at}: sheet panel spans x${m.sheet.left}-${m.sheet.right}, outside the ${vw}px viewport`)
      }
      if (m.action) {
        if (m.action.hitIsSelf === false) fail(`${at}: "${m.action.label}" does not hit-test to itself — the primary action is occluded`)
        if (m.action.hitIsSelf === null && m.action.insidePanel) fail(`${at}: "${m.action.label}" is inside the panel but outside the viewport — it can never be probed or tapped`)
        if (!m.action.fitsX) fail(`${at}: "${m.action.label}" sits outside the ${vw}px viewport`)
        // Below the panel's visible fold is acceptable only while the panel actually scrolls. Clipped
        // out of a non-scrolling panel is unreachable, full stop.
        if (!m.action.insidePanel && !m.sheet?.scrollable) fail(`${at}: "${m.action.label}" is painted outside a panel that does not scroll — unreachable`)
      }

      // ── The record. Printed on pass as well as fail: these are the numbers a redesign has to move,
      //    and a gate that only speaks when it is angry leaves nothing to compare against.
      const minTap = m.taps.length ? Math.min(...m.taps.map(t => t.h)) : 0
      console.log(`[putup] ${at}: ${m.counts.closedRows} rows / ${m.counts.monthHeadings} months / ${m.counts.outcomeChips} outcomes / ${m.counts.jarRows} jars · ${m.counts.controls} controls, shortest ${minTap}px (floor ${TAP_MIN_HEIGHT_PX}px), ${short.length} under · pageH ${m.pageH}px`)
      if (m.rowMetrics.length) {
        console.log(`[putup] ${at}: row gap title→Reopen ${m.rowMetrics.map(r => r.hasReopen ? r.colToReopenPx + 'px' : '—').join('/')} · row heights ${m.rowMetrics.map(r => r.h).join('/')}px · overflow ${m.rowMetrics.filter(r => r.overflowX || r.colClips).length}`)
      }
      if (m.sheet) {
        console.log(`[putup] ${at}: sheet y${m.sheet.top}-${m.sheet.bottom} h${m.sheet.height} z${m.sheet.zIndex} · scrollable ${m.sheet.scrollable} (${m.sheet.hiddenBelowPx}px below the fold)`)
      }
      if (m.action) {
        console.log(`[putup] ${at}: primary "${m.action.label}" y${m.action.top}-${m.action.bottom} h${m.action.h} · insidePanel ${m.action.insidePanel} · hitIsSelf ${m.action.hitIsSelf}`)
      }
      // Anchors: reported, never asserted (see the note in MEASURE).
      const shortLinks = m.links.filter(l => l.h < TAP_MIN_HEIGHT_PX)
      if (m.links.length) {
        console.log(`[putup] ${at}: ${m.links.length} link target(s), ${shortLinks.length} under ${TAP_MIN_HEIGHT_PX}px [REPORTED, NOT ASSERTED — WCAG 2.5.8 exempts inline links]: ${shortLinks.map(l => `"${l.label}"=${l.h}px`).join(', ') || 'none'}`)
      }

      // Out-of-scope controls (Put-Up 1a scoped cases): REPORTED, never asserted here, never dropped.
      const oosShort = (m.outOfScope || []).filter(t => t.h < TAP_MIN_HEIGHT_PX)
      if (oosShort.length) {
        console.log(`[putup] ${at}: REPORT (out of this case's scope, not asserted): ${oosShort.map(t => `"${t.label}" ${t.w}x${t.h}`).join(', ')} under ${TAP_MIN_HEIGHT_PX}px`)
      }

      // ── (e)(f)(g) THE PANEL — Put-Up 1a's new sheets only (V4 §6.7).
      if (e.panel) {
        const first = await evalSettled(PANEL_MEASURE(c, 'initial'))
        if (!first.panel) { fail(`${at}: no [role="dialog"] for the panel measurement`); continue }
        if (!first.controls) fail(`${at}: the panel holds no measurable control — the census below is over nothing`)
        // (f) min(width, height) — the widened census, inside the panel only.
        for (const t of first.small) fail(`${at}: panel control "${t.label}" is ${t.w}x${t.h} — min(width, height) under the ${TAP_MIN_HEIGHT_PX}px floor`)
        // (h) REACHABILITY — every panel control hit-tests to itself once scrolled clear of the footer.
        const reach = await evalSettled(PANEL_MEASURE(c, 'reach'))
        if (!reach.checked) fail(`${at}: the reachability pass checked no control`)
        for (const u of reach.unreachable) fail(`${at}: panel control "${u.label}" cannot be tapped — scrolled as clear of the footer as the panel allows (scrollTop ${u.scrollTop}) it sits y${u.t}-${u.b} and does not hit-test to itself`)
        // (g) the focused field under neither sticky band, and on screen.
        if (!first.focus.found) fail(`${at}: the field this case focuses (${e.panel.focus}) is not in the panel`)
        else if (!first.focus.active) fail(`${at}: ${e.panel.focus} is not the focused element — the keyboard-up geometry was not reached`)
        else {
          const f = first.focus.box
          if (!first.footer) fail(`${at}: no sticky footer (${e.panel.footer}) to clear`)
          else if (f.b > first.footer.t + 0.5) fail(`${at}: the focused field (y${f.t}-${f.b}) runs under the sticky footer (top y${first.footer.t})`)
          if (f.t < first.panelBox.t - 0.5 || f.b > first.vh + 0.5) fail(`${at}: the focused field (y${f.t}-${f.b}) is not inside the panel on screen (panel y${first.panelBox.t}, viewport ${first.vh})`)
        }
        // (e) the primary fully visible at the FIRST and LAST scroll positions.
        const ends = []
        for (const where of ['top', 'bottom']) {
          const p = await evalSettled(PANEL_MEASURE(c, where))
          const a = p.primary
          if (!a) { fail(`${at}: no ${e.primary} at the panel's ${where}`); continue }
          const visible = a.t >= -0.5 && a.b <= p.vh + 0.5 && a.t >= p.panelBox.t - 0.5 && a.b <= p.panelBox.b + 0.5
          if (!visible) fail(`${at}: "${e.primary}" (y${a.t}-${a.b}) is not fully visible at the panel's ${where} (panel y${p.panelBox.t}-${p.panelBox.b}, viewport ${p.vh})`)
          if (a.hitIsSelf !== true) fail(`${at}: "${e.primary}" does not hit-test to itself at the panel's ${where}`)
          ends.push(`${where} y${a.t}-${a.b} (scroll ${p.scrollTop}/${p.scrollMax})`)
        }
        const fb = first.focus.box
        console.log(`[putup] ${at}: panel y${first.panelBox.t}-${first.panelBox.b} · ${first.controls} controls, ${first.small.length} under min(w,h) ${TAP_MIN_HEIGHT_PX}px, ${reach.checked - reach.unreachable.length}/${reach.checked} reachable · focused ${e.panel.focus} ${fb ? `y${fb.t}-${fb.b}` : '—'} vs footer top y${first.footer?.t ?? '—'} · primary ${ends.join(' · ')}`)
      }

      // ── (d) BAND CLEARANCE, measured at the END of the scroll rather than at the top.
      // At scrollTop 0 every control near the bottom of a long page is off-screen, hitsSelf returns
      // null, and "no control is occluded" is true because nothing was ever probed. The bar only bites
      // where the page ends, so that is where it has to be asked.
      if (!e.band) continue
      await evalSettled(`(()=>{ window.scrollTo(0, document.documentElement.scrollHeight); return 1 })()`)
      await evalSettled(`new Promise(r=>setTimeout(r,250))`)
      const b = await evalSettled(MEASURE(c))
      if (!b.navPresent || !b.nav || b.nav.h <= 0) {
        fail(`${at}: the fixed bottom nav measured ${b.nav ? b.nav.h + 'px' : 'nothing'} at the end of the scroll — there is no band to clear and (d) proved nothing`)
        continue
      }
      const probed = b.taps.filter(t => t.hitIsSelf !== null)
      if (!probed.length) {
        fail(`${at}: not one of ${b.taps.length} control(s) was inside the viewport at the end of the scroll, so nothing was probed against the ${b.nav.h}px nav — "no control is occluded" here is a statement about an empty set`)
      }
      for (const t of b.taps) {
        if (t.navOverlapPx > 0) fail(`${at}: control "${t.label}" (y${t.top}-${t.bottom}) is under the ${b.nav.h}px fixed bottom nav (y${b.nav.t}-${b.nav.b}) by ${t.navOverlapPx}px at the end of the scroll — the page does not reserve enough bottom padding for the bar`)
        if (t.hitIsSelf === false) fail(`${at}: control "${t.label}" does not hit-test to itself at the end of the scroll — something is painted over it`)
      }
      const lowest = b.taps.reduce((lo, t) => (t.bottom > (lo?.bottom ?? -Infinity) ? t : lo), null)
      console.log(`[putup] ${at}: scrolled to ${b.scrollTop}/${b.maxScrollTop}px · nav y${b.nav.t}-${b.nav.b} (${b.nav.h}px) · ${probed.length}/${b.taps.length} control(s) probed · lowest "${lowest?.label}" ends y${lowest?.bottom} — ${lowest ? b.nav.t - lowest.bottom : '—'}px of clear air above the bar`)
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

// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner —
// not the code — says which one happened. An arm that exited 0 on a deliberately-broken instrument is
// a switch someone eventually wires into CI, and it would report a KILL as a SURVIVAL.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[putup] FAIL — EXPECTED. --probe-nothing pointed every selector at a testid nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[putup] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[putup] FAIL — and this one is the real defect: every selector pointed at a testid that does not exist and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[putup] PASS')
