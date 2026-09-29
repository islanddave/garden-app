#!/usr/bin/env node
// putup-ferment-walk.mjs — Put-Up release F's ferment walks, in real Chrome, at Dave's 426×836 and with
// the keyboard up at 426×492 (06 §5 row L3 "3b"; V4 §6.7's keyboard-up height).
//
//   node scripts/layout-gate/putup-ferment-walk.mjs                  # every walk, both heights
//   node scripts/layout-gate/putup-ferment-walk.mjs --walk kimchi    # one walk
//   node scripts/layout-gate/putup-ferment-walk.mjs --probe-nothing  # prove the instrument fires
//   … --short (the keyboard-up height only) · --trace (where each typed field landed, each sheet's scroll)
//
// Each walk is driven INSIDE the page by tests/harness/putupferment.jsx — Start → What went in → the
// Salt block → Jar & heat → Check on it → Put it up and finish → edit Made g and a line — against the
// stateful stand-in in tests/harness/fermentFake.js, which judges every body with the Lambda's own
// validators. This file is only the browser: the same Vite harness, the same headless Chrome, the same
// Emulation-not-window-size geometry and the same exit-code discipline as putup-close-clearance.mjs.
//
// THE INSTRUMENT CHECK, before any verdict: the page must self-report the viewport asked for, the walk
// must have tapped, typed and checked something, and written to the stand-in — a walk that stopped at
// its first selector reports zero of all four, and that is a failure, never a pass. `--probe-nothing`
// points every selector at a testid nothing renders; it MUST exit 1.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5343)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9453)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const TRACE = process.argv.includes('--trace')          // print where each typed field landed
const ONLY = (() => { const i = process.argv.indexOf('--walk'); return i > 0 ? process.argv[i + 1] : null })()

const WALKS = ['petri', 'settlers', 'kraut', 'kimchi', 'appendixc'].filter(w => !ONLY || w === ONLY)
const VIEWPORTS = [[426, 836], [426, 492]].filter(([, h]) => !process.argv.includes('--short') || h === 492)
// Floors for the instrument check, well under what each walk does: a walk that got past Start taps
// dozens of controls and writes a batch, lines, a salt line and a put-up.
const FLOOR = { taps: 20, typed: 8, checks: 10, writes: 6 }

const failures = []
const fail = m => failures.push(m)

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  // Through vite's own bin, never `npx vite`: killing npx at teardown orphans the real server.
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/putupferment.html`)
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
    // Larger than the viewport under test: geometry is imposed by emulation (macOS floors a window at ~500px).
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  const tries = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < tries; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} (code=${proc.exitCode} signal=${proc.signalCode}) - a dead browser, not a slow one`)
    }
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return { proc, version: await r.json() }
    } catch { /* not listening yet */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT} within ${tries * 250}ms`)
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
  // A walk runs for tens of seconds inside one evaluate: the timeout is the walk's, not a CDP round trip's.
  const send = (method, params = {}, sessionId, ms = 90000) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, ms)
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  const evalIn = async (expression, ms) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, ms)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn }
}

const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i
async function evalSettled(cdp, expr, ms) {
  let last
  for (let i = 0; i < 25; i++) {
    try { return await cdp.evalIn(expr, ms) } catch (err) {
      if (!CONTEXT_LOST.test(err.message)) throw err
      last = err
      await sleep(200)
    }
  }
  throw new Error(`page never held still long enough to evaluate: ${last?.message}`)
}

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-putupferment-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[ferment] --probe-nothing: every selector points at a testid nothing renders. This run MUST fail.')
  for (const walk of WALKS) {
    for (const [vw, vh] of VIEWPORTS) {
      const at = `${walk}@${vw}x${vh}`
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 3, mobile: true }, cdp.sessionId)
      const url = `http://localhost:${PORT}/tests/harness/putupferment.html?walk=${walk}${PROBE_NOTHING ? '&probe=1' : ''}${TRACE ? '&trace=1' : ''}`
      const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
      await sleep(200)
      await evalSettled(cdp, `(async()=>{for(let i=0;i<200;i++){if(window.__walk&&window.__walk.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('the harness never reached ready() for ${walk}')})()`)
      const r = await evalSettled(cdp, 'window.__walk.run()', 240000)
      // ── INSTRUMENT CHECK, before the verdict.
      if (r.vw !== vw || r.vh !== vh) { fail(`${at}: the page self-reports ${r.vw}x${r.vh} — emulation did not take`); continue }
      if (!r.font || !(r.font.faces > 0) || r.font.failed > 0) {
        fail(`${at}: the Roboto pin did not load (${JSON.stringify(r.font)}) — every "fits" below was measured in this machine's font, not the phone's`)
      }
      const thin = Object.entries(FLOOR).filter(([k, n]) => !(r[k] >= n)).map(([k, n]) => `${k} ${r[k]} < ${n}`)
      if (thin.length) fail(`${at}: the walk did almost nothing (${thin.join(', ')}) — whatever it reports below is about an empty run`)
      for (const f of r.failures) fail(`${at}: ${f}`)
      for (const n of r.notes) console.log(`[ferment] ${at}: note — ${n}`)
      console.log(`[ferment] ${at}: ${r.failures.length ? `${r.failures.length} failure(s)` : 'clean'} · ${r.taps} taps · ${r.typed} fields typed · ${r.checks} checks · ${r.writes} writes · ${r.ms} ms`)
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

// Not inverted under --probe-nothing: both outcomes there are red, and the banner says which.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[ferment] FAIL — EXPECTED. --probe-nothing pointed every selector at a testid nothing renders and the walks caught it. This red is the proof the instrument fires.'
    : '\n[ferment] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[ferment] FAIL — and this one is the real defect: every selector pointed at nothing and no walk complained.')
  process.exit(1)
}
console.log('[ferment] PASS')
