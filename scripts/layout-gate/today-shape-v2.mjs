#!/usr/bin/env node
// today-shape-v2.mjs — gate:today-shape:v2, the Today redesign's contract in real Chrome (V5-TODAYREDESIGN-001).
//
//   node scripts/layout-gate/today-shape-v2.mjs                  # npm run gate:today-shape:v2
//   node scripts/layout-gate/today-shape-v2.mjs --probe-nothing  # every v2 anchor points at nothing; MUST exit 1
//   node scripts/layout-gate/today-shape-v2.mjs --self-test      # arm every check against an EMPTY V2; must red the census
//   node scripts/layout-gate/today-shape-v2.mjs --record         # write the v2 budget for the ARMED floors (clean tree only)
//
// WHAT IT IS. The plan-v2 §9.1 contract — 20 states, assertions (a)–(m), the REGIONS map — held as DATA in
// tests/harness/_todaymeasure/today-v2-contract.mjs and run here against tests/harness/todaymeasure.html?v2=1
// (the real TodayRoute chooser under the real AuthProvider and PrefsProvider, only the wire stubbed), served by
// tests/harness/vite.harness.v2.mjs. A NEW script: scripts/layout-gate/today-shape.mjs (v1) stays byte-identical
// and keeps gating the default route until S8c; the helpers below are COPIED from it, to be unified at S8c.
//
// ARMED vs PENDING. Every check names the slice(s) whose surface it measures. Checks whose slices have not
// landed (today-v2-contract.mjs LANDED) are PENDING: printed, counted, never passed. What is armed at S0 is the
// instrument itself: viewport, clock, timezone, font pin, stubbed weather, no live request, a complete fixture
// ledger, the V2 flag and seeds written, the critter origin served, and the prefs GET observed exactly once
// (seam b). The census that will judge the V2 surface is proved able to fail BEFORE it arms by --self-test.
//
// REFUSALS CARRIED OVER FROM v1 (today-shape.mjs:465-535, 744-764, 841-854): the fixture preflight runs first;
// a page that does not self-report innerWidth === 426 is VOID (macOS floors an OS window at ~500px, so geometry
// comes from Emulation.setDeviceMetricsOverride, never --window-size); a clock that is not pinned, a host font,
// a live third-party request or a missing fixture is a failure, never a note; --record refuses a dirty tree.
//
// OUTPUT. Every failure line is `<state>@<w>x<h>: [<family>] <message>`, one per line: the mutation runner
// (scripts/mutate-today-shape-v2.mjs) counts INDEPENDENT killer families from the bracket, not by regex.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'
import { fontCensus, fontProbe } from './font-census.mjs'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { STATES, LANDED, isArmed, REGIONS_V2, ROW_TESTIDS, SECTION_ORDER } from '../../tests/harness/_todaymeasure/today-v2-contract.mjs'
import { groupsOfRows, EXPECTED_GROUPS } from '../../tests/harness/_todaymeasure/v2groups.mjs'
import { selectorFor } from '../../tests/harness/_todaymeasure/v2wire.js'
// S3: which section each jump chip lands on, and which chips carry a number — the bar's own table, not a copy.
import { CHIPS } from '../../src/lib/todayV2/chips.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// 5351 / 9451: clear of every sibling (5311-5331 / 9422-9441 are spoken for; the orchestrator's lane rule).
const PORT = Number(process.env.GATE_HARNESS_PORT || 5351)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9451)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const HARNESS_CONFIG = process.env.GATE_HARNESS_CONFIG || 'tests/harness/vite.harness.v2.mjs'
const BUDGET_PATH = join(ROOT, 'tests/harness/_todaymeasure/today-shape-budget.v2.json')
const VIEWPORT = { w: Number(process.env.GATE_VIEWPORT_W || 426), h: Number(process.env.GATE_VIEWPORT_H || 836), dpr: Number(process.env.GATE_VIEWPORT_DPR || 3) }

function topChromeBarH() {
  const src = readFileSync(resolve(ROOT, 'src/components/TopChrome.jsx'), 'utf8')
  const found = [...src.matchAll(/const BAR_H = (\d+)/g)].map(m => Number(m[1]))
  if (found.length !== 1) throw new Error(`TopChrome.jsx declares BAR_H ${found.length} times; expected exactly 1`)
  return found[0]
}
const CHROME_CONST = { barH: topChromeBarH(), bottomNav: BOTTOM_NAV_HEIGHT_PX }
// FIRST_SCREEN_H from source constants (plan §9.1): 836 − 52 − 56 = 728 today, until the phone step-0 reading.
const FIRST_SCREEN = VIEWPORT.h - CHROME_CONST.barH - CHROME_CONST.bottomNav
const resolveY = (v) => (typeof v === 'number' ? v : Number(String(v).replace(/FIRST_SCREEN/g, String(FIRST_SCREEN)).split('+').reduce((a, t) => a + Number(t.includes('*') ? t.split('*').reduce((x, y) => x * Number(y), 1) : t), 0)))

const RECORD = process.argv.includes('--record')
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SELF_TEST = process.argv.includes('--self-test')
// --arm-all: every check runs as if its slice had landed (the self-test and probe-nothing imply it).
const ARM_ALL = SELF_TEST || PROBE_NOTHING || process.argv.includes('--arm-all')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
if (RECORD && (SELF_TEST || PROBE_NOTHING || process.argv.includes('--arm-all'))) { console.error('[today-shape-v2] REFUSING TO RECORD with --self-test/--probe-nothing/--arm-all — a budget over a stub or a deliberately blind run would bless it.'); process.exit(1) }
const ONLY = (process.env.TODAY_SHAPE_V2_STATES || '').split(',').map(s => s.trim()).filter(Boolean)
const RUN_STATES = ONLY.length ? STATES.filter(s => ONLY.includes(s.name)) : STATES
if (ONLY.length && RUN_STATES.length !== ONLY.length) { console.error(`[today-shape-v2] unknown state(s) in TODAY_SHAPE_V2_STATES: ${ONLY.filter(n => !STATES.some(s => s.name === n)).join(', ')}`); process.exit(2) }

// Instrument families: a failure here says the HARNESS did not do its job, not that the page is wrong. The
// self-test requires zero of these (the red must be the census catching an empty V2, not the rig falling over).
const INSTRUMENT = new Set(['instrument', 'void', 'crash', 'fixture', 'prefs-instrument', 'version'])

const failures = []
const fail = (at, family, msg) => failures.push({ at, family, msg, line: `${at}: [${family}] ${msg}` })
const pending = []

async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — another harness or Chrome is running there. Set GATE_HARNESS_PORT / GATE_CDP_PORT to free ports; measuring through it would measure that process's page.`)
}

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
  const proc = spawn(process.execPath, [bin, '--config', HARNESS_CONFIG, '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
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
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} (code=${proc.exitCode} signal=${proc.signalCode}) — a dead browser, not a slow one; re-running will not help`)
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return { proc, version: await r.json() } } catch { /* not up */ }
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
  const pendingCalls = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id != null && pendingCalls.has(m.id)) { const { res, rej, timer } = pendingCalls.get(m.id); clearTimeout(timer); pendingCalls.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pendingCalls.has(mid)) { pendingCalls.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 120000)
    pendingCalls.set(mid, { res, rej, timer })
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

// ── THE MEASUREMENT, in the page. Reads the contract's anchors; asserts nothing. ────────────────────────────
const REGION_IDS = [...new Set(REGIONS_V2.flatMap(r => [r.id, ...(r.replacedBy || [])]))]
const MEASURE = `(() => {
  const d = document, w = window, de = d.documentElement, sy = w.scrollY
  const SUF = ${JSON.stringify(SUFFIX)}
  const box = el => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top + sy), b: Math.round(r.bottom + sy), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } }
  const clippedArea = el => {
    const r = el.getBoundingClientRect(); let t = r.top, b = r.bottom, l = r.left, rr = r.right
    for (let a = el.parentElement; a && a !== de && a !== d.body; a = a.parentElement) {
      const cs = w.getComputedStyle(a); if (cs.display === 'contents') continue
      const cy = cs.overflowY !== 'visible', cx = cs.overflowX !== 'visible'; if (!cy && !cx) continue
      const ar = a.getBoundingClientRect()
      if (cy) { t = Math.max(t, ar.top); b = Math.min(b, ar.bottom) }
      if (cx) { l = Math.max(l, ar.left); rr = Math.min(rr, ar.right) }
    }
    return Math.max(0, b - t) * Math.max(0, rr - l)
  }
  const shown = el => (!el.checkVisibility || el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) && el.getBoundingClientRect().height > 0 && clippedArea(el) > 0
  const all = sel => [...d.querySelectorAll(sel)]
  // S4: text nodes joined with a space — a count followed by a summary that opens with a digit ("233" + "8 tray
  // cells due") must not read as one number.
  const textOf = el => { const out = []; const tw = d.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t; while ((t = tw.nextNode())) if (t.nodeValue.trim()) out.push(t.nodeValue.trim()); return out.join(' ').replace(/\\s+/g, ' ') }
  const tid = id => '[data-testid="' + id + SUF + '"]'
  const ROWS = ${JSON.stringify(ROW_TESTIDS)}
  const sections = all('[data-testid^="today-sec-"]').filter(el => el.getAttribute('data-testid').endsWith(SUF)).map(el => {
    const key = el.getAttribute('data-testid').slice('today-sec-'.length, SUF ? -SUF.length : undefined)
    const hdr = el.querySelector('[aria-expanded]')
    const hb = hdr ? box(hdr) : null
    const rows = {}; let visibleRows = 0, shortRows = 0, rowTotal = 0
    for (const r of ROWS) { const els = [...el.querySelectorAll(tid(r))]; rows[r] = els.length; rowTotal += els.length; for (const x of els) { if (shown(x)) visibleRows++; if (box(x).h < 48) shortRows++ } }
    // S6: the section's own count attribute (a names-not-counts section carries none) and its summary line.
    const sumEl = el.querySelector(tid('section-summary'))
    return { key, box: box(el), shown: shown(el), header: hdr ? { expanded: hdr.getAttribute('aria-expanded'), controls: hdr.getAttribute('aria-controls'), box: hb, shown: shown(hdr), text: textOf(hdr).slice(0, 140) } : null,
      rows, rowTotal, visibleRows, shortRows, overflowsX: el.scrollWidth > el.clientWidth + 1,
      dataCount: el.getAttribute('data-count'), summary: sumEl ? (sumEl.textContent || '').replace(/\\s+/g, ' ').trim() : null }
  })
  // S6: the Sow link row's words (the whole row is one link).
  const sowEl = d.querySelector(tid('cultivation-lead'))
  const sowRowText = sowEl ? (sowEl.textContent || '').replace(/\\s+/g, ' ').trim() : null
  const regions = Object.fromEntries(${JSON.stringify(REGION_IDS)}.map(id => { const els = all(tid(id)); return [id, { count: els.length, boxes: els.slice(0, 3).map(el => ({ ...box(el), shown: shown(el) })) }] }))
  const one = id => { const el = d.querySelector(tid(id)); return el ? { ...box(el), shown: shown(el), sw: el.scrollWidth, cw: el.clientWidth, ox: w.getComputedStyle(el).overflowX, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) } : null }
  const glanceEl = d.querySelector(tid('today-glance'))
  const glanceToggle = glanceEl ? glanceEl.querySelector('[aria-expanded]') : null
  const verdictEl = d.querySelector(tid('today-verdict'))
  const verdict = verdictEl ? (() => { const range = d.createRange(); range.selectNodeContents(verdictEl); const rs = [...range.getClientRects()]; const last = rs[rs.length - 1]; const card = glanceEl ? glanceEl.getBoundingClientRect() : null
    return { sw: verdictEl.scrollWidth, cw: verdictEl.clientWidth, lastRight: last ? Math.round(last.right) : null, cardRight: card ? Math.round(card.right) : null, ellipsis: w.getComputedStyle(verdictEl).textOverflow } })() : null
  // S3: is every glyph of the element painted — inside its own clip and every clipping ancestor's? (first-screen
  // mustShowText). Text rects in page coordinates; the clip in viewport x and page y.
  const textFit = Object.fromEntries(['today-verdict'].map(id => {
    const el = d.querySelector(tid(id)); if (!el) return [id, null]
    let L = -Infinity, R = Infinity, T = -Infinity, B = Infinity
    for (let a = el; a && a !== de && a !== d.body; a = a.parentElement) {
      const cs = w.getComputedStyle(a); if (cs.display === 'contents') continue
      const ar = a.getBoundingClientRect()
      if (cs.overflowX !== 'visible') { L = Math.max(L, ar.left); R = Math.min(R, ar.right) }
      if (cs.overflowY !== 'visible') { T = Math.max(T, ar.top); B = Math.min(B, ar.bottom) }
    }
    const range = d.createRange(); range.selectNodeContents(el)
    const rects = [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5).map(r => ({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top + sy), b: Math.round(r.bottom + sy) }))
    return [id, { rects, clip: { l: L === -Infinity ? null : Math.round(L), r: R === Infinity ? null : Math.round(R), t: T === -Infinity ? null : Math.round(T + sy), b: B === Infinity ? null : Math.round(B + sy) } }]
  }))
  const bar = d.querySelector(tid('today-jumpbar'))
  const chips = bar ? [...bar.querySelectorAll('[data-chip]')].map(c => c.getAttribute('data-chip')) : []
  const testidCounts = {}
  for (const el of all('[data-testid]')) { const t = el.getAttribute('data-testid'); testidCounts[t] = (testidCounts[t] || 0) + 1 }
  const firstBoxes = {}
  for (const el of all('[data-testid]')) { const t = el.getAttribute('data-testid'); (firstBoxes[t] ||= []).push(box(el)) }
  // ink → contentBottom (v1's selector-free floor, the one that bites on short states)
  const H = Math.ceil(de.scrollHeight); let lastInk = -1
  const tw = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT); let n
  const badge = d.getElementById('hbadge')
  while ((n = tw.nextNode())) { if (!n.nodeValue || !n.nodeValue.trim()) continue; if (badge && badge.contains(n)) continue; const range = d.createRange(); range.selectNodeContents(n); for (const rc of range.getClientRects()) if (rc.width > 0.5 && rc.height > 0.5) lastInk = Math.max(lastInk, Math.ceil(rc.bottom + sy)) }
  const controls = all('button, a[href], [role="button"], summary, input, select, textarea').filter(el => !(badge && badge.contains(el))).filter(shown)
  // section-level containers (v1 containers(), width ≥ 120 and height ≥ 20) → fingerprints; font sizes
  const fps = new Set(); const fonts = new Set()
  for (const el of all('#root *')) {
    const cs = w.getComputedStyle(el); const r = el.getBoundingClientRect()
    if ((el.childNodes.length && [...el.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim()))) fonts.add(cs.fontSize)
    const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)', bord = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none', rad = parseFloat(cs.borderTopLeftRadius) > 0
    if ((bg || bord || rad) && r.width >= 120 && r.height >= 20) fps.add([cs.backgroundColor, cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor, cs.borderTopLeftRadius, cs.boxShadow].join(' | '))
  }
  // S4: closed SPOTS mount no rows either (§9.1 (c) "no row testid under a closed section or spot"); the
  // header count against the spot counts (§2.4 invariant), read off data-count.
  const spotEls = all(tid('care-spot'))
  const inSpot = [...ROWS, 'care-exceptions-row', 'care-cohort-row', 'care-spot-panel']
  const closedSpots = spotEls.filter(el => el.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') === 'false')
    .map(el => ({ spot: el.getAttribute('data-spot'), rows: inSpot.reduce((n, r) => n + el.querySelectorAll(tid(r)).length, 0), controls: el.querySelector('[aria-expanded]').getAttribute('aria-controls') }))
  const careSec = d.querySelector(tid('today-sec-care'))
  const counts = { care: careSec ? Number(careSec.getAttribute('data-count')) : null, spots: spotEls.map(el => Number(el.getAttribute('data-count'))) }
  const spotCtl = Object.fromEntries(spotEls.map(el => [el.getAttribute('data-spot'), { bulk: el.querySelectorAll(tid('care-spot-bulk')).length, notToday: [...el.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label') || '').startsWith('Not today')).length }]))
  const groupBulk = Object.fromEntries(all(tid('care-group-bulk')).map(el => [el.getAttribute('data-group'), (el.textContent || '').replace(/\\s+/g, ' ').trim()]))
  const careSummary = careSec ? ((careSec.querySelector('[aria-expanded]')?.textContent || '').replace(/\\s+/g, ' ').trim()) : null
  const reqs = w.__h.requests()
  return {
    vw: w.innerWidth, vh: w.innerHeight, dpr: w.devicePixelRatio,
    screenW: w.screen.width, vvScale: w.visualViewport ? w.visualViewport.scale : null, vvW: w.visualViewport ? w.visualViewport.width : null,
    scrollHeight: H, scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, contentBottom: lastInk,
    controls: controls.length,
    version: all('[data-today-version="2' + SUF + '"]').length,
    prefsLoaded: (d.querySelector('[data-prefs-loaded]') || { getAttribute: () => null }).getAttribute('data-prefs-loaded'),
    sections, regions, testidCounts, firstBoxes, closedSpots, counts, spotCtl, groupBulk, careSummary, sowRowText,
    glance: glanceEl ? { ...box(glanceEl), shown: shown(glanceEl), expanded: glanceToggle ? glanceToggle.getAttribute('aria-expanded') : null, stale: !!glanceEl.querySelector('[data-stale="true"]') } : null,
    verdict, textFit, bar: bar ? { ...box(bar), sw: bar.scrollWidth, cw: bar.clientWidth, ox: w.getComputedStyle(bar).overflowX, chips } : null,
    weather: all(tid('today-weather')).length,
    fingerprints: [...fps], fontSizes: [...fonts],
    harness: {
      error: w.__h.error(), clock: w.__h.clock(), weatherStubbed: w.__h.weatherStubbed(), fixtures: w.__h.fixtures(),
      liveRequests: reqs.filter(r => r.live).map(r => r.path),
      prefsGets: reqs.filter(r => /\\/api\\/notifications\\/prefs(\\?|$)/.test(r.path) && (r.method || 'GET').toUpperCase() === 'GET').length,
      v2: w.__h.v2(), fontPin: w.__fontPin || null, tokens: w.__h.tokens().type,
    },
  }
})()`

// Section tops above the fold at an instant — the remembered-conflict check compares ready vs +2.5 s.
const TOPS = `(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="today-sec-"]')].map(el => [el.getAttribute('data-testid'), Math.round(el.getBoundingClientRect().top + scrollY)]).filter(([, t]) => t < ${FIRST_SCREEN})))()`

// ── CHECKERS, one per contract family. An ARMED check whose family has no checker is a FAILURE: a slice cannot
// add a check this gate does not know how to run and have it read as passed.
const secOf = (m, key) => m.sections.find(s => s.key === key) || null
const inFirst = (b) => b && b.t >= 0 && b.b <= FIRST_SCREEN
const CHECKERS = {
  // "Observed", not "exactly once": measured at S0, V1's own readers (outside PrefsProvider's single flight)
  // issue a second GET once the first has settled — 2 on busy with a 20 ms answer, 1 when the answer is late
  // enough for them to join it. What must hold is that the page READ prefs and every read got this state's body.
  'prefs-instrument': (m, c, F) => {
    if (m.harness.prefsGets < 1) F(`the prefs GET (/api/notifications/prefs) was never observed — seam (b) is not reading the state's prefs fixture, so Layer 1 is untested`)
    if (m.harness.v2.prefs.served !== m.harness.prefsGets) F(`${m.harness.prefsGets} prefs GET(s) observed but the fixture ${m.harness.v2.prefs.fixture} answered ${m.harness.v2.prefs.served} — a read was answered by something other than this state's prefs`)
  },
  version: (m, c, F) => { if (m.version !== 1) F(`data-today-version="2" rendered ${m.version}x, expected exactly 1 — the V2 route did not mount (route: ${m.harness.v2.route})`) },
  'prefs-loaded-attr': (m, c, F) => { if (m.prefsLoaded !== 'true') F(`data-prefs-loaded is ${JSON.stringify(m.prefsLoaded)}, expected "true" after the observed prefs GET`) },
  'no-hscroll': (m, c, F) => {
    if (m.scrollWidth > m.clientWidth + 1) F(`document scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} — the page scrolls sideways at ${VIEWPORT.w}px`)
    for (const s of m.sections) if (s.overflowsX) F(`section '${s.key}' overflows its own box horizontally`)
    if (m.bar && m.bar.sw > m.bar.cw + 1 && m.bar.ox !== 'auto') F(`the chip strip overflows with overflow-x ${m.bar.ox}, not auto`)
  },
  floors: (m, c, F, ctx) => {
    // --record MEASURES the floors it writes; judging that run against the budget it replaces (or, the first
    // time, against no budget at all) would refuse every recording — S2 found the first one could never land.
    if (RECORD) return
    const b = ctx.budget?.states?.[ctx.state.name]
    if (!b) { F(`no v2 budget entry for this state in ${BUDGET_PATH} — record it on a clean tree (npm run gate:today-shape:v2:record); an armed floor with no number is unguarded`); return }
    if (m.contentBottom < b.contentBottomFloor) F(`the last painted pixel is at y=${m.contentBottom}, above the ${b.contentBottomFloor}px floor`)
    if (m.controls < b.controlsFloor) F(`${m.controls} visible controls, under the ${b.controlsFloor} floor`)
    if (m.scrollHeight > b.scrollHeightCeiling) F(`document is ${m.scrollHeight}px, over the ${b.scrollHeightCeiling}px scroll-height ceiling on the default render — "everything opened" is the shape that trips this`)
    // S2: the same ceiling on the LAST INK. A page shorter than a screen has scrollHeight = the viewport however
    // much opens, so on the skeleton's short states "everything opened" could only show here.
    if (b.contentBottomCeiling != null && m.contentBottom > b.contentBottomCeiling) F(`the last painted pixel is at y=${m.contentBottom}, past the ${b.contentBottomCeiling}px ceiling on the default render — on a page shorter than a screen the scroll height cannot grow, so "everything opened" shows here`)
  },
  'first-screen': (m, c, F) => {
    for (const id of c.mustContain || []) {
      // S5 (first arming of a section id here): a section named in mustContain is its HEADER — §9.1 (e)'s "Protect
      // header", "Heads-up header". The whole open section cannot be the claim: on a frost night its band, pick link
      // and five rows run past the fold by design (§12 A cuts the fifth row there); its rows carry their own claims
      // (minCount / allRows below).
      const boxes = id.startsWith('today-sec-') ? (m.sections.filter(s => 'today-sec-' + s.key === id).map(s => (s.header ? s.header.box : s.box))) : (m.firstBoxes[id + SUFFIX] || [])
      if (!boxes.length) F(`'${id}' is not on the page — the first screen must contain it`)
      else if (!inFirst(boxes[0])) F(`'${id}' paints at y=${boxes[0].t}..${boxes[0].b}, not fully inside the first screen [0, ${FIRST_SCREEN})`)
    }
    for (const [id, n] of Object.entries(c.minCount || {})) { const k = (m.firstBoxes[id + SUFFIX] || []).filter(inFirst).length; if (k < n) F(`${k} '${id}' inside the first screen, expected ≥ ${n}`) }
    if (c.allRows) { const bs = m.firstBoxes[c.allRows + SUFFIX] || []; if (!bs.length) F(`no '${c.allRows}' at all — expected every one inside the first screen`); for (const b of bs) if (!inFirst(b)) { F(`a '${c.allRows}' paints at y=${b.t}..${b.b}, outside the first screen`); break } }
    for (const [key, lim] of Object.entries(c.headerTopMax || {})) { const s = secOf(m, key); const L = resolveY(lim); if (!s?.header) F(`section '${key}' has no header to place`); else if (s.header.box.t > L) F(`the '${key}' header top is y=${s.header.box.t}, past its ${L}px ceiling`) }
    if (c.wholePage && m.contentBottom > FIRST_SCREEN) F(`content ends at y=${m.contentBottom}, past the first screen (${FIRST_SCREEN}) — this state must fit one screen`)
    // S3: the element's TEXT, every glyph of it, painted on the first screen — nothing clipped by its own box or
    // an ancestor's (the verdict: an ellipsis, a nowrap line, a max-height all cut it here, whatever its box says).
    for (const id of c.mustShowText || []) {
      const fit = m.textFit?.[id]
      if (!fit) { F(`'${id}' is not on the page — its text must show whole on the first screen`); continue }
      if (!fit.rects.length) { F(`'${id}' paints no text`); continue }
      const k = fit.clip
      for (const r of fit.rects) {
        if ((k.r != null && r.r > k.r + 1) || (k.l != null && r.l < k.l - 1) || (k.b != null && r.b > k.b + 1) || (k.t != null && r.t < k.t - 1)) { F(`'${id}' is cut off: its text paints x=${r.l}..${r.r}, y=${r.t}..${r.b} against a clip of x=${k.l}..${k.r}, y=${k.t}..${k.b}`); break }
        if (r.t < 0 || r.b > FIRST_SCREEN) { F(`'${id}' text paints at y=${r.t}..${r.b}, not inside the first screen [0, ${FIRST_SCREEN})`); break }
      }
    }
  },
  glance: (m, c, F) => {
    if (c.present === false) { if (m.glance) F('a glance card rendered in a state with no plan'); return }
    if (!m.glance) { F('no glance card (today-glance)'); return }
    if (!m.glance.shown) F('the glance card is mounted but not visible')
    if (c.closed && m.glance.expanded !== 'false') F(`the glance card is not closed by default (aria-expanded ${m.glance.expanded})`)
  },
  'verdict-truncation': (m, c, F) => {
    if (!m.verdict) { F('no verdict (today-verdict) in the glance card'); return }
    if (m.verdict.sw > m.verdict.cw + 1) F(`the verdict is truncated: scrollWidth ${m.verdict.sw} > clientWidth ${m.verdict.cw}`)
    if (m.verdict.ellipsis === 'ellipsis') F('the verdict carries text-overflow: ellipsis')
    if (m.verdict.lastRight != null && m.verdict.cardRight != null && m.verdict.lastRight > m.verdict.cardRight) F(`the verdict's last glyph ends at x=${m.verdict.lastRight}, outside the card (x=${m.verdict.cardRight})`)
  },
  'section-open-set': (m, c, F) => {
    // S4: `orderOf` pins the RELATIVE order of the named sections only (a slice-scoped order that later slices'
    // sections cannot break); `order` stays the strict whole-page order.
    if (c.orderOf) { const got = [...m.sections].sort((a, b) => a.box.t - b.box.t).map(s => s.key).filter(k => c.orderOf.includes(k)); if (JSON.stringify(got) !== JSON.stringify(c.orderOf)) F(`sections [${c.orderOf.join(', ')}] paint in the order [${got.join(', ')}]`) }
    if (c.order) { const got = [...m.sections].sort((a, b) => a.box.t - b.box.t).map(s => s.key); if (JSON.stringify(got) !== JSON.stringify(c.order)) F(`sections by measured top are [${got.join(', ')}], expected [${c.order.join(', ')}]`) }
    for (const key of c.open || []) { const s = secOf(m, key); if (!s) F(`section '${key}' is not on the page (expected OPEN)`); else if (s.header?.expanded !== 'true') F(`section '${key}' is ${s.header ? 'closed (aria-expanded ' + s.header.expanded + ')' : 'headerless'}, expected OPEN`) }
    for (const key of c.closed || []) { const s = secOf(m, key); if (!s) F(`section '${key}' is not on the page (expected CLOSED)`); else if (s.header?.expanded !== 'false') F(`section '${key}' is ${s.header ? 'open (aria-expanded ' + s.header.expanded + ')' : 'headerless'}, expected CLOSED`) }
    if (Array.isArray(c.open) && c.open.length === 0 && !c.closed) for (const s of m.sections) if (s.header?.expanded === 'true') F(`section '${s.key}' is open; this state opens nothing`)
    const known = new Set([...SECTION_ORDER]); for (const s of m.sections) if (!known.has(s.key) && !s.key.startsWith('hh-')) F(`section '${s.key}' is not a section the contract knows (plan §1.0)`)
  },
  'collapsed-mounted': (m, c, F) => {
    if (!m.sections.length) { F('no sections on the page — nothing to check closed-means-unmounted against'); return }
    for (const s of m.sections) if (s.header?.expanded === 'false') {
      if (s.rowTotal > 0) F(`closed section '${s.key}' still mounts ${s.rowTotal} row(s) — closed must mean unmounted, not hidden`)
      if (s.header.controls) F(`closed section '${s.key}' header carries aria-controls="${s.header.controls}" pointing at nothing mounted`)
    }
    for (const sp of m.closedSpots || []) {
      if (sp.rows > 0) F(`closed spot '${sp.spot}' still mounts ${sp.rows} row(s) — closed must mean unmounted, not hidden`)
      if (sp.controls) F(`closed spot '${sp.spot}' carries aria-controls="${sp.controls}" pointing at nothing mounted`)
    }
  },
  visibility: (m, c, F) => {
    const open = m.sections.filter(s => s.header?.expanded === 'true')
    if (!open.length) { F('no open section to check (open means visible)'); return }
    for (const s of open) {
      if (s.rowTotal === 0) F(`open section '${s.key}' shows no rows`)
      if (s.visibleRows < s.rowTotal) F(`open section '${s.key}': ${s.rowTotal - s.visibleRows} of ${s.rowTotal} row(s) are mounted but not visible (clipped or hidden)`)
      if (s.shortRows) F(`open section '${s.key}': ${s.shortRows} row(s) under the 48px floor`)
    }
  },
  'header-text': (m, c, F) => {
    for (const [key, n] of Object.entries(c.counts || {})) { const s = secOf(m, key); if (!s?.header) F(`section '${key}' has no header to read its count from`); else if (!new RegExp(`(^|\\D)${n}(\\D|$)`).test(s.header.text)) F(`the '${key}' header reads "${s.header.text}", expected the count ${n}`) }
    // Presence here; the LABEL is read by the group-water-all interaction check (it needs the element's name).
    for (const [target, label] of Object.entries(c.buttons || {})) { const [tid, arg] = target.split(':'); const els = (m.firstBoxes[tid + SUFFIX] || []); if (!els.length) F(`no '${tid}' (${arg}) to read "${label}" from`)
      // S4: a group button's visible label, read (MF3 "Water all 135").
      else if (tid === 'care-group-bulk' && m.groupBulk[arg] !== label) F(`the '${arg}' group button reads "${m.groupBulk[arg]}", expected "${label}"`) }
    for (const spot of c.spotNoButton || []) { if (!(m.testidCounts['care-spot' + SUFFIX] > 0)) F(`no care-spot to check that '${spot}' carries no button`); else if (!m.spotCtl[spot]) F(`no care-spot '${spot}' on the page`); else if (m.spotCtl[spot].bulk) F(`spot '${spot}' carries a Water all although its beds wait for rain`) }
    // S4 (D6): every spot row carries its own Not today; SF8: the Needs care summary is reasons + spots.
    if (c.spotNotToday) for (const [spot, ctl] of Object.entries(m.spotCtl || {})) if (ctl.notToday !== 1) F(`spot '${spot}' carries ${ctl.notToday} Not today control(s), expected 1 (D6)`)
    if (c.careSummary && !(m.careSummary || '').includes(c.careSummary)) F(`the Needs care header reads "${m.careSummary}", expected its summary "${c.careSummary}" (SF8)`)
    // S6: a section's summary line, exactly; a section that names what it lists carries no count (Reward UX, plan §10
    // item 4); the Sow link row reads exactly its door while the 2027 sowing freeze holds.
    for (const [key, text] of Object.entries(c.summaries || {})) { const s = secOf(m, key); if (!s) F(`section '${key}' is not on the page to read its summary`); else if (s.summary !== text) F(`the '${key}' summary reads ${JSON.stringify(s.summary)}, expected ${JSON.stringify(text)}`) }
    for (const key of c.noCount || []) { const s = secOf(m, key); if (!s) F(`section '${key}' is not on the page`); else if (s.dataCount != null) F(`section '${key}' carries a count (${s.dataCount}) — its header names what it lists, never a number`) }
    if (c.sowRow != null && m.sowRowText !== c.sowRow) F(`the Sow link row reads ${JSON.stringify(m.sowRowText)}, expected exactly ${JSON.stringify(c.sowRow)} — dated sow lines during the 2027 freeze (SOW_DATED_LINES_FROZEN)?`)
  },
  jumpbar: (m, c, F) => {
    if (c.present === false) { if (m.bar) F('a jump bar rendered with fewer than 2 chips'); return }
    if (!m.bar) { F('no jump bar (today-jumpbar)'); return }
    if (c.chips && JSON.stringify(m.bar.chips) !== JSON.stringify(c.chips)) F(`jump-bar chips are [${m.bar.chips.join(', ')}], expected [${c.chips.join(', ')}]`)
    // S3: the chips of the sections actually on the page, in the contract's order — never a chip that lands on
    // nothing, never a present section's chip missing.
    if (c.chipsOfPresent) {
      const on = new Set(m.sections.map(s => s.key))
      const want = c.chipsOfPresent.filter(ch => CHIPS[ch] && on.has(CHIPS[ch].section))
      if (JSON.stringify(m.bar.chips) !== JSON.stringify(want)) F(`jump-bar chips are [${m.bar.chips.join(', ')}], expected the chips of the sections on the page [${want.join(', ')}]`)
      for (const ch of m.bar.chips) if (!CHIPS[ch] || !on.has(CHIPS[ch].section)) F(`chip '${ch}' lands on a section that is not on the page`)
    }
  },
  'visual-census': (m, c, F) => {
    if (m.fingerprints.length > c.maxFingerprints) F(`${m.fingerprints.length} distinct section-level container fingerprints, over the ${c.maxFingerprints} the design allows`)
    const ramp = new Set([...Object.values(m.harness.tokens || {}).map(String), ...(c.fontSizesExtra || [])])
    const px = s => (String(s).endsWith('rem') ? `${parseFloat(s) * 16}px` : String(s))
    const allowed = new Set([...ramp].map(px))
    const off = m.fontSizes.filter(s => !allowed.has(s))
    if (!m.sections.length) F('no sections to take a visual census of')
    if (off.length) F(`font sizes outside the T ramp ∪ {${(c.fontSizesExtra || []).join(', ')}}: ${off.join(', ')}`)
  },
  // S4 (§2.4): the Needs care header count is the sum of its spots' counts, with no filter on.
  'count-invariant': (m, c, F) => {
    if (m.counts.care == null || Number.isNaN(m.counts.care)) { F('the Needs care section carries no data-count to check against its spots'); return }
    if (!m.counts.spots.length) { F('no care-spot rows to sum — the invariant has nothing to hold against (is Needs care open?)'); return }
    const sum = m.counts.spots.reduce((a, b) => a + b, 0)
    if (sum !== m.counts.care) F(`the Needs care header counts ${m.counts.care}, its spots sum to ${sum} — chip == header == Σ spots (§2.4)`)
  },
  'stale-marker': (m, c, F) => { if (!m.glance?.stale) F('no stale marker ([data-stale="true"]) on the glance card for a plan dated before today') },
  'remembered-conflict': (m, c, F, ctx) => {
    const a = ctx.topsAtReady || {}, b = ctx.topsSettled || {}
    if (!Object.keys(a).length) F('no section tops above the fold at the ready point to compare')
    for (const [k, t] of Object.entries(a)) if (b[k] == null || Math.abs(b[k] - t) > 1) F(`'${k}' moved from y=${t} at ready to y=${b[k]} at +2.5 s — a late prefs answer rearranged the page mid-visit`)
  },
  // Interaction-driven families run in the interaction phase below; here they only have to exist.
  interaction: () => {}, 'region-headcount': () => {}, 'weather-once': () => {}, 'group-water-all': () => {}, 'chip-census': () => {},
  'spot-retry': () => {}, announce: () => {}, 'caught-up': () => {},
  'owner-floors': () => {},
}
// S6: owner-floors runs FIRST, on the page as it first rendered (it opens each owner it measures and closes it again),
// so what it records does not depend on what the other families leave open, pressed or scrolled.
// The writes run last (group-water-all, then S4g's spot-retry), each undoing itself before the next; S4g's filter
// announcements after them (they leave filters pressed); S4g's caught-up LAST of all — it empties Needs care and
// leaves it empty.
const INTERACTION_FAMILIES = ['owner-floors', 'interaction', 'region-headcount', 'weather-once', 'chip-census', 'group-water-all', 'spot-retry', 'announce', 'caught-up']
// S6: owner heights measured this run, per state — written into the v2 budget by --record, judged against it otherwise.
const ownerRecord = {}

// S3 chip census, measured in the page at normal text and at 200% (WCAG 1.4.4 resize text; Android's font scaling
// reaches the rem-sized labels the same way). Restores the root font size before it returns.
const CHIP_CENSUS = `(async () => {
  const bar = document.querySelector('[data-testid="today-jumpbar${SUFFIX}"]')
  if (!bar) return null
  const frames = (n) => new Promise(r => { const f = k => (k <= 0 ? r() : requestAnimationFrame(() => f(k - 1))); f(n) })
  const read = () => {
    const b = bar.getBoundingClientRect(), cs = getComputedStyle(bar)
    return { ox: cs.overflowX, sw: bar.scrollWidth, cw: bar.clientWidth, l: b.left, r: b.right,
      chips: [...bar.querySelectorAll('[data-chip]')].map(ch => { const q = ch.getBoundingClientRect(); return { key: ch.getAttribute('data-chip'), l: q.left, r: q.right, h: q.height, text: (ch.textContent || '').replace(/\\s+/g, ' ').trim() } }) }
  }
  const normal = read()
  const html = document.documentElement, before = html.style.fontSize
  html.style.fontSize = '200%'; await frames(3)
  const large = read()
  html.style.fontSize = before; await frames(3)
  return { normal, large }
})()`

// S4: how many of a testid are mounted, and how many are SHOWN (the MEASURE shown() rule, inlined).
const VISIBLE_COUNT = (id) => `(() => { const d = document, w = window, de = d.documentElement
  const clipped = el => { const r = el.getBoundingClientRect(); let t = r.top, b = r.bottom, l = r.left, rr = r.right
    for (let a = el.parentElement; a && a !== de && a !== d.body; a = a.parentElement) { const cs = w.getComputedStyle(a); if (cs.display === 'contents') continue
      const cy = cs.overflowY !== 'visible', cx = cs.overflowX !== 'visible'; if (!cy && !cx) continue; const ar = a.getBoundingClientRect()
      if (cy) { t = Math.max(t, ar.top); b = Math.min(b, ar.bottom) } if (cx) { l = Math.max(l, ar.left); rr = Math.min(rr, ar.right) } }
    return Math.max(0, b - t) * Math.max(0, rr - l) }
  const shown = el => (!el.checkVisibility || el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) && el.getBoundingClientRect().height > 0 && clipped(el) > 0
  const els = [...d.querySelectorAll('[data-testid="${id}${SUFFIX}"]')]
  return { mounted: els.length, shown: els.filter(shown).length } })()`
const CARE_COUNT = `(() => { const s = document.querySelector('[data-testid="today-sec-care${SUFFIX}"]'); return s ? Number(s.getAttribute('data-count')) : null })()`

async function runInteractions(state, checks, at) {
  for (const c of checks) {
    const F = (msg) => fail(at, c.family === 'interaction' ? 'interaction' : c.family, msg)
    if (c.family === 'interaction') {
      for (const step of c.steps) {
        const s = step.scroll != null ? { scroll: resolveY(step.scroll) } : step
        const r = await evalSettled(`window.__h.act(${JSON.stringify(s)})`)
        // A step that cannot run makes the interaction run VOID: nothing after it is evidence. Filed under the
        // check's own family (not the page-level 'void'): a missing or dead control is what the contract caught.
        if (r.void) { F(`VOID interaction run at ${JSON.stringify(step)}: ${r.void}`); break }
        // S4: §9.1 (d) exact row counts after a phase, of rows that are SHOWN; mounted-but-unseen is `visibility`.
        const phase = step.tap?.startsWith('spot:') ? 'afterSpot' : step.tap?.startsWith('cohort:') ? 'afterCohort' : null
        for (const [id, want] of Object.entries((phase && c.counts?.[phase]) || {})) {
          const k = await evalSettled(VISIBLE_COUNT(id))
          if (k.shown !== want) F(`after ${step.tap}: ${k.shown} visible '${id}', expected exactly ${want} (${k.mounted} mounted)`)
          if (k.mounted > k.shown) fail(at, 'visibility', `after ${step.tap}: ${k.mounted - k.shown} of ${k.mounted} '${id}' are mounted but not visible (clipped or hidden)`)
        }
        // S4: a sub-list's label count is the rows it shows ("Different from the rest · 8" over 8 rows).
        if (phase === 'afterSpot') {
          const lab = await evalSettled(`(() => { const e = document.querySelector('[data-testid="care-exceptions${SUFFIX}"]'); if (!e) return null; const m = (e.firstElementChild?.textContent || '').match(/(\\d+)\\s*$/); return m ? Number(m[1]) : null })()`)
          const rowsShown = (await evalSettled(VISIBLE_COUNT('care-exceptions-row'))).shown
          if (lab != null && lab !== rowsShown) fail(at, 'count-invariant', `the exceptions label counts ${lab}, ${rowsShown} exception row(s) show under it`)
        }
      }
    } else if (c.family === 'owner-floors') {
      // S6: the geometric witness for a region moved into an owner (the glance's details, Needs care's foot, Harvest's two
      // bands, Put-Up's band, Resting's rows): opened from the default render, the owner is at least as tall as the
      // budget recorded (0.99×) — a region deleted inside it shortens it, whatever element census says. Put back as found.
      for (const owner of c.owners) {
        const target = owner === 'glance' ? 'glance' : `section:${owner}`
        const anchor = owner === 'glance' ? 'today-glance' : `today-sec-${owner}`
        const wasOpen = (await evalSettled(`window.__h.expanded(${JSON.stringify(target)})`)) === 'true'
        if (!wasOpen) { const a = await evalSettled(`window.__h.act({ tap: ${JSON.stringify(target)} })`); if (a.void) { F(`could not open '${owner}' to measure it: ${a.void}`); continue } }
        await evalSettled('new Promise(r => setTimeout(r, 150))')
        const h = await evalSettled(`(() => { const el = document.querySelector('[data-testid="${anchor}${SUFFIX}"]'); return el ? Math.round(el.getBoundingClientRect().height) : null })()`)
        if (h == null) F(`owner '${owner}' (${anchor}) is not on the page to measure`)
        else {
          ;(ownerRecord[state.name] ||= {})[owner] = h
          const floor = budget?.states?.[state.name]?.owners?.[owner]?.floor
          if (!RECORD) {
            if (floor == null) F(`no owner floor for '${owner}' in the v2 budget — record it on a clean tree (an armed floor with no number is unguarded)`)
            else if (h < floor) F(`'${owner}' opened is ${h}px tall, under its ${floor}px floor — something inside it is gone`)
          }
        }
        if (!wasOpen) await evalSettled(`window.__h.act({ tap: ${JSON.stringify(target)} })`)
      }
    } else if (c.family === 'weather-once') {
      // Opened only if closed, and left as found: region-headcount runs first and leaves the glance OPEN (its last
      // glance rows are counted open), so a blind tap here would CLOSE it (merged S3 × S4 ordering).
      const wasOpen = (await evalSettled(`window.__h.expanded('glance')`)) === 'true'
      const r = wasOpen ? { void: null } : await evalSettled(`window.__h.act({ tap: 'glance' })`)
      if (r.void) { F(`VOID — could not open the glance card: ${r.void}`); continue }
      const k = await evalSettled(`document.querySelectorAll('[data-testid="today-weather${SUFFIX}"]').length`)
      if (k !== 1) F(`with the glance OPEN, today-weather renders ${k}x, expected exactly 1 (MF2)`)
      // S3: "hi/lo text" is a DISPLAYED temperature — an element whose whole text is a bare "65°". A sentence that
      // names the low ("Cool night (42°F)", "low 42°F") is not a repeat: V5-FROSTTWOMODELS-001 makes the card, the
      // cue and the frost line print the one low on purpose, and MF2 keeps those lines under the open card. Counting
      // every "\\d+°" (the S0 draft) failed that design by construction; this counts what MF2 forbids — rows A–C's
      // numerals printed beside the weather card's own.
      const temps = await evalSettled(`(() => { const g = document.querySelector('[data-testid="today-glance${SUFFIX}"]'); if (!g) return null; return [...g.querySelectorAll('*')].filter(el => !el.children.length && /^-?\\d+°$/.test((el.textContent || '').trim())).map(el => el.textContent.trim()) })()`)
      if (!temps || !temps.length) F('the open glance card shows no high/low at all — nothing to check for repeats (MF2)')
      else {
        const seen = {}; for (const x of temps) seen[x] = (seen[x] || 0) + 1
        const rep = Object.entries(seen).filter(([, n]) => n > 1).map(([x]) => x)
        if (rep.length) F(`hi/lo text repeats inside the open glance card: ${rep.join(', ')} (MF2)`)
      }
      if (!wasOpen) await evalSettled(`window.__h.act({ tap: 'glance' })`)
    } else if (c.family === 'chip-census') {
      const r = await evalSettled(CHIP_CENSUS)
      if (!r) { F('no jump bar to take a chip census of'); continue }
      for (const ch of r.normal.chips) {
        if (ch.h < 47.5) F(`chip '${ch.key}' is ${ch.h}px tall, under the 48px chip floor`)
        const counted = CHIPS[ch.key]?.counted
        const label = CHIPS[ch.key]?.label
        if (!label) { F(`chip '${ch.key}' is not a chip the bar knows`); continue }
        if (counted && !new RegExp(`^${label} (\\d+|· done)$`).test(ch.text)) F(`work chip '${ch.key}' reads "${ch.text}", expected "${label} <count>" or "${label} · done"`)
        if (!counted && ch.text !== label) F(`chip '${ch.key}' reads "${ch.text}" — only Protect, Water, Feed and Check carry a number`)
      }
      // At 200% text the chips outgrow the strip: it must scroll (overflow-x auto), and every chip must sit inside
      // the strip's scrollable range — not painted past its edge where no scroll reaches it.
      const L = r.large
      if (L.sw > L.cw + 1 && L.ox !== 'auto' && L.ox !== 'scroll') fail(at, 'no-hscroll', `at 200% text the chip strip overflows with overflow-x ${L.ox} — its chips spill past the column instead of scrolling inside it`)
      const scrolls = (L.ox === 'auto' || L.ox === 'scroll')
      for (const ch of L.chips) {
        const inside = ch.l >= L.l - 1 && ch.r <= L.r + 1
        const reachable = inside || (scrolls && ch.l >= L.l - 1 && ch.r <= L.l + L.sw + 1)
        if (!reachable) { F(`at 200% text chip '${ch.key}' paints at x=${Math.round(ch.l)}..${Math.round(ch.r)}, past the strip (x=${Math.round(L.l)}..${Math.round(L.r)}), which cannot scroll to it`); break }
      }
      if (L.sw <= L.cw + 1) F(`at 200% text the chips still fit the strip (${L.sw} ≤ ${L.cw}px) — the census cannot tell a scrolling strip from a clipped one`)
    } else if (c.family === 'region-headcount') {
      // S3 + S4: a region row counts once its OWN slice has landed (its armedAt — its owner exists), so the family
      // arms slice by slice; the rest are PENDING rows.
      for (const r of REGIONS_V2.filter(x => (x.state === state.name || x.state === '*') && isArmed(x, LANDED, ARM_ALL))) {
        if (r.removed) { for (const rep of r.replacedBy) { const k = await evalSettled(`document.querySelectorAll('[data-testid="${rep}${SUFFIX}"]').length`); if (k < 1) F(`'${r.id}' was REMOVED by D3/D7; its declared replacement '${rep}' is not on the page`) } continue }
        if (r.open) {
          const target = ['glance'].includes(r.open) ? 'glance' : (r.open.includes(':') ? r.open : `section:${r.open}`)
          const cur = await evalSettled(`window.__h.expanded(${JSON.stringify(target)})`)
          if (cur !== 'true') { const a = await evalSettled(`window.__h.act({ tap: ${JSON.stringify(target)} })`); if (a.void) { F(`could not open '${r.open}' to count '${r.id}': ${a.void}`); continue } }
        }
        // S3: a region the contract places on the CLOSED owner is counted with the owner closed.
        if (r.closed) {
          const cur = await evalSettled(`window.__h.expanded(${JSON.stringify(r.closed)})`)
          if (cur === 'true') { const a = await evalSettled(`window.__h.act({ tap: ${JSON.stringify(r.closed)} })`); if (a.void) { F(`could not close '${r.closed}' to count '${r.id}': ${a.void}`); continue } }
        }
        // S4: a region that lives under a task filter (the substrate note under Feed) — that filter ALONE first. The
        // row is multi-select (OR), and a chip jump may have pre-selected another task (S3 × S4: the Water chip
        // leaves Water pressed), so every other pressed task is released before the named one is pressed.
        if (r.filter) {
          const pressed = await evalSettled(`(async () => { const row = () => [...document.querySelectorAll('[data-testid="care-filter-tasks${SUFFIX}"] button[aria-pressed]')]; const is = x => x.textContent.trim().toLowerCase() === ${JSON.stringify(r.filter)}
            if (!row().some(is)) return null
            for (let o; (o = row().find(x => !is(x) && x.getAttribute('aria-pressed') === 'true'));) { o.click(); await new Promise(res => setTimeout(res, 50)) }
            const b = row().find(is); if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true })()`)
          if (!pressed) { F(`could not press the '${r.filter}' task filter to count '${r.id}'`); continue }
          await evalSettled('new Promise(r => setTimeout(r, 120))')
        }
        const k = await evalSettled(`document.querySelectorAll('[data-testid="${r.id}${SUFFIX}"]').length`)
        if (k < 1) F(`region '${r.id}' (owner: ${r.owner}) is not on the page after opening its owner — a moved region was deleted inside its owner`)
        if (r.filter) await evalSettled(`(() => { const b = [...document.querySelectorAll('[data-testid="care-filter-tasks${SUFFIX}"] button[aria-pressed="true"]')].find(x => x.textContent.trim().toLowerCase() === ${JSON.stringify(r.filter)}); if (b) b.click(); return 1 })()`)
      }
    } else if (c.family === 'group-water-all') {
      const q = `[data-testid="care-group-bulk${SUFFIX}"][data-group="${c.group}"]`
      const name = await evalSettled(`(() => { const el = document.querySelector(${JSON.stringify(q)}); return el ? (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim() : null })()`)
      if (name == null) { F(`no group Water all for '${c.group}' (care-group-bulk[data-group])`); continue }
      if (c.expectN != null && !new RegExp(`Water all ${c.expectN}\\b`).test(name)) F(`the '${c.group}' group button reads "${name}", expected "Water all ${c.expectN} …" (MF3)`)
      if (!c.run) continue
      // S4 (MF3): run it. Every spot it touched shrinks to its done line; the group label row becomes ONE line
      // "Outside · watered N" with ONE Undo; that Undo deletes exactly the created ids, and the page returns to
      // its rest counts (the header reads what it read before the tap).
      const n = Number((name.match(/Water all (\d+)/) || [])[1])
      const before = await evalSettled(CARE_COUNT)
      const SPOT_ORDER = `[...document.querySelectorAll('[data-testid="care-group${SUFFIX}"][data-group="${c.group}"] li[data-spot]')].map(li => li.getAttribute('data-spot'))`
      const orderBefore = await evalSettled(SPOT_ORDER)
      await evalSettled(`document.querySelector(${JSON.stringify(q)}).click()`)
      const gq = `[data-testid="care-group-done${SUFFIX}"][data-group="${c.group}"]`
      const doneLine = await evalSettled(`(async () => { for (let i = 0; i < 150; i++) { const el = document.querySelector(${JSON.stringify(gq + ' [data-focus-id]')}); if (el) return (el.textContent || '').replace(/\\s+/g, ' ').trim(); await new Promise(r => setTimeout(r, 100)) } return null })()`)
      if (doneLine == null) { F(`after "Water all" the '${c.group}' group line never became its done line (care-group-done)`); continue }
      if (!new RegExp(`${c.group} · watered ${n}\\b`).test(doneLine)) F(`the group done line reads "${doneLine}", expected "${c.group} · watered ${n}" (MF3)`)
      const undos = await evalSettled(`document.querySelectorAll(${JSON.stringify(gq + ' button')}).length`)
      if (undos !== 1) F(`the group done line carries ${undos} control(s), expected ONE Undo (MF3)`)
      // Held for the visit (§2.2, D10): every spot keeps its slot — shrunk to a done line or still a row.
      const orderAfter = await evalSettled(SPOT_ORDER)
      if (JSON.stringify(orderAfter) !== JSON.stringify(orderBefore)) fail(at, 'spot-order', `the '${c.group}' spots were [${orderBefore.join(', ')}] before its Water all and [${orderAfter.join(', ')}] after — a log must not move or drop a spot`)
      const doneLines = await evalSettled(`document.querySelectorAll('[data-testid="care-group${SUFFIX}"][data-group="${c.group}"] [data-testid="care-done-line${SUFFIX}"]').length`)
      if (!doneLines) F(`no spot in '${c.group}' shrank to its done line after the group Water all (MF3)`)
      const leftBtns = await evalSettled(`document.querySelectorAll('[data-testid="care-group${SUFFIX}"][data-group="${c.group}"] [data-testid="care-spot-bulk${SUFFIX}"]').length`)
      if (leftBtns) F(`${leftBtns} spot Water all button(s) still in '${c.group}' after its group Water all`)
      await evalSettled(`document.querySelector(${JSON.stringify(gq + ' button')}).click()`)
      const back = await evalSettled(`(async () => { for (let i = 0; i < 150; i++) { const el = document.querySelector(${JSON.stringify(q)}); if (el && !document.querySelector(${JSON.stringify(gq)})) return (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim(); await new Promise(r => setTimeout(r, 100)) } return null })()`)
      if (back == null) { F(`the group Undo never brought '${c.group}' back to its Water all`); continue }
      if (back !== name) F(`after Undo the '${c.group}' group button reads "${back}", it read "${name}" before the tap — Undo must delete exactly the created ids (MF3)`)
      const after = await evalSettled(CARE_COUNT)
      if (after !== before) fail(at, 'header-text', `after the group Water all and its Undo the Needs care header counts ${after}, it counted ${before} before the tap`)
    } else if (c.family === 'spot-retry') {
      await spotRetry(c, at, F)
      await evalSettled('window.__h.failPosts(0)')
    } else if (c.family === 'announce') {
      await announceRun(c, at, F)
    } else if (c.family === 'caught-up') {
      await caughtUpRun(c, at, F)
    }
  }
}

// S4g (§2.5 + §5.5): empty Needs care the way Dave would — one spot's Water all, then Not today on every spot left
// (no filter) — and read what its header became: the title, the summary (logged today + covered by rain), no count,
// and focus on it (the action that emptied the section sends focus there). Files `header-text` (the title, the
// count), `caught-up` (the summary), `empty-focus` (§5.5: the focused element is the header and reads the whole
// emptied wording, as TalkBack would).
async function caughtUpRun(c, at, F) {
  const sec = `[data-testid="today-sec-care${SUFFIX}"]`
  const band = `${sec} [aria-expanded]`
  const txt = (q) => `(() => { const el = document.querySelector(${JSON.stringify(q)}); return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null })()`
  const wait = (ms) => evalSettled(`new Promise(r => setTimeout(r, ${ms}))`)
  const start = await evalSettled(`(async () => {
    for (const r of ['tasks', 'spots']) { const b = [...document.querySelectorAll('[data-testid="care-filter-' + r + '${SUFFIX}"] button')].find(x => x.textContent.trim() === 'Clear'); if (b) { b.click(); await new Promise(res => setTimeout(res, 120)) } }
    const h = document.querySelector(${JSON.stringify(band)}); if (!h) return { miss: 'no Needs care band (today-sec-care)' }
    if (h.getAttribute('aria-expanded') !== 'true') { h.click(); await new Promise(res => setTimeout(res, 150)) }
    return { text: (h.textContent || '').replace(/\\s+/g, ' ').trim() } })()`)
  if (start.miss) { F(`could not start: ${start.miss}`); return }
  if (start.text.includes('all caught up')) F(`the Needs care band reads "${start.text}" before anything was logged`)
  const spotQ = `[data-testid="care-spot${SUFFIX}"][data-spot="${c.water}"]`
  const tapped = await evalSettled(`(() => { const b = document.querySelector(${JSON.stringify(spotQ + ` [data-testid="care-spot-bulk${SUFFIX}"]`)}); if (!b) return false; b.click(); return true })()`)
  if (!tapped) { F(`no Water all on '${c.water}' to log with`); return }
  const logged = await evalSettled(`(async () => { for (let i = 0; i < 100; i++) { if (document.querySelector('[data-testid="care-done-line${SUFFIX}"][data-spot="${c.water}"]')) return true; await new Promise(r => setTimeout(r, 100)) } return false })()`)
  if (!logged) { F(`'${c.water}' never shrank to its done line after its Water all`); return }
  // Not today on every spot still on the list, until none is left.
  let skipped = 0
  for (let i = 0; i < 30; i++) {
    const s = await evalSettled(`(() => { const li = document.querySelector('[data-testid="care-spot${SUFFIX}"]'); if (!li) return null; const b = [...li.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').startsWith('Not today')); if (!b) return { stuck: li.getAttribute('data-spot') }; b.click(); return { spot: li.getAttribute('data-spot') } })()`)
    if (!s) break
    if (s.stuck) { F(`spot '${s.stuck}' has no Not today to empty the list with`); return }
    skipped++
    await wait(150)
  }
  await wait(250)
  const head = await evalSettled(txt(band))
  const summary = await evalSettled(txt(`${band} [data-testid="section-summary${SUFFIX}"]`))
  const count = await evalSettled(`(() => { const s = document.querySelector(${JSON.stringify(sec)}); return s ? s.getAttribute('data-count') : 'no section' })()`)
  if (!(head || '').includes(c.title)) fail(at, 'header-text', `emptied, the Needs care band reads "${head}", expected the title "${c.title}" (§2.5)`)
  if (count != null) fail(at, 'header-text', `emptied, the Needs care section still carries a count (data-count="${count}")`)
  if (summary !== c.summary) fail(at, 'caught-up', `emptied, the Needs care summary reads "${summary}", expected "${c.summary}" (§2.5: logged today = done items + store; rain = plan.rain_skipped)`)
  const foc = await evalSettled(`(() => { const a = document.activeElement, h = document.querySelector(${JSON.stringify(band)}); return { on: !!a && a === h, text: a ? (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : 'nothing', tag: a ? a.tagName.toLowerCase() : 'none' } })()`)
  if (!foc.on) fail(at, 'empty-focus', `the action that emptied Needs care left focus on ${foc.tag} "${foc.text}", not the section's header (§5.5)`)
  else if (!foc.text.includes(c.title) || !foc.text.includes(c.summary)) fail(at, 'empty-focus', `focus is on the Needs care header, but what it reads — "${foc.text}" — is not "${c.title}" over "${c.summary}"`)
  console.log(`[today-shape-v2] ${at}: caught-up · ${c.water} watered, ${skipped} spot(s) Not today → "${head}" · focus ${foc.on ? 'header' : foc.tag}`)
}

// S4g (§2.6 / §5.6): each filter change says its result ONCE through the page's one status region; a re-render that
// changes no filter says nothing. A MutationObserver on today-status counts every WRITE — one per record, not per
// callback (two writes in one task arrive in one callback); a same-text rewrite is a write too, and is re-spoken.
// `announce` judges the words, `announce-once` the count.
async function announceRun(c, at, F) {
  const status = `[data-testid="today-status${SUFFIX}"]`
  const row = (r) => `[data-testid="care-filter-${r}${SUFFIX}"]`
  // Start from no filter (earlier families leave some pressed), THEN watch.
  const reset = await evalSettled(`(async () => { const wait = () => new Promise(r => setTimeout(r, 120))
    for (const q of ${JSON.stringify([row('tasks'), row('spots')])}) { const clear = [...document.querySelectorAll(q + ' button')].find(b => b.textContent.trim() === 'Clear'); if (clear) { clear.click(); await wait() } }
    const s = document.querySelector(${JSON.stringify(status)}); if (!s) return 'no status region (today-status)'
    if (!document.querySelector(${JSON.stringify(row('tasks'))})) return 'no task filter row (care-filter-tasks) — is Needs care open?'
    window.__s4gAnn = []; window.__s4gObs = new MutationObserver((recs) => { for (const r of recs) if (r.type === 'characterData' || r.addedNodes.length) window.__s4gAnn.push((s.textContent || '').trim()) })
    window.__s4gObs.observe(s, { childList: true, characterData: true, subtree: true }); return null })()`)
  if (reset) { F(`could not start: ${reset}`); return }
  const said = []
  for (const step of c.steps) {
    const act = step.press ? `(() => { const [r, label] = ${JSON.stringify(step.press)}.split(':'); const b = [...document.querySelectorAll('[data-testid="care-filter-' + r + '${SUFFIX}"] button[aria-pressed]')].find(x => x.textContent.trim() === label); if (!b) return 'no ' + r + ' chip "' + label + '"'; b.click(); return null })()`
      : step.clear ? `(() => { const b = [...document.querySelectorAll('[data-testid="care-filter-${step.clear}${SUFFIX}"] button')].find(x => x.textContent.trim() === 'Clear'); if (!b) return 'no Clear on the ${step.clear} row'; b.click(); return null })()`
        : step.jump ? `(() => { const b = document.querySelector('[data-testid="today-jumpbar${SUFFIX}"] [data-chip="${step.jump}"]'); if (!b) return 'no jump chip ${step.jump}'; b.click(); return null })()`
          : `(async () => { const b = document.querySelector(${JSON.stringify(selectorFor(step.quiet, SUFFIX))}); if (!b) return 'no ${step.quiet} to open'; b.click(); await new Promise(r => setTimeout(r, 150)); b.click(); return null })()`
    const n0 = await evalSettled('window.__s4gAnn.length')
    const miss = await evalSettled(act)
    if (miss) { F(`VOID at ${JSON.stringify(step)}: ${miss}`); break }
    await evalSettled('new Promise(r => setTimeout(r, 400))')
    const got = await evalSettled(`({ n: window.__s4gAnn.length, text: (document.querySelector(${JSON.stringify(status)}).textContent || '').trim() })`)
    const wrote = got.n - n0
    if (step.say) {
      said.push(got.text)
      if (got.text !== step.say) fail(at, 'announce', `after ${JSON.stringify(step)} the status region says "${got.text}", expected "${step.say}" (§2.6)`)
      if (wrote !== 1) fail(at, 'announce-once', `${JSON.stringify(step)} wrote the status region ${wrote}x, expected exactly once (once per filter change, not per render)`)
    } else if (wrote !== 0) fail(at, 'announce-once', `${JSON.stringify(step)} changed no filter but wrote the status region ${wrote}x ("${got.text}") — a filter result is said per change, never per render`)
  }
  await evalSettled('(window.__s4gObs && window.__s4gObs.disconnect(), 1)')
  console.log(`[today-shape-v2] ${at}: announce · ${said.map((s) => `"${s}"`).join(' · ')}`)
}

// S4g (MF3 "failures stay per spot 'Not logged · Retry'"): the group Water all with its first `c.fail` writes
// answered 503 by the harness. Each spot's state is read off its <li>: a done line, or a row (its disclosure text,
// aria-expanded, its "N not logged" line, its Retry and Water all names).
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SPOT_STATE = (G) => `(() => Object.fromEntries([...document.querySelectorAll(${JSON.stringify(G + ' li[data-spot]')})].map(li => {
  const t = el => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null)
  const btn = li.querySelector('[aria-expanded]'), bulk = li.querySelector('[data-testid="care-spot-bulk${SUFFIX}"]'), retry = li.querySelector('[data-testid="care-spot-retry${SUFFIX}"]')
  const done = li.getAttribute('data-testid') === 'care-done-line${SUFFIX}'
  return [li.getAttribute('data-spot'), { done, text: done ? t(li) : t(btn), expanded: btn ? btn.getAttribute('aria-expanded') : null,
    failed: t(li.querySelector('[data-testid="care-spot-failed${SUFFIX}"] span')), retry: retry ? retry.getAttribute('aria-label') : null, bulk: bulk ? bulk.getAttribute('aria-label') : null }]
})))()`
const STATUS_TEXT = `(() => { const s = document.querySelector('[data-testid="today-status${SUFFIX}"]'); return s ? (s.textContent || '').trim() : null })()`
async function spotRetry(c, at, F) {
  const G = `[data-testid="care-group${SUFFIX}"][data-group="${c.group}"]`
  const q = `[data-testid="care-group-bulk${SUFFIX}"][data-group="${c.group}"]`
  const gq = `[data-testid="care-group-done${SUFFIX}"][data-group="${c.group}"]`
  const lineText = `(() => { const el = document.querySelector(${JSON.stringify(gq + ' [data-focus-id]')}); return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null })()`
  const name0 = await evalSettled(`(() => { const el = document.querySelector(${JSON.stringify(q)}); return el ? el.getAttribute('aria-label') : null })()`)
  if (name0 == null) { F(`no group Water all for '${c.group}' to run with failing writes (care-group-bulk[data-group])`); return }
  const N = Number((name0.match(/Water all (\d+)/) || [])[1])
  const before = await evalSettled(CARE_COUNT)
  const pre = await evalSettled(SPOT_STATE(G))
  // Each spot's own candidates, from its own Water all's name ("Water all 97 in Bag Area" / "Water 1 in Deck").
  const want = Object.fromEntries(Object.entries(pre).map(([s, v]) => [s, Number(((v.bulk || '').match(/^Water (?:all |the other )?(\d+) in /) || [])[1] || 0)]))
  await evalSettled(`window.__h.failPosts(${c.fail})`)
  await evalSettled(`document.querySelector(${JSON.stringify(q)}).click()`)
  const ran = await evalSettled(`(async () => { for (let i = 0; i < 150; i++) { if (document.querySelector(${JSON.stringify(gq + ' [data-focus-id]')})) return true; await new Promise(r => setTimeout(r, 100)) } return false })()`)
  const unconsumed = await evalSettled('window.__h.failPosts(0)')
  if (!ran) { F(`after "Water all" with ${c.fail} failing writes the '${c.group}' group line never became its done line`); return }
  if (unconsumed) { F(`VOID — ${unconsumed} of the ${c.fail} injected failures were never consumed: the run posted fewer writes than that`); return }
  await evalSettled('new Promise(r => setTimeout(r, 150))')
  const line = await evalSettled(lineText)
  if (!new RegExp(`${reEsc(c.group)} · watered ${N - c.fail}\\b`).test(line || '')) F(`with ${c.fail} writes failing the group line reads "${line}", expected "${c.group} · watered ${N - c.fail}" (what landed)`)
  const mid = await evalSettled(SPOT_STATE(G))
  let failedTotal = 0
  const failing = []
  for (const [s, v] of Object.entries(mid)) {
    const k = v.failed ? Number((v.failed.match(/^(\d+) not logged$/) || [])[1]) : 0
    if (v.failed && !k) fail(at, 'header-text', `spot '${s}' says "${v.failed}", expected "<n> not logged"`)
    if (k) {
      failedTotal += k
      failing.push(s)
      if (v.done) fail(at, 'header-text', `spot '${s}' holds ${k} failed write(s) but shrank to a done line — failures stay on the spot (MF3)`)
      else if (v.expanded !== 'false') fail(at, 'spot-retry', `spot '${s}' holding a failure is ${v.expanded === 'true' ? 'OPEN' : 'not a closed row'} — the claim is about the closed row`)
      if (v.retry !== `Retry: ${k} not logged in ${s}`) fail(at, 'spot-retry', `spot '${s}' with ${k} not logged carries ${v.retry ? `a Retry named "${v.retry}"` : 'no Retry'}, expected "Retry: ${k} not logged in ${s}"`)
      if (v.bulk) fail(at, 'spot-retry', `spot '${s}' still offers "${v.bulk}" — its failed rows must be out of Water all (only Retry re-posts them)`)
      if (want[s] - k > 0 && !(v.text || '').includes(`Watered ${want[s] - k}`)) fail(at, 'header-text', `spot '${s}' reads "${v.text}", expected its own share "Watered ${want[s] - k}" (MF3)`)
    } else if (want[s] > 0) {
      // MF3 "each touched spot shrinks to its own done line": ITS share of the run, never the group's total.
      if (v.done) { if (!new RegExp(`${reEsc(s)} · watered ${want[s]}\\b`).test(v.text || '')) fail(at, 'group-water-all', `the '${s}' done line reads "${v.text}", expected its own share "${s} · watered ${want[s]}" (MF3)`) }
      else if (!(v.text || '').includes(`Watered ${want[s]}`)) fail(at, 'header-text', `spot '${s}' reads "${v.text}" after the group run, expected its own share "Watered ${want[s]}" (MF3)`)
    }
  }
  if (failedTotal !== c.fail) fail(at, 'header-text', `the '${c.group}' spots say ${failedTotal} "not logged" in all (${failing.join(', ') || 'none'}), expected ${c.fail} — failures stay per spot (MF3)`)
  // §5.5: a partial bulk failure puts focus on the first Retry.
  const foc = await evalSettled(`(() => { const a = document.activeElement, first = document.querySelector(${JSON.stringify(G + ` [data-testid="care-spot-retry${SUFFIX}"]`)}); return { on: !!a && !!first && a === first, what: a ? a.tagName.toLowerCase() + ' ' + (a.getAttribute('data-focus-id') || a.getAttribute('data-testid') || (a.textContent || '').trim().slice(0, 30)) : 'nothing' } })()`)
  if (!foc.on) fail(at, 'retry-focus', `after the partial failure focus is on ${foc.what}, not the first Retry (§5.5)`)
  const said = await evalSettled(STATUS_TEXT)
  if (!new RegExp(`^Watered ${N - c.fail} in ${reEsc(c.group.toLowerCase())}\\. ${c.fail} not logged in ${reEsc(c.group.toLowerCase())}: .+\\. Retry is on each\\.$`).test(said || '')) fail(at, 'announce', `after the partial failure the status region says "${said}", expected "Watered ${N - c.fail} in ${c.group.toLowerCase()}. ${c.fail} not logged in ${c.group.toLowerCase()}: <names>. Retry is on each." (§5.6)`)
  // Retry each: the failures complete THEIR run, so the group line comes back to the full N.
  for (const s of failing) {
    const sq = `${G} li[data-spot="${s.replace(/"/g, '\\"')}"] [data-testid="care-spot-retry${SUFFIX}"]`
    const tapped = await evalSettled(`(() => { const b = document.querySelector(${JSON.stringify(sq)}); if (!b) return false; b.click(); return true })()`)
    if (!tapped) { fail(at, 'spot-retry', `spot '${s}' has no Retry to tap`); continue }
    const cleared = await evalSettled(`(async () => { for (let i = 0; i < 100; i++) { if (!document.querySelector(${JSON.stringify(sq)})) return true; await new Promise(r => setTimeout(r, 100)) } return false })()`)
    if (!cleared) fail(at, 'spot-retry', `after its Retry spot '${s}' still says it has writes not logged`)
    const lost = await evalSettled('document.activeElement === document.body || document.activeElement == null')
    if (lost) fail(at, 'retry-focus', `after the '${s}' Retry focus fell to BODY (§5.5)`)
  }
  const line2 = await evalSettled(lineText)
  if (!new RegExp(`${reEsc(c.group)} · watered ${N}\\b`).test(line2 || '')) fail(at, 'spot-retry', `after every Retry the group line reads "${line2}", expected "${c.group} · watered ${N}" — a Retry completes the run it failed in (MF3)`)
  const post = await evalSettled(SPOT_STATE(G))
  for (const s of failing) {
    const v = post[s]
    if (!v) { fail(at, 'spot-retry', `after its Retry spot '${s}' left the page`); continue }
    const ok = v.done ? new RegExp(`${reEsc(s)} · watered ${want[s]}\\b`).test(v.text || '') : (v.text || '').includes(`Watered ${want[s]}`)
    if (!ok) fail(at, 'spot-retry', `after its Retry spot '${s}' reads "${v.text}", expected its whole share ${want[s]} watered`)
  }
  // The run's ONE Undo deletes every id it created, the retried ones included: the page is back where it began.
  await evalSettled(`(() => { const b = document.querySelector(${JSON.stringify(gq + ' button')}); if (b) b.click(); return 1 })()`)
  const back = await evalSettled(`(async () => { for (let i = 0; i < 150; i++) { const el = document.querySelector(${JSON.stringify(q)}); if (el && !document.querySelector(${JSON.stringify(gq)})) return el.getAttribute('aria-label'); await new Promise(r => setTimeout(r, 100)) } return null })()`)
  if (back == null) { fail(at, 'spot-retry', `the group Undo never brought '${c.group}' back to its Water all`); return }
  if (back !== name0) fail(at, 'spot-retry', `after the Undo the group button reads "${back}", it read "${name0}" before the run — the one Undo must delete every id the run created, retries included`)
  const after = await evalSettled(CARE_COUNT)
  if (after !== before) fail(at, 'header-text', `after the run, its Retries and its Undo the Needs care header counts ${after}, it counted ${before} before`)
  const stuck = Object.entries(await evalSettled(SPOT_STATE(G))).filter(([, v]) => v.failed).map(([s]) => s)
  if (stuck.length) fail(at, 'spot-retry', `after the run was undone ${stuck.join(', ')} still say "not logged" — an undone run leaves nothing to retry`)
  console.log(`[today-shape-v2] ${at}: spot-retry · "${line}" with ${c.fail} failing (${failing.map((s) => `${s} ${mid[s].failed}`).join(', ') || 'none'}) · focus ${foc.on ? 'first Retry' : foc.what} · retried → "${line2}" · Undo → "${back}", header ${after} (was ${before})`)
}

// ── budget ───────────────────────────────────────────────────────────────────────────────────────────────
let budget = null
try { budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) } catch { budget = null }
if (budget && !RECORD && (budget.viewport?.w !== VIEWPORT.w || budget.viewport?.h !== VIEWPORT.h || budget.viewport?.dpr !== VIEWPORT.dpr)) {
  console.error(`[today-shape-v2] FAIL — the v2 budget was recorded at ${budget.viewport?.w}x${budget.viewport?.h} @ DPR ${budget.viewport?.dpr}, the gate runs at ${VIEWPORT.w}x${VIEWPORT.h} @ DPR ${VIEWPORT.dpr}. Re-record or unset GATE_VIEWPORT_*.`)
  process.exit(1)
}
if (RECORD) {
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src', 'tests/harness', 'scripts/layout-gate'], { cwd: ROOT, encoding: 'utf8' })
  if (dirty.status !== 0 || dirty.stdout.trim()) { console.error(`[today-shape-v2] REFUSING TO RECORD on a dirty tree — a budget must describe committed code:\n${dirty.stdout || dirty.stderr}`); process.exit(1) }
}

// ── STEP 0: fixtures, before a browser starts ───────────────────────────────────────────────────────────────
function fixtureStep() {
  const pre = spawnSync(process.execPath, [join(ROOT, 'scripts/layout-gate/todayshape-fixture-preflight.mjs')], { cwd: ROOT, stdio: 'inherit' })
  if (pre.status !== 0) fail('fixtures', 'fixture', 'the fixture preflight refused the tracked fixtures (see above)')
  const grafts = spawnSync(process.execPath, [join(ROOT, 'tests/harness/_todaymeasure/build-v2-grafts.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' })
  if (grafts.status !== 0) fail('fixtures', 'fixture', `v2-grafts.json is stale against the fixtures + engine.js: ${(grafts.stderr || grafts.stdout).trim()}`)
  const read = f => JSON.parse(readFileSync(join(ROOT, 'tests/harness/_todaymeasure', f), 'utf8'))
  // SF5 (plan §13): the grouping S4 builds on must yield exactly Outside / Stable / House over the busy plan's rows.
  try {
    const plan = read('dailyplan.dave.json').plan
    const g = groupsOfRows([...plan.water_due, ...plan.fertilize, ...plan.pest], read('plants.json'), read('locations.full.json'))
    const got = Object.keys(g).sort(), want = [...EXPECTED_GROUPS].sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) fail('fixtures', 'fixture', `SF5: locations.full.json groups the busy care rows into [${got.join(', ')}], expected exactly [${want.join(', ')}] — S4's three groups rest on this`)
    else console.log(`[today-shape-v2] SF5: busy care rows group into ${Object.entries(g).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  } catch (e) { fail('fixtures', 'fixture', `SF5 could not be evaluated: ${e.message}`) }
  for (const s of STATES) {
    try { read(s.prefs) } catch (e) { fail('fixtures', 'fixture', `${s.name}: prefs fixture ${s.prefs} unreadable (${e.message})`) }
    for (const c of s.checks) if (!CHECKERS[c.family]) fail('fixtures', 'crash', `${s.name}: the contract names family '${c.family}', which this gate has no checker for — it would read as passed`)
  }
}

let harness, chrome
const udd = mkdtempSync(join(tmpdir(), 'gate-todayshape-v2-'))
const recorded = {}
let armedCount = 0
let pinned = null
try {
  fixtureStep()
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[today-shape-v2] --probe-nothing: every v2 anchor points at a testid nothing renders and every check is armed. This run MUST fail.')
  if (SELF_TEST) console.log('[today-shape-v2] --self-test: every check armed against tests/harness/stubs/TodayV2Stub.jsx (data-today-version="2", empty). The census MUST red on every state; the instrument must hold.')
  if (HARNESS_CONFIG !== 'tests/harness/vite.harness.v2.mjs') console.log(`[today-shape-v2] harness config: ${HARNESS_CONFIG}`)
  console.log(`[today-shape-v2] LANDED ${LANDED.join(', ')} · FIRST_SCREEN ${FIRST_SCREEN}px = ${VIEWPORT.h} − ${CHROME_CONST.barH} TopChrome − ${CHROME_CONST.bottomNav} BottomNav · ${RUN_STATES.length} state(s)`)

  for (const state of RUN_STATES) {
    const at = `${state.name}@${VIEWPORT.w}x${VIEWPORT.h}`
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: VIEWPORT.dpr, mobile: true }, cdp.sessionId)
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }, cdp.sessionId)
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }, cdp.sessionId)
    const url = `http://localhost:${PORT}/tests/harness/todaymeasure.html?state=${state.name}&v2=1&badge=0&clock=${encodeURIComponent(state.clock)}${SELF_TEST ? '&v2stub=1' : ''}`
    const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
    await sleep(200)
    try { await evalSettled(`(async()=>{for(let i=0;i<250;i++){if(window.__h&&window.__h.v2ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('the page never became ready')})()`) }
    catch (e) { fail(at, 'void', `VOID — ${e.message}`); continue }
    const topsAtReady = await evalSettled(TOPS)
    await evalSettled(`new Promise(r=>setTimeout(r,2500))`)
    const topsSettled = await evalSettled(TOPS)
    const m = await evalSettled(MEASURE)
    const v2 = m.harness.v2

    // ── (a) INSTRUMENT — armed from S0 on every state. Each is a way this file could print PASS over nothing.
    if (m.vw !== VIEWPORT.w || m.vh !== VIEWPORT.h) {
      // S5 + S6 (one implementation since integration 2): a page WIDER than the phone is not emulation failing. With the
      // emulated screen at the phone's width, the page's own horizontal overflow makes mobile Chrome grow the layout
      // viewport to fit it — S5 measured a zoomed-out self-report of 477x935 (the chip strip at overflow-x visible with
      // Protect's chip), S6 an innerWidth of 465 with the visual viewport still 426 (with Harvest's chip). That is the
      // defect no-hscroll exists for, so it is filed there, and the state's other checks are skipped, as for a VOID,
      // since every later number would be read off the wider layout. A screen that is not the phone's is still a VOID.
      if (m.screenW === VIEWPORT.w && m.vw > VIEWPORT.w && m.scrollWidth > VIEWPORT.w) { fail(at, 'no-hscroll', `the page is ${m.scrollWidth}px wide on the ${VIEWPORT.w}px phone: its content pushed the layout viewport to ${m.vw}x${m.vh} (emulation in force: screen.width ${m.screenW}, visual viewport ${m.vvW}px at scale ${m.vvScale}) — something overflows sideways`); continue }
      fail(at, 'void', `VOID — page self-reports ${m.vw}x${m.vh} (screen.width ${m.screenW}, visual viewport ${m.vvW}px); emulation did not take, so every number here is from the wrong layout (never --window-size)`); continue
    }
    if (m.harness.error) fail(at, 'instrument', `the page raised "${m.harness.error}" while mounting`)
    if (!v2?.requested || v2.problem) fail(at, 'instrument', `the V2 seam did not engage: ${v2?.problem || 'v2 not requested'}`)
    if (v2.flag !== '1') fail(at, 'instrument', `localStorage garden.todayV2 is ${JSON.stringify(v2.flag)}, expected "1" (seam a)`)
    if (!v2.critterOrigin) fail(at, 'instrument', 'VITE_API_CRITTERS is not defined — the harness is not on vite.harness.v2.mjs, so the prefs GET can never go out')
    if (!m.harness.clock.pinned) fail(at, 'instrument', `the clock is NOT pinned (${m.harness.clock.now})`)
    else if (m.harness.clock.iso !== state.clock) fail(at, 'instrument', `the clock is pinned to ${m.harness.clock.iso}, the contract says ${state.clock}`)
    if (m.harness.clock.tz !== 'America/New_York') fail(at, 'instrument', `page timezone is ${m.harness.clock.tz}, expected America/New_York`)
    const pin = m.harness.fontPin
    if (!pin || !pin.ok) fail(at, 'instrument', `the Roboto pin is NOT in force (${pin ? `${pin.faces} face(s), ${pin.failed.length} failed` : 'window.__fontPin missing'})`)
    else pinned = pin.source
    if (budget?.font && pin?.ok && pin.source !== budget.font) fail(at, 'instrument', `the harness pins ${pin.source}, the v2 budget was recorded in ${budget.font} — re-record, never compare across fonts`)
    if (!m.harness.weatherStubbed) fail(at, 'instrument', 'Open-Meteo was NOT stubbed')
    for (const p of m.harness.liveRequests || []) fail(at, 'instrument', `a third-party request ESCAPED the harness to the live network — ${p}`)
    for (const f of m.harness.fixtures.filter(f => !f.ok || f.bytes === 0)) fail(at, 'fixture', `fixture ${f.name} is unusable (${f.why || 'zero bytes'})`)
    for (const need of ['v2-grafts.json', 'locations.full.json', state.prefs]) if (!m.harness.fixtures.some(f => f.name === need && f.ok)) fail(at, 'fixture', `fixture ${need} was not loaded — the state is not the one the contract names`)
    const wantSeeds = 1 + (state.local?.todaySeen ? 1 : 0) + (state.local?.mirror ? 1 : 0) + (state.local?.showOthers ? 1 : 0)
    if ((v2.seeds || []).length !== wantSeeds) fail(at, 'instrument', `${(v2.seeds || []).length} device seed(s) written (${(v2.seeds || []).join(', ')}), the contract asks for ${wantSeeds}`)
    if (state.redate && v2.planDate !== state.redate) fail(at, 'instrument', `the plan is dated ${v2.planDate}, the contract re-dates it to ${state.redate}`)
    if (SELF_TEST && v2.route !== 'stub') fail(at, 'instrument', `--self-test expected the stub V2 mounted, got route '${v2.route}'`)

    // ── the contract's checks: ARMED ones run, PENDING ones are listed.
    const armed = state.checks.filter(c => isArmed(c, LANDED, ARM_ALL))
    const pend = state.checks.filter(c => !isArmed(c, LANDED, ARM_ALL))
    armedCount += armed.length
    for (const c of pend) pending.push({ state: state.name, family: c.family, armedAt: c.armedAt })
    const ctx = { state, budget, topsAtReady, topsSettled }
    for (const c of armed) {
      const F = (msg) => fail(at, c.family, msg)
      try { CHECKERS[c.family](m, c, F, ctx) } catch (e) { fail(at, 'crash', `checker '${c.family}' threw: ${e.message}`) }
    }
    // In INTERACTION_FAMILIES order: group-water-all WRITES (then undoes), so it runs last.
    await runInteractions(state, armed.filter(c => INTERACTION_FAMILIES.includes(c.family)).sort((a, b) => INTERACTION_FAMILIES.indexOf(a.family) - INTERACTION_FAMILIES.indexOf(b.family)), at)

    // font census (the pin painting the page), as v1 does
    const census = await fontCensus(cdp, '#root')
    if (!census.glyphs && v2.route !== 'stub') fail(at, 'instrument', 'the font census read no glyphs under #root')
    // S4: FilterChipRow (a frozen primitive) labels its tray toggle "More ▾" / "Less ▴" — mixed text, so the
    // census's whole-text allowance cannot see that only the arrow falls to a host font. That one arrow, on that
    // one 48px-min chip, is let through here; any other host glyph still fails.
    // S4g MEASURED it as font-census.mjs asks (scripts/layout-gate/tray-arrow-measure.mjs; 2026-09-29, Chrome 154,
    // 426x836 @3, Roboto pin; v2-busy + v2-frost, the spot row collapsed, with a spot selected, and expanded): the
    // arrow is host-painted (.SF NS on the Mac); swapped for Roboto 'v' / '^' only the toggle's OWN width moves
    // (66.05 → 66.41 px; 63.13 → 62.59 px) — and a Clear sharing its line, by the same 0.53 px. Every other chip,
    // the row's height, the task row, Needs care, every spot row, the page height and the last ink are identical,
    // and the toggle's line keeps ≥ 57 px of slack. Recorded, not gated: with a spot selected, Clear wraps to a
    // second line by 0.45 px, so another host's arrow width (CI's DejaVu Sans) could flip that wrap — no check
    // measures geometry with a spot selected. Re-run the measurement if the toggle or the spot row changes.
    const TRAY = /painted 1 glyph\(s\) of "(More ▾|Less ▴)"$/
    for (const v of census.violations.filter(x => !TRAY.test(x)).slice(0, 3)) fail(at, 'instrument', `a HOST font painted text the Roboto pin should own — ${v}`)

    console.log(`[today-shape-v2] ${at}: route ${v2.route} · ${armed.length} armed / ${pend.length} PENDING check(s) · prefs GET ×${m.harness.prefsGets} (${v2.prefs.fixture}${v2.prefs.delayMs ? `, +${v2.prefs.delayMs}ms` : ''}) · seeds ${v2.seeds.join(', ')} · plan ${v2.planDate}${v2.grafts.length ? ` · grafts ${v2.grafts.join('+')}` : ''} · ${m.scrollHeight}px, content ends y=${m.contentBottom}, ${m.controls} controls · sections [${m.sections.map(s => `${s.key}:${s.header?.expanded ?? '?'}`).join(' ')}]`)
    if (isArmed({ armedAt: 'S2' }, LANDED, false) && !SELF_TEST && !PROBE_NOTHING) recorded[state.name] = {
      clock: state.clock,
      contentBottomFloor: Math.round(m.contentBottom * 0.99),
      contentBottomCeiling: Math.round(m.contentBottom * 1.02),
      controlsFloor: m.controls > 0 ? Math.max(1, m.controls - 2) : 0,
      scrollHeightCeiling: Math.round(m.scrollHeight * 1.02),
      measured: { scrollHeight: m.scrollHeight, contentBottom: m.contentBottom, controls: m.controls },
      // S6: each owner-floors owner, as opened this run.
      ...(ownerRecord[state.name] ? { owners: Object.fromEntries(Object.entries(ownerRecord[state.name]).map(([k, h]) => [k, { floor: Math.round(h * 0.99), measured: h }])) } : {}),
    }
  }
  if (!failures.length || PROBE_NOTHING || SELF_TEST) console.log(`[today-shape-v2] font: ${pinned ?? 'NO PIN'} · ${chrome.version.Browser} · probe widths ${JSON.stringify(await fontProbe(cdp.evalIn))}`)
} catch (e) {
  fail('gate', 'crash', `gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

// ── PENDING, printed loudly and counted — never passed.
const byState = {}
for (const p of pending) (byState[p.state] ||= []).push(`${p.family}@${[].concat(p.armedAt).join('+')}`)
if (pending.length) {
  console.log(`\n[today-shape-v2] PENDING — ${pending.length} check(s) across ${Object.keys(byState).length} state(s) are NOT MEASURED and NOT PASSED (their slices have not landed):`)
  for (const [s, list] of Object.entries(byState)) console.log(`  ⏸ ${s}: ${list.join(', ')}`)
}

if (RECORD) {
  if (failures.length) { console.error('[today-shape-v2] REFUSING TO RECORD — the run had failures:'); for (const f of failures) console.error('  · ' + f.line); process.exit(1) }
  if (!Object.keys(recorded).length) { console.log('[today-shape-v2] nothing to record: no state has an armed floors check yet (it arms with S2). No budget written.'); process.exit(0) }
  writeFileSync(BUDGET_PATH, JSON.stringify({ _: 'GENERATED by scripts/layout-gate/today-shape-v2.mjs --record on a clean tree. Floors and ceilings for the ARMED v2 states; viewport-, instant- and font-specific.', recordedAt: new Date().toISOString(), viewport: VIEWPORT, font: pinned, chrome: CHROME_CONST, landed: LANDED, states: recorded }, null, 2) + '\n')
  console.log(`[today-shape-v2] recorded ${Object.keys(recorded).length} state(s) to ${BUDGET_PATH}`)
  process.exit(0)
}

if (SELF_TEST) {
  // PASS iff every state went red on the CENSUS and nothing says the rig itself failed.
  const inst = failures.filter(f => INSTRUMENT.has(f.family))
  const censusByState = {}
  for (const f of failures) if (!INSTRUMENT.has(f.family)) (censusByState[f.at.split('@')[0]] ||= new Set()).add(f.family)
  const survivors = RUN_STATES.map(s => s.name).filter(n => !censusByState[n]?.size)
  console.log(`\n[today-shape-v2] self-test: ${failures.length - inst.length} census failure(s) across ${Object.keys(censusByState).length}/${RUN_STATES.length} state(s); families hit: ${[...new Set(failures.filter(f => !INSTRUMENT.has(f.family)).map(f => f.family))].join(', ')}`)
  for (const [s, fams] of Object.entries(censusByState)) console.log(`  ✗ ${s}: ${[...fams].join(', ')}`)
  if (inst.length || survivors.length) {
    console.error('[today-shape-v2] SELF-TEST FAIL —' + (survivors.length ? ` the census did NOT red on ${survivors.join(', ')} (an empty V2 passed there: the contract cannot fail on that state);` : '') + (inst.length ? ` ${inst.length} instrument failure(s) — the red is not the census's:` : ''))
    for (const f of inst) console.error('  · ' + f.line)
    process.exit(1)
  }
  console.log('[today-shape-v2] SELF-TEST PASS — an empty V2 (data-today-version="2", nothing else) reds the contract on every state, and the instrument held on every state.')
  process.exit(0)
}

if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[today-shape-v2] FAIL — EXPECTED. --probe-nothing pointed every v2 anchor at a testid nothing renders and armed every check; the census caught it. Exit 1 is the correct outcome for this arm.'
    : '\n[today-shape-v2] FAIL')
  for (const f of failures) console.error('  · ' + f.line)
  process.exit(1)
}
if (PROBE_NOTHING) { console.error('\n[today-shape-v2] FAIL — and this one is the real defect: every v2 anchor pointed at nothing and the gate found nothing to complain about.'); process.exit(1) }
console.log(`\n[today-shape-v2] PASS — ${armedCount} armed check(s) green over ${RUN_STATES.length} state(s) plus the instrument on every state; ${pending.length} PENDING (listed above: not measured, not passed).`)
process.exit(0)
