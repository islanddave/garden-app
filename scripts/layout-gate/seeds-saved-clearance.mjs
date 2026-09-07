#!/usr/bin/env node
// seeds-saved-clearance.mjs — the first observable /seeds/saved has ever had.
//
//   node scripts/layout-gate/seeds-saved-clearance.mjs                  # npm run gate:seeds-saved
//   node scripts/layout-gate/seeds-saved-clearance.mjs --probe-nothing  # prove the instrument fires
//
// MEASURES, in real Chrome at a TRUE 390x844 (and 390x667 for the two sheet cases), across the four
// states tests/harness/seedssaved.jsx can render — empty / populated list / candidate picker /
// advance sheet:
//   (a) TAP HEIGHT — every visible button and form control, as a census rather than a named list,
//       against T.tapMinHeight read from the token file. A gate that re-checks four named controls
//       passes the day a fifth is authored short.
//   (b) CARD INTEGRITY — no seed-lot card overflows its own box horizontally or vertically, its
//       text column does not clip its content, and the advance button's rect does not intersect
//       that column. Plus: the document does not scroll sideways. V5-SEEDCOUNTCARD-001 added the
//       seed-measure line to that column, so it gets its own box read: clipping, viewport fit,
//       visibility by checkVisibility(), and non-intersection with the advance button. Its
//       PRESENCE is reported and not asserted — see the fixture note under SCOPE.
//   (c) ACTION CLEARANCE — in the two sheet states, the primary action hit-tests to itself, sits
//       inside the 390px viewport, and is reachable: either painted within the panel or inside a
//       panel that genuinely scrolls. A Save that is clipped out of a non-scrolling panel is
//       unreachable, and that is the state this half exists to refuse.
//
// WHY IT CANNOT BE A VITEST TEST. The harness entry says it in its own header and it is the whole
// reason this file exists: jsdom returns 0 from every getBoundingClientRect(), so nothing under
// src/__tests__/** can tell "the 44-character variety name fits beside the advance button" from
// "it does not". The suite is green on this page and always will be, whatever the page looks like.
// The harness (tests/harness/seedssaved.{html,jsx}) shipped in v4.90.0 and was wired to NOTHING:
// `grep -rn "seedssaved\|seeds-saved" .github/ package.json scripts/` returned no output until this
// file. An instrument nothing runs is an instrument that does not exist.
//
// SCOPE, said out loud. This measures LAYOUT at the fixture's scale — 4 tracked lots, 4 untracked
// candidates, taken from real prod rows longest-first. It says nothing about the page's other
// stated defect, a candidate picker that lists every untracked packet unfiltered (260 in prod). That
// is a property of the DATA, not of the layout, and its instrument is
// scripts/seed_label_ambiguity.py. Padding this fixture to 260 rows by repeating eight real names
// would fabricate a distribution rather than measure one.
//
// AND ONE THING IT CANNOT MEASURE TODAY, said here rather than left to be discovered. The TRACKED
// rows in tests/harness/seedssaved.jsx carry no `seed_count`, `seed_weight_g` or
// `seed_count_estimated`, so V5-SEEDCOUNTCARD-001's seed-measure line renders on ZERO of the four
// cards and every box read below is of a card WITHOUT it. The checks in (b) are therefore live but
// unexercised: they will fire the day the line exists and they say nothing about it until then. That
// is REPORTED loudly on every run rather than asserted, because the fixture is the thing that has to
// change and failing here would only red CI at a file this gate does not own. The fix is two scalars
// on the TRACKED array — one hand-counted lot (`seed_count`, `seed_count_estimated: false`, ideally
// with a `seed_weight_g` so both segments are on one line) and one vendor-estimated lot
// (`seed_count_estimated: true`, which renders the longer "approx. N seeds" string and is the worse
// case for the 44-character name it shares a column with).
//
// THE INSTRUMENT CHECK, and why it is not optional. A layout gate that measures nothing scores a
// perfect pass — every "all targets clear the floor" is trivially true of a page with no targets.
// So, before any invariant is evaluated: the page must self-report the viewport it was asked for,
// must have raised no error while mounting, must have reached harness ready(), every selector this
// gate depends on must match the count the fixture promises, and the boxes read back must not be
// uniformly zero (which is exactly what an unrendered document, or a jsdom-shaped one, looks like).
// `--probe-nothing` points every selector at a testid that does not exist; it MUST exit 1. It is a
// permanent, runnable proof that this file can go red, kept because a gate whose failure path has
// never been executed is a claim, not a guard.
//
// TRAPS THESE SIBLINGS ALREADY PAID FOR:
//   1. macOS Chrome floors an OS window at ~500px, so --window-size=390 lays the page out at ~500
//      and CROPS the capture. Geometry comes from Emulation.setDeviceMetricsOverride and the run
//      REFUSES TO PASS unless the page self-reports innerWidth 390 (inventory-list-shot.mjs).
//   2. The in-app browser pane reports visibilityState 'hidden', so rAF never fires and a React page
//      can sit half-mounted forever. Hence headless Chrome with --disable-renderer-backgrounding
//      rather than that pane (log-chooser-clearance.mjs).
//   3. CI pins node 20.19.0, which has no global WebSocket — attach through resolveWebSocket(),
//      never a bare global (cdp-socket.mjs).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { T } from '../../src/components/forms/formStyles.js'
import { resolveWebSocket } from './cdp-socket.mjs'

// Read from the token, never spelled here: a gate carrying its own copy of the floor is a gate that
// keeps passing after someone lowers the real one.
const TAP_MIN_HEIGHT_PX = T.tapMinHeight

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5316)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9426)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI passes --no-sandbox and resolves CHROME_PATH in its own step.
// Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)

// THE INSTRUMENT SELF-TEST. Not a debug switch: it is the demonstration that the non-vacuity half
// of this gate is load-bearing. Every testid below gains a suffix nothing renders, so the fixture
// counts cannot be met and the run must exit 1 on "matched 0 elements" rather than sailing through
// on vacuously-true invariants.
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`
const tidPrefix = (name) => `[data-testid^="${name}${SUFFIX}"]`

// The four states the harness entry can render, and what each one must produce before it is
// measured. Nothing here may be silently satisfied by an empty page: a selector that matches
// nothing FAILS this gate rather than passing it.
//
// EXACT vs MINIMUM is a deliberate split, not sloppiness:
//   · cards / sections / advanceBtns are EXACT because they fall straight out of the fixture rows
//     in tests/harness/seedssaved.jsx, which this gate owns — 4 tracked lots whose stages are
//     fermenting/fermenting/drying/stored, so 3 sections, and `stored` is terminal so only 3 cards
//     carry an advance button. If a redesign changes that grouping the two files move together,
//     and being told so is the point.
//   · minCandidates is a FLOOR because the candidate list is the surface under redesign — a cap or
//     a search filter legitimately changes how many of the 4 untracked rows are offered, and
//     pinning the number would freeze a decision this lane did not make. What must never happen is
//     zero: a picker offering nothing is indistinguishable from a picker that never rendered.
// 667 is the same phone with the keyboard up and is the tighter geometry; it is run for the two
// sheet states, where an 85vh panel cap is what bites.
const CASES = [
  { name: 'empty', viewports: [[390, 844]], expect: { cards: 0, sections: 0, minCandidates: 0, minControls: 1, emptyState: true, sheet: false } },
  { name: 'list', viewports: [[390, 844]], expect: { cards: 4, sections: 3, minCandidates: 0, advanceBtns: 3, minControls: 4, emptyState: false, sheet: false } },
  { name: 'picker', viewports: [[390, 844], [390, 667]], expect: { cards: 4, sections: 3, minCandidates: 1, minControls: 5, emptyState: false, sheet: true } },
  { name: 'advance', viewports: [[390, 844], [390, 667]], expect: { cards: 4, sections: 3, minCandidates: 0, minControls: 4, emptyState: false, sheet: true, primary: 'stage-save' } },
]

const failures = []
const fail = m => failures.push(m)

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
      const r = await fetch(`http://localhost:${PORT}/tests/harness/seedssaved.html`)
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
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation, so the
    // window only has to be big enough not to clip it. See trap 1 in the header.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  // CDP wait: 240 x 250ms = 60s, raised from 60 tries (15s) on 2026-09-04. 15s is comfortable on a
  // Mac and MARGINAL on a loaded GitHub runner: `Chrome did not expose CDP on 9422 within 15s` failed
  // the whole unit job on two consecutive dev commits (1909c4e8, 729bebf3) with nothing wrong in the
  // tree — every gate passed locally on the same SHA. Nothing about the success path changes; a
  // browser ready in 300ms still returns in 300ms. This only lengthens the patience before giving up.
  // Override with CDP_WAIT_MS for a slower runner.
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
    // A DEAD CHROME IS NOT A SLOW CHROME, and the two need different responses: one is "re-run the
    // job", the other is "go find the missing shared library". Waiting the full 60s to report a
    // timeout for a process that exited in the first 200ms buys nothing and actively misleads.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} (code=${proc.exitCode} signal=${proc.signalCode}) - a dead browser, not a slow one; re-running will not help`)
    }
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return { proc, version: await r.json() }
    } catch { /* not listening yet */ }
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

// ── The measurement, evaluated in the page itself ───────────────────────────────────────────────
// Nothing is tapped or scrolled here: the harness entry has already driven the real controls (it
// CLICKS track-a-lot / advance-stage rather than forcing state, so "is this surface reachable" is
// answered before "does it fit"). Every number below is read from the live document.
const MEASURE = (c) => `(() => {
  const d = document, w = window
  const de = d.documentElement
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: Math.round(r.top), l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom),
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } }
  const name = el => el.getAttribute('aria-label') || el.getAttribute('data-testid') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30) ||
    ('<' + el.tagName.toLowerCase() + ' ' + (el.type || '') + '>')
  // checkVisibility(), not offsetParent: a collapsed <details> or a zero-opacity ancestor reports a
  // parent and reads as visible through offsetParent.
  const shown = el => (!el.checkVisibility || el.checkVisibility()) && el.getBoundingClientRect().height > 0
  const hitsSelf = (el, r) => {
    const x = (r.l + r.r) / 2, y = (r.t + r.b) / 2
    if (x < 0 || y < 0 || x > w.innerWidth || y > w.innerHeight) return null  // never probed != not occluded
    const at = d.elementFromPoint(x, y)
    return at === el || (at != null && (el.contains(at) || at.contains(el)))
  }

  const cards = [...d.querySelectorAll('${tid('seed-lot-card')}')]
  const sections = [...d.querySelectorAll('${tidPrefix('stage-section-')}')]
  const candidates = [...d.querySelectorAll('${tid('track-candidate')}')]
  const panel = d.querySelector('[role="dialog"]')
  const primary = ${c.expect.primary ? `d.querySelector('${tid(c.expect.primary)}')` : 'null'}

  const controls = [...d.querySelectorAll('button, input, select, textarea, [role="button"]')].filter(shown)
  const taps = controls.map(el => {
    const r = box(el)
    // A control BEHIND an open modal correctly fails to hit-test — the backdrop is over it, by
    // design. Recording which layer each control is on keeps that from reading as an occlusion bug.
    return { label: name(el), w: r.w, h: r.h, hitIsSelf: hitsSelf(el, r),
             inDialog: panel ? panel.contains(el) : true,
             fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5 }
  })
  // REPORTED, not asserted. The card title and "Set parent plant →" are anchors, and WCAG 2.5.8
  // exempts a link inline in a block of text — asserting a 44px floor on them would freeze a design
  // call this lane did not make. The heights are printed so the redesign has a number to move.
  const links = [...d.querySelectorAll('a[href]')].filter(shown).map(el => ({ label: name(el), h: box(el).h }))

  const cardMetrics = cards.map(cd => {
    const r = box(cd)
    const col = cd.firstElementChild
    const adv = cd.querySelector('${tid('advance-stage')}')
    const cr = col ? box(col) : null, ar = adv ? box(adv) : null
    // V5-SEEDCOUNTCARD-001. Read as its own box rather than trusting the column's colClips above:
    // colClips answers "did anything in this column overflow" and this answers "was it this line",
    // which is the difference between a finding and a search. \`shown\` is checkVisibility(), never
    // offsetParent — a line inside a collapsed <details> reports a parent and reads as visible.
    const meas = cd.querySelector('${tid('lot-seed-measure')}')
    const mr = meas ? box(meas) : null
    return {
      measure: meas ? {
        text: (meas.textContent || '').trim().replace(/\\s+/g, ' '),
        w: mr.w, h: mr.h,
        shown: shown(meas),
        clips: meas.scrollWidth > meas.clientWidth + 1,
        fitsX: mr.l >= -0.5 && mr.r <= w.innerWidth + 0.5,
        overlapsAdvance: ar ? !(ar.l >= mr.r || ar.r <= mr.l || ar.t >= mr.b || ar.b <= mr.t) : false,
      } : null,
      label: name(cd.querySelector('a[href]') || cd),
      h: r.h, w: r.w,
      overflowX: cd.scrollWidth > cd.clientWidth + 1,
      overflowY: cd.scrollHeight > cd.clientHeight + 1,
      colClips: col ? col.scrollWidth > col.clientWidth + 1 : null,
      hasAdvance: !!adv,
      // Positive = clear air between the text column and the advance button. Negative = they
      // overlap, which at 390px with a 44-char variety name is the exact question this page has
      // never been able to answer.
      colToAdvancePx: (cr && ar) ? Math.round(ar.l - cr.r) : null,
      overlaps: (cr && ar) ? !(ar.l >= cr.r || ar.r <= cr.l || ar.t >= cr.b || ar.b <= cr.t) : false,
      fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5,
    }
  })

  let sheet = null
  if (panel) {
    const pr = box(panel)
    const cs = w.getComputedStyle(panel)
    const scrollList = candidates.length ? candidates[0].parentElement : null
    sheet = {
      top: pr.t, bottom: pr.b, height: pr.h, left: pr.l, right: pr.r,
      overflowY: cs.overflowY, position: cs.position, visibility: cs.visibility,
      overflowsX: panel.scrollWidth > panel.clientWidth + 1,
      scrollable: panel.scrollHeight > panel.clientHeight + 1,
      hiddenBelowPx: Math.max(0, panel.scrollHeight - panel.clientHeight),
      candidateListScrollPx: scrollList ? Math.max(0, scrollList.scrollHeight - scrollList.clientHeight) : null,
      // Is there any way to narrow the candidate list? Only meaningful on a sheet that HAS a
      // candidate list — the advance sheet's date/note fields are inputs too, and counting those
      // would report a search box that does not exist. Reported so a redesign adding one shows up.
      hasFilterControl: candidates.length
        ? !!panel.querySelector('input[type="search"], input[type="text"]') : null,
    }
  }
  let action = null
  if (primary) {
    const r = box(primary)
    action = {
      label: name(primary), h: r.h, top: r.t, bottom: r.b, left: r.l, right: r.r,
      hitIsSelf: hitsSelf(primary, r), fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5,
      // Painted inside the panel's visible box? If not, it is only reachable by scrolling, which is
      // acceptable ONLY while the panel genuinely scrolls.
      insidePanel: panel ? (r.b <= box(panel).b + 0.5 && r.t >= box(panel).t - 0.5) : null,
    }
  }

  return {
    vw: w.innerWidth, vh: w.innerHeight, dpr: w.devicePixelRatio,
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    sidewaysScroll: de.scrollWidth > de.clientWidth + 1,
    pageH: Math.round(de.scrollHeight),
    emptyState: !!d.querySelector('${tid('saved-seeds-empty')}'),
    counts: { cards: cards.length, sections: sections.length, candidates: candidates.length,
              controls: taps.length, links: links.length,
              advanceBtns: d.querySelectorAll('${tid('advance-stage')}').length,
              measureLines: d.querySelectorAll('${tid('lot-seed-measure')}').length },
    taps, links, cardMetrics, sheet, action,
  }
})()`

// Six navigations on one target, and Runtime.evaluate races the commit: dispatched a beat too early
// the execution context is torn down under it and CDP answers "Inspected target navigated or
// closed". Measured here — the run died on case 4 of 4 having already passed cases 1-2. Retried
// ONLY on that one class of transport error; anything else still throws, because a gate that
// swallows page errors as retryable is a gate that reports a broken page as a slow one.
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i
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

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-seedssaved-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[seeds-saved] --probe-nothing: every selector points at a testid nothing renders. This run MUST fail.')

  for (const c of CASES) {
    for (const [vw, vh] of c.viewports) {
      const at = `${c.name}@${vw}x${vh}`
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
      // verdict=0 strips the harness's fixed instrument bar. It is z-index 99999 and would sit on
      // top of the page's own header — elementFromPoint would then report the bar, and this gate
      // would be measuring its own instrument.
      const url = `http://localhost:${PORT}/tests/harness/seedssaved.html?case=${c.name}&verdict=0`
      const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
      await sleep(200)
      await evalSettled(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('harness never reached ready() on case=${c.name}')})()`)
      await evalSettled(`new Promise(r=>setTimeout(r,400))`)   // let fonts and the sheet transition settle
      const m = await evalSettled(MEASURE(c))

      // ── INSTRUMENT CHECK, before any invariant. Each of these is a way this gate could report a
      //    perfect pass while telling us nothing at all.
      if (m.vw !== vw || m.vh !== vh) {
        fail(`${at}: page self-reports ${m.vw}x${m.vh} — emulation did not take, every coordinate below is from the wrong layout`)
        continue
      }
      const e = c.expect
      const mismatch = []
      if (m.counts.cards !== e.cards) mismatch.push(`cards ${m.counts.cards} != ${e.cards}`)
      if (m.counts.sections !== e.sections) mismatch.push(`stage sections ${m.counts.sections} != ${e.sections}`)
      if (m.counts.candidates < e.minCandidates) mismatch.push(`${m.counts.candidates} candidates offered, expected >=${e.minCandidates} — a picker offering nothing is indistinguishable from a picker that never rendered`)
      if (!e.sheet && m.counts.candidates) mismatch.push(`${m.counts.candidates} candidates on a case with no picker open`)
      if (e.advanceBtns != null && m.counts.advanceBtns !== e.advanceBtns) mismatch.push(`advance buttons ${m.counts.advanceBtns} != ${e.advanceBtns}`)
      if (m.counts.controls < e.minControls) mismatch.push(`${m.counts.controls} interactive controls, expected >=${e.minControls}`)
      if (m.emptyState !== e.emptyState) mismatch.push(`empty state ${m.emptyState}, expected ${e.emptyState}`)
      if (e.sheet && !m.sheet) mismatch.push('no [role="dialog"] — the sheet this case exists to measure never opened')
      if (!e.sheet && m.sheet) mismatch.push('a sheet is open on a case that should have none')
      if (e.primary && !m.action) mismatch.push(`no ${e.primary} control — the primary action this case measures did not render`)
      if (mismatch.length) {
        // A selector that matched nothing is a FAILURE, never a quiet pass. If the page was
        // redesigned, tests/harness/seedssaved.jsx and the CASES table here move together.
        fail(`${at}: the fixture did not produce what this gate measures — ${mismatch.join('; ')}`)
        continue
      }
      // The zero-box detector. An unrendered document — or a jsdom-shaped one — hands back a full
      // set of elements whose every box is 0x0, and every "clears the floor" assertion below is
      // then vacuously true. Demand at least one real box and more than one distinct height.
      const heights = m.taps.map(t => t.h).concat(m.cardMetrics.map(cd => cd.h))
      if (!heights.length) fail(`${at}: no boxes measured at all`)
      else if (heights.every(h => h === 0)) fail(`${at}: every one of ${heights.length} measured boxes is 0px tall — this is what an unrendered document looks like, not a passing layout`)
      else if (m.docScrollW === 0 || m.docClientW === 0) fail(`${at}: document reports scrollWidth ${m.docScrollW} / clientWidth ${m.docClientW} — nothing was laid out`)

      // ── (a) TAP HEIGHT — census, not a named list.
      const short = m.taps.filter(t => t.h < TAP_MIN_HEIGHT_PX)
      for (const t of short) fail(`${at}: control "${t.label}" renders ${t.w}x${t.h}, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
      for (const t of m.taps) {
        // Hit-testing is asserted on the TOP layer only. With a sheet open the backdrop covers the
        // page behind it and every background control correctly fails to hit-test; asserting there
        // would red this gate on the modal working exactly as designed.
        if (t.inDialog && t.hitIsSelf === false) fail(`${at}: control "${t.label}" does not hit-test to itself — occluded`)
        if (!t.fitsX) fail(`${at}: control "${t.label}" sits outside the ${vw}px viewport — unreachable`)
      }

      // ── (b) CARD INTEGRITY.
      for (const cd of m.cardMetrics) {
        if (cd.overflowX) fail(`${at}: card "${cd.label}" overflows its own box horizontally (scrollWidth > clientWidth)`)
        if (cd.overflowY) fail(`${at}: card "${cd.label}" clips its own content vertically`)
        if (cd.colClips) fail(`${at}: card "${cd.label}" clips its text column — the variety name does not fit beside the advance button`)
        if (cd.overlaps) fail(`${at}: card "${cd.label}": the advance button's rect intersects the text column`)
        if (!cd.fitsX) fail(`${at}: card "${cd.label}" sits outside the ${vw}px viewport`)
        // V5-SEEDCOUNTCARD-001. Only reachable on a card whose row carries a measurement; see the
        // fixture note in the header for why that is currently no card at all.
        const ms = cd.measure
        if (ms) {
          if (!ms.shown) fail(`${at}: card "${cd.label}": the seed-measure line "${ms.text}" is in the document but not visible — a rendered measurement nobody can read is the defect this line exists to fix, one layer down`)
          if (ms.clips) fail(`${at}: card "${cd.label}": the seed-measure line "${ms.text}" clips its own content — the count is on screen and cut off`)
          if (!ms.fitsX) fail(`${at}: card "${cd.label}": the seed-measure line sits outside the ${vw}px viewport`)
          if (ms.overlapsAdvance) fail(`${at}: card "${cd.label}": the seed-measure line's rect intersects the advance button`)
        }
      }
      if (m.sidewaysScroll) fail(`${at}: document scrollWidth ${m.docScrollW} > clientWidth ${m.docClientW} — the page scrolls sideways`)

      // ── (c) ACTION CLEARANCE.
      if (m.sheet) {
        if (m.sheet.visibility !== 'visible') fail(`${at}: sheet visibility is '${m.sheet.visibility}' — an invisible panel makes every measurement below vacuous`)
        if (m.sheet.height <= 0) fail(`${at}: sheet panel has zero height`)
        if (m.sheet.overflowsX) fail(`${at}: sheet panel overflows horizontally — a field is wider than the panel, which does NOT show up as document hscroll`)
        if (m.sheet.left < -0.5 || m.sheet.right > vw + 0.5) fail(`${at}: sheet panel spans x${m.sheet.left}-${m.sheet.right}, outside the ${vw}px viewport`)
      }
      if (m.action) {
        if (m.action.hitIsSelf === false) fail(`${at}: "${m.action.label}" does not hit-test to itself — the primary action is occluded`)
        if (m.action.hitIsSelf === null && m.action.insidePanel) fail(`${at}: "${m.action.label}" is inside the panel but outside the viewport — it can never be probed or tapped`)
        if (!m.action.fitsX) fail(`${at}: "${m.action.label}" sits outside the ${vw}px viewport`)
        // Below the panel's visible fold is acceptable only while the panel actually scrolls.
        // Clipped out of a non-scrolling panel is unreachable, full stop.
        if (!m.action.insidePanel && !m.sheet?.scrollable) fail(`${at}: "${m.action.label}" is painted outside a panel that does not scroll — unreachable`)
      }

      // ── The record. Printed on pass as well as fail: these are the numbers a redesign has to move,
      //    and a gate that only speaks when it is angry leaves nothing to compare against.
      const minTap = m.taps.length ? Math.min(...m.taps.map(t => t.h)) : 0
      console.log(`[seeds-saved] ${at}: ${m.counts.cards} cards / ${m.counts.sections} sections / ${m.counts.candidates} candidates · ${m.counts.controls} controls, shortest ${minTap}px (floor ${TAP_MIN_HEIGHT_PX}px), ${short.length} under · pageH ${m.pageH}px`)
      if (m.cardMetrics.length) {
        console.log(`[seeds-saved] ${at}: card gap text→advance ${m.cardMetrics.map(cd => cd.hasAdvance ? cd.colToAdvancePx + 'px' : '—').join('/')} · card heights ${m.cardMetrics.map(cd => cd.h).join('/')}px · overflow ${m.cardMetrics.filter(cd => cd.overflowX || cd.colClips).length}`)
        // V5-SEEDCOUNTCARD-001. The zero case is printed as loudly as the populated one and says
        // NOT MEASURED in those words: a silent "0 lines" beside a PASS is exactly how a change
        // whose clearance was never read gets recorded as one that was.
        const withMeasure = m.cardMetrics.filter(cd => cd.measure)
        console.log(withMeasure.length
          ? `[seeds-saved] ${at}: seed-measure line on ${withMeasure.length}/${m.cardMetrics.length} card(s) · ${withMeasure.map(cd => `"${cd.measure.text}" ${cd.measure.w}x${cd.measure.h}`).join(' / ')} · clipped ${withMeasure.filter(cd => cd.measure.clips).length}`
          : `[seeds-saved] ${at}: seed-measure line on 0/${m.cardMetrics.length} cards — NOT MEASURED. The fixture's tracked rows carry no seed_count/seed_weight_g, so every height above is a card WITHOUT that line and this run says nothing about its clearance (header, SCOPE).`)
      }
      if (m.sheet) {
        console.log(`[seeds-saved] ${at}: sheet y${m.sheet.top}-${m.sheet.bottom} h${m.sheet.height} · scrollable ${m.sheet.scrollable} (${m.sheet.hiddenBelowPx}px below the fold) · candidate list scroll ${m.sheet.candidateListScrollPx ?? '—'}px · narrowing control ${m.sheet.hasFilterControl ? 'present' : 'NONE'}`)
      }
      if (m.action) {
        console.log(`[seeds-saved] ${at}: primary "${m.action.label}" y${m.action.top}-${m.action.bottom} h${m.action.h} · insidePanel ${m.action.insidePanel} · hitIsSelf ${m.action.hitIsSelf}`)
      }
      // Anchors: reported, never asserted (see the note in MEASURE).
      const shortLinks = m.links.filter(l => l.h < TAP_MIN_HEIGHT_PX)
      if (m.links.length) {
        console.log(`[seeds-saved] ${at}: ${m.links.length} link target(s), ${shortLinks.length} under ${TAP_MIN_HEIGHT_PX}px [REPORTED, NOT ASSERTED — WCAG 2.5.8 exempts inline links]: ${shortLinks.map(l => `"${l.label}"=${l.h}px`).join(', ') || 'none'}`)
      }
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

// Exit codes are NOT inverted under --probe-nothing: both outcomes there are red, and the banner —
// not the code — says which one happened. An arm that exited 0 on a deliberately-broken instrument
// is a switch someone eventually wires into CI, and it would report a KILL as a SURVIVAL.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[seeds-saved] FAIL — EXPECTED. --probe-nothing pointed every selector at a testid nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[seeds-saved] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[seeds-saved] FAIL — and this one is the real defect: every selector pointed at a testid that does not exist and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[seeds-saved] PASS')
