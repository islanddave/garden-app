#!/usr/bin/env node
// log-chooser-clearance.mjs — BUG-LOGBANDOCCLUDE-001's real-engine gate.
//
//   node scripts/layout-gate/log-chooser-clearance.mjs        # npm run gate:log-chooser
//
// ASSERTS, at a TRUE 390x844 AND 390x667 in real Chrome, on the ordinary Log Event page at FIRST
// PAINT (no taps, no scrolling — the state the user actually arrives in): the "Plant or group"
// chooser is returned by elementFromPoint at five points across its own width, and clears the
// sticky Save band by SAVE_BAND_MIN_CLEARANCE_PX.
//
// WHAT WAS MEASURED BEFORE THE FIX, same instrument, 390x844: band stuck at bottom:68 spanning
// y728-776 x16-359; chooser y712-756 x35-340, i.e. 28 of its 44px underneath. Five probes across
// the chooser returned the chooser ZERO times — x50 and x111 hit the band's transparent action
// row, x188/x264/x325 hit the Save BUTTON (x179-359). A required field, completely untappable,
// with nothing on screen to explain why. The right two thirds were worse than untappable: a tap
// there COMMITTED the form.
//
// WHY IT CANNOT BE A VITEST TEST — the same reason its sibling save-band-clearance.mjs cannot be.
// jsdom has no layout engine: every getBoundingClientRect() is zeros and elementFromPoint is
// meaningless (tests/harness/README.md §Limits), so nothing under src/__tests__/** can tell
// "the chooser is clear" from "the chooser is buried". EventNew.logBandOcclusion.test.jsx pins the
// STRUCTURAL half (which nodes hit-test) and says so; the pixels are this file's job.
//
// AND WHY IT CANNOT BE THE BROWSER PANE. Measured the hard way while building this fix: the
// in-app Browser pane tab reports `document.visibilityState === 'hidden'`, so requestAnimationFrame
// never fires and ResizeObserver is throttled — the clearance effect could not run there and read
// as "the fix does nothing" through three rounds of correct code. Chrome is spawned here with
// --disable-renderer-backgrounding et al so the page is genuinely live. If a future run of this
// gate reports a scroll of 0 with a collision present, check visibilityState BEFORE the source.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { SAVE_BAND_MIN_CLEARANCE_PX } from '../../src/lib/saveBandLayout.js'
import { T } from '../../src/components/forms/formStyles.js'

// Read from the token, never spelled here: a gate carrying its own copy of the floor is a gate that
// keeps passing after someone lowers the real one.
const TAP_MIN_HEIGHT_PX = T.tapMinHeight

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5314)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9424)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Both of Dave's measured device geometries. 844 is the phone at rest; 667 is the same phone with
// the keyboard up, and it is the tighter one — the band eats a larger fraction of a shorter page.
const VIEWPORTS = [{ w: 390, h: 844 }, { w: 390, h: 667 }]

const failures = []
const fail = m => failures.push(m)

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/`)
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
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
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
  const ws = new WebSocket(wsUrl)
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

// ── The measurement, run in the driver page against the child frame ────────────────────────────
// NOTHING is tapped, scrolled or focused before measuring. That is the entire point: the defect is
// a FIRST-PAINT one, and any interaction here would latch `userActedRef` in the page and disable
// the very clearance under test — a gate that drove the UI first would pass against the bug.
const DRIVE = `(async () => {
  const f = document.getElementById('frame')
  for (let i=0;i<240;i++){ try { if (f.contentWindow && f.contentWindow.__h && f.contentWindow.__h.ready()) break } catch {} await new Promise(r=>setTimeout(r,100)) }
  const w = f.contentWindow
  if (!(w.__h && w.__h.ready())) throw new Error('harness never became ready in the child frame')
  const d = w.document
  await w.__h.settle(20)

  const band = d.querySelector('[data-testid="save-sticky"]')
  const chooser = d.querySelector('[aria-label="Plant or group"]')
  if (!band) throw new Error('no [data-testid="save-sticky"] on /log — this gate is measuring the wrong surface')
  if (!chooser) throw new Error('no [aria-label="Plant or group"] on /log — the chooser this gate is about did not render')

  const save = [...band.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Save')
  if (!save) throw new Error('no Save button inside the band')

  const cs = w.getComputedStyle(band), ss = w.getComputedStyle(save)
  const br = band.getBoundingClientRect(), cr = chooser.getBoundingClientRect(), sr = save.getBoundingClientRect()

  const probes = []
  for (const frac of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const x = cr.left + cr.width * frac, y = (cr.top + cr.bottom) / 2
    const el = d.elementFromPoint(x, y)
    probes.push({
      x: Math.round(x),
      isChooser: el === chooser || (el != null && chooser.contains(el)),
      hit: el ? (el.getAttribute('data-testid') || (el.textContent||'').trim().slice(0,16) + '|' + el.tagName) : 'null',
    })
  }
  const sc = d.elementFromPoint((sr.left+sr.right)/2, (sr.top+sr.bottom)/2)

  // BUG-DISCLOSURETAPSIZE-001 — census, not a named list. The bug was four controls under the
  // floor and the audit that found them was a manual sweep; a gate that re-checks only those four
  // would pass the day a fifth is authored short. So: every visible interactive control on the
  // surface, measured, and the short ones named.
  const tapTargets = [...d.querySelectorAll('button, input, select, textarea, [role="button"]')]
    .filter(el => el.checkVisibility && el.checkVisibility() && el.getBoundingClientRect().height > 0)
    .map(el => {
      const r = el.getBoundingClientRect()
      const label = el.getAttribute('aria-label') || el.getAttribute('data-testid') ||
        (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28) || ('<' + el.tagName.toLowerCase() + ' ' + (el.type||'') + '>')
      return { label, h: Math.round(r.height * 10) / 10 }
    })

  return {
    tapTargets,
    innerW: w.innerWidth, innerH: w.innerHeight,
    scrollTop: d.scrollingElement.scrollTop,
    scrollRoom: d.scrollingElement.scrollHeight - d.scrollingElement.clientHeight,
    band: { top: Math.round(br.top), bottom: Math.round(br.bottom), height: Math.round(br.height),
            position: cs.position, visibility: cs.visibility, pointerEvents: cs.pointerEvents },
    save: { top: Math.round(sr.top), left: Math.round(sr.left), right: Math.round(sr.right),
            pointerEvents: ss.pointerEvents, hitIsSelf: sc === save || (sc != null && save.contains(sc)) },
    chooser: { top: Math.round(cr.top), bottom: Math.round(cr.bottom), left: Math.round(cr.left),
               right: Math.round(cr.right), height: Math.round(cr.height) },
    clearancePx: Math.round(br.top - cr.bottom),
    probes,
  }
})()`

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-logchooser-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  for (const vp of VIEWPORTS) {
    const url = `http://localhost:${PORT}/tests/harness/viewport.html?vw=${vp.w}&vh=${vp.h}&surface=fullpage`
    await cdp.evalIn(`location.href = ${JSON.stringify(url)}`, false)
    await sleep(1500)
    const m = await cdp.evalIn(DRIVE)
    const at = `${vp.w}x${vp.h}`

    // ── NON-VACUITY, before any invariant. Every one of these is a way this gate could pass while
    //    the bug is live: a band that never rendered, a band with no height, a hidden band, or a
    //    Save that does not hit-test are all states in which "the chooser is reachable" is true
    //    for a reason that has nothing to do with the fix.
    if (m.innerW !== vp.w || m.innerH !== vp.h) fail(`${at}: frame reported ${m.innerW}x${m.innerH} — not the viewport asked for; every coordinate below is from the wrong layout`)
    if (m.band.position !== 'sticky') fail(`${at}: band position is '${m.band.position}', not sticky — it cannot float over the form, so this gate proves nothing`)
    if (m.band.height <= 0) fail(`${at}: band has zero height`)
    if (m.band.visibility !== 'visible') fail(`${at}: band visibility is '${m.band.visibility}' — an invisible band occludes nothing and every probe below passes vacuously`)
    if (!m.save.hitIsSelf) fail(`${at}: Save does not hit-test to itself — the band is inert for some unrelated reason and the probes prove nothing`)
    if (m.chooser.height <= 0) fail(`${at}: chooser has zero height`)

    // ── THE STRUCTURAL HALF. The band's own box paints nothing before a save, so it must not take
    //    a tap; Save is painted, so it must.
    if (m.band.pointerEvents !== 'none') fail(`${at}: band pointerEvents is '${m.band.pointerEvents}' — the transparent box is hit-testing again, which is half of BUG-LOGBANDOCCLUDE-001`)
    if (m.save.pointerEvents !== 'auto') fail(`${at}: Save pointerEvents is '${m.save.pointerEvents}' — Save must stay tappable when the band around it does not`)

    // ── THE INVARIANT.
    for (const p of m.probes) {
      if (!p.isChooser) fail(`${at}: elementFromPoint at x${p.x} across the chooser returns ${p.hit}, not the chooser — occluded`)
    }
    if (m.clearancePx < SAVE_BAND_MIN_CLEARANCE_PX) {
      fail(`${at}: chooser clears the Save band by ${m.clearancePx}px, minimum is ${SAVE_BAND_MIN_CLEARANCE_PX}px`)
    }

    // ── BUG-DISCLOSURETAPSIZE-001. Same page load, same instrument.
    if (m.tapTargets.length < 6) fail(`${at}: only ${m.tapTargets.length} interactive controls found — the census is too thin to be measuring the real surface`)
    const short = m.tapTargets.filter(t => t.h < TAP_MIN_HEIGHT_PX)
    for (const t of short) fail(`${at}: "${t.label}" is ${t.h}px tall, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
    console.log(`[log-chooser-clearance] ${at}: ${m.tapTargets.length} interactive controls, ${short.length} under ${TAP_MIN_HEIGHT_PX}px · shortest ${Math.min(...m.tapTargets.map(t => t.h))}px`)

    console.log(`[log-chooser-clearance] ${at}: band y${m.band.top}-${m.band.bottom} h${m.band.height} pe=${m.band.pointerEvents} · Save x${m.save.left}-${m.save.right} pe=${m.save.pointerEvents}`)
    console.log(`[log-chooser-clearance] ${at}: chooser y${m.chooser.top}-${m.chooser.bottom} · clearance ${m.clearancePx}px (floor ${SAVE_BAND_MIN_CLEARANCE_PX}px) · auto-scrolled ${m.scrollTop}px of ${m.scrollRoom}px available · ${m.probes.filter(p => p.isChooser).length}/5 probes hit the chooser`)
  }
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (failures.length) {
  console.error('\n[log-chooser-clearance] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[log-chooser-clearance] PASS')
