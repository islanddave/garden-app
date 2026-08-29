#!/usr/bin/env node
// inventory-list-shot.mjs — HG-4.2. Renders the redesigned Inventory LIST in real Chrome at
// phone geometry, asserts what the vitest lock cannot, and writes a PNG.
//
//   node scripts/layout-gate/inventory-list-shot.mjs [--out path.png]
//
// ASSERTS, at a TRUE 390x844 with a real layout engine:
//   (a) every control the redesign owns is >=44x44 AS RENDERED — not merely authored that way;
//   (b) every control hit-tests to itself and sits inside the viewport;
//   (c) no row wraps or overflows to the right at the fixture's worst-case 44-char name;
//   (d) the document does not scroll sideways;
//   (e) the page raised no error while mounting.
//
// TWO MEASUREMENT TRAPS THIS AVOIDS (both produce a confident wrong answer):
//   1. macOS Chrome floors an OS window at ~500px wide, so `--window-size=390` lays the page out
//      at ~500 and CROPS the capture to 390 — a plausible-looking mobile screenshot of a
//      desktop-width layout. Geometry here comes from Emulation.setDeviceMetricsOverride, and the
//      run REFUSES TO PASS unless the page self-reports innerWidth 390. An instrument that cannot
//      prove its own viewport fails closed.
//   2. The in-app browser preview reports visibilityState 'hidden', so requestAnimationFrame never
//      fires and ResizeObserver is throttled — a React page can sit half-mounted forever there.
//      --disable-renderer-backgrounding (plus the sibling flags) is why this runs headless Chrome
//      directly rather than through that pane.
//
// NON-VACUITY. A gate that measures zero controls passes for the wrong reason, which is the exact
// failure mode this directory exists to refuse. The run fails if the fixture does not yield its
// full set of rows, sections and controls before anything is asserted about them.
//
// TRANSPORT. resolveWebSocket(), not a bare global: CI pins node 20.19.0, which has no global
// WebSocket — see cdp-socket.mjs for the measurement that established this.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5313)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9424)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI needs --no-sandbox and resolves CHROME_PATH in its own step.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)

// Dave is Android-only; 390x844 is the common Android logical viewport and the geometry the
// sibling gates in this directory already measure at.
const VIEWPORT = { w: 390, h: 844 }
const TAP_FLOOR = 44                 // SC 2.5.8 design target, = T.tapMinHeight
const EXPECT = { rows: 8, sections: 6, controls: 12 }   // what the harness fixture must yield

// REPO-RELATIVE default, not the authoring machine's scratch dir. The old default was an absolute
// /Users/davenichols/... path; on a Linux runner /Users does not exist and cannot be created at /,
// so the mkdirSync below threw INSIDE the try and became fail('gate could not complete') -> exit 1
// AFTER the Vite boot, the Chrome launch and every tap-target assertion had already passed. A gate
// that reds on where it writes its by-product, having found nothing wrong, is worse than no gate.
const outArg = process.argv.indexOf('--out')
const OUT = outArg > -1 ? process.argv[outArg + 1]
  : resolve(ROOT, 'artifacts/layout-gate/inventory-list-390x844.png')

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
      const r = await fetch(`http://localhost:${PORT}/tests/harness/inventory.html`)
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
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation below,
    // so the window only has to be big enough not to clip it. See trap 1 in the header.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return { proc, version: await r.json() }
    } catch { /* not listening yet */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT} within 15s`)
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

const failures = []
const fail = m => failures.push(m)

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'inventory-shot-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  // THE VIEWPORT, imposed by devtools emulation rather than by the OS window (header trap 1).
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 2, mobile: true,
  }, cdp.sessionId)

  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/inventory.html` }, cdp.sessionId)
  await cdp.evalIn(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('inventory list never rendered a row')})()`)
  await cdp.evalIn(`new Promise(r=>setTimeout(r,600))`)   // let the verdict strip settle

  const m = await cdp.evalIn(`({
    vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth,
    err: window.__h.error(), taps: window.__h.tapTargets(), rows: window.__h.rows(),
    sections: window.__h.sections(), sideways: window.__h.docOverflows(),
    header: window.__h.header(),
  })`)

  // ── Instrument first: an unproven viewport voids every number below it ──
  if (m.vw !== VIEWPORT.w) fail(`page reports innerWidth ${m.vw}, expected ${VIEWPORT.w} — emulation did not take, measurement void`)
  if (m.err) fail(`the page raised an error while mounting: ${m.err}`)

  // ── Non-vacuity: assert the fixture actually produced something to measure ──
  if (m.rows.length !== EXPECT.rows) fail(`${m.rows.length} rows rendered, expected ${EXPECT.rows} — the fixture did not fully mount`)
  if (m.sections.length !== EXPECT.sections) fail(`${m.sections.length} sections rendered, expected ${EXPECT.sections}`)
  if (m.taps.length < EXPECT.controls) fail(`only ${m.taps.length} controls found, expected >=${EXPECT.controls} — "all targets pass" would be true of almost nothing`)

  console.log(`[inventory-list-shot] ${m.vw}x${m.vh} (page self-reports) · ${m.rows.length} rows in ${m.sections.length} sections: ${m.sections.join(' > ')}`)

  // ── (a)/(b) tap targets, AS RENDERED ──
  for (const t of m.taps) {
    if (t.h < TAP_FLOOR || t.w < TAP_FLOOR) fail(`"${t.id}" renders ${t.w}x${t.h}, under the ${TAP_FLOOR}px floor`)
    if (!t.visible) fail(`"${t.id}": checkVisibility() false`)
    // null = the harness never got it into the viewport to probe. Distinct from false, and
    // treated as a gate failure rather than a pass: "not measured" is not "not occluded".
    if (t.hitIsSelf === null) fail(`"${t.id}": never entered the viewport, so occlusion was never probed`)
    else if (!t.hitIsSelf) fail(`"${t.id}": elementFromPoint at its centre is not the control — occluded`)
    if (!t.fits) fail(`"${t.id}" sits outside the ${VIEWPORT.w}px viewport — unreachable`)
  }
  const minTap = Math.min(...m.taps.map(t => Math.min(t.w, t.h)))
  const probed = m.taps.filter(t => t.hitIsSelf !== null).length
  console.log(`[inventory-list-shot] ${m.taps.length} controls measured, smallest side ${minTap}px (floor ${TAP_FLOOR}px), ${probed}/${m.taps.length} hit-tested to themselves`)

  // ── (c)/(d) the row holds together at 390 ──
  for (const r of m.rows) {
    if (r.overflowsRight) fail(`row "${r.name}" overflows the right edge`)
    if (r.wrapped) fail(`row "${r.name}" is ${r.h}px tall — the meta line has wrapped`)
    if (!r.coin) fail(`row "${r.name}" has no category coin`)
  }
  if (m.sideways) fail(`document scrollWidth ${m.scrollW} > ${m.vw} — the page scrolls sideways`)
  const badged = m.rows.filter(r => r.badge)
  console.log(`[inventory-list-shot] row heights ${m.rows.map(r => r.h).join('/')}px · coins ${m.rows[0].coin}px · low-stock badges: ${badged.map(b => b.badge).join(', ') || 'none'}`)

  // Reported, NOT asserted. The header's action group wraps to 2 lines at 390px because the h1
  // plus three actions are wider than the column; that is a pre-existing layout call, not a
  // regression from the tap-target change, and pinning a number here would freeze a design
  // decision this lane did not make. Printed so the next session sees it without re-measuring.
  const H = m.header
  console.log(`[inventory-list-shot] header: h1 ${H.h1Width}px + actions ${H.totalActionWidth}px vs ${H.availableWidth}px available -> ${H.actionLines} action line(s), chip ${H.chipH}px, block ${H.blockH}px`)

  // ── The artifact ──
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, cdp.sessionId)
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log(`[inventory-list-shot] wrote ${OUT}`)
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (failures.length) {
  console.error('\n[inventory-list-shot] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[inventory-list-shot] PASS')
