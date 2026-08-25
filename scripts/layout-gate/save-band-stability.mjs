#!/usr/bin/env node
// save-band-stability.mjs — the weigh-in session's "it doesn't jump around" invariant.
//
//   node scripts/layout-gate/save-band-stability.mjs             # npm run gate:save-band-stability
//   node scripts/layout-gate/save-band-stability.mjs --report    # measure only, never fails, prints JSON
//   VH=844 node scripts/layout-gate/save-band-stability.mjs --report   # the keyboard-DOWN control run
//
// ASSERTS, at a TRUE 390x500 in real Chrome, driving four consecutive harvest entries through the
// weigh-in session (pick planting -> qty -> weight -> three keypad digits -> Save):
//   1. every entry's TOTAL VERTICAL TRAVEL (the sum of |Δ scrollTop| across the entry's steps, i.e.
//      how far the page moves under the user's thumb, NOT where it ends up) is within a stated,
//      named budget;
//   2. every steady-state entry's NET DISPLACEMENT is exactly zero — the session returns the user to
//      the same offset it started them at, so entry N+1 begins where entry N began;
//   3. the Save band's height follows the exact recorded progression as the session ledger grows.
//
// WHY THIS EXISTS. Dave's requirement for the weigh-in session is that it "doesn't jump around up
// and down". That was a preference, not an invariant, and preferences do not survive diffs. Its
// sibling gate (save-band-clearance.mjs) exists because the shipped Save-band CLEARANCE silently
// drifted +1px -> -15px with nobody noticing; there is no reason to expect scroll STABILITY to be
// any better behaved. jsdom cannot see this at all — it has no layout engine, no scrollTop that
// responds to layout, and no smooth-scroll — so no test under src/__tests__/** can distinguish "the
// page holds still" from "the page travels 594px per entry" (tests/harness/README.md §Limits).
//
// ── THREE MEASUREMENT TRAPS THIS SCRIPT EXISTS TO AVOID ────────────────────────────────────────
//  1. VIEWPORT. macOS Chrome floors an OS window at ~500px wide; `--window-size=390` lays the page
//     out at ~500 and CROPS the capture to 390, yielding a plausible mobile screenshot of a desktop
//     layout. The page is therefore loaded in a 390x500 IFRAME inside a 900x900 window, and this
//     gate REFUSES TO PASS unless the frame self-reports innerWidth/innerHeight 390x500 with no
//     horizontal overflow. An instrument that cannot prove its own viewport fails closed.
//  2. OCCLUSION. offsetParent (and a non-zero rect) report content buried under an opaque sibling —
//     and content hidden by `content-visibility` — as visible. Only checkVisibility() knows the
//     latter and only elementFromPoint answers the former, so the non-vacuity checks below use
//     BOTH. Never reach for offsetParent in this directory.
//  3. ⚠️ THE HARNESS AUTO-OPENS THE PLANTING CHOOSER AND PROD DOES NOT. tests/harness/main.jsx:85-92
//     documents this: the real weigh-in URL carries `session=harvest` with NO `event_type`, which is
//     exactly why harvestFabAutoOpen does not fire there — the session's tray is the picker. The
//     harness must add `event_type` to render the panel at all, and that ALSO satisfies
//     `preselectedEventType === 'harvest'`, so a chooser pops open here that would not in prod. That
//     note ends "do NOT use this mount to reason about auto-open". A modal chooser also owns its own
//     scroll container, so measuring travel with one open measures the WRONG element. This script
//     therefore DISMISSES the chooser before any measurement and FAILS if it cannot — see
//     dismissAutoChooser in the drive below. If you add a step here, keep it after the dismissal.
//
// NON-VACUITY. A stability gate that measures a page which never scrolls at all, or a band that is
// not painted, passes for the wrong reason — this repo has shipped several gates that could not
// fail. The preconditions below fail the run if the band is missing/hidden/pointer-transparent/zero
// height, if the Save button does not hit-test to itself, if fewer than four entries completed, or
// if scrollTop never varied across the whole run (a constant instrument, cf. the "bound scoring
// exactly 0.0% across every row" class of false pass).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Distinct from save-band-clearance.mjs's 5312/9422 on purpose, so both gates can run at once and
// so a peer worktree holding those ports does not wedge this one. 20+ sibling worktrees exist.
const PORT = Number(process.env.GATE_HARNESS_PORT || 5313)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9423)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const REPORT_ONLY = process.argv.includes('--report')
// Height is overridable ONLY in --report mode: the asserted numbers below are 390x500 facts, and a
// run at another height that still claimed to check them would be the exact "confident wrong answer"
// this file is built to prevent.
const VIEWPORT = { w: 390, h: REPORT_ONLY ? Number(process.env.VH || 500) : 500 }

// ── THE BUDGET ─────────────────────────────────────────────────────────────────────────────────
// Total vertical travel one harvest entry is allowed to move the page under the user, in CSS px,
// at 390x500 with the keyboard up. Travel is the SUM of the absolute scroll deltas across the
// entry's 13 hops — it counts churn, not final position, which is the thing Dave actually feels.
//
// The budget is stated as a SUM OF NAMED PARTS rather than one number, because its two parts have
// different lifetimes and a single 594 would hide which half a future diff moved.
//
// PART 1 — the anchor scrolls this tree performs on every entry. Measured 2026-08-25 on dev
// e5a8ab9 at 390x500, identical at every steady-state entry (2, 3 and 4) and identical again at
// 390x844, i.e. viewport-independent:
//     213 -> ~230   (+17)   quantity focus, anchorSectionToTop starting
//    ~230 ->  339  (+109)   anchorSectionToTop landing (smooth)
//     339 ->  213  (-126)   Save — re-anchor to the top of the planting row
const BASE_ENTRY_TRAVEL_PX = 252
//
// PART 2 — the Save-band CLEARANCE scroll, which is NOT in this tree. BUG-WEIGHPADSAVEBAND-001's
// fix (lane-weighband, commit eeee76a, a direct child of this same base) scrolls the weigh-in on
// weight focus so the keypad clears the band. Measured on THAT tree, the same four entries run:
//     339 ->  510  (+171)   weight focus — the clearance scroll
//     510 ->  213  (-297)   Save — the now-longer re-anchor
// which is 594 total, and the identical run at 390x844 there totals 252 because the clearance
// scroll fires 0px at every entry with the keyboard down. That control is the proof of causation:
// the delta between the two heights IS the clearance scroll and nothing else.
const CLEARANCE_SCROLL_ALLOWANCE_PX = 342
//
// WHY THE CEILING ADMITS A SCROLL THIS TREE DOES NOT HAVE. The clearance fix and this gate are
// separate lanes off the same base, and the fix is already written and mutation-proved. A budget
// pinned to 252 would fail the instant it merged — a gate blocking a fix, not a regression. So the
// ceiling admits it and nothing more. The cost is that on a tree without the clearance scroll this
// budget carries 342px of slack; the run prints exactly that, and the number to tighten to, every
// time (see the SLACK NOTE below). Tighten it as soon as the lanes are merged and settled.
//
// WHEN IT MAY BE LOWERED: freely, and it should be. A sibling lane is building a fixed frame whose
// target is "nothing moves except the IME reflow"; when that lands, most of these hops go to zero.
// RE-BASELINE PROCEDURE — two commands, no guessing:
//     node scripts/layout-gate/save-band-stability.mjs --report        # prints per-entry travel
//     # set BASE_ENTRY_TRAVEL_PX to the reported max entry travel, drop CLEARANCE_SCROLL_ALLOWANCE_PX
//     # to 0 if the clearance scroll is gone, and say in the commit WHY it dropped
// Lowering is a one-line diff with a visible reason. RAISING is the move that needs argument: a diff
// that increases travel is the regression this file was written to catch, so a raise must carry the
// measurement and the reason in the same commit, exactly as the clearance floor does.
const MAX_ENTRY_TRAVEL_PX = BASE_ENTRY_TRAVEL_PX + CLEARANCE_SCROLL_ALLOWANCE_PX // 594

// If measured travel comes in this far under budget, the budget has gone slack and is no longer
// catching anything — say so loudly. Deliberately ADVISORY, not a failure: failing a run because
// the app got BETTER would punish the fixed-frame lane for succeeding.
const SLACK_NOTICE_PX = 100

// ── THE BAND PROGRESSION ───────────────────────────────────────────────────────────────────────
// The sticky Save band's height, in CSS px, at [before any save, after save 1, 2, 3, 4]. The band is
// not a constant: the weigh-in session's ledger grows inside it, and from the 4th save it also adds
// an 18px "+N earlier" summary line. Measured 2026-08-25 at 390x500 AND independently at 390x844 —
// identical at both, so this is a content progression, not a viewport artifact.
//
// This is pinned because the repo's own clearance rule (src/lib/saveBandLayout.js:9-11, on the
// lane-weighband branch) states a 184px cap, and the real 4th-save height is 202px — the rule is
// reasoning 18px short of the band it resolves against. Pinning the true progression here means the
// next change to the ledger row markup cannot move these numbers without someone noticing.
const BAND_HEIGHT_PROGRESSION_PX = [48, 128, 156, 184, 202]

const ENTRIES = 4
// Entry 1 starts at scrollTop 0 and descends into the form, so its net displacement is legitimately
// non-zero. Steady state — the loop Dave actually lives in — is entry 2 onward.
const STEADY_FROM_ENTRY = 2

// ── Boot the layout harness (tests/harness) ────────────────────────────────────────────────────
// Vite is spawned through its own bin, NOT `npx vite`: npx is a wrapper process, so killing it at
// teardown orphans the real server, which keeps this script's stdout pipe open forever and hangs any
// caller that pipes it (`... | tail`). Killing the server directly is the whole point.
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
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 180000)
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

// ── The drive, run inside the driver page against the 390x500 child frame ──────────────────────
// The step list per entry mirrors what a person does: pick a planting, type a count, move to the
// weigh-in, tap three digits, Save. scrollTop is sampled at every step, and travel is the sum of the
// absolute deltas between consecutive samples.
const DRIVE = `(async () => {
  const f = document.getElementById('f')
  for (let i=0;i<240;i++){ try { if (f.contentWindow && f.contentWindow.__h && f.contentWindow.__h.ready()) break } catch {} await new Promise(r=>setTimeout(r,100)) }
  const w = f.contentWindow
  if (!(w.__h && w.__h.ready())) throw new Error('harness never became ready in the child frame')
  const H = w.__h, d = w.document
  const sc = () => (d.scrollingElement || d.documentElement)
  const top = () => Math.round(sc().scrollTop)
  const out = { steps: [], entries: [], bandHeights: [] }

  // ── Wait for the page to STOP MOVING, rather than sleeping a fixed guess ───────────────────────
  // Every anchor in this flow is a SMOOTH scroll, and the save also reflows the band (the ledger row
  // is added, and from the 4th save an extra "+N earlier" line). A fixed sleep samples whatever
  // happens to be on screen at that instant: measured 2026-08-25, a fixed 900ms post-save sleep read
  // entry 4's resting offset as 213 on one run and 99 on the next, from the same tree — a 114px
  // spread that is the instrument, not the app. Polling to quiescence removes that entirely.
  // 'converged: false' means the page was STILL MOVING when the cap ran out, which is itself the
  // "jumps around" symptom and is reported rather than silently sampled.
  const settleScroll = async (stableTicks = 4, capTicks = 26) => {
    let last = top(), stable = 0
    for (let i = 0; i < capTicks; i++) {
      await H.sleepReal(120)
      const now = top()
      if (now === last) { if (++stable >= stableTicks) return { v: now, ticks: i + 1, converged: true } }
      else { stable = 0; last = now }
    }
    return { v: top(), ticks: capTicks, converged: false }
  }

  const bandEl = () => d.querySelector('[data-testid="save-sticky"]')
  const bandH = () => { const b = bandEl(); return b ? Math.round(b.getBoundingClientRect().height) : null }
  const chooserOpen = () => !!d.querySelector('[role="listbox"]')

  await H.settle(10)
  const tile = H.byText('Harvested'); if (tile) { H.tap(tile); await H.settle(10) }
  await H.waitFor(() => d.getElementById('harvest-quantity'), { label: 'harvest panel' })

  // ⚠️ Trap 3 (see header). The harness auto-opens the planting chooser; prod does not. A modal
  // chooser owns its own scroll container, so every number below would describe the wrong element.
  // Dismiss it, and refuse to continue if it will not go.
  // The chooser is INLINE, not a modal: measured 2026-08-25 it has no role="dialog", no
  // aria-modal, leaves body overflow 'visible', and expands the page to scrollHeight 1174. So it
  // does not hijack the scroller — but it does change the page's height and the position of every
  // field below it, which is enough to make travel numbers describe a layout the user never sees.
  // Escape does NOT close it (tried on document, the listbox, the active element and window — all
  // four leave it open) and neither does blurring. Its own close control is the only way out.
  out.autoChooserWasOpen = chooserOpen()
  if (out.autoChooserWasOpen) {
    const close = d.querySelector('[data-testid="ps-close"]')
    if (close) { H.tap(close); await H.settle(10) }
  }
  out.chooserOpenAtMeasureStart = chooserOpen()
  if (out.chooserOpenAtMeasureStart) throw new Error('auto-opened planting chooser would not dismiss — measurement would read the modal scroller, not the page')

  await H.settle(6)
  out.bandHeights.push(bandH())

  const doEntry = async (i) => {
    const e = { i, samples: [], stalled: [] }
    const S = (at) => e.samples.push({ at, v: top() })
    // Sample a RESTING position: wait for quiescence first, and record any step that never settled.
    const SR = async (at) => { const r = await settleScroll(); if (!r.converged) e.stalled.push(at); e.samples.push({ at, v: r.v }) }

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
    S('before-qty-focus')
    H.tap(qty, { focus: true }); qty.focus()
    await H.settle(4)
    S('qty-focus-immediate')
    await H.settle(14)
    await SR('qty-focus-settled')
    H.typeInto(qty, '3'); await H.settle(6)
    S('after-qty-typed')

    const wt = d.getElementById('harvest-weight')
    if (!wt) throw new Error('#harvest-weight absent — is the weigh-in session mounted?')
    S('before-weight-focus')
    H.tap(wt, { focus: true }); wt.focus()
    await H.settle(4)
    S('weight-focus-immediate')
    await H.settle(14)
    await SR('weight-focus-settled')

    const wpad = d.querySelector('[aria-label="Harvest weight keypad"]')
    if (!wpad) throw new Error('weight keypad absent at the weigh-in step')
    const keys = [...wpad.querySelectorAll('button')]
    e.weightKeyCount = keys.length
    for (let k = 0; k < 3 && k < keys.length; k++) { H.tap(keys[k]); await H.settle(8); S('padkey' + (k + 1)) }

    // Non-vacuity, taken at the moment the band is tallest and most able to occlude: the Save button
    // must be painted AND reachable. checkVisibility + elementFromPoint, never offsetParent.
    const band = bandEl()
    const saveBtn = band ? band.querySelector('button:not([aria-label^="Undo"])') : null
    if (band && saveBtn) {
      const cs = w.getComputedStyle(band), br = band.getBoundingClientRect(), sr = saveBtn.getBoundingClientRect()
      const hit = d.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2)
      e.bandProbe = {
        h: Math.round(br.height), position: cs.position, visibility: cs.visibility, pointerEvents: cs.pointerEvents,
        saveVisible: saveBtn.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        saveHitIsSelf: hit === saveBtn || saveBtn.contains(hit),
        saveHit: hit ? (hit.dataset?.testid ? '#' + hit.dataset.testid : hit.tagName.toLowerCase()) : null,
      }
    }

    if (saveBtn) {
      H.tap(saveBtn)
      try {
        await H.waitFor(() => d.getElementById('harvest-quantity') && d.getElementById('harvest-quantity').value === '' && !d.querySelector('[data-testid="evtnew-planting-chip"]'), { label: 'session reset', timeout: 9000 })
      } catch (err) { e.saveWaitErr = String(err) }
      await H.settle(12)
      await SR('after-save')
    }
    out.bandHeights.push(bandH())

    const v = e.samples.map(s => s.v)
    e.path = v
    e.travel = v.slice(1).reduce((a, x, k) => a + Math.abs(x - v[k]), 0)
    e.net = v[v.length - 1] - v[0]
    return e
  }

  for (let i = 1; i <= ${ENTRIES}; i++) {
    try { out.entries.push(await doEntry(i)) } catch (err) { out.entries.push({ i, error: String(err) }); break }
  }

  out.frame = { vw: w.innerWidth, vh: w.innerHeight, scrollW: d.documentElement.scrollWidth, dpr: w.devicePixelRatio, hidden: d.hidden }
  out.distinctScrollTops = [...new Set(out.entries.flatMap(e => e.path || []))].length
  return out
})()`

const WRAP = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#333}
#f{display:block;width:${VIEWPORT.w}px;height:${VIEWPORT.h}px;border:0}
</style></head><body><iframe id="f" src="/tests/harness/?surface=fullpage&session=harvest"></iframe></body></html>`

const failures = []
const fail = m => failures.push(m)
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

let harness, chrome, cdp, m
const udd = mkdtempSync(join(tmpdir(), 'save-band-stability-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/` }, cdp.sessionId)
  await cdp.evalIn(`(async()=>{for(let i=0;i<150;i++){if(window.__h)return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('driver page never loaded the harness')})()`)
  // Same-origin wrapper written over the loaded page, so the parent can reach into the child frame.
  await cdp.evalIn(`(()=>{document.open();document.write(${JSON.stringify(WRAP)});document.close();return 1})()`, false)
  m = await cdp.evalIn(DRIVE)

  // ── Instrument first: an unproven viewport voids every number under it ──
  if (m.frame.vw !== VIEWPORT.w || m.frame.vh !== VIEWPORT.h) {
    fail(`frame is ${m.frame.vw}x${m.frame.vh}, expected ${VIEWPORT.w}x${VIEWPORT.h} — measurement void`)
  }
  if (m.frame.scrollW !== VIEWPORT.w) fail(`frame scrollWidth ${m.frame.scrollW} != ${VIEWPORT.w} — page overflows horizontally, the layout is not the one claimed`)
  if (m.chooserOpenAtMeasureStart) fail('planting chooser was still open when measurement began — travel would describe the modal scroller')

  // ── Non-vacuity: prove the instrument and the subject are both live ──
  const ok = m.entries.filter(e => !e.error)
  if (ok.length !== ENTRIES) fail(`only ${ok.length}/${ENTRIES} entries completed: ${m.entries.filter(e => e.error).map(e => `entry ${e.i}: ${e.error}`).join('; ')}`)
  if (m.distinctScrollTops < 2) fail(`scrollTop took ${m.distinctScrollTops} distinct value(s) across the whole run — the instrument is reading a constant, not the page`)
  for (const e of ok) {
    const p = e.bandProbe
    if (!p) { fail(`entry ${e.i}: no Save band found at the weigh-in step — clearance/stability would pass vacuously`); continue }
    if (p.position !== 'sticky') fail(`entry ${e.i}: band position is '${p.position}', not sticky — measuring the wrong element`)
    if (p.visibility !== 'visible') fail(`entry ${e.i}: band visibility is '${p.visibility}' — would pass vacuously`)
    if (p.pointerEvents !== 'auto') fail(`entry ${e.i}: band pointerEvents is '${p.pointerEvents}' — would pass vacuously`)
    if (!(p.h > 0)) fail(`entry ${e.i}: band has zero height — would pass vacuously`)
    if (!p.saveVisible) fail(`entry ${e.i}: Save button checkVisibility() false`)
    if (!p.saveHitIsSelf) fail(`entry ${e.i}: elementFromPoint at the Save button's centre returns ${p.saveHit}, not the button — occluded`)
    if (e.weightKeyCount !== 12) fail(`entry ${e.i}: weight keypad rendered ${e.weightKeyCount} keys, expected 12`)
    if (e.saveWaitErr) fail(`entry ${e.i}: the session never reset after Save (${e.saveWaitErr}) — the entry did not complete`)
    // A step that never reached a resting position IS the jumping-around symptom, and it also means
    // the offset recorded for it is a sample of something still in motion — the numbers below it
    // would be unreproducible. Fail rather than average it away.
    if (e.stalled.length) fail(`entry ${e.i}: scroll never came to rest at ${e.stalled.join(', ')} (still moving after ~3s) — the page is still settling when the user's next tap lands`)
  }

  // ── 1. The travel budget ──
  for (const e of ok) {
    if (e.travel > MAX_ENTRY_TRAVEL_PX) {
      fail(`entry ${e.i}: vertical travel ${e.travel}px exceeds the budget of ${MAX_ENTRY_TRAVEL_PX}px. Path: ${e.path.join(' -> ')}. A diff that moves the page further under the user's thumb is the regression this gate exists to catch — measure it, and if the increase is intended, raise MAX_ENTRY_TRAVEL_PX in the same commit with the reason.`)
    }
  }

  // ── 2. Net displacement: the session must hand entry N+1 the offset entry N started from ──
  for (const e of ok) {
    if (e.i >= STEADY_FROM_ENTRY && e.net !== 0) {
      fail(`entry ${e.i}: net displacement ${e.net > 0 ? '+' : ''}${e.net}px, expected 0 — the session does not return to where it started, so entries drift down the page as the ledger grows. Path: ${e.path.join(' -> ')}`)
    }
  }

  // ── 3. The band-height progression ──
  const heights = m.bandHeights.map(h => (h == null ? -1 : h))
  if (!eq(heights, BAND_HEIGHT_PROGRESSION_PX)) {
    fail(`Save band height progression is [${heights.join(', ')}], expected [${BAND_HEIGHT_PROGRESSION_PX.join(', ')}] (before any save, then after saves 1-${ENTRIES}). The band's height drives the clearance rule, so a change here silently changes how much room the keypad has.`)
  }

  // ── Report ──
  const maxTravel = ok.length ? Math.max(...ok.map(e => e.travel)) : null
  console.log(`[save-band-stability] ${VIEWPORT.w}x${VIEWPORT.h} (frame self-reports ${m.frame.vw}x${m.frame.vh}, scrollW ${m.frame.scrollW}); auto-chooser was open: ${m.autoChooserWasOpen}, dismissed: ${!m.chooserOpenAtMeasureStart}`)
  for (const e of ok) console.log(`[save-band-stability] entry ${e.i}: travel ${e.travel}px, net ${e.net >= 0 ? '+' : ''}${e.net}px, band ${e.bandProbe?.h}px  |  ${e.path.join(' -> ')}`)
  console.log(`[save-band-stability] band heights [before, after 1..${ENTRIES}] = [${heights.join(', ')}]`)
  console.log(`[save-band-stability] max entry travel ${maxTravel}px against a budget of ${MAX_ENTRY_TRAVEL_PX}px`)
  if (maxTravel != null && maxTravel <= MAX_ENTRY_TRAVEL_PX - SLACK_NOTICE_PX) {
    console.log(`[save-band-stability] NOTE — the budget is ${MAX_ENTRY_TRAVEL_PX - maxTravel}px slack and is no longer catching much. Re-baseline MAX_ENTRY_TRAVEL_PX to ${maxTravel} (see the constant's comment for the two-command procedure).`)
  }
  if (REPORT_ONLY) console.log('\n' + JSON.stringify({ frame: m.frame, bandHeights: heights, entries: ok.map(e => ({ i: e.i, travel: e.travel, net: e.net, path: e.path, bandH: e.bandProbe?.h })) }, null, 1))
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (REPORT_ONLY) {
  if (failures.length) { console.error('\n[save-band-stability] --report: would FAIL'); for (const f of failures) console.error('  · ' + f) }
  process.exit(0)
}
if (failures.length) {
  console.error('\n[save-band-stability] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[save-band-stability] PASS')
