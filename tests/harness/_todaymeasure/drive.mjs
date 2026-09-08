#!/usr/bin/env node
// drive.mjs — drive the real Today page in real Chrome at a TRUE 390x844 and record what it does.
//
//   node tests/harness/_todaymeasure/drive.mjs [--out DIR] [--states busy,quiet,noplan]
//
// Not a gate: it asserts nothing about right or wrong, it RECORDS. The only thing it refuses to
// proceed on is an unproven instrument — if the page does not self-report innerWidth 390, or if it
// raised an error while mounting, every number after that is void and the run says so.
//
// Geometry comes from Emulation.setDeviceMetricsOverride, not from --window-size: macOS Chrome
// floors an OS window at ~500px, so a --window-size=390 run lays out at 500 and crops the capture to
// 390 — a plausible-looking mobile screenshot of a desktop-width layout. (Trap documented at length
// in scripts/layout-gate/inventory-list-shot.mjs, whose transport this reuses.)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from '../../../scripts/layout-gate/cdp-socket.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const PORT = Number(process.env.TM_PORT || 5317)
const CDP_PORT = Number(process.env.TM_CDP_PORT || 9431)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { w: 390, h: 844 }

const argOf = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt }
const OUT = resolve(argOf('--out', join(HERE, 'out')))
const STATES = argOf('--states', 'busy,quiet,noplan').split(',').filter(Boolean)

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin}`)
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  proc.stdout.on('data', d => { log += d }); proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/tests/harness/todaymeasure.html`); if (r.ok) return proc } catch { /* not up */ }
    if (proc.exitCode != null) throw new Error(`vite exited (${proc.exitCode}):\n${log}`)
    await sleep(250)
  }
  proc.kill('SIGKILL'); throw new Error(`vite never served :${PORT}:\n${log}`)
}

async function startChrome(udd) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`)
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${udd}`,
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  for (let i = 0; i < 240; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Chrome EXITED before CDP (code=${proc.exitCode})`)
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return { proc, version: await r.json() } } catch { /* not up */ }
    await sleep(250)
  }
  proc.kill('SIGKILL'); throw new Error(`Chrome did not expose CDP on ${CDP_PORT}`)
}

async function attach(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 120000)
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId)
  const evalIn = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn }
}

const notes = []
let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'todaymeasure-'))
mkdirSync(OUT, { recursive: true })
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  for (const state of STATES) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
    // V5-TODAYSHAPE-001 — pinned alongside the harness's clock shim so a capture taken on a UTC CI
    // runner and one taken on a New York laptop describe the same page. The date subtitle and the
    // "as of 5:30 AM" stamp are rendered in the HOST timezone, and different copy is a different
    // wrap is a different height. Without these two the recorder and scripts/layout-gate/
    // today-shape.mjs would silently disagree, which is worse than either being wrong alone.
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }, cdp.sessionId)
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }, cdp.sessionId)
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/todaymeasure.html?state=${state}` }, cdp.sessionId)
    await cdp.evalIn(`(async()=>{for(let i=0;i<250;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('today never rendered (${state})')})()`)
    await cdp.evalIn(`new Promise(r=>setTimeout(r,2500))`)   // self-fetching bands + live rain settle

    const vp = await cdp.evalIn(`window.__h.viewport()`)
    const err = await cdp.evalIn(`window.__h.error()`)
    if (vp.innerWidth !== VIEWPORT.w) { notes.push(`[${state}] VOID: page reports innerWidth ${vp.innerWidth}, expected ${VIEWPORT.w}`); continue }
    if (err) notes.push(`[${state}] page raised: ${err}`)

    const data = await cdp.evalIn(`JSON.stringify(window.__h.all(4))`)
    writeFileSync(join(OUT, `measure-${state}.json`), data)

    // Screenshots. Badge hidden for the crucible-facing captures; a badged full-page follows so the
    // geometry of the run is self-evidencing rather than trusted.
    const H = Math.ceil(vp.scrollHeight)
    const scale = (H * 2 > 15000) ? 1 : 2
    await cdp.evalIn(`window.__h.hideBadge()`)
    const full = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: VIEWPORT.w, height: H, scale } }, cdp.sessionId)
    writeFileSync(join(OUT, `today-${state}-390-full.png`), Buffer.from(full.data, 'base64'))

    const slices = Math.ceil(H / VIEWPORT.h)
    for (let s = 0; s < slices; s++) {
      const y = s * VIEWPORT.h
      const h = Math.min(VIEWPORT.h, H - y)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: VIEWPORT.w, height: h, scale: 2 } }, cdp.sessionId)
      writeFileSync(join(OUT, `today-${state}-390-screen${String(s + 1).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'))
    }
    await cdp.evalIn(`window.__h.showBadge()`)
    const badged = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, cdp.sessionId)
    writeFileSync(join(OUT, `today-${state}-390-badge.png`), Buffer.from(badged.data, 'base64'))

    notes.push(`[${state}] ${vp.innerWidth}x${vp.innerHeight} · scrollH ${H}px = ${(H / VIEWPORT.h).toFixed(2)} screens · ${slices} slice PNGs · reqs ${(await cdp.evalIn(`window.__h.requests().length`))}`)
    console.log(notes[notes.length - 1])
  }
} catch (e) {
  notes.push('RUN FAILED: ' + e.message)
  console.error('RUN FAILED:', e.message)
} finally {
  try { cdp?.ws.close() } catch { /* gone */ }
  chrome?.proc.kill('SIGKILL'); harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}
writeFileSync(join(OUT, 'run-notes.txt'), notes.join('\n') + '\n')
console.log('\n' + notes.join('\n'))
