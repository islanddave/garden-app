#!/usr/bin/env node
// seed-detail-shot.mjs — V5-SEEDSTAB-001 follow-up. The seed detail page (/inventory/:id,
// src/pages/InventoryDetail.jsx), in real Chrome, at the two phone geometries it is built for.
//
//   node scripts/layout-gate/seed-detail-shot.mjs [--outdir dir]     # npm run gate:seed-detail
//   node scripts/layout-gate/seed-detail-shot.mjs --probe-nothing    # prove the instrument fires
//
// WHY IT EXISTS. The Seeds release gave the packet page "Sow this" (the shared Sow sheet, in place),
// the "Sown ✓ · See the planting" line a sow from here leaves, "Edit sow details →", the "Sown from
// this packet" card (one 44px row link per planting) and the F2 breeding fact — and no layout gate
// rendered /inventory/:id (pre-ship QA, IMPORTANT #1). jsdom returns 0 from every
// getBoundingClientRect(), so the unit suites pin style strings and never a box.
//
// MEASURES tests/harness/seeddetail.{html,jsx} — the real <InventoryDetail /> under the app's 52px top
// bar and 56px bottom nav stand-ins — at a TRUE 360x640 and 390x844, in three states:
//   packet  a BOUGHT packet with stock and two plantings in sown_from, as loaded;
//   sown    the same page after a REAL sow — Sow this tapped, then the sheet's "Add planting", each a
//           hit-tested tap through the browser's input pipeline, never element.click() — so the page
//           shows "Sown ✓ · See the planting";
//   f2      a lot saved off an F1 plant, still drying: no Sow this, the F2 breeding fact, "Change stage
//           in Saved seeds →", and nothing sown from it (no card).
// and asserts, per state and viewport:
//   (a) NO SIDEWAYS SCROLL — documentElement.scrollWidth <= clientWidth. (Chrome's mobile emulation
//       WIDENS the layout viewport to fit a wider document; that shape is refused by the viewport check
//       below, by name.)
//   (b) TAP FLOOR — every visible link, button, role=button and form control is >= T.tapMinHeight, as
//       a census rather than a named list, and inside the viewport width; the ones on screen at
//       scrollTop 0 hit-test to themselves. NAMED EXEMPTIONS (EXEMPTIONS below) are printed with their
//       heights on every run; none of them is part of the Seeds release.
//   (c) THE "SOWN FROM THIS PACKET" CARD — present with EXACTLY the fixture's rows (in order, each
//       linking its planting), the card inside the viewport and not overflowing its own box; each row
//       full-width in the card, >= the tap floor, inside the card and the viewport, not overflowing,
//       and WHOLE: every text run of the name, the meta line and the chevron is painted inside the row.
//       At 360 at least one name must wrap inside its row, so "whole" is asked of a wrapped name.
//       Absent (no card at all) when nothing was sown from the lot.
//   (d) SOW THIS — present on the packet, ABSENT on the in-process F2 lot.
//   (e) THE SOW (state sown) — exactly one create POST, carrying this packet; the sheet closed; the line
//       reads "Sown ✓" and its "See the planting" links the planting the create named; the line is
//       whole inside the viewport.
//   (f) F2 — the Breeding fact reads exactly `${F2_LABEL} (parent F1 hybrid)` (the label read from
//       seedLots.js), whole inside the packet card; and "Change stage in Saved seeds →" is present.
//   (g) REACH — each of the page's seed controls (Sow this, See the planting, Edit sow details, every
//       Sown-from row, Change stage) scrolled to the middle of the visible band hit-tests to itself.
//   (h) THE REFUSED REMOVE (BUG-INVDELETEERROROFFSCREEN-001), its own state at both viewports: "Remove
//       item" and then the dialog's "Remove", both real taps, against a harness that answers the DELETE
//       with the Lambda's 409 sentence (remove=refuse). The dialog must still be up, wholly inside the
//       viewport, with the sentence INSIDE it as role="alert", every text run whole, directly above the
//       Remove / Keep it row, shown exactly once on the page; both buttons on the tap floor and hitting
//       themselves; exactly one DELETE sent; the page not left.
//
// THE INSTRUMENT CHECK comes first, and a mismatch stops that state before any invariant is read: the
// page must self-report the viewport it was asked for (trap 1), must have raised no error, must still be
// the detail page (no "left the page" marker, the packet card and the fixture's title present, no sheet
// open), the chrome stand-ins must be exactly TopChrome's BAR_H and BOTTOM_NAV_HEIGHT_PX, and every count
// the fixture promises must match. A selector that matched nothing is a FAILURE, never a quiet pass.
// `--probe-nothing` points every testid at one nothing renders; it MUST exit 1.
//
// SCREENSHOTS: viewport-only PNGs per state and viewport (the first screen), plus evidence shots with
// the card, the sown line or the F2 fact scrolled into view, written to --outdir (artifacts/layout-gate
// by default, gitignored).
//
// TRAPS THE SIBLINGS ALREADY PAID FOR (seeds-page-shot.mjs, seeds-saved-clearance.mjs):
//   1. macOS Chrome floors an OS window at ~500px, so --window-size=360 lays the page out at ~500 and
//      CROPS the capture. Geometry comes from Emulation.setDeviceMetricsOverride, and a page whose
//      innerWidth/innerHeight is not the one requested is REFUSED, never measured.
//   2. The in-app browser pane reports visibilityState 'hidden' and rAF never fires; hence headless
//      Chrome with --disable-renderer-backgrounding.
//   3. CI pins node 20.19.0, which has no global WebSocket — resolveWebSocket(), never a bare global.
//   4. Fonts differ on the Linux runner; every margin that matters is printed.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { T } from '../../src/components/forms/formStyles.js'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Read from the token / the sources, never spelled here: a gate carrying its own copy keeps passing
// after someone moves the real one.
const TAP_MIN_HEIGHT_PX = T.tapMinHeight
function readOne(file, re, what) {
  const src = readFileSync(resolve(ROOT, file), 'utf8')
  const found = [...src.matchAll(re)].map((m) => m[1])
  if (found.length !== 1) throw new Error(`${file} carries ${what} ${found.length} times; expected exactly 1 — the gate cannot read it`)
  return found[0]
}
const TOP_CHROME_PX = Number(readOne('src/components/TopChrome.jsx', /const BAR_H = (\d+)/g, 'BAR_H'))
const F2_LABEL = readOne('src/components/seed/seedLots.js', /export const F2_LABEL = '([^']+)'/g, 'F2_LABEL')

const PORT = Number(process.env.GATE_HARNESS_PORT || 5320)   // 5312-5319 / 9422-9430 are sibling gates'
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9431)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI passes --no-sandbox. Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const outArg = process.argv.indexOf('--outdir')
const OUTDIR = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(ROOT, 'artifacts/layout-gate')

// MUTATION HOOK — CSS injected into the page once it has arrived, before the sow and before anything is
// read (e.g. '[data-testid="sown-from-link"]{white-space:nowrap!important}'). Never set in CI; a run with
// it set says so in its first line, so its output cannot pass for a clean one.
const MUTATE_CSS = process.env.GATE_MUTATE_CSS || ''

const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`

// What tests/harness/seeddetail.jsx promises. EXACT: every number falls straight out of the fixture, and
// the two files move together.
const PACKET_NAME = 'Sungold F1 tomato seeds'
const F2_NAME = 'Thai Dragon — saved 2026'
// sown_from, newest sowing first as the route orders it.
const SOWN_FROM = [
  { href: '/plantings/pl-sungold-pot', name: 'Sungold pot 4' },
  { href: '/plantings/pl-sungold-bed', name: 'Sungold F1 — raised bed 3, north end, second sowing' },
]
const PACKET_ID = 'pkt-sungold'
const NEW_PLANTING_HREF = '/plantings/pl-new'   // the harness's POST /api/plants answers { id: 'pl-new' }
const STAGE_LINK_WORDS = 'Change stage in Saved seeds →'
const STATES = [
  { name: 'packet', harness: 'packet', sow: false,
    expect: { h1: PACKET_NAME, sowThis: 1, sownLine: 0, sownFrom: SOWN_FROM, f2: false, stageLink: 1, editSow: 1 } },
  { name: 'sown', harness: 'packet', sow: true,
    expect: { h1: PACKET_NAME, sowThis: 1, sownLine: 1, sownFrom: SOWN_FROM, f2: false, stageLink: 1, editSow: 1 } },
  { name: 'f2', harness: 'f2', sow: false,
    expect: { h1: F2_NAME, sowThis: 0, sownLine: 0, sownFrom: [], f2: true, stageLink: 1, editSow: 1 } },
]
const VIEWPORTS = [[360, 640], [390, 844]]

// NAMED TAP-FLOOR EXEMPTIONS, from the first measured run (2026-09-24). Each is matched by what the
// control IS on this page — its place in the structure, never a label alone — printed with its size on
// every run, and reported INERT once every match clears the floor. NONE is part of the Seeds release.
// The two inline links are WCAG 2.5.8's own exemption (a target inside a line of text). The other two
// are PRE-EXISTING tap-floor misses in code this gate's brief does not own (the frozen forms pickers'
// clear ✕, the app-wide Favorite toggle); they were REPORTED for a decision
// (lane-seedpolish-20260924 report) rather than fixed here, and each should leave this list when fixed.
// (The delete button's `remove-item` entry left it with BUG-SEEDPAGETAPFLOORS-001: "Remove item" now
// sits on the floor and is held to it by the census like every other control.)
const EXEMPTIONS = [
  { key: 'breadcrumb', why: 'the "Seeds" link inline in the breadcrumb line — WCAG 2.5.8 inline exemption',
    match: (t) => t.inBreadcrumb },
  { key: 'history-origin', why: 'the parent planting inline in the processing history\'s "Saved from …" sentence — WCAG 2.5.8 inline exemption',
    match: (t) => t.inHistoryOrigin },
  { key: 'favorite', why: 'FavoriteToggle, the app-wide heart beside every detail title — pre-existing, REPORTED',
    match: (t) => t.favorite },
  { key: 'picker-clear', why: 'the ✕ on a chosen value in the frozen forms pickers (SourcePicker\'s "Clear supplier", PlantingSelect\'s "Clear planting selection"), drawn at 30px by their chipClearBtn — pre-existing, REPORTED',
    match: (t) => t.pickerClear },
]

const failures = []
const fail = (m) => failures.push(m)

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  // Spawned through vite's own bin, NOT `npx vite`: npx is a wrapper, so killing it at teardown
  // orphans the real server and hangs any caller that pipes this script's stdout.
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', (d) => { log += d })
  proc.stderr.on('data', (d) => { log += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/seeddetail.html`)
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
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation (trap 1).
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) {
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id)
      clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  // Each call's timeout is CLEARED when its answer lands, so a passing run exits as soon as it is done
  // (seeds-page-shot.mjs measured ~90 s of idle armed timers on a sibling that left them running).
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
  return { ws, send, sessionId, evalIn }
}

// ── The measurement, evaluated in the page itself ───────────────────────────────────────────────
// Nothing is tapped, scrolled or restyled here: every number is read from the live document as it
// stands, at scrollTop 0 (the gate scrolls back before calling it).
const MEASURE = `(() => {
  const d = document, w = window, de = d.documentElement
  const R = n => Math.round(n * 10) / 10
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: R(r.top), l: R(r.left), r: R(r.right), b: R(r.bottom), w: R(r.width), h: R(r.height) } }
  // checkVisibility(), not offsetParent: a collapsed <details> or a zero-opacity ancestor reports a
  // parent and reads as visible through offsetParent.
  const shown = el => (!el.checkVisibility || el.checkVisibility()) && el.getBoundingClientRect().height > 0
  const name = el => el.getAttribute('aria-label') || el.getAttribute('data-testid') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40) ||
    ('<' + el.tagName.toLowerCase() + ' ' + (el.type || '') + '>')
  const text = el => (el ? (el.textContent || '').trim().replace(/\\s+/g, ' ') : null)
  const px = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0 }
  // Text runs, one rect per line fragment per TEXT NODE, from a Range over each live text node — no
  // clone, no style mutation (a gate that edits the document to measure it measures its instrument).
  const runsOf = el => { const out = [], tw = d.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!t.textContent.trim()) continue
      const rg = d.createRange(); rg.selectNodeContents(t)
      for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) out.push(r)
    }
    return out }
  // Visual lines: text runs clustered by vertical overlap.
  const lines = el => { const rs = runsOf(el).sort((a, b) => a.top - b.top); const out = []
    for (const r of rs) { const last = out[out.length - 1]
      if (last && r.top < last.bottom - 1) last.bottom = Math.max(last.bottom, r.bottom)
      else out.push({ top: r.top, bottom: r.bottom }) }
    return out.length }
  const within = (r, c) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5
  const inViewX = r => r.left >= -0.5 && r.right <= w.innerWidth + 0.5
  // Every run of el painted inside the rect c and inside the viewport's width.
  const whole = (el, c) => { const rs = runsOf(el); return { runs: rs.length,
    inside: rs.every(r => within(r, c)), inViewX: rs.every(inViewX) } }

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
  const inChrome = el => (topBar && topBar.contains(el)) || (nav && nav.contains(el))

  const h1 = d.querySelector('h1')
  const titleRow = h1 ? h1.parentElement : null
  const crumb = titleRow ? titleRow.previousElementSibling : null

  // (b) the census: every visible control on the page, chrome stand-ins excluded (they carry none).
  // The exemption facts are STRUCTURAL — what the control is on this page — never a name match alone.
  const taps = [...d.querySelectorAll('a[href], button, [role="button"], input, select, textarea')]
    .filter(shown).filter(el => !inChrome(el)).map(el => {
      const r = box(el)
      return { label: name(el), tag: el.tagName.toLowerCase(), testid: el.getAttribute('data-testid'),
        w: r.w, h: r.h, t: r.t, fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5, hitIsSelf: hitsSelf(el, r),
        inBreadcrumb: !!(crumb && crumb.contains(el)),
        inHistoryOrigin: !!el.closest('[data-testid="seed-history-origin"]'),
        favorite: el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Favorite' && !!(titleRow && titleRow.contains(el)),
        // The pickers' chosen-value chip: [value … ✕] with the picker's own "Change" button beside it.
        pickerClear: el.tagName === 'BUTTON' && /^Clear /.test(el.getAttribute('aria-label') || '') &&
          !!(el.parentElement && el.parentElement.nextElementSibling && text(el.parentElement.nextElementSibling) === 'Change') }
    })

  // (c) the "Sown from this packet" card.
  const cards = [...d.querySelectorAll('${tid('packet-sown-from')}')]
  const card = cards[0] || null
  let sownFrom = null
  if (card) {
    const cr = card.getBoundingClientRect(), cs = w.getComputedStyle(card)
    const contentW = cr.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight)
    sownFrom = { box: box(card), inViewX: inViewX(cr), overflowX: card.scrollWidth > card.clientWidth + 1,
      heading: text(card.firstElementChild), contentW: R(contentW),
      rows: [...card.querySelectorAll('${tid('sown-from-link')}')].map(a => {
        const r = a.getBoundingClientRect()
        const col = a.firstElementChild, chev = a.lastElementChild !== col ? a.lastElementChild : null
        const nameEl = col && col.children[0], metaEl = col && col.children[1]
        return { href: a.getAttribute('href'), name: text(nameEl), meta: text(metaEl),
          box: box(a), inViewX: inViewX(r), inCard: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5,
          fullWidth: r.width >= contentW - 1, overflowX: a.scrollWidth > a.clientWidth + 1,
          whole: whole(a, r), nameLines: nameEl ? lines(nameEl) : 0,
          chevron: chev ? { text: text(chev), inside: within(chev.getBoundingClientRect(), r) } : null }
      }) }
  }

  // (e) the sown line.
  const sownLineEl = d.querySelector('${tid('sow-this-sown')}')
  const seeLink = d.querySelector('${tid('sow-this-see-planting')}')
  const sownLine = sownLineEl ? { text: text(sownLineEl), box: box(sownLineEl), inViewX: inViewX(sownLineEl.getBoundingClientRect()),
    whole: whole(sownLineEl, sownLineEl.getBoundingClientRect()),
    see: seeLink ? { href: seeLink.getAttribute('href'), text: text(seeLink), h: box(seeLink).h } : null } : null

  // (f) the packet card's Breeding fact.
  const packetCard = d.querySelector('${tid('packet-card')}')
  const breedingEl = [...d.querySelectorAll('${tid('packet-fact')}')].find(f => f.getAttribute('data-fact') === 'breeding') || null
  const pcr = packetCard ? packetCard.getBoundingClientRect() : null
  const breeding = breedingEl ? { label: text(breedingEl.children[0]), value: text(breedingEl.children[1]),
    whole: pcr ? whole(breedingEl, pcr) : null, lines: breedingEl.children[1] ? lines(breedingEl.children[1]) : 0,
    overflowX: breedingEl.children[1] ? breedingEl.children[1].scrollWidth > breedingEl.children[1].clientWidth + 1 : null } : null

  const stageLink = d.querySelector('${tid('seed-stage-change-link')}')
  const h = window.__h
  return {
    vw: w.innerWidth, vh: w.innerHeight, scrollY: R(w.scrollY),
    docScrollW: de.scrollWidth, docClientW: de.clientWidth, pageH: Math.round(de.scrollHeight),
    chrome: { top: topBar ? R(topBar.getBoundingClientRect().height) : null, nav: nav ? R(nav.getBoundingClientRect().height) : null },
    surface: { leftPage: !!d.querySelector('[data-testid="harness-left-page"]'), packetCard: !!packetCard,
      h1: text(h1), dialog: !!d.querySelector('[role="dialog"]') },
    counts: { sowThis: d.querySelectorAll('${tid('sow-this')}').length, sownLine: sownLineEl ? 1 : 0,
      editSow: d.querySelectorAll('${tid('edit-sow-details')}').length, stageLink: stageLink ? 1 : 0,
      cards: cards.length, controls: taps.length },
    stageLinkText: text(stageLink),
    taps, sownFrom, sownLine, breeding,
    errors: h ? h.errors() : ['window.__h missing'], unstubbed: h ? h.unstubbed() : [], posts: h ? h.posts() : [],
  }
})()`

// Navigations race Runtime.evaluate: dispatched a beat early, the execution context is torn down under
// it. Retried ONLY on that class of transport error; anything else still throws.
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i
let cdp
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

// Waits in the page for `cond` (a JS expression) and then for the scroll position to hold still for
// 300ms. False on timeout.
const waitSettled = (cond, ms = 8000) => evalSettled(`(async () => {
  const t0 = performance.now(); let y = null, still = 0
  while (performance.now() - t0 < ${ms}) {
    await new Promise(r => setTimeout(r, 50))
    if (!(${cond})) { y = null; still = 0; continue }
    const now = Math.round(window.scrollY * 10)
    if (now === y) { still += 50; if (still >= 300) return true } else { y = now; still = 0 }
  }
  return false
})()`)

// A REAL tap: the element is brought to the middle of the visible band, its centre is hit-tested — a
// tap that would land on something else is reported, never dispatched — then a press and release at
// that point go through the browser's own input pipeline. Returns null, or why the tap was not made.
async function tap(expr, what) {
  const there = await evalSettled(`(() => { const el = ${expr}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
  if (!there) return `${what} is not on the page`
  await waitSettled('true', 3000)
  const p = await evalSettled(`(() => { const el = ${expr}; if (!el) return null
    const r = el.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
    const at = document.elementFromPoint(x, y)
    return { x, y, hits: at === el || (at != null && el.contains(at)),
      at: at ? (at.getAttribute('data-testid') || at.tagName.toLowerCase()) : 'nothing' } })()`)
  if (!p) return `${what} left the page before it could be tapped`
  if (!p.hits) return `${what} does not hit-test at its centre (x${Math.round(p.x)} y${Math.round(p.y)} lands on ${p.at})`
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  return null
}

// (g) REACH: scrolled to the middle of the band, does the control's centre hit-test to itself? Read-only
// otherwise — nothing is dispatched.
async function reach(expr) {
  const there = await evalSettled(`(() => { const el = ${expr}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
  if (!there) return { present: false }
  await waitSettled('true', 3000)
  return evalSettled(`(() => { const el = ${expr}; const r = el.getBoundingClientRect()
    const top = document.querySelector('header[data-app-chrome="top"]'), nav = document.querySelector('nav[aria-label="Main navigation"]')
    const bandTop = top ? top.getBoundingClientRect().bottom : 0, bandBottom = nav ? nav.getBoundingClientRect().top : window.innerHeight
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
    const inBand = y >= bandTop && y <= bandBottom && x >= 0 && x <= window.innerWidth
    const at = inBand ? document.elementFromPoint(x, y) : null
    return { present: true, inBand, hits: !!at && (at === el || el.contains(at)),
      at: at ? (at.getAttribute('data-testid') || at.tagName.toLowerCase()) : 'nothing', h: Math.round(r.height * 10) / 10 } })()`)
}

const shoot = async (path) => {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  return path
}
const toTop = async () => {
  await evalSettled('(() => { window.scrollTo(0, 0); return 1 })()')
  await waitSettled('window.scrollY === 0', 3000)
}

// ── THE SOW (state sown) — Sow this, then the sheet's own "Add planting", both real taps ─────────────
const SOW_SHEET = `document.querySelector('[role="dialog"]')`
const ADD_PLANTING = `(() => { const s = ${SOW_SHEET}; return s ? [...s.querySelectorAll('button')].find(b => /^Add planting$/i.test((b.textContent || '').trim())) || null : null })()`
async function sow(at) {
  const why = await tap(`document.querySelector('${tid('sow-this')}')`, 'Sow this')
  if (why) return why
  // The sheet is up, and its editor has what it needs: the places list landed (the editor mounts only
  // then) and the packet prefill put the packet's name in the Name field.
  const ready = await waitSettled(`(() => { const s = ${SOW_SHEET}; if (!s) return false
    const add = ${ADD_PLANTING}
    return !!add && !add.disabled && [...s.querySelectorAll('input')].some(i => i.value === ${JSON.stringify(PACKET_NAME)}) })()`)
  if (!ready) return 'the Sow sheet never showed a ready editor (Add planting, with the packet\'s name prefilled)'
  const why2 = await tap(ADD_PLANTING, 'the sheet\'s Add planting')
  if (why2) return why2
  const done = await waitSettled(`!${SOW_SHEET} && !!document.querySelector('${tid('sow-this-sown')}')`)
  if (!done) return 'the create did not land: the sheet is still open or the page shows no "Sown ✓" line'
  // The sheet's own "Planted!" toast is transient (2.5 s) and sits over the page's lower controls while
  // it shows; the state under test is the page it leaves behind.
  const quiet = await waitSettled(`![...document.querySelectorAll('[role="status"]')].some(e => /Planted!/.test(e.textContent || ''))`, 8000)
  if (!quiet) return 'the "Planted!" toast never went away'
  await toTop()
  console.log(`[seed-detail] ${at}: sown — Sow this and Add planting tapped, sheet closed, "Sown ✓" line up`)
  return null
}

// ── (h) THE REFUSED REMOVE — BUG-INVDELETEERROROFFSCREEN-001 ─────────────────────────────────────────
// The defect this state exists for: a refused delete closed the dialog and wrote its reason to the
// form banner, above the whole form — off-screen on a phone, with nothing changed near the finger. So
// the question is geometric, and jsdom cannot ask it: after the refusal, is the reason ON SCREEN, in
// the dialog, beside the buttons the finger is on?
const REMOVE_DIALOG = `document.querySelector('${tid('inventory-remove-dialog')}')`
const MEASURE_REMOVE = `(() => {
  const d = document, w = window, de = d.documentElement
  const R = n => Math.round(n * 10) / 10
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: R(r.top), l: R(r.left), r: R(r.right), b: R(r.bottom), w: R(r.width), h: R(r.height) } }
  const runsOf = el => { const out = [], tw = d.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!t.textContent.trim()) continue
      const rg = d.createRange(); rg.selectNodeContents(t)
      for (const r of rg.getClientRects()) if (r.width > 0.5 && r.height > 0.5) out.push(r)
    }
    return out }
  const inside = (r, c) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5
  const view = { left: 0, top: 0, right: w.innerWidth, bottom: w.innerHeight }
  const hitsSelf = el => { const r = el.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
    const at = d.elementFromPoint(x, y); return at === el || (at != null && el.contains(at)) }
  const dlg = ${REMOVE_DIALOG}
  const err = d.querySelector('${tid('inventory-remove-error')}')
  const confirm = d.querySelector('${tid('inventory-remove-confirm')}')
  const keep = dlg ? [...dlg.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Keep it') || null : null
  const refusal = window.__h ? window.__h.refusal() : null
  const head = refusal ? refusal.slice(0, 30) : null
  const shownAt = head ? [...d.querySelectorAll('body *')].filter(el =>
    [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.includes(head))).length : 0
  const er = err ? err.getBoundingClientRect() : null
  const row = err ? err.nextElementSibling : null
  const runs = err ? runsOf(err) : []
  return {
    vw: w.innerWidth, vh: w.innerHeight, docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    leftPage: !!d.querySelector('[data-testid="harness-left-page"]'), refusal, shownAt,
    dialog: dlg ? { box: box(dlg), inView: inside(dlg.getBoundingClientRect(), view) } : null,
    error: err ? { box: box(err), role: err.getAttribute('role'), text: (err.textContent || '').trim(),
      inDialog: !!dlg && dlg.contains(err) && inside(er, dlg.getBoundingClientRect()), inView: inside(er, view),
      runs: runs.length, runsWhole: runs.every(r => inside(r, er) && inside(r, view)),
      rowHoldsButtons: !!row && !!confirm && !!keep && row.contains(confirm) && row.contains(keep),
      gapToButtons: row ? R(row.getBoundingClientRect().top - er.bottom) : null } : null,
    confirm: confirm ? { h: box(confirm).h, hits: hitsSelf(confirm), inView: inside(confirm.getBoundingClientRect(), view) } : null,
    keep: keep ? { h: box(keep).h, hits: hitsSelf(keep), inView: inside(keep.getBoundingClientRect(), view) } : null,
    deletes: window.__h ? (window.__h.hits()['item-delete'] || 0) : null,
    errors: window.__h ? window.__h.errors() : ['window.__h missing'],
  }
})()`

async function removeRefused(vw, vh) {
  const at = `remove-refused@${vw}x${vh}`
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
  const url = `http://localhost:${PORT}/tests/harness/seeddetail.html?case=packet&remove=refuse&topbar=${TOP_CHROME_PX}&vp=${vw}x${vh}-remove&verdict=0`
  const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
  if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
  await sleep(200)
  await evalSettled(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('harness never reached ready() on remove=refuse')})()`)
  await evalSettled('document.fonts ? document.fonts.ready.then(() => 1) : 1')
  if (!await evalSettled('window.__h.arrived()')) return fail(`${at}: the page never arrived — nothing to measure`)
  if (MUTATE_CSS) {
    await evalSettled(`(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(MUTATE_CSS)}; document.head.appendChild(st); return 1 })()`)
  }
  await waitSettled('true', 2000)
  // Both taps real, hit-tested at their centres, exactly as the finger would land.
  const why = await tap(`document.querySelector('${tid('inventory-remove')}')`, '"Remove item"')
  if (why) return fail(`${at}: (h) ${why}`)
  if (!await waitSettled(`!!${REMOVE_DIALOG}`)) return fail(`${at}: (h) "Remove item" was tapped and no "Remove item?" dialog opened`)
  const why2 = await tap(`document.querySelector('${tid('inventory-remove-confirm')}')`, 'the dialog\'s "Remove"')
  if (why2) return fail(`${at}: (h) ${why2}`)
  // Settles on whichever happens: the reason appears, the dialog goes away, or the page leaves. The
  // measurement below says which, and only the first is a pass.
  if (!await waitSettled(`!!document.querySelector('${tid('inventory-remove-error')}') || !${REMOVE_DIALOG} || !!document.querySelector('[data-testid="harness-left-page"]')`)) {
    return fail(`${at}: (h) the refusal never showed — the dialog is still up with no reason in it`)
  }
  const m = await evalSettled(MEASURE_REMOVE)
  if (m.vw !== vw || m.vh !== vh) return fail(`${at}: page self-reports ${m.vw}x${m.vh} — emulation did not take`)
  if (m.errors.length) return fail(`${at}: the page raised ${m.errors.length} error(s): ${m.errors.join(' | ')}`)
  if (!m.refusal) return fail(`${at}: the harness is not refusing (remove=refuse not honoured) — the state measures nothing`)
  if (m.leftPage) return fail(`${at}: (h) the page LEFT after a refused delete`)
  if (m.deletes !== 1) fail(`${at}: (h) ${m.deletes} DELETE request(s) sent, expected exactly 1`)
  if (m.docScrollW > m.docClientW + 1) fail(`${at}: (a) document scrollWidth ${m.docScrollW} > clientWidth ${m.docClientW} — the page scrolls sideways`)
  if (!m.dialog) return fail(`${at}: (h) the dialog CLOSED on the refusal — the reason is not where the tap was`)
  if (!m.dialog.inView) fail(`${at}: (h) the dialog spans y${m.dialog.box.t}-${m.dialog.box.b} x${m.dialog.box.l}-${m.dialog.box.r}, not wholly inside the ${vw}x${vh} viewport`)
  const e = m.error
  if (!e) return fail(`${at}: (h) no reason in the dialog`)
  if (e.role !== 'alert') fail(`${at}: (h) the reason is not role="alert" (it is ${JSON.stringify(e.role)}) — a screen reader would not announce it`)
  if (e.text !== m.refusal) fail(`${at}: (h) the dialog shows "${e.text}", expected the server's sentence "${m.refusal}"`)
  if (m.shownAt !== 1) fail(`${at}: (h) the sentence is on the page ${m.shownAt} times, expected once (in the dialog only)`)
  if (!e.inDialog) fail(`${at}: (h) the reason is not inside the dialog's box`)
  if (!e.inView) fail(`${at}: (h) the reason spans y${e.box.t}-${e.box.b}, not wholly inside the ${vw}x${vh} viewport`)
  if (!e.runs || !e.runsWhole) fail(`${at}: (h) the reason is not whole — ${e.runs} text run(s), some painted outside its box or the viewport`)
  if (!e.rowHoldsButtons) fail(`${at}: (h) the element after the reason is not the Remove / Keep it row — the reason is not beside the buttons`)
  if (e.gapToButtons == null || e.gapToButtons < 0 || e.gapToButtons > 24) fail(`${at}: (h) the reason ends ${e.gapToButtons}px above the buttons, expected 0-24px`)
  for (const [what, b] of [['Remove', m.confirm], ['Keep it', m.keep]]) {
    if (!b) { fail(`${at}: (h) the dialog has no "${what}" button`); continue }
    if (b.h < TAP_MIN_HEIGHT_PX) fail(`${at}: (h) "${what}" is ${b.h}px tall, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
    if (!b.inView || !b.hits) fail(`${at}: (h) "${what}" is off-screen or covered (inView=${b.inView}, hitsSelf=${b.hits})`)
  }
  shots.push(await shoot(join(OUTDIR, `seed-detail-remove-refused-${vw}x${vh}.png`)))
  console.log(`[seed-detail] ${at}: dialog y${m.dialog.box.t}-${m.dialog.box.b} · reason ${e.box.w}x${e.box.h}px at y${e.box.t}-${e.box.b}, ${e.gapToButtons}px above the buttons · Remove ${m.confirm?.h}px · Keep it ${m.keep?.h}px · DELETEs ${m.deletes}`)
}

let harness, chrome
const udd = mkdtempSync(join(tmpdir(), 'gate-seeddetail-'))
const shots = []
try {
  if (MUTATE_CSS) console.log(`[seed-detail] MUTATION RUN — GATE_MUTATE_CSS=${JSON.stringify(MUTATE_CSS)}: this is not a clean run`)
  mkdirSync(OUTDIR, { recursive: true })
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[seed-detail] --probe-nothing: every testid points at one nothing renders. This run MUST fail.')

  for (const s of STATES) {
    for (const [vw, vh] of VIEWPORTS) {
      const at = `${s.name}@${vw}x${vh}`
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
      // verdict=0 strips the harness's fixed instrument bar (z-index 99999 over the page's own header).
      const url = `http://localhost:${PORT}/tests/harness/seeddetail.html?case=${s.harness}&topbar=${TOP_CHROME_PX}&vp=${vw}x${vh}-${s.name}&verdict=0`
      const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
      await sleep(200)
      await evalSettled(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('harness never reached ready() on case=${s.harness}')})()`)
      await evalSettled('document.fonts ? document.fonts.ready.then(() => 1) : 1')
      if (!await evalSettled('window.__h.arrived()')) {
        fail(`${at}: the page never arrived (the form's Name field, the stage history and the supplier registry) — nothing to measure`)
        continue
      }
      if (MUTATE_CSS) {
        await evalSettled(`(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(MUTATE_CSS)}; document.head.appendChild(st); return 1 })()`)
      }
      await waitSettled('true', 2000)

      if (s.sow) {
        const why = await sow(at)
        if (why) { fail(`${at}: the sow could not be made — ${why}`); continue }
      }
      await toTop()
      const m = await evalSettled(MEASURE)

      // ── INSTRUMENT CHECK, before any invariant.
      if (m.vw !== vw || m.vh !== vh) {
        const widened = m.vw > vw && Math.abs(m.vw / m.vh - vw / vh) < 0.01
        fail(`${at}: page self-reports ${m.vw}x${m.vh}${widened ? ' — mobile emulation WIDENED the layout viewport to fit a document wider than the device: that is (a), sideways scroll' : ' — emulation did not take, every coordinate below is from the wrong layout'}`)
        continue
      }
      const e = s.expect
      const mismatch = []
      if (m.errors.length) mismatch.push(`the page raised ${m.errors.length} error(s): ${m.errors.join(' | ')}`)
      if (m.surface.leftPage) mismatch.push('the router left /inventory/:id (the harness shows its "left the page" marker)')
      if (!m.surface.packetCard) mismatch.push('no packet card — this is not the seed detail page')
      if (m.surface.h1 !== e.h1) mismatch.push(`the title reads "${m.surface.h1}", expected "${e.h1}"`)
      if (m.surface.dialog) mismatch.push('a sheet is still open over the page')
      if (m.chrome.top !== TOP_CHROME_PX) mismatch.push(`top-bar stand-in is ${m.chrome.top}px, expected TopChrome's BAR_H ${TOP_CHROME_PX}px`)
      if (m.chrome.nav !== BOTTOM_NAV_HEIGHT_PX) mismatch.push(`bottom-nav stand-in is ${m.chrome.nav}px, expected BOTTOM_NAV_HEIGHT_PX ${BOTTOM_NAV_HEIGHT_PX}px`)
      if (m.counts.sowThis !== e.sowThis) mismatch.push(`Sow this ${m.counts.sowThis} != ${e.sowThis}${e.sowThis === 0 ? ' — (d) it must be ABSENT on a lot still in process' : ''}`)
      if (m.counts.sownLine !== e.sownLine) mismatch.push(`"Sown ✓" line ${m.counts.sownLine} != ${e.sownLine}`)
      if (m.counts.editSow !== e.editSow) mismatch.push(`Edit sow details ${m.counts.editSow} != ${e.editSow}`)
      if (m.counts.stageLink !== e.stageLink) mismatch.push(`"${STAGE_LINK_WORDS}" link ${m.counts.stageLink} != ${e.stageLink}`)
      if (m.counts.cards !== (e.sownFrom.length ? 1 : 0)) mismatch.push(`"Sown from this packet" cards ${m.counts.cards} != ${e.sownFrom.length ? 1 : 0}`)
      if (m.sownFrom && m.sownFrom.rows.length !== e.sownFrom.length) mismatch.push(`sown-from rows ${m.sownFrom.rows.length} != ${e.sownFrom.length}`)
      if (e.f2 && !m.breeding) mismatch.push('no Breeding fact in the packet card — (f) has nothing to read')
      if (m.counts.controls < 8) mismatch.push(`${m.counts.controls} controls measured — a page this size carries far more`)
      if (mismatch.length) {
        fail(`${at}: the fixture did not produce what this gate measures — ${mismatch.join('; ')}`)
        continue
      }
      // The zero-box detector: an unrendered document hands back elements whose every box is 0x0.
      const heights = m.taps.map((t) => t.h)
      if (heights.every((h) => h === 0)) { fail(`${at}: every one of ${heights.length} measured controls is 0px tall — nothing was laid out`); continue }

      // ── (a) NO SIDEWAYS SCROLL.
      if (m.docScrollW > m.docClientW + 1) fail(`${at}: (a) document scrollWidth ${m.docScrollW} > clientWidth ${m.docClientW} — the page scrolls sideways`)

      // ── (b) TAP FLOOR — census, with the named exemptions printed.
      const exemptOf = (t) => EXEMPTIONS.find((x) => x.match(t)) || null
      const exempt = m.taps.filter(exemptOf)
      const short = m.taps.filter((t) => !exemptOf(t) && t.h < TAP_MIN_HEIGHT_PX)
      for (const t of short) fail(`${at}: (b) <${t.tag}> "${t.label}" renders ${t.w}x${t.h}, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
      for (const t of m.taps) {
        if (!t.fitsX) fail(`${at}: (b) <${t.tag}> "${t.label}" sits outside the ${vw}px viewport — unreachable`)
        if (t.hitIsSelf === false) fail(`${at}: (b) <${t.tag}> "${t.label}" does not hit-test to itself — occluded`)
      }

      // ── (c) THE "SOWN FROM THIS PACKET" CARD.
      if (m.sownFrom) {
        const c = m.sownFrom
        if (!c.inViewX) fail(`${at}: (c) the Sown-from card spans x${c.box.l}-${c.box.r}, outside the ${vw}px viewport`)
        if (c.overflowX) fail(`${at}: (c) the Sown-from card overflows its own box horizontally`)
        c.rows.forEach((r, i) => {
          const want = e.sownFrom[i]
          const tag = `(c) Sown-from row ${i + 1} "${r.name}"`
          if (r.href !== want.href) fail(`${at}: ${tag} links ${r.href}, expected ${want.href}`)
          if (r.name !== want.name) fail(`${at}: ${tag} names "${r.name}", expected "${want.name}" — the row is not the planting it claims`)
          if (!r.meta) fail(`${at}: ${tag} has no meta line (sown date · status)`)
          if (r.box.h < TAP_MIN_HEIGHT_PX) fail(`${at}: ${tag} is ${r.box.h}px tall, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
          if (!r.fullWidth) fail(`${at}: ${tag} is ${r.box.w}px wide in a ${c.contentW}px card — the row is not the full-width target it is designed as`)
          if (!r.inCard) fail(`${at}: ${tag} spans x${r.box.l}-${r.box.r}, outside its card x${c.box.l}-${c.box.r}`)
          if (!r.inViewX) fail(`${at}: ${tag} spans x${r.box.l}-${r.box.r}, outside the ${vw}px viewport`)
          if (r.overflowX) fail(`${at}: ${tag} overflows its own box horizontally`)
          if (!r.whole.runs) fail(`${at}: ${tag} paints no text`)
          if (!r.whole.inside) fail(`${at}: ${tag} is not whole — some of its text is painted outside the row`)
          if (!r.whole.inViewX) fail(`${at}: ${tag} is not whole — some of its text is painted outside the viewport`)
          if (!r.chevron || r.chevron.text !== '›' || !r.chevron.inside) fail(`${at}: ${tag} has no chevron inside the row`)
        })
        // The non-vacuity of "whole": at the narrowest phone a wrapped name must be among the rows.
        if (vw === 360 && !c.rows.some((r) => r.nameLines >= 2)) fail(`${at}: (c) no Sown-from name wraps at 360px — the fixture stopped carrying a name long enough to ask "whole" of a wrapped row`)
      }

      // ── (e) THE SOW.
      if (s.sow) {
        const creates = m.posts.filter((p) => p && p.source_inventory_item_id === PACKET_ID)
        if (m.posts.length !== 1 || creates.length !== 1) fail(`${at}: (e) ${m.posts.length} create POST(s), ${creates.length} carrying the packet — expected exactly one, carrying ${PACKET_ID}`)
        const L = m.sownLine
        if (!L.text.startsWith('Sown ✓')) fail(`${at}: (e) the sown line reads "${L.text}", expected it to start "Sown ✓"`)
        if (!L.see) fail(`${at}: (e) the sown line has no "See the planting" link`)
        else if (L.see.href !== NEW_PLANTING_HREF) fail(`${at}: (e) "See the planting" links ${L.see.href}, expected ${NEW_PLANTING_HREF} (the planting the create named)`)
        if (!L.inViewX || !L.whole.inViewX) fail(`${at}: (e) the sown line is not whole inside the ${vw}px viewport`)
      }

      // ── (f) F2.
      if (e.f2) {
        const want = `${F2_LABEL} (parent F1 hybrid)`
        const b = m.breeding
        if (b.label !== 'Breeding' || b.value !== want) fail(`${at}: (f) the Breeding fact reads "${b.label}: ${b.value}", expected "Breeding: ${want}"`)
        if (!b.whole || !b.whole.inside || !b.whole.inViewX) fail(`${at}: (f) the Breeding fact is not whole inside the packet card and the viewport`)
        if (b.overflowX) fail(`${at}: (f) the Breeding value overflows its own box`)
      } else if (m.breeding && m.breeding.value && m.breeding.value.includes(F2_LABEL)) {
        fail(`${at}: (f) a bought packet reads "${m.breeding.value}" — F2 belongs only to a lot saved off an F1 plant`)
      }
      if (m.counts.stageLink && m.stageLinkText !== STAGE_LINK_WORDS) fail(`${at}: (f) the stage link reads "${m.stageLinkText}", expected "${STAGE_LINK_WORDS}"`)

      // ── (g) REACH — each seed control, brought to the middle of the band, hit-tests to itself.
      const keys = [
        ['Sow this', `document.querySelector('${tid('sow-this')}')`],
        ['See the planting', `document.querySelector('${tid('sow-this-see-planting')}')`],
        ['Edit sow details', `document.querySelector('${tid('edit-sow-details')}')`],
        ['Change stage in Saved seeds', `document.querySelector('${tid('seed-stage-change-link')}')`],
        ...e.sownFrom.map((_, i) => [`Sown-from row ${i + 1}`, `document.querySelectorAll('${tid('sown-from-link')}')[${i}]`]),
      ]
      const reached = []
      for (const [what, expr] of keys) {
        const r = await reach(expr)
        if (!r.present) continue
        reached.push(`${what} ${r.h}px`)
        if (!r.inBand) fail(`${at}: (g) ${what} cannot be brought into the visible band`)
        else if (!r.hits) fail(`${at}: (g) ${what}, in the middle of the band, hit-tests to ${r.at} instead of itself`)
      }

      // ── Screenshots: the first screen, then the evidence.
      await toTop()
      shots.push(await shoot(join(OUTDIR, `seed-detail-${s.name}-${vw}x${vh}.png`)))
      const evidence = s.name === 'sown' ? `document.querySelector('${tid('sow-this-sown')}')`
        : e.f2 ? `[...document.querySelectorAll('${tid('packet-fact')}')].find(f => f.getAttribute('data-fact') === 'breeding')`
        : `document.querySelector('${tid('packet-sown-from')}')`
      if (await evalSettled(`(() => { const el = ${evidence}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)) {
        await waitSettled('true', 3000)
        shots.push(await shoot(join(OUTDIR, `seed-detail-${s.name}-${vw}x${vh}-evidence.png`)))
      }

      // ── The record, printed on pass as well as fail.
      const floored = m.taps.filter((t) => !exemptOf(t))
      const minTap = floored.length ? Math.min(...floored.map((t) => t.h)) : 0
      console.log(`[seed-detail] ${at}: ${m.taps.length} controls, shortest non-exempt ${minTap}px (floor ${TAP_MIN_HEIGHT_PX}px), ${short.length} under · scrollW ${m.docScrollW}/${m.docClientW} · pageH ${m.pageH}px`)
      for (const x of EXEMPTIONS) {
        const hit = m.taps.filter(x.match)
        if (!hit.length) continue
        console.log(`[seed-detail] ${at}: NAMED EXEMPTION ${x.key} — ${hit.map((t) => `"${t.label}"=${t.w}x${t.h}px`).join(', ')}${hit.every((t) => t.h >= TAP_MIN_HEIGHT_PX) ? ' · clears the real floor now: the exemption is INERT, delete it' : ''} (${x.why})`)
      }
      if (m.sownFrom) {
        console.log(`[seed-detail] ${at}: Sown-from card x${m.sownFrom.box.l}-${m.sownFrom.box.r} (content ${m.sownFrom.contentW}px) · rows ${m.sownFrom.rows.map((r) => `${r.box.w}x${r.box.h}px/${r.nameLines}L`).join(', ')}`)
      }
      if (m.sownLine) console.log(`[seed-detail] ${at}: sown line "${m.sownLine.text}" ${m.sownLine.box.w}x${m.sownLine.box.h}px · See the planting ${m.sownLine.see ? `${m.sownLine.see.h}px → ${m.sownLine.see.href}` : 'ABSENT'}`)
      if (m.breeding) console.log(`[seed-detail] ${at}: Breeding "${m.breeding.value}" on ${m.breeding.lines} line(s)`)
      console.log(`[seed-detail] ${at}: reach ${reached.join(' · ') || 'none'}${m.unstubbed.length ? ` · unstubbed requests: ${[...new Set(m.unstubbed)].join(', ')}` : ''}`)
    }
  }
  for (const [vw, vh] of VIEWPORTS) await removeRefused(vw, vh)
} catch (err) {
  fail(`gate could not complete: ${err.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (shots.length) console.log(`[seed-detail] screenshots: ${shots.map((p) => p.replace(`${ROOT}/`, '')).join(', ')}`)
// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner says
// which one happened.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[seed-detail] FAIL — EXPECTED. --probe-nothing pointed every testid at one nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[seed-detail] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[seed-detail] FAIL — and this one is the real defect: every testid pointed at nothing and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[seed-detail] PASS')
