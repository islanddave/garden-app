#!/usr/bin/env node
// save-seed-sheet-clearance.mjs — the first layout gate the Save seed sheet has had (QA B4).
//
//   node scripts/layout-gate/save-seed-sheet-clearance.mjs                  # npm run gate:save-seed-sheet
//   node scripts/layout-gate/save-seed-sheet-clearance.mjs --probe-nothing  # prove the instrument fires
//
// MEASURES, in real Chrome at a TRUE 360x640, 390x844 and 426x836, the five states
// tests/harness/saveseedsheet.jsx can produce — one / two / four parent plantings, the longest mix
// name the client can generate, and a refused mix call — of the sheet as a planting page opens it:
//   (a) TAP HEIGHT — every visible button and form control in the document, as a census rather than
//       a named list, against T.tapMinHeight read from the token file. The remove control is an icon
//       with no words, so it is held to the same number sideways as well.
//   (b) REACH — every control, scrolled to the middle of the panel, hit-tests to itself and sits
//       inside the viewport's width. A control something else is painted over fails here.
//   (c) SAVE — the primary action is either painted inside the panel's visible box and hit-tests to
//       itself as the sheet opens, or sits in a panel that genuinely scrolls; and once scrolled to,
//       it hit-tests to itself at its centre and at four inset corners, and no other element of the
//       sheet shares any of its box. The notice and the refusal sentence, when present, are above it.
//   (d) NO SIDEWAYS SCROLL — of the document, and of the panel, which scrolls its own content so a
//       row wider than the panel does NOT show up as document scroll.
//
// WHY IT CANNOT BE A VITEST TEST. jsdom returns 0 from every getBoundingClientRect(), so nothing
// under src/__tests__/** can tell a 44px remove control from a 20px one, or a Save that four parent
// rows pushed out of an 85vh panel from one that is on screen. Release 2b (V5-SEEDMULTIPARENT-001)
// put parent rows, an adder, a plant-count field and a mix name ABOVE Save on a surface nothing
// measured: tests/harness/seedwarning.jsx mounts the sheet and no script, alias or workflow drives it.
//
// SCOPE, said out loud.
//   · The sheet as opened FROM A PLANTING (the `planting` prop). The Seeds door's "Where did this
//     seed come from?" block and its two pickers are not rendered by any case here.
//   · The adder's own picker panel is opened and tapped by the harness to build each case, and is
//     CLOSED again when the measurement is taken. Its rows are PlantingSelect's and are not censused.
//   · The side gutter is whatever the Sheet gives (contract O-9, unchanged). It is printed, not judged.
//   · THE LOT NAME FIELD IS REPORTED, NOT ASSERTED. It is a single-line text input, and a value
//     longer than the field scrolls inside it as every text input does; the same name is printed in
//     full, wrapping, in the Variety row directly under it. How much of it the field shows is printed
//     on every run so a change to that field has a number to move.
//
// THE INSTRUMENT CHECK, and why it is not optional. A layout gate that measures nothing scores a
// perfect pass. So, before any invariant is evaluated: the page must self-report the viewport it was
// asked for, the harness must have driven its case without error and reached ready(), every selector
// this gate depends on must match the count the case promises, and the boxes read back must not be
// uniformly zero. `--probe-nothing` points every selector at a testid that does not exist; it MUST
// exit 1. It is a permanent, runnable proof that this file can go red. CI runs the gate, not the twin
// (contract O-5, the convention for every clearance gate).
//
// TRAPS THE SIBLINGS ALREADY PAID FOR (seeds-saved-clearance.mjs has the long form):
//   1. macOS Chrome floors an OS window at ~500px, so geometry comes from
//      Emulation.setDeviceMetricsOverride and the run REFUSES TO PASS unless the page self-reports it.
//   2. Headless Chrome with --disable-renderer-backgrounding, never the in-app browser pane.
//   3. CI pins a node with no global WebSocket — attach through resolveWebSocket().
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { T } from '../../src/components/forms/formStyles.js'
import { resolveWebSocket } from './cdp-socket.mjs'
import { armExitWatchdog } from './exit-watchdog.mjs'

// Read from the token, never spelled here: a gate carrying its own copy of the floor is a gate that
// keeps passing after someone lowers the real one.
const TAP_MIN_HEIGHT_PX = T.tapMinHeight

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// 5327 / 9437: clear of every sibling's default AND of the Today recorder
// (tests/harness/_todaymeasure/drive.mjs), which holds 5324 / 9434.
const PORT = Number(process.env.GATE_HARNESS_PORT || 5327)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9437)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI passes --no-sandbox and resolves CHROME_PATH in its own step.
// Rendering-affecting flags do NOT belong here.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const HARNESS_PAGE = 'tests/harness/saveseedsheet.html'
// MUTATION SEAM, as in seed-detail-shot.mjs: CSS injected into the page after the harness has built its
// case and before anything is measured. For proving that an assertion fires (cover Save, shorten a
// control) or that a proposed fix is enough, from a clean checkout. A run with it set says so on its
// first line and is never a clean run.
const MUTATE_CSS = process.env.GATE_MUTATE_CSS || ''

// THE INSTRUMENT SELF-TEST. Not a debug switch: every testid below gains a suffix nothing renders, so
// the case counts cannot be met and the run must exit 1 on a mismatch rather than sailing through on
// vacuously-true invariants.
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''
const tid = (name) => `[data-testid="${name}${SUFFIX}"]`

// The longest name previewMixName can generate from the harness's cultivars: three names joined (four
// or more collapse to "A + B + N more"), sorted, plus " mix". Spelled here so a harness that stopped
// producing it reds the `mixname` case instead of measuring a shorter one.
const LONGEST_MIX_NAME = 'Biquinho Red & Yellow Blend + Bulgarian Carrot (Shipka) + Megatron F1 (jumbo jalapeno) mix'

// What each case must produce before it is measured. EXACT, all of it: every number falls straight
// out of tests/harness/saveseedsheet.jsx, which this gate owns, and the two files move together.
//   rows        parent rows in the "From" block.
//   removes     rows - 1: the page's own planting cannot be taken off the jar.
//   plantCount  the plant-count field: absent only for one planting that holds exactly one plant.
//   hint        the "hold N plants today" line under it.
//   mix         the jar is filed as a mix: the reason line is there and "Change" is not.
//   notice      sentences in the block above Save (the F1 parent speaks in every case).
//   error       the refusal sentence.
const VIEWPORTS = [[360, 640], [390, 844], [426, 836]]
const CASES = [
  { name: 'one', expect: { rows: 1, removes: 0, plantCount: 0, hint: 0, mix: false, notice: true, error: 0 } },
  { name: 'two', expect: { rows: 2, removes: 1, plantCount: 1, hint: 1, mix: true, notice: true, error: 0 } },
  { name: 'four', expect: { rows: 4, removes: 3, plantCount: 1, hint: 1, mix: true, notice: true, error: 0 } },
  { name: 'mixname', expect: { rows: 3, removes: 2, plantCount: 1, hint: 1, mix: true, notice: true, error: 0, varietyName: LONGEST_MIX_NAME } },
  { name: 'blendfailed', expect: { rows: 2, removes: 1, plantCount: 1, hint: 1, mix: true, notice: true, error: 1 } },
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
      const r = await fetch(`http://localhost:${PORT}/${HARNESS_PAGE}`)
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
  // 60s of patience, as in the siblings: 15s was marginal on a loaded runner. Override with CDP_WAIT_MS.
  const CDP_WAIT_TRIES = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < CDP_WAIT_TRIES; i++) {
    // A DEAD CHROME IS NOT A SLOW CHROME: one is "re-run the job", the other is "go find the missing
    // shared library".
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
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id)
      clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  // Each call's 90s timeout is CLEARED when its answer lands, so a passing run does not idle after PASS.
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
  const evalIn = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn }
}

// ── The measurement, evaluated in the page itself ───────────────────────────────────────────────
// The harness has already built the case by tapping the real controls. The only thing this does to
// the page is SCROLL the sheet's own panel (instantly, never smoothly) to bring each control to the
// middle before hit-testing it, which is what a thumb does; it puts the panel back at the top after.
const MEASURE = () => `(() => {
  const d = document, w = window
  const de = d.documentElement
  const box = el => { const r = el.getBoundingClientRect(); return {
    t: Math.round(r.top * 10) / 10, l: Math.round(r.left * 10) / 10,
    r: Math.round(r.right * 10) / 10, b: Math.round(r.bottom * 10) / 10,
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } }
  const name = el => el.getAttribute('aria-label') || el.getAttribute('data-testid') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30) ||
    ('<' + el.tagName.toLowerCase() + ' ' + (el.type || '') + '>')
  // checkVisibility(), not offsetParent: a collapsed ancestor reports a parent and reads as visible.
  const shown = el => (!el.checkVisibility || el.checkVisibility()) && el.getBoundingClientRect().height > 0
  const hitAt = (el, x, y) => {
    if (x < 0 || y < 0 || x > w.innerWidth || y > w.innerHeight) return null  // never probed != not occluded
    // The control itself or something inside it. An ANCESTOR answering is not a hit: that is what the
    // panel's own background says when the control cannot take the tap.
    const at = d.elementFromPoint(x, y)
    return at === el || (at != null && el.contains(at))
  }
  const hitsSelf = el => { const r = el.getBoundingClientRect(); return hitAt(el, (r.left + r.right) / 2, (r.top + r.bottom) / 2) }
  const bring = (el, block) => el.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' })
  const text = el => (el ? (el.textContent || '').trim().replace(/\\s+/g, ' ') : null)

  const panel = d.querySelector('[role="dialog"]')
  const rows = [...d.querySelectorAll('${tid('save-seed-from-row')}')]
  const removes = [...d.querySelectorAll('${tid('save-seed-from-remove')}')]
  const save = d.querySelector('${tid('save-seed-submit')}')
  const nameInput = d.querySelector('${tid('save-seed-name')}')
  const varietyName = d.querySelector('${tid('save-seed-variety-name')}')
  const notice = d.querySelector('${tid('breeding-notice')}')
  const error = d.querySelector('${tid('save-seed-error')}')

  // Where focus sits once the harness has built the case. REPORTED: the sheet opens with focus on its
  // first control, which since release 2b is the adder and no longer the Lot name field.
  const focused = d.activeElement && d.activeElement !== d.body ? name(d.activeElement) : null

  // AS THE SHEET OPENS — read before anything is scrolled.
  if (panel) panel.scrollTop = 0
  let sheet = null
  if (panel) {
    const pr = box(panel), cs = w.getComputedStyle(panel)
    sheet = {
      top: pr.t, bottom: pr.b, left: pr.l, right: pr.r, height: pr.h, width: pr.w,
      overflowY: cs.overflowY, visibility: cs.visibility,
      // The gutter (contract O-9): how far the first row sits in from the panel's edge. Reported.
      gutterL: rows.length ? Math.round((box(rows[0]).l - pr.l) * 10) / 10 : null,
      gutterR: rows.length ? Math.round((pr.r - box(rows[0]).r) * 10) / 10 : null,
      overflowsX: panel.scrollWidth > panel.clientWidth + 1,
      scrollW: panel.scrollWidth, clientW: panel.clientWidth,
      scrollable: panel.scrollHeight > panel.clientHeight + 1,
      hiddenBelowPx: Math.max(0, panel.scrollHeight - panel.clientHeight),
    }
  }
  let action = null
  if (save) {
    const r = box(save)
    action = {
      label: name(save), h: r.h, w: r.w, top: r.t, bottom: r.b, disabled: !!save.disabled,
      fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5,
      // Painted inside the panel's visible box as the sheet opens? If not, it is only reachable by
      // scrolling, which is acceptable ONLY while the panel genuinely scrolls.
      insidePanelAtRest: panel ? (r.b <= box(panel).b + 0.5 && r.t >= box(panel).t - 0.5) : null,
      hitAtRest: hitsSelf(save),
    }
  }

  // THE CENSUS. Tags and roles, never testids: a control authored tomorrow with no testid is still a
  // control, and a list of named ones passes the day a new one is authored short.
  const controls = [...d.querySelectorAll('button, input, select, textarea, [role="button"]')].filter(shown)
  const taps = controls.map(el => {
    bring(el, 'center')
    const r = box(el)
    return { label: name(el), testid: el.getAttribute('data-testid'), w: r.w, h: r.h,
             inDialog: panel ? panel.contains(el) : false,
             hitIsSelf: hitsSelf(el),
             fitsX: r.l >= -0.5 && r.r <= w.innerWidth + 0.5 }
  })

  // SAVE, SCROLLED TO. Centre and four inset corners: a neighbour that covers one corner of the
  // button leaves its centre answering for itself.
  if (save) {
    bring(save, 'end')
    const r = save.getBoundingClientRect()
    const inset = 4
    const pts = [[(r.left + r.right) / 2, (r.top + r.bottom) / 2],
      [r.left + inset, r.top + inset], [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset], [r.right - inset, r.bottom - inset]]
    action.hits = pts.map(([x, y]) => hitAt(save, x, y))
    action.scrolledTop = Math.round(r.top * 10) / 10
    action.scrolledBottom = Math.round(r.bottom * 10) / 10
    action.insidePanelScrolled = panel ? (r.bottom <= panel.getBoundingClientRect().bottom + 0.5 && r.top >= panel.getBoundingClientRect().top - 0.5) : null
    // Anything else in the sheet that shares any of Save's box. Leaves only (an element with no
    // element children) plus every control: a wrapper's box legitimately contains the button.
    const others = panel ? [...panel.querySelectorAll('*')].filter(el =>
      el !== save && !el.contains(save) && !save.contains(el) && shown(el) &&
      (el.childElementCount === 0 || controls.includes(el))) : []
    action.overlappers = others.filter(el => {
      const o = el.getBoundingClientRect()
      return Math.min(o.right, r.right) - Math.max(o.left, r.left) > 0.5 &&
             Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top) > 0.5
    }).map(el => name(el) + ' ' + box(el).w + 'x' + box(el).h)
    const above = el => (el && shown(el) ? el.getBoundingClientRect().bottom <= r.top + 0.5 : null)
    action.noticeAbove = above(notice)
    action.errorAbove = above(error)
  }
  if (panel) panel.scrollTop = 0

  return {
    vw: w.innerWidth, vh: w.innerHeight,
    harnessError: w.__h && w.__h.error ? w.__h.error() : 'no harness',
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    sidewaysScroll: de.scrollWidth > de.clientWidth + 1,
    counts: {
      rows: rows.length, removes: removes.length,
      add: d.querySelectorAll('${tid('save-seed-add-plant')}').length,
      plantCount: d.querySelectorAll('${tid('save-seed-plant-count')}').length,
      hint: d.querySelectorAll('${tid('save-seed-plant-count-hint')}').length,
      mixReason: d.querySelectorAll('${tid('save-seed-mix-reason')}').length,
      change: d.querySelectorAll('${tid('save-seed-variety-change')}').length,
      error: error ? 1 : 0,
      noticeSentences: notice ? notice.querySelectorAll('${tid('breeding-notice-set')}').length : 0,
      controls: taps.length,
    },
    notice: !!notice && shown(notice), focused,
    varietyName: text(varietyName),
    // Line boxes from a Range over the live contents: the name is a flex item, so the element's own
    // getClientRects() is one box however many lines it wraps to.
    varietyLines: varietyName ? (() => {
      const rg = d.createRange(); rg.selectNodeContents(varietyName)
      return new Set([...rg.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5).map(r => Math.round(r.top))).size
    })() : 0,
    errorText: text(error),
    rowHeights: rows.map(el => box(el).h),
    removeBoxes: removes.map(el => ({ label: name(el), w: box(el).w, h: box(el).h })),
    // REPORTED, not asserted — see SCOPE in the header.
    nameField: nameInput ? { value: nameInput.value, chars: nameInput.value.length,
      scrollW: nameInput.scrollWidth, clientW: nameInput.clientWidth,
      clips: nameInput.scrollWidth > nameInput.clientWidth + 1 } : null,
    taps, sheet, action,
  }
})()`

// Navigations on one target race Runtime.evaluate: dispatched a beat early the execution context is
// torn down under it. Retried ONLY on that class of transport error; anything else still throws.
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
const udd = mkdtempSync(join(tmpdir(), 'gate-saveseedsheet-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (MUTATE_CSS) console.log(`[save-seed-sheet] MUTATION RUN — GATE_MUTATE_CSS=${JSON.stringify(MUTATE_CSS)}: this is not a clean run`)
  if (PROBE_NOTHING) console.log('[save-seed-sheet] --probe-nothing: every selector points at a testid nothing renders. This run MUST fail.')

  for (const c of CASES) {
    for (const [vw, vh] of VIEWPORTS) {
      const at = `${c.name}@${vw}x${vh}`
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 2, mobile: true }, cdp.sessionId)
      // verdict=0 strips the harness's fixed instrument bar: at z-index 99999 it would answer the
      // hit tests, and this gate would be measuring its own instrument.
      const url = `http://localhost:${PORT}/${HARNESS_PAGE}?case=${c.name}&verdict=0`
      const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
      await sleep(200)
      await evalSettled(`(async()=>{for(let i=0;i<300;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('harness never reached ready() on case=${c.name}')})()`)
      if (MUTATE_CSS) {
        await evalSettled(`(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(MUTATE_CSS)}; document.head.appendChild(st); return 1 })()`)
      }
      await evalSettled(`new Promise(r=>setTimeout(r,400))`)   // let fonts and the sheet transition settle
      const m = await evalSettled(MEASURE())

      // ── INSTRUMENT CHECK, before any invariant. Each of these is a way this gate could report a
      //    perfect pass while telling us nothing at all.
      if (m.vw !== vw || m.vh !== vh) {
        fail(`${at}: page self-reports ${m.vw}x${m.vh} — emulation did not take, every coordinate below is from the wrong layout`)
        continue
      }
      if (m.harnessError) {
        fail(`${at}: the harness could not build this case by tapping the real controls — ${m.harnessError}`)
        continue
      }
      const e = c.expect
      const mismatch = []
      if (!m.sheet) mismatch.push('no [role="dialog"] — the sheet never opened')
      if (!m.action) mismatch.push('no save-seed-submit control — the primary action did not render')
      if (!m.nameField) mismatch.push('no save-seed-name field')
      if (m.counts.rows !== e.rows) mismatch.push(`parent rows ${m.counts.rows} != ${e.rows}`)
      if (m.counts.removes !== e.removes) mismatch.push(`remove controls ${m.counts.removes} != ${e.removes}`)
      if (m.counts.add !== 1) mismatch.push(`"+ Add seed from another plant" controls ${m.counts.add} != 1`)
      if (m.counts.plantCount !== e.plantCount) mismatch.push(`plant-count fields ${m.counts.plantCount} != ${e.plantCount}`)
      if (m.counts.hint !== e.hint) mismatch.push(`plant-count hints ${m.counts.hint} != ${e.hint} — the harness plantings stopped carrying a whole quantity`)
      if (m.counts.mixReason !== (e.mix ? 1 : 0)) mismatch.push(`mix reason lines ${m.counts.mixReason} != ${e.mix ? 1 : 0}`)
      if (m.counts.change !== (e.mix ? 0 : 1)) mismatch.push(`"Change" controls ${m.counts.change} != ${e.mix ? 0 : 1}`)
      if (m.counts.error !== e.error) mismatch.push(`refusal sentences ${m.counts.error} != ${e.error}`)
      if (m.notice !== e.notice) mismatch.push(`notice above Save ${m.notice ? 'present' : 'absent'}, expected ${e.notice ? 'present' : 'absent'}`)
      if (e.varietyName != null && m.varietyName !== e.varietyName) mismatch.push(`the Variety row reads "${m.varietyName}", expected the longest generated name "${e.varietyName}"`)
      if (!m.varietyName) mismatch.push('the Variety row names nothing')
      // Rows, removes, add, name, the count and weight fields, the basis switch, three process rows,
      // Save and the sheet's own close: a census that found fewer than this did not see the sheet.
      if (m.counts.controls < 8 + e.removes) mismatch.push(`${m.counts.controls} interactive controls, expected >=${8 + e.removes}`)
      if (mismatch.length) {
        // A selector that matched nothing is a FAILURE, never a quiet pass. If the sheet was
        // redesigned, tests/harness/saveseedsheet.jsx and the CASES table here move together.
        fail(`${at}: the harness did not produce what this gate measures — ${mismatch.join('; ')}`)
        continue
      }
      // The zero-box detector: an unrendered document hands back elements whose every box is 0x0,
      // and every "clears the floor" assertion below is then vacuously true.
      const heights = m.taps.map(t => t.h).concat(m.rowHeights)
      if (!heights.length) fail(`${at}: no boxes measured at all`)
      else if (heights.every(h => h === 0)) fail(`${at}: every one of ${heights.length} measured boxes is 0px tall — this is what an unrendered document looks like, not a passing layout`)
      else if (m.docScrollW === 0 || m.docClientW === 0) fail(`${at}: document reports scrollWidth ${m.docScrollW} / clientWidth ${m.docClientW} — nothing was laid out`)

      // ── (a) TAP HEIGHT — census, not a named list. No exemptions.
      const short = m.taps.filter(t => t.h < TAP_MIN_HEIGHT_PX)
      for (const t of short) fail(`${at}: control "${t.label}" renders ${t.w}x${t.h}, under the ${TAP_MIN_HEIGHT_PX}px tap floor`)
      for (const r of m.removeBoxes) {
        if (r.w < TAP_MIN_HEIGHT_PX) fail(`${at}: remove control "${r.label}" is ${r.w}px wide — an icon with no words needs the ${TAP_MIN_HEIGHT_PX}px floor sideways too`)
      }

      // ── (b) REACH — each control, scrolled to the middle of the panel.
      for (const t of m.taps) {
        if (!t.inDialog) fail(`${at}: control "${t.label}" is outside the sheet — the harness mounts nothing else, so something leaked out of the panel`)
        if (t.hitIsSelf === false) fail(`${at}: control "${t.label}" does not hit-test to itself when scrolled into view — occluded`)
        if (t.hitIsSelf === null) fail(`${at}: control "${t.label}" could not be brought inside the ${vw}x${vh} viewport — unreachable`)
        if (!t.fitsX) fail(`${at}: control "${t.label}" sits outside the ${vw}px viewport — unreachable`)
      }

      // ── (c) SAVE.
      const a = m.action
      if (m.sheet.visibility !== 'visible') fail(`${at}: sheet visibility is '${m.sheet.visibility}' — an invisible panel makes every measurement vacuous`)
      if (m.sheet.height <= 0) fail(`${at}: sheet panel has zero height`)
      if (!a.fitsX) fail(`${at}: "${a.label}" sits outside the ${vw}px viewport`)
      // Below the panel's visible fold is acceptable only while the panel actually scrolls. Clipped
      // out of a non-scrolling panel is unreachable, full stop.
      if (!a.insidePanelAtRest && !m.sheet.scrollable) fail(`${at}: "${a.label}" is painted outside a panel that does not scroll — unreachable`)
      if (a.insidePanelAtRest && a.hitAtRest === false) fail(`${at}: "${a.label}" is inside the panel as the sheet opens and does not hit-test to itself — occluded`)
      if (!a.insidePanelScrolled) fail(`${at}: "${a.label}" is still outside the panel's visible box (y${a.scrolledTop}-${a.scrolledBottom}) after scrolling to it — the panel does not scroll far enough to show it`)
      const missed = a.hits.filter(h => h !== true).length
      if (missed) fail(`${at}: "${a.label}", scrolled to, hit-tests to itself at only ${a.hits.length - missed} of ${a.hits.length} points (centre and four corners: ${a.hits.join(', ')}) — something is painted over it`)
      if (a.overlappers.length) fail(`${at}: ${a.overlappers.length} element(s) share part of "${a.label}"'s box: ${a.overlappers.join('; ')}`)
      if (a.noticeAbove === false) fail(`${at}: the notice is not above "${a.label}" — a sentence about the save sits under the button it is about`)
      if (a.errorAbove === false) fail(`${at}: the refusal sentence is not above "${a.label}"`)

      // ── (d) NO SIDEWAYS SCROLL.
      if (m.sidewaysScroll) fail(`${at}: document scrollWidth ${m.docScrollW} > clientWidth ${m.docClientW} — the page scrolls sideways`)
      if (m.sheet.overflowsX) fail(`${at}: sheet panel scrollWidth ${m.sheet.scrollW} > clientWidth ${m.sheet.clientW} — something in the sheet is wider than the panel, which does NOT show up as document scroll`)
      if (m.sheet.left < -0.5 || m.sheet.right > vw + 0.5) fail(`${at}: sheet panel spans x${m.sheet.left}-${m.sheet.right}, outside the ${vw}px viewport`)

      // ── The record. Printed on pass as well as fail: these are the numbers a redesign has to move.
      const minTap = Math.min(...m.taps.map(t => t.h))
      console.log(`[save-seed-sheet] ${at}: ${m.counts.rows} row(s) ${m.rowHeights.join('/')}px · ${m.counts.removes} remove ${m.removeBoxes.map(r => `${r.w}x${r.h}`).join('/') || '—'} · ${m.counts.controls} controls, shortest ${minTap}px (floor ${TAP_MIN_HEIGHT_PX}px), ${short.length} under · notice ${m.counts.noticeSentences} set sentence(s)`)
      console.log(`[save-seed-sheet] ${at}: sheet y${m.sheet.top}-${m.sheet.bottom} h${m.sheet.height} · gutter L${m.sheet.gutterL}/R${m.sheet.gutterR}px [REPORTED] · scrollable ${m.sheet.scrollable} (${m.sheet.hiddenBelowPx}px below the fold) · "${a.label}" h${a.h} at rest y${a.top}-${a.bottom} insidePanel ${a.insidePanelAtRest} · scrolled to y${a.scrolledTop}-${a.scrolledBottom}, hits ${a.hits.filter(h => h === true).length}/${a.hits.length}, overlapped by ${a.overlappers.length}`)
      console.log(`[save-seed-sheet] ${at}: Variety "${m.varietyName}" (${m.varietyName.length} chars, ${m.varietyLines} line(s)) · Lot name field ${m.nameField.chars} chars, ink ${m.nameField.scrollW}px in ${m.nameField.clientW}px, ${m.nameField.clips ? 'SCROLLS INSIDE THE FIELD' : 'fits'} [REPORTED, NOT ASSERTED — a single-line input; the name is printed in full in the Variety row] · focus on "${m.focused ?? 'nothing'}" [REPORTED]${m.errorText ? ` · refusal "${m.errorText}"` : ''}`)
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
// not the code — says which one happened.
if (failures.length) {
  console.error(PROBE_NOTHING
    ? '\n[save-seed-sheet] FAIL — EXPECTED. --probe-nothing pointed every selector at a testid nothing renders and the instrument check caught it. This red is the proof the check fires; exit 1 is the correct outcome for this arm.'
    : '\n[save-seed-sheet] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) {
  console.error('\n[save-seed-sheet] FAIL — and this one is the real defect: every selector pointed at a testid that does not exist and the gate still found nothing to complain about. The non-vacuity checks are not doing their job.')
  process.exit(1)
}
console.log('[save-seed-sheet] PASS')
armExitWatchdog()
