#!/usr/bin/env node
// save-band-clearance.mjs — BUG-WEIGHPADSAVEBAND-001's real-engine gate.
//
//   node scripts/layout-gate/save-band-clearance.mjs        # npm run gate:save-band
//
// ASSERTS, at a TRUE 390x500 in real Chrome: in the harvest weigh-in session, once the user has
// moved to the weight field, every key in the weight keypad's bottom row is (a) visible per
// checkVisibility(), (b) returned by elementFromPoint at its own centre, and (c) at least
// SAVE_BAND_MIN_CLEARANCE_PX above the sticky Save band's top edge.
//
// WHY IT CANNOT BE A VITEST TEST. jsdom has no layout engine: every getBoundingClientRect() is
// zeros and elementFromPoint is meaningless, so no test under src/__tests__/** can distinguish
// "the keypad clears the Save band" from "the keypad is buried under it" (tests/harness/README.md
// §Limits). That is precisely how the shipped clearance drifted from +1px to -15px unnoticed.
//
// TWO MEASUREMENT TRAPS THIS SCRIPT EXISTS TO AVOID, both of which produce a confident wrong answer:
//   1. macOS Chrome floors an OS window at ~500px wide. `--window-size=390` lays the page out at
//      ~500 and CROPS the capture to 390 — a plausible-looking mobile screenshot of a desktop-width
//      layout. The page under test is therefore loaded in a 390x500 IFRAME inside a 900x900 window,
//      and the gate REFUSES TO PASS unless the frame self-reports innerWidth/innerHeight 390x500
//      with no horizontal overflow. An instrument that cannot prove its own viewport fails closed.
//   2. offsetParent (and a non-zero rect) report content hidden by `content-visibility` — and
//      content buried under an opaque sibling — as visible. Only checkVisibility() knows about the
//      former and only elementFromPoint answers the latter, so BOTH are required here. A key that
//      is painted and unreachable is the exact defect; "visible" alone would pass it.
//
// NON-VACUITY. A gate that measures clearance against a band that is not there, or is hidden, or
// takes no pointer events, passes for the wrong reason. The preconditions below fail the run if the
// band is missing/hidden/pointer-transparent or if the pad does not yield a full six-key bottom row
// — the same class of check as "is the instrument reading anything at all".
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { SAVE_BAND_MIN_CLEARANCE_PX } from '../../src/lib/saveBandLayout.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5312)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9422)
const VIEWPORT = { w: 390, h: 500 }
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// ── Boot the layout harness (tests/harness) ────────────────────────────────────────────────────
// Vite is spawned through its own bin, NOT `npx vite`: npx is a wrapper process, so killing it at
// teardown orphans the real server, which keeps this script's stdout pipe open forever and hangs
// any caller that pipes it (`... | tail`). Killing the server directly is the whole point.
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

// ── Chrome over CDP. Node 22+ ships a global WebSocket, so this needs no dependency. ───────────
async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=900,900', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
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

// ── The measurement, run inside the driver page against the 390x500 child frame ────────────────
const DRIVE = `(async () => {
  const f = document.getElementById('f')
  for (let i=0;i<240;i++){ try { if (f.contentWindow && f.contentWindow.__h && f.contentWindow.__h.ready()) break } catch {} await new Promise(r=>setTimeout(r,100)) }
  const w = f.contentWindow
  if (!(w.__h && w.__h.ready())) throw new Error('harness never became ready in the child frame')
  const H = w.__h, d = w.document
  await H.settle(10)

  const tile = H.byText('Harvested'); if (tile) { H.tap(tile); await H.settle(10) }
  await H.waitFor(() => d.getElementById('harvest-quantity'), { label: 'harvest panel' })

  const pIn = d.querySelector('[data-testid="evtnew-planting"]')
  if (pIn && !d.querySelector('[data-testid="evtnew-planting-chip"]')) {
    H.tap(pIn, { focus: true }); await H.settle(6)
    const lb = await H.waitFor(() => d.querySelector('[role="listbox"]'), { label: 'planting listbox' })
    H.tap(lb.querySelector('[role="option"]')); await H.settle(12)
  }

  // Quantity focus runs anchorSectionToTop (V4-HARVSCROLLANCHOR-001) — the scroll offset the app
  // itself puts the user at, and the one the collision was measured at. smooth, so let it land.
  const qty = d.getElementById('harvest-quantity')
  H.tap(qty, { focus: true }); H.typeInto(qty, '3'); qty.focus()
  await H.settle(14); await H.sleepReal(800); await H.settle(6)

  // ...then the user moves to the weigh-in. This is the moment the clearance rule fires.
  const wt = d.getElementById('harvest-weight')
  if (!wt) throw new Error('#harvest-weight absent — is the weigh-in session mounted?')
  H.tap(wt, { focus: true }); wt.focus()
  await H.settle(14); await H.sleepReal(400); await H.settle(6)

  const band = d.querySelector('[data-testid="save-sticky"]')
  if (!band) throw new Error('save-sticky band absent')
  const bandCS = w.getComputedStyle(band)
  const bandR = band.getBoundingClientRect()
  const pad = d.querySelector('[aria-label="Harvest weight keypad"]')
  if (!pad) throw new Error('weight keypad absent')
  const keys = [...pad.querySelectorAll('button')]
  const byTop = new Map()
  for (const k of keys) { const t = Math.round(k.getBoundingClientRect().top); if (!byTop.has(t)) byTop.set(t, []); byTop.get(t).push(k) }
  const bottomRow = [...byTop.entries()].sort((a,b)=>a[0]-b[0]).pop()[1]

  return {
    frame: { vw: w.innerWidth, vh: w.innerHeight, scrollW: d.documentElement.scrollWidth },
    band: {
      top: +bandR.top.toFixed(1), bottom: +bandR.bottom.toFixed(1), height: +bandR.height.toFixed(1),
      visibility: bandCS.visibility, pointerEvents: bandCS.pointerEvents, position: bandCS.position,
    },
    keyCount: keys.length,
    bottomRow: bottomRow.map(k => {
      const r = k.getBoundingClientRect()
      const hit = d.elementFromPoint(r.left + r.width/2, r.top + r.height/2)
      return {
        id: k.dataset.testid || k.getAttribute('aria-label'),
        bottom: +r.bottom.toFixed(1),
        visible: k.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        hitIsSelf: hit === k || k.contains(hit),
        hit: hit ? (hit.dataset?.testid ? '#' + hit.dataset.testid : hit.tagName.toLowerCase()) : null,
        clearancePx: +(bandR.top - r.bottom).toFixed(1),
      }
    }),
  }
})()`

const WRAP = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#333}
#f{display:block;width:${VIEWPORT.w}px;height:${VIEWPORT.h}px;border:0}
</style></head><body><iframe id="f" src="/tests/harness/?surface=fullpage&session=harvest"></iframe></body></html>`

// The floor is spelled out here as well as imported, deliberately. Importing alone would let a
// session shave SAVE_BAND_MIN_CLEARANCE_PX down to whatever the layout currently happens to give
// and still see a green gate — which is the "eating the last pixel" move this whole ticket exists
// to stop. Lowering the policy number is allowed; doing it silently is not.
const DOCUMENTED_FLOOR_PX = 20

const failures = []
const fail = m => failures.push(m)

if (SAVE_BAND_MIN_CLEARANCE_PX < DOCUMENTED_FLOOR_PX) {
  fail(`SAVE_BAND_MIN_CLEARANCE_PX is ${SAVE_BAND_MIN_CLEARANCE_PX}, below the documented floor of ${DOCUMENTED_FLOOR_PX}px (BUG-WEIGHPADSAVEBAND-001). Lowering it needs this constant AND this gate changed together, with a reason.`)
}

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'save-band-gate-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/` }, cdp.sessionId)
  await cdp.evalIn(`(async()=>{for(let i=0;i<150;i++){if(window.__h)return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('driver page never loaded the harness')})()`)
  // Same-origin wrapper written over the loaded page, so the parent can reach into the child frame.
  await cdp.evalIn(`(()=>{document.open();document.write(${JSON.stringify(WRAP)});document.close();return 1})()`, false)
  const m = await cdp.evalIn(DRIVE)

  // ── Instrument first (an unproven viewport voids every number below it) ──
  if (m.frame.vw !== VIEWPORT.w || m.frame.vh !== VIEWPORT.h) {
    fail(`frame is ${m.frame.vw}x${m.frame.vh}, expected ${VIEWPORT.w}x${VIEWPORT.h} — measurement void`)
  }
  if (m.frame.scrollW !== VIEWPORT.w) fail(`frame scrollWidth ${m.frame.scrollW} != ${VIEWPORT.w} — page overflows, layout is not the one claimed`)

  // ── Non-vacuity: the band must actually be able to occlude something ──
  if (m.band.position !== 'sticky') fail(`band position is '${m.band.position}', not sticky — gate is measuring the wrong element`)
  if (m.band.visibility !== 'visible') fail(`band visibility is '${m.band.visibility}' — clearance would pass vacuously`)
  if (m.band.pointerEvents !== 'auto') fail(`band pointerEvents is '${m.band.pointerEvents}' — clearance would pass vacuously`)
  if (m.band.height <= 0) fail('band has zero height — clearance would pass vacuously')
  if (m.keyCount !== 12) fail(`weight keypad rendered ${m.keyCount} keys, expected 12`)
  if (m.bottomRow.length !== 6) fail(`bottom row has ${m.bottomRow.length} keys, expected 6`)

  // ── The invariant ──
  for (const k of m.bottomRow) {
    if (!k.visible) fail(`${k.id}: checkVisibility() false`)
    if (!k.hitIsSelf) fail(`${k.id}: elementFromPoint at its centre returns ${k.hit}, not the key — occluded`)
    if (k.clearancePx < SAVE_BAND_MIN_CLEARANCE_PX) {
      fail(`${k.id}: clears the Save band by ${k.clearancePx}px, minimum is ${SAVE_BAND_MIN_CLEARANCE_PX}px`)
    }
  }

  const min = Math.min(...m.bottomRow.map(k => k.clearancePx))
  console.log(`[save-band-clearance] ${VIEWPORT.w}x${VIEWPORT.h} (frame self-reports ${m.frame.vw}x${m.frame.vh}, scrollW ${m.frame.scrollW})`)
  console.log(`[save-band-clearance] band y${m.band.top}-${m.band.bottom} h${m.band.height} ${m.band.visibility}/${m.band.pointerEvents}`)
  console.log(`[save-band-clearance] weight keypad bottom row: min clearance ${min}px (floor ${SAVE_BAND_MIN_CLEARANCE_PX}px), all six keys hit-test to themselves: ${m.bottomRow.every(k => k.hitIsSelf)}`)
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (failures.length) {
  console.error('\n[save-band-clearance] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[save-band-clearance] PASS')
