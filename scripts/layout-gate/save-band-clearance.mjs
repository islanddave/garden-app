#!/usr/bin/env node
// save-band-clearance.mjs — BUG-WEIGHPADSAVEBAND-001's real-engine gate.
//
//   node scripts/layout-gate/save-band-clearance.mjs        # npm run gate:save-band
//
// ASSERTS, at a TRUE 390x500 in real Chrome: in the harvest weigh-in session, once the user has
// moved to the weight field, every key in the weight keypad's bottom row is (a) visible per
// checkVisibility(), (b) returned by elementFromPoint at its own centre, and (c) clear of the Save
// row by that arm's floor.
//
// TWO ARMS, BOTH ASSERTED, NEITHER SKIPPED — see §ARM DETECTION below. Since 2026-08-25 the shipped
// default is the fixed frame, which has no sticky band; the legacy band is the rollback lever. The
// gate identifies the rendered arm and asserts what is true of it, and FAILS on one it cannot
// identify.
//   LEGACY  (c) is SAVE_BAND_MIN_CLEARANCE_PX above the sticky band's top edge.
//   FRAME   (c) is SAVE_BAND_MIN_CLEARANCE_PX above SAVE'S top edge — the SAME floor, because it is
//           the same hazard (V4-WEIGHFRAME-001 R1) — plus "not underneath track 3", proof that the
//           strip between them is DEAD, per-entry weight-pad travel of 0px in VIEWPORT coordinates,
//           and Save on-screen and hit-testing to itself at all four entries.
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
import { SAVE_BAND_MIN_CLEARANCE_PX, FRAME_SAVE_HEIGHT_PX } from '../../src/lib/saveBandLayout.js'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5312)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9422)
const VIEWPORT = { w: 390, h: 500 }
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Launch flags this machine does not need but another environment does. CI passes --no-sandbox:
// a Chrome that cannot open its sandbox never exposes CDP, which fails this gate for a reason that
// has nothing to do with layout. Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)

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

// ── Chrome over CDP. Transport comes from cdp-socket.mjs: the global WebSocket where the runtime
// has one, else `ws` — CI pins Node 20.19.0, which has neither a global WebSocket nor this gate. ──
async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=900,900', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
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

// ── ARM DETECTION ──────────────────────────────────────────────────────────────────────────────
// V4-WEIGHFRAME-001 shipped WEIGH_IN_FRAME_ENABLED true, and the frame has NO sticky Save band: its
// Save lives in `weigh-frame-track3`, a real grid track. `save-sticky` now renders only on the
// rollback arm. So this gate cannot key off one testid any more — it detects which arm rendered and
// asserts what is TRUE of that arm.
//
// Both arms ship: the frame is the default, the legacy band is the rollback lever. Both therefore
// need a guard, and neither may be skipped. THE GATE FAILS ON AN ARM IT CANNOT IDENTIFY — a gate
// that no-ops on the default path is the vacuous-guard pattern this directory exists to refuse, and
// "no band found" must never resolve to "nothing to check".
//
// What each arm is asserted on, and why they differ rather than being forced into one number:
//   LEGACY  the band is a STICKY OVERLAY, so content can slide under it. The invariant is
//           CLEARANCE — SAVE_BAND_MIN_CLEARANCE_PX of gap between every bottom-row key and the
//           band's top edge. Unchanged from BUG-WEIGHPADSAVEBAND-001.
//   FRAME   two invariants, because track 3 being a grid track answers only one of them. STRUCTURAL:
//           the pad is never beneath the ledger (that would mean track 2 overflowed). MIS-TAP: the
//           same SAVE_BAND_MIN_CLEARANCE_PX, measured to SAVE'S top edge rather than the track's —
//           the first version of this gate asserted only the structural one and passed at 1px
//           (V4-WEIGHFRAME-001 R1), which is the whole reason the floor is now spelled against the
//           button. Plus the frame's own claims: per-entry weight-pad travel of 0px in VIEWPORT
//           coordinates, every bottom-row key hit-testing to itself, and Save on-screen and
//           hit-testing to itself at all four entries.
//
// Why VIEWPORT coordinates on the frame arm and not scrollTop: the frame's document is
// `overflow: hidden`, so scrollTop is pinned at 0 for the whole run. A scroll-based travel number
// there reads 0 for the wrong reason — it is a constant instrument, not a still page. The sibling
// gate's own non-vacuity precondition already refuses such a run.

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

  // Detect the arm BEFORE driving anything, so the legacy path below runs the exact sequence it has
  // always run. Ambiguity is a failure, never a default: one arm, identified, or the gate stops.
  const hasSticky = !!d.querySelector('[data-testid="save-sticky"]')
  const hasFrame = !!d.querySelector('[data-testid="weigh-frame-track3"]')
  if (hasSticky && hasFrame) throw new Error('BOTH save-sticky and weigh-frame-track3 rendered — the arms are not exclusive, every number below would be ambiguous')
  if (!hasSticky && !hasFrame) throw new Error('neither save-sticky nor weigh-frame-track3 rendered — the weigh-in surface is unrecognised, refusing to pass')
  const arm = hasFrame ? 'frame' : 'legacy'

  // Shared bottom-row extraction: group the keypad's 12 buttons by rounded top, take the lowest row.
  const bottomRowOf = (pad) => {
    const keys = [...pad.querySelectorAll('button')]
    const byTop = new Map()
    for (const k of keys) { const t = Math.round(k.getBoundingClientRect().top); if (!byTop.has(t)) byTop.set(t, []); byTop.get(t).push(k) }
    return { keys, bottomRow: [...byTop.entries()].sort((a,b)=>a[0]-b[0]).pop()[1] }
  }
  // The strip between a key and Save has to be DEAD, not merely empty: a gap measured in px says
  // nothing about what answers a tap landing in it. Sampled at the key's own centre-x so it probes
  // the column a low press would actually fall down, and it refuses anything clickable — a <button>,
  // or anything role=button — rather than only refusing Save by name.
  const stripIsDead = (k, from, to) => {
    const r = k.getBoundingClientRect()
    const x = r.left + r.width/2
    const hits = []
    for (let n = 0; n <= 4; n++) {
      const y = from + (to - from) * (n / 4)
      const el = d.elementFromPoint(x, y)
      if (!el) { hits.push('null'); continue }
      const clickable = el.closest('button, [role="button"], a, input, select, textarea')
      hits.push((clickable ? '!' : '') + (el.dataset?.testid ? '#' + el.dataset.testid : el.tagName.toLowerCase()))
    }
    return { x: +x.toFixed(1), from: +from.toFixed(1), to: +to.toFixed(1), hits, dead: hits.every(h => !h.startsWith('!')) }
  }
  const probeKey = (k, refTop, saveRect) => {
    const r = k.getBoundingClientRect()
    const hit = d.elementFromPoint(r.left + r.width/2, r.top + r.height/2)
    const overlapsSaveX = saveRect ? (r.left < saveRect.right && r.right > saveRect.left) : null
    return {
      id: k.dataset.testid || k.getAttribute('aria-label'),
      left: +r.left.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
      visible: k.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
      hitIsSelf: hit === k || k.contains(hit),
      hit: hit ? (hit.dataset?.testid ? '#' + hit.dataset.testid : hit.tagName.toLowerCase()) : null,
      clearancePx: refTop == null ? null : +(refTop - r.bottom).toFixed(1),
      // V4-WEIGHFRAME-001 R1 — the mis-tap distance. Save's TOP edge, not the track's: Save is
      // bottom-aligned in track 3, so the two differ by exactly the height the button gives up.
      saveClearancePx: saveRect ? +(saveRect.top - r.bottom).toFixed(1) : null,
      overlapsSaveX,
      strip: saveRect && overlapsSaveX ? stripIsDead(k, r.bottom + 1, saveRect.top - 1) : null,
    }
  }

  if (arm === 'frame') {
    // ⚠️ The harness auto-opens the planting chooser and prod does not (tests/harness/main.jsx:85-92).
    // It expands the page and moves every field below it, so it is dismissed before measuring —
    // Escape does not close it; its own control is the only way out.
    if (d.querySelector('[role="listbox"]')) {
      const close = d.querySelector('[data-testid="ps-close"]')
      if (close) { H.tap(close); await H.settle(10) }
    }
    if (d.querySelector('[role="listbox"]')) throw new Error('auto-opened planting chooser would not dismiss — measurement would describe a layout the user never sees')

    const padEl = () => d.querySelector('[aria-label="Harvest weight keypad"]')
    const padTop = () => { const p = padEl(); return p ? Math.round(p.getBoundingClientRect().top) : null }
    const t3El = () => d.querySelector('[data-testid="weigh-frame-track3"]')
    const saveEl = () => { const t = t3El(); return t ? [...t.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Save') : null }
    // Quiescence on the PAD's viewport y, NOT scrollTop: the frame's document cannot scroll, so a
    // scroll-based settle would report "converged" instantly and always.
    const settlePad = async (stable = 4, cap = 26) => {
      let last = padTop(), n = 0
      for (let i = 0; i < cap; i++) {
        await H.sleepReal(120)
        const now = padTop()
        if (now === last) { if (++n >= stable) return { v: now, converged: true } } else { n = 0; last = now }
      }
      return { v: padTop(), converged: false }
    }

    const entries = []
    for (let i = 1; i <= 4; i++) {
      const e = { i, samples: [], stalled: [] }
      const S = at => e.samples.push({ at, v: padTop() })
      const SR = async at => { const r = await settlePad(); if (!r.converged) e.stalled.push(at); e.samples.push({ at, v: r.v }) }

      const pIn = d.querySelector('[data-testid="evtnew-planting"]')
      if (pIn && !d.querySelector('[data-testid="evtnew-planting-chip"]')) {
        S('before-picker-open')
        H.tap(pIn, { focus: true }); await H.settle(6)
        const lb = await H.waitFor(() => d.querySelector('[role="listbox"]'), { label: 'planting listbox' })
        S('picker-open')
        H.tap(lb.querySelector('[role="option"]')); await H.settle(12)
        await SR('after-pick')
      }
      const qty = d.getElementById('harvest-quantity')
      S('before-qty-focus'); H.tap(qty, { focus: true }); qty.focus(); await H.settle(14); await SR('qty-focus-settled')
      H.typeInto(qty, '3'); await H.settle(6); S('after-qty-typed')
      const wt = d.getElementById('harvest-weight')
      if (!wt) throw new Error('#harvest-weight absent — is the weigh-in session mounted?')
      S('before-weight-focus'); H.tap(wt, { focus: true }); wt.focus(); await H.settle(14); await SR('weight-focus-settled')

      const pad = padEl(); if (!pad) throw new Error('weight keypad absent at the weigh-in step')
      const { keys, bottomRow } = bottomRowOf(pad)
      for (let k = 0; k < 3 && k < keys.length; k++) { H.tap(keys[k]); await H.settle(8); S('padkey'+(k+1)) }

      // Measured with the pad and Save both live — the moment a mis-tap would happen.
      const t3 = t3El(), save = saveEl()
      if (!t3 || !save) throw new Error('track 3 or its Save button absent at the weigh-in step')
      const t3r = t3.getBoundingClientRect(), sr = save.getBoundingClientRect()
      const t3cs = w.getComputedStyle(t3)
      const shit = d.elementFromPoint(sr.left + sr.width/2, sr.top + sr.height/2)
      e.keyCount = keys.length
      e.bottomRow = bottomRow.map(k => probeKey(k, t3r.top, sr))
      e.track3 = {
        top: +t3r.top.toFixed(1), height: +t3r.height.toFixed(1),
        visibility: t3cs.visibility, pointerEvents: t3cs.pointerEvents,
      }
      e.save = {
        left: +sr.left.toFixed(1), right: +sr.right.toFixed(1), top: +sr.top.toFixed(1), bottom: +sr.bottom.toFixed(1),
        height: +sr.height.toFixed(1), width: +sr.width.toFixed(1),
        onScreen: sr.left >= 0 && sr.right <= w.innerWidth + 0.5 && sr.top >= 0 && sr.bottom <= w.innerHeight + 0.5,
        visible: save.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        hitIsSelf: shit === save || save.contains(shit),
        hit: shit ? (shit.dataset?.testid ? '#' + shit.dataset.testid : (shit.textContent||'').trim().slice(0,12) || shit.tagName.toLowerCase()) : null,
      }

      H.tap(save)
      try { await H.waitFor(() => d.getElementById('harvest-quantity') && d.getElementById('harvest-quantity').value === '' && !d.querySelector('[data-testid="evtnew-planting-chip"]'), { label: 'session reset', timeout: 9000 }) }
      catch (err) { e.saveWaitErr = String(err) }
      await H.settle(12); await SR('after-save')

      const v = e.samples.map(s => s.v).filter(x => x != null)
      e.path = v
      e.travel = v.slice(1).reduce((a,x,k)=>a+Math.abs(x-v[k]),0)
      e.net = v.length ? v[v.length-1] - v[0] : null
      entries.push(e)
    }
    return {
      arm,
      frame: { vw: w.innerWidth, vh: w.innerHeight, scrollW: d.documentElement.scrollWidth },
      docScrollHeight: d.documentElement.scrollHeight, docClientHeight: d.documentElement.clientHeight,
      entries,
    }
  }

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
  const { keys, bottomRow } = bottomRowOf(pad)

  return {
    arm,
    frame: { vw: w.innerWidth, vh: w.innerHeight, scrollW: d.documentElement.scrollWidth },
    band: {
      top: +bandR.top.toFixed(1), bottom: +bandR.bottom.toFixed(1), height: +bandR.height.toFixed(1),
      visibility: bandCS.visibility, pointerEvents: bandCS.pointerEvents, position: bandCS.position,
    },
    keyCount: keys.length,
    bottomRow: bottomRow.map(k => probeKey(k, bandR.top)),
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

// ── THE FRAME ARM'S NUMBERS ────────────────────────────────────────────────────────────────────
// Measured 2026-08-25 on lane-frameon at a true 390x500, WEIGH_IN_FRAME_ENABLED true, four entries.
//
// TRAVEL. The frame's headline claim is that the weight pad does not move under the thumb. Measured
// in VIEWPORT coordinates the pad's top is 295 at every one of the 14 sample points of entries 2, 3
// and 4 — travel 0, net 0. The control is the same script one commit earlier with the flag false:
// 482 / 538 / 594px of travel at the same entries, from 12 distinct pad positions. That delta is
// what makes 0 a measurement rather than a broken instrument.
const FRAME_STEADY_TRAVEL_PX = 0
// Entry 1 alone is allowed one settle: PlantingSelect swaps a 62px search input for a 52px chip on
// pick, moving track 2's top edge by 10px once, and the 1fr disclosure row absorbs whatever of that
// it still has spare. So this number is not free-floating — it is `10 - row0's remaining slack`,
// which was 3 when that row had 7px and is 8 now that R1 has spent 5 of them. Measured 8 at entries
// 1 and 0 at 2-4; 12 leaves headroom for a font metric without hiding a real jump.
// This is a MOUNT-only settle, not a per-entry one: entries 2-4 return to the same pre-pick state
// after each save and measure 0, because track 1 no longer swings once a chip has been picked.
const FRAME_FIRST_ENTRY_SETTLE_PX = 12
// STRUCTURAL floor: the pad may sit close to track 3 but never BENEATH it. Negative means track 2
// overflowed and pushed the pad under the ledger — measured to happen when the planting chip wraps
// to a second line, at a name of 72 characters or more (the longest real planting name today is 52).
// 0 rather than 20 because this is not the mis-tap rule: track 3 is a grid track, not an overlay, so
// nothing can slide under it while track 2 fits. The mis-tap rule is the next constant, and keeping
// them separate is deliberate — the first version of this gate had only this one and passed at 1px
// of clearance, because "not underneath the ledger" was true and says nothing about Save.
const FRAME_MIN_PAD_TO_TRACK3_PX = 0
// THE MIS-TAP FLOOR (V4-WEIGHFRAME-001 R1). Key bottom -> Save top, same number as the legacy arm
// and for the same stated reason. MEASURED after the fix, all four entries: bottom row y336-384,
// track 3 top y399, Save y404-448 — 20.0px, with the 15px above the track and the 4px inside it
// (Save is 44 tall in a 48 row, bottom-aligned) both dead to elementFromPoint.
const FRAME_MIN_PAD_TO_SAVE_PX = SAVE_BAND_MIN_CLEARANCE_PX

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

  console.log(`[save-band-clearance] ${VIEWPORT.w}x${VIEWPORT.h} (frame self-reports ${m.frame.vw}x${m.frame.vh}, scrollW ${m.frame.scrollW}) — arm: ${m.arm}`)

  if (m.arm === 'frame') {
    // ── FRAME ARM ────────────────────────────────────────────────────────────────────────────────
    // Non-vacuity first. Track 3 must be a real, painted, pointer-taking row, and the keypad must
    // yield its full six-key bottom row — otherwise "no key is occluded" is true of nothing.
    if (m.entries.length !== 4) fail(`only ${m.entries.length} of 4 entries completed — the run did not reach steady state`)
    if (m.docScrollHeight !== m.docClientHeight) {
      fail(`document scrollHeight ${m.docScrollHeight} != clientHeight ${m.docClientHeight} — the frame's document IS scrollable, which is the one thing it claims not to be`)
    }
    for (const e of m.entries) {
      if (e.saveWaitErr) fail(`entry ${e.i}: the save never reset the session (${e.saveWaitErr})`)
      if (e.stalled?.length) fail(`entry ${e.i}: still moving when sampling gave up at [${e.stalled.join(', ')}] — that IS the jump this gate is about`)
      if (!e.track3 || e.track3.height <= 0) fail(`entry ${e.i}: track 3 has zero height — every assertion about it would pass vacuously`)
      if (e.track3?.visibility !== 'visible') fail(`entry ${e.i}: track 3 visibility is '${e.track3?.visibility}' — Save is not on screen to be cleared of`)
      if (e.track3?.pointerEvents !== 'auto') fail(`entry ${e.i}: track 3 pointerEvents is '${e.track3?.pointerEvents}' — Save takes no taps`)
      if (e.keyCount !== 12) fail(`entry ${e.i}: weight keypad rendered ${e.keyCount} keys, expected 12`)
      if (e.bottomRow.length !== 6) fail(`entry ${e.i}: bottom row has ${e.bottomRow.length} keys, expected 6`)
      if (new Set(e.bottomRow.map(k => k.left)).size !== e.bottomRow.length) {
        fail(`entry ${e.i}: bottom-row keys do not have distinct left edges — the instrument is reading one rect six times`)
      }

      // THE INVARIANT — every bottom-row key painted, reachable, and not underneath track 3.
      for (const k of e.bottomRow) {
        if (!k.visible) fail(`entry ${e.i} ${k.id}: checkVisibility() false`)
        if (!k.hitIsSelf) fail(`entry ${e.i} ${k.id}: elementFromPoint at its centre returns ${k.hit}, not the key — occluded`)
        if (k.left < 0 || k.right > VIEWPORT.w + 0.5) {
          fail(`entry ${e.i} ${k.id}: sits at x${k.left}-${k.right}, outside a ${VIEWPORT.w}px viewport — unreachable`)
        }
        // NOT SAVE_BAND_MIN_CLEARANCE_PX: there is no overlay to clear. Track 3 is a grid track, so
        // the only way the pad can reach it is by track 2 overflowing, and a NEGATIVE gap means the
        // pad has been pushed underneath the ledger row. Measured 2026-08-25 the gap is exactly 0.
        if (k.clearancePx < FRAME_MIN_PAD_TO_TRACK3_PX) {
          fail(`entry ${e.i} ${k.id}: bottom is ${-k.clearancePx}px BELOW track 3's top edge — track 2 has overflowed and pushed the pad under the ledger`)
        }
        // THE MIS-TAP RULE. Not occlusion — every key above still hit-tests to itself — but the
        // distance between a corrective key and an irreversible commit, which is what a low press
        // crosses. Recovery is Undo-then-redo, so this is the expensive direction.
        if (k.saveClearancePx < FRAME_MIN_PAD_TO_SAVE_PX) {
          fail(`entry ${e.i} ${k.id}: bottom is ${k.saveClearancePx}px above Save's top edge, minimum is ${FRAME_MIN_PAD_TO_SAVE_PX}px — a low press on this key commits the entry`)
        }
        // ...and the px are only worth having if nothing in them takes a tap. A gap that answers
        // with a button is the same defect measured differently.
        if (k.strip && !k.strip.dead) {
          fail(`entry ${e.i} ${k.id}: the strip between it and Save is not dead — elementFromPoint down x${k.strip.x} returns [${k.strip.hits.join(', ')}] (! = clickable)`)
        }
      }

      // Save must be on screen and reachable at every entry. BUG at 76e5c96: an implicit `auto` grid
      // column sized to max-content and put Save at x424-574 from entry 2 — painted, clipped, gone.
      if (!e.save.onScreen) fail(`entry ${e.i}: Save at x${e.save.left}-${e.save.right} y${e.save.top}-${e.save.bottom} is outside the ${VIEWPORT.w}x${VIEWPORT.h} viewport`)
      if (!e.save.visible) fail(`entry ${e.i}: Save checkVisibility() false`)
      if (!e.save.hitIsSelf) fail(`entry ${e.i}: elementFromPoint at Save's centre returns ${e.save.hit}, not the button — occluded`)
      // R1 bought 4px of its clearance off this button's height, so the floor it landed on is
      // asserted here rather than left to a comment. It also keeps `saveClearancePx` honest: that
      // number is measured from `sr.top`, and a degenerate rect would make every gap above look fine.
      if (e.save.height < FRAME_SAVE_HEIGHT_PX || e.save.width < FRAME_SAVE_HEIGHT_PX) {
        fail(`entry ${e.i}: Save is ${e.save.width}x${e.save.height}, under the ${FRAME_SAVE_HEIGHT_PX}px WCAG 2.5.5 floor it was reduced to`)
      }

      // THE HEADLINE PROPERTY. Viewport coordinates, never scrollTop: this document is
      // overflow:hidden, so a scroll-based zero would be a constant instrument rather than a still
      // page. Entry 1 legitimately settles once — the chooser swaps a 62px search input for a 52px
      // chip, moving track 2's top edge — so the budget applies from steady state.
      const budget = e.i === 1 ? FRAME_FIRST_ENTRY_SETTLE_PX : FRAME_STEADY_TRAVEL_PX
      if (e.travel > budget) {
        fail(`entry ${e.i}: the weight pad travelled ${e.travel}px in viewport coordinates (budget ${budget}px) via ${JSON.stringify(e.path)}`)
      }
      if (e.i >= 2 && e.net !== 0) fail(`entry ${e.i}: net displacement ${e.net}px — entry ${e.i + 1} would not begin where entry ${e.i} did`)
    }

    const gap = Math.min(...m.entries.flatMap(e => e.bottomRow.map(k => k.clearancePx)))
    const saveGap = Math.min(...m.entries.flatMap(e => e.bottomRow.map(k => k.saveClearancePx)))
    const over = m.entries[0].bottomRow.filter(k => k.overlapsSaveX).map(k => k.id)
    console.log(`[save-band-clearance] track 3 y${m.entries[0].track3.top} h${m.entries[0].track3.height} ${m.entries[0].track3.visibility}/${m.entries[0].track3.pointerEvents} (a grid track — no sticky band to clear)`)
    console.log(`[save-band-clearance] weight-pad travel per entry (VIEWPORT px): ${m.entries.map(e => e.i + ':' + e.travel).join('  ')}`)
    console.log(`[save-band-clearance] min pad-to-track-3 gap ${gap}px (floor ${FRAME_MIN_PAD_TO_TRACK3_PX}px); all six keys and Save hit-test to themselves at every entry: ${m.entries.every(e => e.bottomRow.every(k => k.hitIsSelf) && e.save.hitIsSelf)}`)
    console.log(`[save-band-clearance] min pad-to-SAVE gap ${saveGap}px (floor ${FRAME_MIN_PAD_TO_SAVE_PX}px), Save ${m.entries[0].save.width}x${m.entries[0].save.height} at y${m.entries[0].save.top}-${m.entries[0].save.bottom}`)
    console.log(`[save-band-clearance] keys sharing Save's x-range: ${over.length ? over.join(', ') : 'none'} — the strip below each is dead to elementFromPoint: ${m.entries.every(e => e.bottomRow.every(k => !k.strip || k.strip.dead))}`)
  } else {
    // ── LEGACY ARM — unchanged from BUG-WEIGHPADSAVEBAND-001 ──────────────────────────────────────
    // Non-vacuity: the band must actually be able to occlude something.
    if (m.band.position !== 'sticky') fail(`band position is '${m.band.position}', not sticky — gate is measuring the wrong element`)
    if (m.band.visibility !== 'visible') fail(`band visibility is '${m.band.visibility}' — clearance would pass vacuously`)
    if (m.band.pointerEvents !== 'auto') fail(`band pointerEvents is '${m.band.pointerEvents}' — clearance would pass vacuously`)
    if (m.band.height <= 0) fail('band has zero height — clearance would pass vacuously')
    if (m.keyCount !== 12) fail(`weight keypad rendered ${m.keyCount} keys, expected 12`)
    if (m.bottomRow.length !== 6) fail(`bottom row has ${m.bottomRow.length} keys, expected 6`)

    // The invariant.
    for (const k of m.bottomRow) {
      if (!k.visible) fail(`${k.id}: checkVisibility() false`)
      if (!k.hitIsSelf) fail(`${k.id}: elementFromPoint at its centre returns ${k.hit}, not the key — occluded`)
      if (k.clearancePx < SAVE_BAND_MIN_CLEARANCE_PX) {
        fail(`${k.id}: clears the Save band by ${k.clearancePx}px, minimum is ${SAVE_BAND_MIN_CLEARANCE_PX}px`)
      }
    }

    const min = Math.min(...m.bottomRow.map(k => k.clearancePx))
    console.log(`[save-band-clearance] band y${m.band.top}-${m.band.bottom} h${m.band.height} ${m.band.visibility}/${m.band.pointerEvents}`)
    console.log(`[save-band-clearance] weight keypad bottom row: min clearance ${min}px (floor ${SAVE_BAND_MIN_CLEARANCE_PX}px), all six keys hit-test to themselves: ${m.bottomRow.every(k => k.hitIsSelf)}`)
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
  console.error('\n[save-band-clearance] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[save-band-clearance] PASS')
