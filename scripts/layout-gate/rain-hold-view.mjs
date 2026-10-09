#!/usr/bin/env node
// rain-hold-view.mjs — BUG-DEFERNOSTRESSOVERRIDE-001 (Design A): the Today V2 weather card's "Waiting for rain"
// list, driven in real Chrome at Dave's 426×836 (DPR 3), with a PNG per step.
//
//   node scripts/layout-gate/rain-hold-view.mjs --shots <dir>
//
// NOT WIRED INTO CI (no package.json script, no workflow step): a tool a lane runs by hand, on the pattern of
// putup-refusal-view.mjs. It ends through exit-watchdog.mjs like every gate here.
//
// WHAT IT DRIVES: the gate's own harness page (tests/harness/todaymeasure.html?v2=1) in the gate's own
// `v2-bedwait` state — Dave's 2026-09-24 plan with 17 in-ground rows moved to rain_skipped in the engine's item
// shape (build-v2-grafts.mjs). The page is not edited: a script installed before it loads trims the forecast-held
// rows of the plan answer to the count a scenario names (`n`), wrapping whatever fetch the harness installs.
// Every tap is CDP Input.dispatchMouseEvent at the control's own centre; a tap whose point is not painted by
// its target fails the run.
//
// WHAT IT CHECKS, beside the pictures:
//   · closed card: its box is the same with 17 held as with none, and it holds no waiting row;
//   · 3 waiting: the list shows itself, 3 rows, each ≥ 48 px with a ≥ 48 px Water and no other control, none of
//     them inside the card's toggle button; nothing overflows the viewport sideways;
//   · 9 waiting: collapsed behind a ≥ 48 px Show; Show draws 9 rows;
//   · Water on a row: one POST /api/events (watering), the row is its done line with Undo, the count drops;
//   · a failed write: "Not logged" + Retry on the row, the count stays.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'
import { armExitWatchdog } from './exit-watchdog.mjs'
import { stateByName } from '../../tests/harness/_todaymeasure/today-v2-contract.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5367)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9477)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const SHOTS = arg('--shots')
const VW = 426, VH = 836
const STATE = stateByName('v2-bedwait')
const failures = []
const fail = (m) => failures.push(m)

async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — set GATE_HARNESS_PORT / GATE_CDP_PORT to free ports`)
}
async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  proc.stdout.on('data', (d) => { log += d }); proc.stderr.on('data', (d) => { log += d })
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/tests/harness/todaymeasure.html`); if (r.ok) return proc } catch { /* not listening yet */ }
    if (proc.exitCode != null) throw new Error(`harness vite exited (${proc.exitCode}):\n${log}`)
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`harness vite never served :${PORT} within 30s:\n${log}`)
}
async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  await assertPortFree(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP')
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { stdio: ['ignore', 'ignore', 'ignore'] })
  for (let i = 0; i < 240; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT}`)
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return { proc, version: await r.json() } } catch { /* not listening yet */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT}`)
}
async function attach(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) { const { res, rej, timer } = pending.get(m.id); pending.delete(m.id); clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
  }
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
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn }
}

// Installed before the page's own scripts: whatever fetch the harness installs is wrapped, and the plan answer's
// forecast-held rows are cut to window.__rainHoldN (the rows rain covered, and everything else, pass untouched).
// Also counts the event writes at the wire, body kept.
const TRIM = `(() => {
  const KINDS = new Set(['today', 'incoming_dry', 'soon'])
  let real = window.fetch.bind(window)
  window.__rainPosts = []
  const wrapped = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const path = new URL(url, location.href).pathname
    if (path === '/api/events' && String(init.method || 'GET').toUpperCase() === 'POST') { try { window.__rainPosts.push(JSON.parse(init.body)) } catch { window.__rainPosts.push(null) } }
    const res = await real(input, init)
    const n = Number(new URLSearchParams(location.search).get('rainHold'))
    if (path !== '/api/daily-plan' || !Number.isFinite(n) || !res.ok) return res
    const body = await res.clone().json()
    if (!body || !body.plan || !Array.isArray(body.plan.rain_skipped)) return res
    let kept = 0
    body.plan.rain_skipped = body.plan.rain_skipped.filter((it) => !(it && KINDS.has(it.sat_kind)) || kept++ < n)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  Object.defineProperty(window, 'fetch', { configurable: true, get: () => wrapped, set: (f) => { real = f } })
})()`

const Q = (s) => JSON.stringify(s)
async function point(cdp, selector) {
  const p = await cdp.evalIn(`(() => {
    const el = document.querySelector(${Q(selector)})
    if (!el) return { missing: true }
    const r0 = el.getBoundingClientRect()
    if (r0.top < 60 || r0.bottom > innerHeight - 70) el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return { x, y, hit: !!top && (top === el || el.contains(top)) }
  })()`)
  if (p.missing) throw new Error(`no ${selector} on the page`)
  if (!p.hit) throw new Error(`${selector} is not what is painted at its own centre (${Math.round(p.x)},${Math.round(p.y)})`)
  return p
}
async function tap(cdp, selector) {
  const p = await point(cdp, selector)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  await sleep(450)
}
async function shot(cdp, name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId)
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
}
async function open(cdp, n) {
  const url = `http://localhost:${PORT}/tests/harness/todaymeasure.html?state=${STATE.name}&v2=1&badge=0&clock=${encodeURIComponent(STATE.clock)}&rainHold=${n}`
  const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
  if (nav.errorText) throw new Error(`navigate: ${nav.errorText}`)
  await cdp.evalIn(`(async()=>{for(let i=0;i<300;i++){if(window.__h&&window.__h.v2ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('the harness never became ready: '+(window.__h&&window.__h.error&&window.__h.error()))})()`)
  await sleep(300)
}
// What is drawn: the card, the lines, the rows and their controls.
const READ = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(2), left: +r.left.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2), right: +r.right.toFixed(2) } }
  const card = document.querySelector('[data-testid="today-glance"]')
  const toggle = card && card.querySelector('h2 > button[aria-expanded]')
  const note = document.querySelector('[data-testid="care-rain-note"]')
  const rows = [...document.querySelectorAll('[data-testid="rain-wait-row"]')]
  const show = document.querySelector('[data-testid="rain-waiting-toggle"]')
  return {
    open: toggle ? toggle.getAttribute('aria-expanded') : null,
    card: box(card), cardHtmlLen: card ? card.outerHTML.length : 0,
    line: document.querySelector('[data-testid="rain-waiting-line"]')?.textContent ?? null,
    covered: document.querySelector('[data-testid="rain-covered-line"]')?.textContent ?? null,
    show: show ? { text: show.textContent, expanded: show.getAttribute('aria-expanded'), box: box(show) } : null,
    rows: rows.map((r) => ({ box: box(r), text: r.textContent, inToggle: !!(toggle && toggle.contains(r)), inButton: !!r.closest('button'), buttons: [...r.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label'), text: b.textContent, box: box(b) })) })),
    done: [...(note ? note.querySelectorAll('[data-testid="care-row-done"]') : [])].map((d) => ({ text: d.textContent, box: box(d), undo: box(d.querySelector('button')) })),
    posts: (window.__rainPosts || []).map((b) => b && { event_type: b.event_type, plant_id: b.plant_id, metadata: b.metadata }),
    scrollW: document.documentElement.scrollWidth, vw: innerWidth,
    status: document.querySelector('[data-testid="today-status"]')?.textContent ?? null,
  }
})()`

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-rainhold-'))
const t0 = Date.now()
const results = {}
try {
  if (!STATE) throw new Error('the contract has no v2-bedwait state')
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 3, mobile: true }, cdp.sessionId)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: TRIM }, cdp.sessionId)
  const GL = '[data-testid="today-glance"] h2 > button[aria-expanded]'
  const fresh = async (n) => { await cdp.send('Network.clearBrowserCookies', {}, cdp.sessionId).catch(() => {}); await cdp.evalIn(`(() => { try { localStorage.clear(); sessionStorage.clear() } catch {} })()`).catch(() => {}); await open(cdp, n) }

  // ── closed card: 17 held vs none ──
  await fresh(17)
  const closed17 = await cdp.evalIn(READ)
  await shot(cdp, '0-closed-17-waiting')
  await fresh(0)
  const closed0 = await cdp.evalIn(READ)
  await shot(cdp, '0-closed-0-waiting')
  results.closed = { with17: closed17.card, with0: closed0.card, html17: closed17.cardHtmlLen, html0: closed0.cardHtmlLen }
  if (closed17.open !== 'false' || closed0.open !== 'false') fail(`the card did not start closed (${closed17.open}, ${closed0.open})`)
  if (JSON.stringify(closed17.card) !== JSON.stringify(closed0.card)) fail(`the CLOSED card's box differs with held plantings: ${JSON.stringify(closed17.card)} vs ${JSON.stringify(closed0.card)}`)
  if (closed17.cardHtmlLen !== closed0.cardHtmlLen) fail(`the CLOSED card's markup differs with held plantings (${closed17.cardHtmlLen} vs ${closed0.cardHtmlLen} chars)`)
  if (closed17.rows.length || closed17.line) fail('the closed card draws the waiting list')

  // ── open, 3 waiting ──
  await fresh(3)
  await tap(cdp, GL)
  let m = await cdp.evalIn(READ)
  results.open3 = m
  await cdp.evalIn(`document.querySelector('[data-testid="rain-waiting"]').scrollIntoView({ block: 'center' })`); await sleep(200)
  await shot(cdp, '1-open-3-waiting')
  if (m.open !== 'true') fail('the card did not open')
  if (m.line !== 'Waiting for rain · 3') fail(`line reads ${Q(m.line)}`)
  if (!m.show || m.show.text !== 'Hide') fail(`3 waiting did not show itself (toggle ${Q(m.show?.text)})`)
  if (m.rows.length !== 3) fail(`${m.rows.length} waiting rows drawn, expected 3`)
  for (const r of m.rows) {
    if (r.box.height < 48) fail(`a waiting row is ${r.box.height}px tall (< 48)`)
    if (r.inToggle || r.inButton) fail('a waiting row sits inside a button')
    if (r.buttons.length !== 1 || !/^Log Water for /.test(r.buttons[0].label || '')) fail(`a waiting row's controls: ${JSON.stringify(r.buttons.map((b) => b.label))}`)
    else if (r.buttons[0].box.height < 48 || r.buttons[0].box.width < 48) fail(`a Water chip is ${r.buttons[0].box.width}×${r.buttons[0].box.height}`)
    if (!/Rain expected tomorrow · 0\.62 in/.test(r.text)) fail(`row reason: ${Q(r.text)}`)
    if (/@|%|Skip/.test(r.text)) fail(`row prints the engine's sentence: ${Q(r.text)}`)
    if (r.box.right > VW + 0.5) fail('a waiting row overflows the viewport')
  }
  if (m.show && (m.show.box.height < 48 || m.show.box.width < 48)) fail(`Hide is ${m.show.box.width}×${m.show.box.height}`)
  if (m.scrollW > m.vw) fail(`the page scrolls sideways (${m.scrollW} > ${m.vw})`)

  // ── Water on the first row ──
  await tap(cdp, '[data-testid="rain-wait-row"] button[aria-label^="Log Water for "]')
  await sleep(400)
  m = await cdp.evalIn(READ)
  results.afterWater = m
  await cdp.evalIn(`document.querySelector('[data-testid="rain-waiting"]').scrollIntoView({ block: 'center' })`); await sleep(200)
  await shot(cdp, '3-after-water-tap')
  if (m.posts.length !== 1 || m.posts[0]?.event_type !== 'watering') fail(`after one Water tap the wire saw ${JSON.stringify(m.posts)}`)
  if (m.done.length !== 1 || !/ · watered$/.test(m.done[0].text.replace(/Undo$/, ''))) fail(`done line: ${JSON.stringify(m.done.map((d) => d.text))}`)
  else { if (m.done[0].box.height < 48) fail(`the done line is ${m.done[0].box.height}px`); if (!m.done[0].undo) fail('the done line has no Undo') }
  if (m.line !== 'Waiting for rain · 2' || m.rows.length !== 2) fail(`after Water: ${Q(m.line)}, ${m.rows.length} rows`)

  // ── a write that fails ──
  await cdp.evalIn(`window.__h.failPosts(1)`)
  await tap(cdp, '[data-testid="rain-wait-row"] button[aria-label^="Log Water for "]')
  await sleep(500)
  m = await cdp.evalIn(READ)
  results.afterFail = m
  await cdp.evalIn(`document.querySelector('[data-testid="rain-waiting"]').scrollIntoView({ block: 'center' })`); await sleep(200)
  await shot(cdp, '4-after-failed-write')
  const failedRow = m.rows.find((r) => /Not logged/.test(r.text))
  if (!failedRow) fail(`no row says "Not logged" after a failed write: ${JSON.stringify(m.rows.map((r) => r.text))}`)
  else if (failedRow.buttons.length !== 1 || !/^Retry: /.test(failedRow.buttons[0].label || '')) fail(`the failed row's controls: ${JSON.stringify(failedRow.buttons.map((b) => b.label))}`)
  if (m.line !== 'Waiting for rain · 2') fail(`after a failed write the line reads ${Q(m.line)}`)
  if (m.done.length !== 1) fail('the failed write left a done line')

  // ── 9 waiting: collapsed, then shown ──
  await fresh(9)
  await tap(cdp, GL)
  m = await cdp.evalIn(READ)
  results.open9 = m
  await cdp.evalIn(`document.querySelector('[data-testid="rain-waiting"]').scrollIntoView({ block: 'center' })`); await sleep(200)
  await shot(cdp, '2-open-9-waiting-collapsed')
  if (m.line !== 'Waiting for rain · 9') fail(`line reads ${Q(m.line)}`)
  if (!m.show || m.show.text !== 'Show' || m.show.expanded !== 'false') fail(`9 waiting is not collapsed behind Show (${JSON.stringify(m.show)})`)
  else if (m.show.box.height < 48 || m.show.box.width < 48) fail(`Show is ${m.show.box.width}×${m.show.box.height}`)
  if (m.rows.length) fail(`${m.rows.length} rows drawn while collapsed`)
  await tap(cdp, '[data-testid="rain-waiting-toggle"]')
  m = await cdp.evalIn(READ)
  results.open9shown = { rows: m.rows.length, show: m.show }
  await shot(cdp, '2b-open-9-waiting-shown')
  if (m.rows.length !== 9) fail(`Show drew ${m.rows.length} rows, expected 9`)

  if (SHOTS) writeFileSync(join(SHOTS, 'measurements.json'), JSON.stringify(results, null, 2))
  console.log(`[rain-hold] closed card ${JSON.stringify(results.closed.with17)} with 17 held = with none · open/3: rows ${results.open3.rows.map((r) => r.box.height).join(', ')}px, Water ${results.open3.rows.map((r) => r.buttons[0]?.box.width + '×' + r.buttons[0]?.box.height).join(', ')}, toggle ${results.open3.show?.box.width}×${results.open3.show?.box.height}`)
} catch (e) {
  fail(`could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (failures.length) {
  console.error('\n[rain-hold] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log(`[rain-hold] PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
armExitWatchdog()
