#!/usr/bin/env node
// undo-toast-target.mjs — BUG-UNDOTOASTTAPTARGET-001's real-engine check. Runnable by hand; not wired
// into CI (see "CI WIRING" below).
//
//   node scripts/layout-gate/undo-toast-target.mjs [--out <dir>] [--label <name>] [--json <file>]
//                                                  [--baseline <full sha>] [--measure-only]
//
// MEASURES, in real Chrome at Dave's phone viewport — 426x836 CSS px, DPR 3, mobile emulation via
// Emulation.setDeviceMetricsOverride, never --window-size (macOS Chrome floors a window at ~500px and
// crops) — on tests/harness/undotap.html: every production caller's undo toast, one at a time, and the
// tallest stack Today can build from real row taps. It refuses to report unless the page itself says
// innerWidth 426 x innerHeight 836, and burns that into the top of every PNG.
//
// ASSERTS (skipped with --measure-only):
//   (a) TARGET — on every caller's toast the Undo control's box is >= TAP x TAP, it takes a tap across
//       a whole TAP x TAP square centred on it (a 5x5 elementFromPoint grid), and its hit-tested extent
//       through the centre is >= TAP both ways. Hit-tested, not just boxed: a box can exist and still
//       not take the tap. (At DPR 3 hit-testing snaps to device pixels, so an extent reads up to ~0.7px
//       over the box — which is why the box is asserted too.)
//   (b) NO BULK — the toast did not grow to buy that: height <= max(text column + padding, TAP) + 1,
//       and the painted pill stays shorter than TAP (the extra is invisible). A visible 48px button, or
//       a target made of padding that takes layout space, fails here.
//   (c) NEIGHBOUR — the Dismiss (x) control is >= TAP tall, takes a tap across its whole box, reaches
//       the toast's right edge (the padding there is target, not dead space), and sits >= MIN_TARGET_GAP
//       px clear of Undo. The gap is the part that matters most: Undo reverses the action, x throws the
//       undo away, so a thumb that misses Undo must land on nothing rather than on x.
//   (d) STACK — Water, Skip, Feed tapped on real rows is 3 toasts, none overlapping, ending above the
//       bottom nav; a fourth (Moist) takes a slot from the low-priority Skip toast, not from a log.
//   (e) NAME — the Undo control's accessible name is still exactly "Undo".
//
// NON-VACUITY: --baseline <sha> serves src/** from that commit (HARNESS_BASELINE_SHA), so the same
// instrument measures the code before a change. Against the pre-fix dev SHA
// 3c83e8b02877bcec3744c441f514010fd14fbffc this gate exits 1 on (a) and (c) for every caller.
//
// CI WIRING it would need (deliberately not done in this lane): a `gate:undo-toast` script in
// package.json, and a step in .github/workflows/ci.yml beside gate:log-chooser — same Chrome install,
// same GATE_CHROME_FLAGS=--no-sandbox. Node 20 on CI has no global WebSocket; cdp-socket.mjs covers it.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { T } from '../../src/components/forms/formStyles.js'
import { resolveWebSocket } from './cdp-socket.mjs'

// Read from the token, never spelled here: a gate carrying its own copy of the target is a gate that
// keeps passing after someone lowers the real one. buttonMinHeight is the frozen 48 tap target.
const TAP = T.buttonMinHeight
// Material's minimum spacing between two touch targets. Not a token in this codebase; the Today Skip
// fix (BUG-TODAYSKIPNOUNDO-001, CareNeeded.jsx SKIP_GAP) used the same 8.
const MIN_TARGET_GAP = 8

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = resolve(arg('--out') || join(ROOT, 'artifacts/layout-gate'))
const LABEL = arg('--label') || 'run'
const JSON_OUT = arg('--json')
const BASELINE = arg('--baseline')
const MEASURE_ONLY = process.argv.includes('--measure-only')
// Unused elsewhere (2026-09-24): the other gates hold 5312-5323 / 9422-9433, and .claude/launch.json's
// harness previews hold 5311, 5325 and 5326. --strictPort makes a clash a loud failure, never a
// measurement of somebody else's server.
const PORT = Number(process.env.GATE_HARNESS_PORT || 5329)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9439)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Launch flags another environment needs (CI: --no-sandbox). Rendering-affecting flags do not belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
// Dave's handset, read off the phone 2026-09-24 (More -> Debug & smoke -> "Viewport (CSS px)").
const VIEWPORT = { w: 426, h: 836, dpr: 3 }

if (BASELINE && !/^[0-9a-f]{40}$/.test(BASELINE)) {
  console.error('[undo-toast-target] --baseline needs a full 40-hex sha')
  process.exit(2)
}

const failures = []
const fail = m => failures.push(m)

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  const env = { ...process.env }
  if (BASELINE) env.HARNESS_BASELINE_SHA = BASELINE; else delete env.HARNESS_BASELINE_SHA
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/undotap.html`)
      if (r.ok) {
        // The plugin prints this line when it pins src/**; without it a "before" run measured the tree.
        if (BASELINE && !log.includes(BASELINE)) { await sleep(500) }
        if (BASELINE && !log.includes(BASELINE)) throw new Error(`harness did not confirm serving src/** from ${BASELINE}:\n${log}`)
        return { proc, log: () => log }
      }
    } catch (e) { if (/did not confirm/.test(e.message)) { proc.kill('SIGKILL'); throw e } }
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
    '--window-size=900,1100', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  const tries = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < tries; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} (code=${proc.exitCode} signal=${proc.signalCode})`)
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
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  // Viewport capture only: captureBeyondViewport resizes the rendering viewport and reflows the page.
  const shot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
  return { ws, send, sessionId, evalIn, shot }
}

// One toast's verdicts. `where` names it in a failure line.
function checkToast(where, m) {
  const u = m.undo, c = m.close
  if (!u) { fail(`${where}: no Undo control in the toast`); return }
  if (!u.visible) fail(`${where}: Undo is not visible (checkVisibility false)`)
  if (u.name !== 'Undo') fail(`${where}: Undo's accessible name is ${JSON.stringify(u.name)}, not "Undo"`)
  if (u.w < TAP || u.h < TAP) fail(`${where}: Undo's box is ${u.w}x${u.h}px, under ${TAP}x${TAP}`)
  if (u.hitW < TAP || u.hitH < TAP) fail(`${where}: Undo takes a tap across ${u.hitW}x${u.hitH}px through its centre, under ${TAP}x${TAP}`)
  if (u.grid.ok !== u.grid.of) fail(`${where}: only ${u.grid.ok}/${u.grid.of} points of a ${TAP}x${TAP} square on Undo hit Undo`)
  const need = Math.max(m.textCol.h + m.toast.padY, TAP) + 1
  if (m.toast.h > need) fail(`${where}: toast is ${m.toast.h}px tall; its text needs ${r1(m.textCol.h + m.toast.padY)}px and one target ${TAP}px — the target made the toast bulkier`)
  if (!m.pill) fail(`${where}: no painted Undo pill found (nothing under Undo draws a border)`)
  else if (m.pill.h >= TAP) fail(`${where}: the painted Undo pill is ${m.pill.h}px tall — a visible ${TAP}px button, not an invisible target`)
  if (!c) { fail(`${where}: no Dismiss control in the toast`); return }
  if (c.h < TAP || c.hitH < TAP) fail(`${where}: Dismiss is ${c.h}px tall (hit ${c.hitH}px), under ${TAP}`)
  if (c.ownGrid.ok !== c.ownGrid.of) fail(`${where}: only ${c.ownGrid.ok}/${c.ownGrid.of} points of Dismiss's own box hit Dismiss`)
  if (c.right < m.toast.right - 0.5) fail(`${where}: Dismiss stops ${r1(m.toast.right - c.right)}px short of the toast's right edge — that padding is dead space again`)
  if (m.gapUndoToClose < MIN_TARGET_GAP) fail(`${where}: Undo and Dismiss are ${m.gapUndoToClose}px apart, under ${MIN_TARGET_GAP}px`)
}
const r1 = n => Math.round(n * 10) / 10
const fmt = m => `toast ${m.toast.w}x${m.toast.h} (${m.lines} line${m.lines === 1 ? '' : 's'}${m.detail ? ' + detail' : ''}) · text col ${m.textCol.w}px`
  + ` · Undo box ${m.undo.w}x${m.undo.h} hit ${m.undo.hitW}x${m.undo.hitH} grid ${m.undo.grid.ok}/${m.undo.grid.of}`
  + (m.pill ? ` · pill ${m.pill.w}x${m.pill.h}` : '')
  + ` · x box ${m.close.w}x${m.close.h} hit ${m.close.hitW}x${m.close.hitH} own-box grid ${m.close.ownGrid.ok}/${m.close.ownGrid.of}`
  + ` · x to toast edge ${r1(m.toast.right - m.close.right)}px · Undo-x gap ${m.gapUndoToClose}px`

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-undotoast-'))
const result = { label: LABEL, baseline: BASELINE, viewport: VIEWPORT, tap: TAP, shots: [] }
try {
  mkdirSync(OUT, { recursive: true })
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: VIEWPORT.dpr, mobile: true }, cdp.sessionId)
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/undotap.html` }, cdp.sessionId)
  await cdp.evalIn(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('rows never rendered: '+(window.__h&&window.__h.error()))})()`)
  await sleep(500)

  // NON-VACUITY first: a measurement from the wrong viewport is a measurement of a different layout.
  const vp = await cdp.evalIn('window.__h.vw()')
  result.page = vp
  if (vp.vw !== VIEWPORT.w || vp.vh !== VIEWPORT.h) throw new Error(`page reports ${vp.vw}x${vp.vh}, expected ${VIEWPORT.w}x${VIEWPORT.h} — emulation did not take, every number would be void`)
  if (vp.dpr !== VIEWPORT.dpr) fail(`page reports dpr ${vp.dpr}, expected ${VIEWPORT.dpr}`)

  const callers = await cdp.evalIn(`window.__h.measureCallers(${TAP})`)
  result.callers = callers
  if (callers.length < 10) fail(`only ${callers.length} caller shapes measured — the census is thinner than the ten production message shapes`)
  for (const m of callers) {
    console.log(`[undo-toast-target] ${LABEL} · ${m.caller}: ${fmt(m)}`)
    checkToast(m.caller, m)
  }

  // Three caller shapes together (the cap), outlined, for the eye: shortest, EventNew's worst, Skip.
  await cdp.evalIn('window.__h.raise([0, 9, 4])')
  await cdp.evalIn(`window.__h.outline(true)`)
  await cdp.evalIn(`window.__h.badge('innerWidth '+innerWidth+' · innerHeight '+innerHeight+' · dpr '+devicePixelRatio+' · ${LABEL} · dashed = what takes the tap')`)
  result.shots.push(await cdp.shot(join(OUT, `undotap-callers-${LABEL}-426x836.png`)))
  await cdp.evalIn('window.__h.outline(false)')
  await cdp.evalIn('window.__h.clear()')

  const { three } = await cdp.evalIn(`window.__h.stack(${TAP})`)
  result.stack = three
  await cdp.evalIn(`window.__h.badge('innerWidth '+innerWidth+' · innerHeight '+innerHeight+' · dpr '+devicePixelRatio+' · ${LABEL} · Water, Skip, Feed · stack y${three.stackTop}-${three.stackBottom} · nav y${three.navTop} · list controls half+ hidden ${three.controlsCovered}/${three.controlsOnScreen}, any part ${three.controlsTouched}')`)
  result.shots.push(await cdp.shot(join(OUT, `undotap-stack-${LABEL}-426x836.png`)))
  await cdp.evalIn('window.__h.outline(true)')
  result.shots.push(await cdp.shot(join(OUT, `undotap-stack-hitbox-${LABEL}-426x836.png`)))
  await cdp.evalIn('window.__h.outline(false)')
  const give = await cdp.evalIn(`window.__h.stackGiveWay(${TAP})`)
  result.giveWay = give

  console.log(`[undo-toast-target] ${LABEL} · stack Water+Skip+Feed: ${three.count} toasts y${three.stackTop}-${three.stackBottom} (h${three.stackH}) · nav top y${three.navTop} · clearance ${three.clearanceAboveNav}px · overlaps ${three.overlaps} · list controls half+ hidden ${three.controlsCovered}/${three.controlsOnScreen}, any part ${three.controlsTouched}`)
  for (const m of three.toasts) console.log(`[undo-toast-target] ${LABEL} ·   ${JSON.stringify(m.message)}: ${fmt(m)}`)
  console.log(`[undo-toast-target] ${LABEL} · after Moist: ${give.after.count} toasts ${JSON.stringify(give.after.toasts.map(t => t.message))} y${give.after.stackTop}-${give.after.stackBottom}`)

  if (three.count !== 3) fail(`stack: Water, Skip, Feed produced ${three.count} toasts, not 3 — the stack under test never formed`)
  if (three.overlaps) fail(`stack: ${three.overlaps} toast(s) overlap the one above`)
  if (three.clearanceAboveNav < 0) fail(`stack: bottom y${three.stackBottom} runs ${-three.clearanceAboveNav}px into the nav (top y${three.navTop})`)
  if (three.stackTop < 0) fail(`stack: top y${three.stackTop} is off the top of the screen`)
  for (const m of three.toasts) checkToast(`stack ${JSON.stringify(m.message)}`, m)
  if (give.after.count !== 3) fail(`after Moist: ${give.after.count} toasts, not 3`)
  if (give.after.toasts.some(t => /^Skipped /.test(t.message))) fail(`after Moist: the low-priority Skip toast is still up — a log Undo gave way instead`)

  result.error = await cdp.evalIn('window.__h.error()')
  if (result.error) fail(`page error: ${result.error}`)
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
  result.fatal = e.message
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.proc.kill('SIGKILL')
  await sleep(300)
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

result.failures = failures
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2))
for (const s of result.shots) console.log(`[undo-toast-target] ${LABEL} · wrote ${s}`)
if (result.fatal || (!MEASURE_ONLY && failures.length)) {
  console.error(`\n[undo-toast-target] ${LABEL} FAIL`)
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (MEASURE_ONLY && failures.length) console.log(`[undo-toast-target] ${LABEL} · measure-only: ${failures.length} assertion(s) would fail`)
console.log(`[undo-toast-target] ${LABEL} ${MEASURE_ONLY ? 'MEASURED' : 'PASS'}`)
