#!/usr/bin/env node
// putup-refusal-view.mjs — BUG-PUTUPREPLAYREST-001: is the Put-Up replay refusal line ON SCREEN when it
// appears, in real Chrome, at Dave's 426×836 (DPR 3)?
//
//   node scripts/layout-gate/putup-refusal-view.mjs                 # every sheet, every arrival
//   node scripts/layout-gate/putup-refusal-view.mjs --sheet door    # one sheet (door, recipe, putupdoor, start, putitup, walk)
//   node scripts/layout-gate/putup-refusal-view.mjs --shots <dir>   # also write a PNG per measurement
//   node scripts/layout-gate/putup-refusal-view.mjs --list          # print the test ids each sheet draws
//
// NOT WIRED INTO CI (no package.json script, no workflow step): a tool a lane runs by hand. It still ends
// through exit-watchdog.mjs like every gate here, so it cannot idle after PASS.
//
// WHAT IT DRIVES (tests/harness/putuprefusal.jsx fakes only the far side of the wire):
//   1. the sheet is filled through its real controls, every disclosure open, so it scrolls;
//   2. Save — the request goes out and no answer comes back;
//   3. one field is changed — `end`: the notes, where the form ends (he is at the bottom of the sheet);
//      `top`: the name, after scrolling back to the top of the sheet (the line will be a whole screen away);
//   4. Save again — the server answers "that key already made a row", the row is not this sitting's, and
//      the sheet refuses. The refusal line is the last thing in the scroller, under the pinned Save.
// Every tap is CDP Input.dispatchMouseEvent at the control's own centre and every character is
// Input.insertText into the field that tap focused — the trusted-input path the Today gates use
// (today-shape-v2.mjs). A tap whose point is not painted by its target fails the run; nothing is clicked
// from page script. The keyboard is NOT emulated: this is the phone at rest.
//
// WHAT IT ASSERTS, per sheet and arrival, with the keyboard down:
//   · the line's box is inside the scroller's box and ends above the pinned footer's top;
//   · the browser paints the LINE at nine points across it (elementFromPoint) — a point under the footer
//     answers with the footer;
//   · on the Walk (`saveScrolls`): the group's Save, under the line, is whole above the band as well;
//   · the refusal text is the replay refusal, and exactly two creates went out (never a third);
//   · BUG-PUTUPSAVEFAILHIDDEN-001: the ORDINARY failure line the first, lost Save leaves ("Couldn't save
//     it…") passes the same two checks, and is not the refusal. Its own instrument check: the scroller put
//     back where it stood when Save was tapped must NOT read as fully visible.
// INSTRUMENT CHECK, every run: the scroller is then put back where it stood when Save was tapped (`top`
// arrival: scrollTop 0) and measured again. That state MUST read as not visible — it is what the sheet
// would show with no scroll on refusal — or the verdict above is not worth reading.
//
// THE THREE QA I-5 SCENARIOS (BUG-PUTUPREPLAYREST-001 review, I-5) — the refusals that work added, which had
// been seen only in jsdom. Each is ONE arrival (`change`) through the same loop and the same assertions:
//   · putupdoor — the door on a METHOD chip with its options CLOSED; the lost Save; the date changed (the
//     options opened, Yesterday, the options closed again); Save → "Already in the Pantry as …, put up … Set
//     the date back to …". Also measured: the When chips the refusal opened (`also`).
//   · start — Start a batch: a name, the lost tap, When changed, Start it → "This batch is already started …".
//   · putitup — Put it up with two rows and "More about this sitting" open; the lost tap; a count changed;
//     tap → "This is already put up …".
// A sheet short enough not to scroll when it is filled is allowed for these (`mayNotScroll`): then nothing can
// be under the fold at the FIRST failure and that one instrument check is skipped, and said so.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'
import { armExitWatchdog } from './exit-watchdog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5357)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9467)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
const ONLY = arg('--sheet')
const SHOTS = arg('--shots')
const LIST = process.argv.includes('--list')
const [VW, VH] = [426, 836]

// Each sheet's walk. `fill` opens everything the sheet can hold; `end` / `top` are the one change made
// between the lost Save and the retry. A step is [verb, test id, text?].
const SHEETS = {
  door: {
    ids: { error: 'door-error', footer: 'door-footer', save: 'door-save' },
    refusal: /was already saved earlier — it is in the Pantry\. This Save did not change it\./,
    fill: [
      ['type', 'door-what-name', 'Sweet corn, cut off the cob'],
      ['tap', 'door-place-id:loc-cf1'],
      ['tap', 'door-method-as_is'],
      ['tap', 'door-amount-open'],
      ['type', 'door-amount-value', '2'],
      ['tap', 'door-amount-unit-bag'],
      ['tap', 'door-more'],
      ['tap', 'door-from'],
      ['tap', 'door-source-more'],
      ['type', 'door-notes', 'Two bags from the farm stand, blanched'],
    ],
    end: [['type', 'door-notes', ' and cooled']],
    top: [['type', 'door-what-name', ', late']],
  },
  recipe: {
    ids: { error: 'recipe-sheet-error', footer: 'recipe-sheet-footer', save: 'recipe-save' },
    refusal: /was already saved earlier — it is with your recipes\. This Save did not change it\./,
    fill: [
      ['type', 'recipe-name', 'Smoked reaper hot sauce'],
      ['type', 'recipe-notes', 'Char the onion first. Ferment three weeks, then blend and strain.'],
      ['type', 'recipe-keeps-n', '6'],
      ['tap', 'recipe-keeps-unit-month'],
      ['tap', 'recipe-keeps-kind-fridge'],
      ['type', 'recipe-made-text', '228 g, one bottle'],
    ],
    end: [['type', 'recipe-made-text', ' and a half']],
    top: [['type', 'recipe-name', ', the charred one']],
  },
}

Object.assign(SHEETS, {
  putupdoor: {
    page: 'putupdoor', arrivals: ['change'], mayNotScroll: true,
    ids: { error: 'door-error', footer: 'door-footer', save: 'door-save' },
    refusal: /^Already in the Pantry as “Sweet corn, cut off the cob”, put up .+ — an earlier Save went through\. That date can't be changed once it is saved\. Set the date back to .+ and tap Save to put your other changes on it\.$/,
    fill: [
      ['type', 'door-what-name', 'Sweet corn, cut off the cob'],
      ['tap', 'door-place-id:loc-cf1'],
      ['tap', 'door-method-whole_freeze'],
    ],
    // The options are opened for the date and CLOSED again: the refusal has to open them itself.
    change: [['tap', 'door-more'], ['tap', 'door-when-yesterday'], ['tap', 'door-more']],
    also: ['door-when-yesterday'],
  },
  start: {
    page: 'start', arrivals: ['change'], mayNotScroll: true,
    ids: { error: 'start-error', footer: 'start-footer', save: 'start-submit' },
    failure: /^Couldn't start it/,
    refusal: /^This batch is already started — an earlier tap on “Start it” went through\. This tap changed nothing on it\. Close this and open the batch to see it\.$/,
    fill: [
      ['type', 'start-label', 'Megatron mash, the red one'],
      ['tap', 'start-kind-toggle'],
      ['tap', 'start-kind-other'],
      ['type', 'start-kind-other-text', 'a mash'],
      ['tap', 'following-recipe-toggle'],
      ['type', 'following-recipe-ref', 'Noma guide, p. 40'],
    ],
    // When changed — to "Earlier… → Last month", which also makes the sheet longer than the screen, so the line
    // has somewhere to be hidden and the instrument check below means something.
    change: [['tap', 'start-when-earlier'], ['tap', 'start-when-last_month']],
  },
  putitup: {
    page: 'putitup', arrivals: ['change'], mayNotScroll: true,
    ids: { error: 'putup-error', footer: 'putup-footer', save: 'putup-finish' },
    failure: /^Couldn't put it up/,
    refusal: /^This is already put up — an earlier tap went through\. This tap changed nothing on it\. Close this and open the batch to see what was put up\.$/,
    fill: [
      ['tap', 'putup-method-hot_sauce'],
      ['tap', 'putup-row-0-place-id:loc-fridge'],
      ['tap', 'putup-row-add'],
      ['tap', 'putup-sitting-more'],
    ],
    change: [['tap', 'putup-row-1-plus']],
  },
})

// THE WALK (BUG-PUTUPREPLAYREST-001 re-review I-E). In a walk a refusal that leaves the group spent now ends with
// the way on ("To log more here, end this walk and start another."), which makes the walk's "saved earlier" line its
// longest. The Walk is a page: the document scrolls, the fixed band ("End the walk") is what can cover the line,
// and Save is the group's own button UNDER the line — so it is tapped where it is brought to (`saveScrolls`), and
// the line must then be whole above the band. Its options are opened so the group is as tall as it gets.
Object.assign(SHEETS, {
  walk: {
    page: 'walk', arrivals: ['change'], mayNotScroll: true, saveScrolls: true,
    ids: { error: 'walk-error', footer: 'putup-walk-band', save: 'walk-save' },
    refusal: /^“Sweet corn, cut off the cob, late” was already saved earlier — it is in the Pantry\. This Save did not change it\. To change it, open it in the Pantry\. To log more here, end this walk and start another\.$/,
    fill: [
      ['tap', 'putup-walk-place-id:loc-cf1'],
      ['tap', 'putup-walk-when-this_month'],
      ['tap', 'putup-walk-start'],
      ['type', 'walk-what-name', 'Sweet corn, cut off the cob'],
      ['tap', 'walk-method-as_is'],
      ['tap', 'walk-more'],
    ],
    change: [['type', 'walk-what-name', ', late']],
  },
})

const failures = []
const fail = m => failures.push(m)

// A port something else is already serving is REFUSED, never measured through (OPS-PUTUPGATEPORTREFUSAL-001).
async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — set GATE_HARNESS_PORT / GATE_CDP_PORT to free ports`)
}

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
  // Through vite's own bin, never `npx vite`: killing npx at teardown orphans the real server.
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tests/harness/putuprefusal.html`)
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
  await assertPortFree(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP')
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
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id)
      clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  // Each call's timeout is CLEARED when its answer lands (see exit-watchdog.mjs for what an armed one costs).
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
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn }
}

const sel = (tid) => `[data-testid=${JSON.stringify(tid)}]`

// Where a finger would land on the control: its centre, once it is on screen above the pinned footer.
// `still` leaves the scroller where it is (the pinned Save, and anything measured in place).
async function pointOf(cdp, s, tid, { still = false } = {}) {
  const p = await cdp.evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(sel(tid))})
    if (!el) return { missing: true }
    const footer = document.querySelector(${JSON.stringify(sel(s.ids.footer))})
    if (!${still}) {
      const r0 = el.getBoundingClientRect()
      const floor = footer ? footer.getBoundingClientRect().top : innerHeight
      if (r0.top < 60 || r0.bottom > floor - 8) el.scrollIntoView({ block: 'center' })
    }
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return { x, y, hit: !!top && (top === el || el.contains(top) || top.contains(el)), disabled: !!el.disabled }
  })()`)
  if (p.missing) throw new Error(`no ${sel(tid)} on the sheet`)
  if (p.disabled) throw new Error(`${sel(tid)} is disabled`)
  if (!p.hit) throw new Error(`${sel(tid)} is not what is painted at its own centre (${Math.round(p.x)},${Math.round(p.y)}) — a tap there would land on something else`)
  return p
}

async function tap(cdp, s, tid, opts) {
  const p = await pointOf(cdp, s, tid, opts)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, cdp.sessionId)
  await sleep(250)
}

// Appends: the tap puts the cursor in the field, End moves it past what is there, the text is inserted.
async function type(cdp, s, tid, text) {
  await tap(cdp, s, tid)
  const focused = await cdp.evalIn(`document.activeElement === document.querySelector(${JSON.stringify(sel(tid))})`)
  if (!focused) throw new Error(`the tap on ${sel(tid)} did not focus it`)
  await cdp.evalIn(`(() => { const el = document.activeElement; const n = el.value.length; try { el.setSelectionRange(n, n) } catch {} })()`)
  await cdp.send('Input.insertText', { text }, cdp.sessionId)
  await sleep(250)
}

async function walk(cdp, s, steps) {
  for (const [verb, tid, text] of steps) {
    if (verb === 'tap') await tap(cdp, s, tid)
    else await type(cdp, s, tid, text)
  }
}

// A real wheel over the sheet, until the scroller is at its top.
async function wheelToTop(cdp) {
  for (let i = 0; i < 20; i++) {
    const at = await cdp.evalIn(`document.querySelector('[role="dialog"]').scrollTop`)
    if (at <= 0) return
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: VW / 2, y: VH / 2, deltaX: 0, deltaY: -600 }, cdp.sessionId)
    await sleep(200)
  }
  throw new Error('the wheel never brought the sheet back to its top')
}

async function shot(cdp, name) {
  if (!SHOTS) return null
  mkdirSync(SHOTS, { recursive: true })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, cdp.sessionId)
  const file = join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

// fully visible · partly covered · off-screen — from the line's box against the scroller's box and the
// pinned footer's top, AND from what the browser says is painted at nine points of the line.
function verdictOf(m) {
  if (!m.line || !m.footer || !m.panel) return 'not drawn'
  const floor = Math.min(m.footer.top, m.panel.bottom, m.vh)
  const ceil = Math.max(m.panel.top, 0)
  const seen = m.hits.filter(h => h.line).length
  if (m.line.top >= ceil - 0.5 && m.line.bottom <= floor + 0.5 && seen === m.hits.length) return 'fully visible'
  if (m.line.bottom <= ceil || m.line.top >= floor || seen === 0) return 'off-screen'
  return 'partly covered'
}
// BUG-WALKSAVEUNDERBAND-001: where Save is the group's own button UNDER the line (`saveScrolls`), a refusal must
// leave it whole above the band too — a line of several rows used to push it under, 15 px a row.
const saveCovered = (m) => !m.save || !m.footer || m.save.top < -0.5 || m.save.bottom > Math.min(m.footer.top, m.vh) + 0.5
const say = (m) => `line y${m.line?.top}–${m.line?.bottom} (h ${m.line?.height}) · footer top y${m.footer?.top} · Save y${m.save?.top}–${m.save?.bottom} · scroller y${m.panel?.top}–${m.panel?.bottom}, scrollTop ${m.scroll?.top} of ${m.scroll ? m.scroll.height - m.scroll.client : '?'} · painted as the line at ${m.hits.filter(h => h.line).length}/${m.hits.length} points (${m.hits.filter(h => h.footer).length} answer with the footer)`

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-putuprefusal-'))
const t0 = Date.now()
const results = []
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 3, mobile: true }, cdp.sessionId)
  for (const [name, s] of Object.entries(SHEETS)) {
    if (ONLY && ONLY !== name) continue
    for (const arrival of (s.arrivals ?? ['end', 'top'])) {
      const at = `${name}/${arrival}@${VW}x${VH}`
      try {
        const nav = await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/putuprefusal.html?sheet=${s.page ?? name}` }, cdp.sessionId)
        if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`)
        await sleep(300)
        await cdp.evalIn(`(async()=>{for(let i=0;i<300;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('the harness never reached ready()')})()`)
        await sleep(400)
        if (LIST) { console.log(`[refusal] ${name}: ${(await cdp.evalIn('window.__h.testids()')).join(' ')}`); break }

        await walk(cdp, s, s.fill)
        const filled = await cdp.evalIn('window.__h.measure()')
        if (filled.vw !== VW || filled.vh !== VH || filled.dpr !== 3) throw new Error(`the page self-reports ${filled.vw}x${filled.vh} @${filled.dpr} — emulation did not take`)
        if (!filled.font || !(filled.font.faces > 0) || filled.font.failed > 0) throw new Error(`the Roboto pin did not load (${JSON.stringify(filled.font)})`)
        const scrolls = filled.scroll.height > filled.scroll.client + 40
        if (!scrolls && !s.mayNotScroll) throw new Error(`the filled sheet does not scroll (${filled.scroll.height} in ${filled.scroll.client}) — nothing could be under the fold`)

        await tap(cdp, s, s.ids.save, { still: !s.saveScrolls })
        await sleep(500)
        const lost = await cdp.evalIn('window.__h.measure()')
        if (lost.creates !== 1) throw new Error(`the first Save sent ${lost.creates} creates, not 1 (calls: ${lost.calls.join(' | ')}; line: ${lost.text})`)
        const lpng = await shot(cdp, `${name}-${arrival}-1-first-save-lost`)
        const lv = verdictOf(lost)
        console.log(`[refusal] ${at}: first Save lost, its failure line ${JSON.stringify(lost.text)}: ${lv.toUpperCase()} — ${say(lost)}${lpng ? `\n            ${lpng}` : ''}`)
        if (!(s.failure ?? /^Couldn't save it/).test(lost.text ?? '') || s.refusal.test(lost.text ?? '')) fail(`${at}: the first Save's line is not the ordinary failure: ${JSON.stringify(lost.text)}`)
        if (lv !== 'fully visible') fail(`${at}: the first Save's failure line is ${lv} — ${say(lost)}`)
        if (s.saveScrolls && saveCovered(lost)) fail(`${at}: after the first Save's failure line, Save is not whole above the footer — ${say(lost)}`)
        // Its instrument check: the scroller back where it stood when Save was tapped, then put back again.
        let lc = lost
        let lcv = 'not run (the filled sheet does not scroll: nothing can be under the fold)'
        if (scrolls) {
          await cdp.evalIn(`window.__h.setScroll(${filled.scroll.top})`)
          await sleep(200)
          lc = await cdp.evalIn('window.__h.measure()')
          lcv = verdictOf(lc)
          console.log(`[refusal] ${at}: first-failure control (scrollTop back to ${filled.scroll.top}, as with no scroll on a failed Save): ${lcv} — ${say(lc)}`)
          if (lcv === 'fully visible') fail(`${at}: the first-failure instrument check did not fire — unscrolled, the line still reads as fully visible`)
          await cdp.evalIn(`window.__h.setScroll(${lost.scroll.top})`)
          await sleep(200)
        } else console.log(`[refusal] ${at}: first-failure control ${lcv} (${filled.scroll.height} in ${filled.scroll.client})`)

        if (arrival === 'top') await wheelToTop(cdp)
        await walk(cdp, s, s[arrival])
        const before = await cdp.evalIn('window.__h.measure()')
        await tap(cdp, s, s.ids.save, { still: !s.saveScrolls })
        await sleep(700)
        const m = await cdp.evalIn('window.__h.measure()')
        if (m.creates !== 2) throw new Error(`the retry sent ${m.creates - 1} creates, not 1 (calls: ${m.calls.join(' | ')})`)
        if (m.saved) throw new Error('the retry SAVED — the sheet did not refuse')
        if (!s.refusal.test(m.text ?? '')) throw new Error(`the line is not the replay refusal: ${JSON.stringify(m.text)}`)
        const v = verdictOf(m)
        const png = await shot(cdp, `${name}-${arrival}-2-refused`)
        console.log(`[refusal] ${at}: ${v.toUpperCase()} — ${say(m)}${png ? `\n            ${png}` : ''}`)
        console.log(`            ${JSON.stringify(m.text)}`)
        if (v !== 'fully visible') fail(`${at}: the refusal line is ${v} — ${say(m)}`)
        if (s.saveScrolls && saveCovered(m)) fail(`${at}: after the refusal line (h ${m.line?.height}), Save is not whole above the footer — ${say(m)}`)
        // The sheet's own header row, while it is on screen: the line is wholly below it.
        if (m.header && m.header.bottom > m.panel.top + 0.5 && m.line.top < m.header.bottom - 0.5) fail(`${at}: the refusal line starts above the sheet header's bottom (line y${m.line.top}, header bottom y${m.header.bottom})`)
        // What the refusal is ABOUT must be on the page (it opened its disclosure); whether it is on screen with
        // the line is measured and said — the line is the thing that has to be read.
        const also = []
        for (const tid of (s.also ?? [])) {
          const o = await cdp.evalIn(`window.__h.onScreen(${JSON.stringify(tid)})`)
          also.push({ tid, ...o })
          console.log(`[refusal] ${at}: ${tid} — ${!o.drawn ? 'NOT ON THE PAGE' : o.whole ? `on screen with the line (y${o.box.top}–${o.box.bottom})` : `on the page, not on screen with the line (y${o.box.top}–${o.box.bottom})`}`)
          if (!o.drawn) fail(`${at}: ${tid} is not on the page after the refusal — the disclosure it sits behind did not open`)
        }

        // INSTRUMENT CHECK: the scroller back where it stood when Save was tapped.
        await cdp.evalIn(`window.__h.setScroll(${before.scroll.top})`)
        await sleep(200)
        const c = await cdp.evalIn('window.__h.measure()')
        const cv = verdictOf(c)
        const cpng = await shot(cdp, `${name}-${arrival}-3-control-unscrolled`)
        console.log(`[refusal] ${at}: control (scrollTop back to ${before.scroll.top}, as with no scroll on refusal): ${cv} — ${say(c)}${cpng ? `\n            ${cpng}` : ''}`)
        if (arrival === 'top' && cv === 'fully visible') fail(`${at}: the instrument check did not fire — with the sheet at its top the line still reads as fully visible, so this run cannot tell a covered line from a clear one`)
        results.push({ at, verdict: v, also, measured: m, lost: { text: lost.text, verdict: lv, line: lost.line, footer: lost.footer, scroll: lost.scroll, hits: lost.hits, control: { verdict: lcv, line: lc.line, scroll: lc.scroll } }, control: { verdict: cv, measured: c } })
      } catch (e) {
        fail(`${at}: ${e.message}`)
      }
    }
  }
  if (SHOTS && results.length) writeFileSync(join(SHOTS, 'measurements.json'), JSON.stringify(results, null, 2))
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (failures.length) {
  console.error('\n[refusal] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log(`[refusal] PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
armExitWatchdog()
