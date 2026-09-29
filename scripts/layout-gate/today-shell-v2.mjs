#!/usr/bin/env node
// today-shell-v2.mjs — gate:today-shell:v2, the Today V2 states inside the APP SHELL (V5-TODAYREDESIGN-001 S0).
//
//   node scripts/layout-gate/today-shell-v2.mjs                  # npm run gate:today-shell:v2
//   node scripts/layout-gate/today-shell-v2.mjs --probe-nothing  # every shell anchor points at nothing; MUST exit 1
//
// Drives tests/harness/todayshell.{html,jsx} — real TopChrome, a 56px BottomNav band, the REAL page-scroll
// manager called exactly as AppShell calls it — in real Chrome at a CDP-emulated 426x836 @ DPR 3 (never
// --window-size: macOS floors an OS window at ~500px). It owns the platform half of plan-v2 §9.1:
//   ARMED from S0 — `shell-instrument`: the shell this gate stands on. TopChrome paints at y=0 with BAR_H
//     (read from src/components/TopChrome.jsx) and position sticky; the nav band's top is VIEWPORT.h −
//     BOTTOM_NAV_HEIGHT_PX and --bottom-nav-height says so; the band between them is FIRST_SCREEN (728 today)
//     MEASURED, not computed; history.scrollRestoration is 'manual' when SCROLL_MANAGER_ENABLED (main.jsx's
//     boot line ran); /api/members was answered production-shaped (2 members, never []); the prefs GET went
//     out to the stub critter origin; and the drift guard below holds.
//   PENDING until their slices land (today-v2-contract.mjs SHELL): (f) sticky, (g) jump landing, (m) Back.
// Every PENDING check is printed and counted, never passed. A new script; nothing in page-scroll.mjs or
// pagescroll.jsx (the SEEDS session's) is touched — the helpers below are copies.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'
import { BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'
import { SHELL, LANDED, isArmed, stateByName } from '../../tests/harness/_todaymeasure/today-v2-contract.mjs'
// S3: where each jump chip lands — the bar's own table (src/lib/todayV2/chips.js), not a copy.
import { CHIPS } from '../../src/lib/todayV2/chips.js'

// plan-v2 §4 / §9.1 (f)(g): the bar is 57px in both states and a jump lands a header within 8px under it.
const BAR_HEIGHT_PX = 57
const LANDING_GAP_PX = 8
const CHIP_SECTION = Object.fromEntries(Object.entries(CHIPS).map(([k, c]) => [k, c.section]))

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5351)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9451)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const HARNESS_CONFIG = process.env.GATE_HARNESS_CONFIG || 'tests/harness/vite.harness.v2.mjs'
const VIEWPORT = { w: Number(process.env.GATE_VIEWPORT_W || 426), h: Number(process.env.GATE_VIEWPORT_H || 836), dpr: Number(process.env.GATE_VIEWPORT_DPR || 3) }
const PROBE_NOTHING = process.argv.includes('--probe-nothing')
const ARM_ALL = PROBE_NOTHING || process.argv.includes('--arm-all')
const SUFFIX = PROBE_NOTHING ? '-PROBE-NOTHING' : ''

const src = (f) => readFileSync(resolve(ROOT, f), 'utf8')
function readOne(file, re, what) {
  const found = [...src(file).matchAll(re)].map((m) => m[1])
  if (found.length !== 1) throw new Error(`${file} carries ${what} ${found.length} times; expected exactly 1`)
  return found[0]
}
const BAR_H = Number(readOne('src/components/TopChrome.jsx', /const BAR_H = (\d+)/g, 'BAR_H'))
const MANAGER_ON = readOne('src/lib/featureFlags.js', /export const SCROLL_MANAGER_ENABLED = (true|false)/g, 'SCROLL_MANAGER_ENABLED') === 'true'
const FIRST_SCREEN = VIEWPORT.h - BAR_H - BOTTOM_NAV_HEIGHT_PX

const failures = []
const fail = (at, family, msg) => failures.push(`${at}: [${family}] ${msg}`)

// DRIFT GUARD — the shell must stay the shell prod has. Same idiom as page-scroll.mjs's harnessCopyDrift.
function drift() {
  const out = []
  const app = src('src/App.jsx')
  const shell = src('tests/harness/todayshell.jsx')
  const managerCall = /usePageScrollManager\(\{ pageLocation, location: overlayLocation, navigationType, ready: [^}]*\}\)/
  const managerProvider = /<PageScrollProvider value=\{pageScroll\}>\s*<TopChrome \/>/
  const appShell = app.match(/function AppShell\([\s\S]*?\n\}\n/)
  if (!appShell || !managerCall.test(appShell[0]) || !managerProvider.test(appShell[0])) out.push('src/App.jsx AppShell no longer calls usePageScrollManager({ pageLocation, location: overlayLocation, navigationType, ready }) and opens <PageScrollProvider value={pageScroll}> with <TopChrome /> — re-model tests/harness/todayshell.jsx on it')
  if (!/from '\.\.\/\.\.\/src\/hooks\/usePageScrollManager\.js'/.test(shell) || !managerCall.test(shell) || !managerProvider.test(shell)) out.push('tests/harness/todayshell.jsx no longer mounts the REAL page-scroll manager and TopChrome the way AppShell does')
  const bootCall = /\napplyBrowserScrollRestoration\(SCROLL_MANAGER_ENABLED\)\n/
  if (!bootCall.test(src('src/main.jsx'))) out.push('src/main.jsx no longer calls applyBrowserScrollRestoration(SCROLL_MANAGER_ENABLED) at boot')
  if (!bootCall.test(shell)) out.push('tests/harness/todayshell.jsx does not set the browser\'s restore mode as main.jsx does')
  const pad = "paddingBottom: user ? 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))'"
  if (!app.includes(pad)) out.push('App.jsx\'s content wrapper no longer reserves calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px)) — the shell copies that padding')
  if (!shell.includes("paddingBottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))'")) out.push('tests/harness/todayshell.jsx no longer reserves the nav band the way App.jsx does')
  // The payload builders todayshell.jsx copies from todaymeasure.jsx (unified at S8c).
  const body = (text, name) => { const m = text.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\}`)); return m ? m[0].replace(/\s+/g, ' ').trim() : null }
  const tm = src('tests/harness/todaymeasure.jsx')
  for (const fn of ['rebase', 'graftBusyfull']) { const a = body(tm, fn), b = body(shell, fn); if (!a || !b) out.push(`could not read ${fn}() in ${a ? 'todayshell.jsx' : 'todaymeasure.jsx'} — the copy guard cannot compare it`); else if (a !== b) out.push(`tests/harness/todayshell.jsx ${fn}() no longer matches todaymeasure.jsx — re-copy it`) }
  if (!/\{ members: \[\{ id: 'harness_user', display_name: '[^']+' \}, \{ id: 'member_jen', display_name: 'Jen' \}\] \}/.test(shell)) out.push('tests/harness/todayshell.jsx no longer answers /api/members production-shaped (two members) — an empty roster hides the household path')
  return out
}

async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — another harness or Chrome is running there. Set GATE_HARNESS_PORT / GATE_CDP_PORT to free ports.`)
}
async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
  const proc = spawn(process.execPath, [bin, '--config', HARNESS_CONFIG, '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const forward = d => { log += d; for (const line of String(d).split('\n')) if (line.includes('[MUTANT APPLIED]')) console.error(line) }
  proc.stdout.on('data', forward); proc.stderr.on('data', forward)
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/tests/harness/todayshell.html`); if (r.ok) return proc } catch { /* not yet */ }
    if (proc.exitCode != null) throw new Error(`harness vite exited (${proc.exitCode}):\n${log}`)
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`harness vite never served :${PORT} within 40s:\n${log}`)
}
async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  await assertPortFree(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP')
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...EXTRA_CHROME_FLAGS], { stdio: ['ignore', 'ignore', 'ignore'] })
  const tries = Math.max(1, Math.ceil(Number(process.env.CDP_WAIT_MS ?? 60000) / 250))
  for (let i = 0; i < tries; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Chrome EXITED before exposing CDP on ${CDP_PORT} — a dead browser, not a slow one`)
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return { proc, version: await r.json() } } catch { /* not up */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT}`)
}
async function attach(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pend = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id != null && pend.has(m.id)) { const { res, rej, timer } = pend.get(m.id); clearTimeout(timer); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 120000)
    pend.set(mid, { res, rej, timer })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId)
  const evalIn = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value }
  return { ws, send, sessionId, evalIn }
}
let cdp
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i
async function evalSettled(expr, tries = 25) {
  let last
  for (let i = 0; i < tries; i++) { try { return await cdp.evalIn(expr) } catch (err) { if (!CONTEXT_LOST.test(err.message)) throw err; last = err; await sleep(200) } }
  throw new Error(`page never held still long enough to evaluate: ${last?.message}`)
}

// The shell's geometry, read with the probe suffix applied (so --probe-nothing blinds exactly these anchors).
const CHROME_MEASURE = `(() => {
  const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height } }
  const top = document.querySelector('header[data-app-chrome="top${SUFFIX}"]')
  const nav = document.querySelector('[data-testid="harness-bottom-nav${SUFFIX}"]')
  return { top: r(top), topPosition: top ? getComputedStyle(top).position : null, topState: top ? top.getAttribute('data-chrome-state') : null,
    nav: r(nav), navVar: getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height').trim(),
    restoration: history.scrollRestoration, vw: innerWidth, vh: innerHeight,
    h: { error: window.__h.error(), problem: window.__h.problem(), route: window.__h.route(), clock: window.__h.clock(), fixtures: window.__h.fixtures(), v2: window.__h.v2(),
      live: window.__h.requests().filter(x => x.live).map(x => x.path),
      prefsGets: window.__h.requests().filter(x => /\\/api\\/notifications\\/prefs(\\?|$)/.test(x.path) && x.method === 'GET').length,
      membersGets: window.__h.requests().filter(x => /\\/api\\/members(\\?|$)/.test(x.path)).length },
    fontPin: window.__fontPin || null }
})()`

// ── S3: (g) jump landing and (f) sticky, measured in the page. Chips are tapped as a finger would (hit-tested at
// their centre, then clicked); a jump is judged once the scroll has SETTLED (smooth unless reduced motion), so a
// landing is never read mid-animation. Reports facts; the checks below judge them.
const SETTLE = `async () => { let last = -1, same = 0; for (let i = 0; i < 240; i++) { await new Promise(r => requestAnimationFrame(r)); const y = window.scrollY; if (Math.abs(y - last) < 0.5) { if (++same >= 10) return y } else same = 0; last = y } return window.scrollY }`
// One chip's jump, measured once its scroll has settled. Integration S3 × S4 adds what the page can show about the
// FOCUS the jump leaves (family jump-focus): whether the focused header is hidden by TopChrome or the bar (WCAG
// 2.4.11 — hit-tested over a grid of points on the header, not computed from its top), and the landing's scroll
// room (a page shorter than the jump needs clamps the landing: the Feed / Check pre-select shrinks Needs care).
const CHIP_KEYS = `(() => { const bar = document.querySelector('[data-testid="today-jumpbar${SUFFIX}"]'); return bar ? [...bar.querySelectorAll('[data-chip]')].map(c => c.getAttribute('data-chip')) : null })()`
const JUMP = (key) => `(async () => {
  const settle = ${SETTLE}
  const bar = document.querySelector('[data-testid="today-jumpbar${SUFFIX}"]')
  const key = ${JSON.stringify(key)}
  window.scrollTo(0, 0); await settle()
  const chip = bar.querySelector('[data-chip="' + key + '"]')
  const cr = chip.getBoundingClientRect()
  const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2)
  if (!hit || !(hit === chip || chip.contains(hit))) return { key, covered: true }
  // Focus on the chip first, as a keyboard, switch or tapped button has it, so each jump starts from the same
  // place: where focus ends (and where the next Tab goes) is then the jump's doing, not the last jump's.
  chip.focus({ preventScroll: true })
  chip.click()
  const y = await settle()
  const section = ${JSON.stringify(CHIP_SECTION)}[key]
  const sec = document.querySelector('[data-testid="today-sec-' + section + '${SUFFIX}"]')
  const header = sec ? sec.querySelector('[aria-expanded]') : null
  const br = bar.getBoundingClientRect()
  const hr = header ? header.getBoundingClientRect() : null
  let shownPoints = null
  if (hr) { shownPoints = 0; for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fy of [0.2, 0.5, 0.8]) { const px = hr.left + hr.width * fx, py = hr.top + hr.height * fy; if (py < 0 || py >= innerHeight) continue; const h = document.elementFromPoint(px, py); if (h && (h === header || header.contains(h))) shownPoints++ } }
  return { key, section, y, found: !!header, expanded: header ? header.getAttribute('aria-expanded') : null,
    headerTop: hr ? hr.top : null, headerBottom: hr ? hr.bottom : null, barBottom: br.bottom,
    focused: !!header && document.activeElement === header, shownPoints,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    maxScroll: document.documentElement.scrollHeight - innerHeight }
})()`
// After a jump, where one Tab puts focus: inside the jumped-to section (its body follows its header in the DOM),
// or elsewhere. Read after a REAL key press (CDP Input), which moves focus the way a keyboard or a switch does.
const AFTER_TAB = (section) => `(() => { const sec = document.querySelector('[data-testid="today-sec-${section}${SUFFIX}"]'); const a = document.activeElement
  const hdr = sec ? sec.querySelector('[aria-expanded]') : null
  return { inside: !!sec && !!a && sec.contains(a) && a !== hdr, what: a ? a.tagName.toLowerCase() + (a.getAttribute('data-testid') ? '[' + a.getAttribute('data-testid') + ']' : '') + (a.getAttribute('data-chip') ? '[chip ' + a.getAttribute('data-chip') + ']' : '') + ' "' + (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) + '"' : 'nothing' } })()`
async function runJumps() {
  const keys = await evalSettled(CHIP_KEYS)
  if (!keys) return { bar: false }
  const out = []
  for (const key of keys) {
    const j = await evalSettled(JUMP(key))
    if (!j.covered && j.found) {
      for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, cdp.sessionId)
      j.afterTab = await evalSettled(AFTER_TAB(j.section))
    }
    out.push(j)
  }
  return { bar: true, out }
}
const STICKY = `(async () => {
  const settle = ${SETTLE}
  const bars = () => [...document.querySelectorAll('[data-testid="today-jumpbar${SUFFIX}"]')]
  const bar = bars()[0]
  const top = document.querySelector('header[data-app-chrome="top"]')
  if (!bar || !top) return { bar: !!bar, top: !!top }
  // The contract's starting page is the one the WATER jump leaves (SHELL sticky: "after the Water jump"). The jumps
  // above end on the LAST chip, whose pre-select (Check) can leave a page too short to pin (integration S3 × S4).
  const water = bar.querySelector('[data-chip="water"]')
  if (water) { water.click(); await settle() }
  window.scrollTo(0, 0); await settle()
  const inFlowTop = bar.getBoundingClientRect().top + window.scrollY
  const want = ${2 * FIRST_SCREEN}
  const maxScroll = document.documentElement.scrollHeight - innerHeight
  window.scrollTo(0, Math.min(want, maxScroll)); const y = await settle()
  const br = bar.getBoundingClientRect(), tr = top.getBoundingClientRect()
  const cx = br.left + br.width / 2, cy = br.top + br.height / 2
  const hit = document.elementFromPoint(cx, cy)
  let clipped = false
  for (let a = bar.parentElement; a && a !== document.documentElement; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { clipped = true; break } }
  const shown = (!bar.checkVisibility || bar.checkVisibility({ opacityProperty: true, visibilityProperty: true })) && br.height > 0
  const pinned = { y, barTop: br.top, barHeight: br.height, chromeBottom: tr.bottom, hitInside: !!hit && (hit === bar || bar.contains(hit)), shown, clipped, inFlowTop, maxScroll }
  // WCAG 2.4.11 (focus not obscured): park a section header UNDER the pinned bar, then move focus to it the way
  // TalkBack or a keyboard does (focus() with its own scroll). With the sticky layers subtracted (html scroll-padding)
  // the browser brings it out below the bar; without, it stays hidden beneath it.
  const sec = document.querySelector('[data-testid="today-sec-care${SUFFIX}"]') || document.querySelector('[data-testid^="today-sec-"]')
  const header = sec ? sec.querySelector('[aria-expanded]') : null
  let focusMove = null
  if (header) {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
    const hTop = header.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, Math.max(0, hTop - (tr.bottom + 8))); await settle()
    const parked = header.getBoundingClientRect().top
    header.focus(); await settle()
    focusMove = { parked, top: header.getBoundingClientRect().top, barBottom: bar.getBoundingClientRect().bottom, focused: document.activeElement === header }
  }
  pinned.focusMove = focusMove
  window.scrollTo(0, 0); const y0 = await settle()
  const b0 = bars()
  const atTop = { y: y0, count: b0.length, top: b0[0] ? b0[0].getBoundingClientRect().top : null, inFlowTop }
  return { bar: true, top: true, pinned, atTop }
})()`

const pending = []
let harness, chrome
const udd = mkdtempSync(join(tmpdir(), 'gate-todayshell-v2-'))
try {
  for (const d of drift()) fail('drift', 'shell-instrument', d)
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  if (PROBE_NOTHING) console.log('[today-shell-v2] --probe-nothing: every shell anchor points at nothing and every check is armed. This run MUST fail.')
  console.log(`[today-shell-v2] LANDED ${LANDED.join(', ')} · BAR_H ${BAR_H} · BOTTOM_NAV ${BOTTOM_NAV_HEIGHT_PX} · FIRST_SCREEN ${FIRST_SCREEN} · manager ${MANAGER_ON ? 'ON' : 'OFF'}`)
  const byState = new Map()
  for (const c of SHELL) { if (!byState.has(c.state)) byState.set(c.state, []); byState.get(c.state).push(c) }
  for (const [name, checks] of byState) {
    const st = stateByName(name)
    const at = `shell:${name}@${VIEWPORT.w}x${VIEWPORT.h}`
    const armed = checks.filter(c => isArmed(c, LANDED, ARM_ALL))
    for (const c of checks.filter(c => !isArmed(c, LANDED, ARM_ALL))) pending.push(`${name}: ${c.family}@${[].concat(c.armedAt).join('+')} — ${c.why}`)
    if (!armed.length) continue
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: VIEWPORT.dpr, mobile: true }, cdp.sessionId)
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }, cdp.sessionId)
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }, cdp.sessionId)
    const url = `http://localhost:${PORT}/tests/harness/todayshell.html?state=${name}&v2=1&clock=${encodeURIComponent(st.clock)}`
    const nav = await cdp.send('Page.navigate', { url }, cdp.sessionId)
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`)
    await sleep(200)
    try { await evalSettled(`(async()=>{for(let i=0;i<250;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('the shell never became ready')})()`) }
    catch (e) { fail(at, 'void', `VOID — ${e.message}`); continue }
    await evalSettled('new Promise(r=>setTimeout(r,1500))')
    const m = await evalSettled(CHROME_MEASURE)
    // S3: the jumps run first (in the contract's order, jump-landing before sticky): the Water jump opens Needs
    // care, and the page it leaves behind is the one the sticky check scrolls. Integration S3 × S4: jump-landing and
    // jump-focus judge ONE pass over the chips (runJumps, run on first use), each its own property of it.
    const order = ['shell-instrument', 'jump-landing', 'jump-focus', 'sticky', 'back-restore']
    let jumps = null
    const jumpRun = async () => (jumps ||= await runJumps())
    for (const c of [...armed].sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family))) {
      const F = (msg) => fail(at, c.family, msg)
      if (c.family === 'jump-landing') {
        const r = await jumpRun()
        if (!r.bar) { F('no jump bar (today-jumpbar) to jump from'); continue }
        if (!r.out.length) F('the jump bar has no chips to jump with')
        let strict = 0
        for (const j of r.out) {
          if (j.covered) { F(`chip '${j.key}' is covered at its centre — a finger would not reach it`); continue }
          if (!j.found) { F(`chip '${j.key}' jumped to '${j.section}', which has no header on the page`); continue }
          if (j.expanded !== 'true') F(`after the '${j.key}' jump its section '${j.section}' is not open (aria-expanded ${j.expanded})`)
          // Integration S3 × S4: a page too short for the landing (the Feed / Check pre-select shrinks Needs care)
          // stops at its bottom. That CLAMPED landing is judged by what it can still promise — scrolled as far as
          // the page goes, the header below the bar and wholly on screen above the nav band — and at least one
          // jump per run must land strictly, or the offset itself went unmeasured.
          const clamped = j.y >= j.maxScroll - 1 && j.headerTop > j.barBottom + LANDING_GAP_PX + 0.5
          if (clamped) {
            if (j.headerBottom > VIEWPORT.h - BOTTOM_NAV_HEIGHT_PX + 0.5) F(`the '${j.key}' jump stopped at the page's end (scrollY ${Math.round(j.y)}) with the '${j.section}' header at y=${Math.round(j.headerTop)}..${Math.round(j.headerBottom)}, not wholly above the nav band (y=${VIEWPORT.h - BOTTOM_NAV_HEIGHT_PX})`)
          } else {
            strict++
            if (j.headerTop < j.barBottom - 0.5 || j.headerTop > j.barBottom + LANDING_GAP_PX + 0.5) F(`the '${j.key}' jump landed the '${j.section}' header at y=${Math.round(j.headerTop)}; the bar ends at y=${Math.round(j.barBottom)}, so it must land in [${Math.round(j.barBottom)}, ${Math.round(j.barBottom + LANDING_GAP_PX)}] (scrollY ${Math.round(j.y)} of ${Math.round(j.maxScroll)})`)
          }
          if (!j.focused) F(`after the '${j.key}' jump focus is not on the '${j.section}' header (R5: the header takes focus)`)
          if (j.hscroll) F(`after the '${j.key}' jump the page scrolls sideways`)
        }
        if (r.out.length && !strict) F(`every jump stopped at the end of a page too short for it (${r.out.map(j => j.key).join(', ')}) — no landing could be held to [bar, bar + ${LANDING_GAP_PX}], so the offset is unmeasured`)
        console.log(`[today-shell-v2] ${at}: jumps · ${r.out.map(j => j.covered ? `${j.key} covered` : `${j.key}→${j.section} header y=${Math.round(j.headerTop)} bar ${Math.round(j.barBottom)} scroll ${Math.round(j.y)}/${Math.round(j.maxScroll)}${j.y >= j.maxScroll - 1 && j.headerTop > j.barBottom + LANDING_GAP_PX + 0.5 ? ' (clamped)' : ''} focus ${j.focused ? 'header' : 'NOT header'} shown ${j.shownPoints}/15 tab→${j.afterTab?.inside ? 'inside' : 'OUTSIDE'} ${j.afterTab?.what ?? ''}`).join(' · ')}`)
        continue
      }
      // Integration S3 × S4 — the FOCUS a jump leaves, judged apart from where the header landed: WCAG 2.4.11 (the
      // focused header is not wholly hidden by TopChrome or the bar — hit-tested, not computed from its top) and
      // 2.4.3 (one real Tab continues INSIDE the jumped-to section, as R5 promises TalkBack and the keyboard). A
      // section whose open body has no control would fail the Tab half; Needs care's opens with its filter row.
      if (c.family === 'jump-focus') {
        const r = await jumpRun()
        if (!r.bar) { F('no jump bar (today-jumpbar) to jump from'); continue }
        if (!r.out.length) F('the jump bar has no chips to jump with')
        for (const j of r.out) {
          if (j.covered || !j.found) { F(`chip '${j.key}' could not be jumped with (${j.covered ? 'covered' : 'no header'}) — nothing to judge focus on`); continue }
          if (j.focused && j.shownPoints === 0) F(`after the '${j.key}' jump the focused '${j.section}' header (y=${Math.round(j.headerTop)}..${Math.round(j.headerBottom)}) is wholly hidden — no point of it is hit-testable past TopChrome and the bar (WCAG 2.4.11)`)
          if (!j.afterTab?.inside) F(`after the '${j.key}' jump one Tab moves focus to ${j.afterTab?.what ?? 'nothing'}, not into '${j.section}' (WCAG 2.4.3 — the next step must continue inside the section it jumped to)`)
        }
        continue
      }
      if (c.family === 'sticky') {
        const r = await evalSettled(STICKY)
        if (!r.bar || !r.top) { F(`nothing to pin: ${r.bar ? '' : 'no jump bar'}${!r.bar && !r.top ? ', ' : ''}${r.top ? '' : 'no TopChrome'}`); continue }
        const p = r.pinned
        // Never pass over a page that cannot pin: the bar must have scrolled past its own in-flow place.
        if (p.maxScroll < p.inFlowTop - p.chromeBottom + 1) { F(`the page scrolls ${Math.round(p.maxScroll)}px, too short to pin a bar that sits at y=${Math.round(p.inFlowTop)} — the check cannot run here`); continue }
        if (Math.abs(p.barTop - p.chromeBottom) > 0.5) F(`scrolled to y=${Math.round(p.y)} the bar's top is y=${p.barTop}, TopChrome ends at y=${p.chromeBottom}: it must pin flush under it`)
        if (Math.abs(p.barHeight - BAR_HEIGHT_PX) > 1) F(`the pinned bar is ${p.barHeight}px tall, expected ${BAR_HEIGHT_PX} ± 1`)
        if (!p.shown) F('the pinned bar is not visible')
        if (p.clipped) F('an ancestor of the bar has overflow other than visible — sticky is scoped to it (plan §6.1)')
        if (!p.hitInside) F('a tap at the pinned bar\'s centre lands on something else — the bar is under another layer')
        const fm = p.focusMove
        if (!fm) F('no section header to move focus to under the pinned bar')
        else if (fm.parked >= fm.barBottom - 0.5) F(`could not park a header under the pinned bar (it sat at y=${Math.round(fm.parked)}, the bar ends at y=${Math.round(fm.barBottom)}) — the focus check did not run`)
        else if (!fm.focused || fm.top < fm.barBottom - 0.5) F(`a section header focused while under the pinned bar stays at y=${Math.round(fm.top)}, beneath the bar (it ends at y=${Math.round(fm.barBottom)}) — WCAG 2.4.11; the page does not scroll with the sticky layers subtracted`)
        const t = r.atTop
        if (t.count !== 1) F(`back at the top ${t.count} jump bars are on the page, expected exactly one`)
        else if (t.y > 0.5 || Math.abs(t.top - (t.inFlowTop - t.y)) > 0.5) F(`back at the top the bar is at y=${t.top}, not its in-flow place y=${Math.round(t.inFlowTop)}`)
        continue
      }
      // S4 — (m) Back round trip through the REAL page-scroll manager: open Bag Area, tap "Red Acre Cabbage"
      // (a planting route, not an overlay: Today unmounts), Back → the visit restores Bag Area open and the
      // manager's POP restore puts the same row at the same screen y (±1 px).
      if (c.family === 'back-restore') {
        const ROW = `[...document.querySelectorAll('[data-testid="care-exceptions-row${SUFFIX}"] a')].find(a => a.textContent.includes('Red Acre Cabbage'))`
        const SPOT = `document.querySelector('[data-testid="care-spot${SUFFIX}"][data-spot="Bag Area"] [aria-expanded]')`
        const r1 = await evalSettled(`(async () => {
          // Integration S3 × S4: the chip jumps before this leave a task pre-selected (the last one wins), and a
          // Check or Feed filter hides the water row this trip taps — release every pressed task first (§9.1 (m)
          // names no filter), one at a time: the row's toggles read the selection they were rendered with.
          const pressedTask = () => document.querySelector('[data-testid="care-filter-tasks${SUFFIX}"] button[aria-pressed="true"]')
          for (let b, i = 0; (b = pressedTask()) && i < 5; i++) { b.click(); await new Promise(r => setTimeout(r, 120)) }
          const btn = ${SPOT}
          if (!btn) return { void: 'no Bag Area spot on the page' }
          if (btn.getAttribute('aria-expanded') !== 'true') { btn.click(); await new Promise(r => setTimeout(r, 300)) }
          const link = ${ROW}
          if (!link) return { void: 'no "Red Acre Cabbage" row in the opened Bag Area' }
          link.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 400))
          const top = Math.round(link.getBoundingClientRect().top), y = Math.round(scrollY)
          link.click()
          return { top, y }
        })()`)
        if (r1.void) { F(`VOID — ${r1.void}`); continue }
        await sleep(1000)
        const away = await evalSettled('location.pathname')
        await evalSettled('(history.back(), 1)')
        await sleep(3000)
        const r2 = await evalSettled(`(() => { const btn = ${SPOT}; const link = ${ROW}
          return { expanded: btn ? btn.getAttribute('aria-expanded') : null, top: link ? Math.round(link.getBoundingClientRect().top) : null, y: Math.round(scrollY), path: location.pathname } })()`)
        if (away === r2.path) F(`the row tap never left Today (still ${away}) — the round trip is VOID`)
        if (r2.expanded !== 'true') F(`after Back, Bag Area is ${r2.expanded ?? 'not on the page'} — expected OPEN, restored from the visit`)
        if (r2.top == null) F('after Back, the "Red Acre Cabbage" row is not on the page')
        else if (Math.abs(r2.top - r1.top) > 1) F(`after Back, "Red Acre Cabbage" sits at screen y=${r2.top}, it was at y=${r1.top} before the tap (±1 px; scroll ${r1.y} → ${r2.y})`)
        console.log(`[today-shell-v2] ${at}: back-restore · tapped at screen y=${r1.top} (scroll ${r1.y}) → ${away} → Back → y=${r2.top} (scroll ${r2.y}) · Bag Area ${r2.expanded}`)
        continue
      }
      if (c.family !== 'shell-instrument') { F(`no checker for '${c.family}' yet — its slice must add one in the same commit that arms it (never read as passed)`); continue }
      if (m.vw !== VIEWPORT.w || m.vh !== VIEWPORT.h) { fail(at, 'void', `VOID — page self-reports ${m.vw}x${m.vh}`); continue }
      if (m.h.error) F(`the shell raised "${m.h.error}" while mounting`)
      if (m.h.problem) F(m.h.problem)
      if (!m.top) F('TopChrome (header[data-app-chrome="top"]) is not on the page')
      else {
        if (Math.abs(m.top.top) > 0.5 || Math.abs(m.top.height - BAR_H) > 0.5) F(`TopChrome paints at y=${m.top.top}, ${m.top.height}px tall; expected y=0 and BAR_H ${BAR_H}`)
        if (m.topPosition !== 'sticky') F(`TopChrome is position ${m.topPosition}, expected sticky (the bar pins under it, plan §6.1)`)
        if (m.topState === 'pending') F('TopChrome is still in its pending (identity-unresolved) state')
      }
      if (!m.nav) F('the BottomNav band is not on the page')
      else if (Math.abs(m.nav.top - (VIEWPORT.h - BOTTOM_NAV_HEIGHT_PX)) > 0.5) F(`the nav band's top is y=${m.nav.top}, expected ${VIEWPORT.h - BOTTOM_NAV_HEIGHT_PX}`)
      if (m.navVar !== `${BOTTOM_NAV_HEIGHT_PX}px`) F(`--bottom-nav-height is "${m.navVar}", expected "${BOTTOM_NAV_HEIGHT_PX}px"`)
      if (m.top && m.nav && Math.abs((m.nav.top - m.top.bottom) - FIRST_SCREEN) > 0.5) F(`the measured page band is ${m.nav.top - m.top.bottom}px, the gate's FIRST_SCREEN is ${FIRST_SCREEN} — the first-screen arithmetic no longer describes the shell`)
      if (MANAGER_ON && m.restoration !== 'manual') F(`history.scrollRestoration is '${m.restoration}' with the manager ON — main.jsx's boot line did not run, so Chrome's native restore would be measured`)
      // S2: whenever the roster is ASKED for it is answered production-shaped (the drift guard above pins the
      // answer). The mounted page need not ask: V1 Today reads it on mount, the V2 skeleton does not until its
      // household sections (S6) — a check that demanded a request would fail the page for a read it has no use for.
      if (m.h.v2.members.count !== 2 || m.h.v2.members.served !== m.h.membersGets) F(`/api/members was asked ${m.h.membersGets}x and answered ${m.h.v2.members.served}x with ${m.h.v2.members.count} member(s) — production-shaped means the two-person roster, every time it is asked`)
      if (!m.h.v2.critterOrigin) F('VITE_API_CRITTERS is not defined — the shell is not on vite.harness.v2.mjs')
      if (m.h.prefsGets < 1 || m.h.v2.prefs.served !== m.h.prefsGets) F(`prefs GET observed ${m.h.prefsGets}x, answered from ${m.h.v2.prefs.fixture} ${m.h.v2.prefs.served}x`)
      if (m.h.v2.flag !== '1') F(`garden.todayV2 is ${JSON.stringify(m.h.v2.flag)}, expected "1"`)
      if (!m.h.clock.pinned || m.h.clock.iso !== st.clock) F(`the clock is ${m.h.clock.pinned ? 'pinned to ' + m.h.clock.iso : 'NOT pinned'}, the contract says ${st.clock}`)
      if (m.h.clock.tz !== 'America/New_York') F(`timezone ${m.h.clock.tz}, expected America/New_York`)
      if (!m.fontPin || !m.fontPin.ok) F('the Roboto pin is not in force')
      for (const p of m.h.live) F(`a third-party request ESCAPED the harness — ${p}`)
      for (const f of m.h.fixtures.filter(f => !f.ok || f.bytes === 0)) F(`fixture ${f.name} is unusable (${f.why || 'zero bytes'})`)
      console.log(`[today-shell-v2] ${at}: route ${m.h.route} · TopChrome y=${m.top?.top} h=${m.top?.height} (${m.topPosition}) · nav band y=${m.nav?.top} (--bottom-nav-height ${m.navVar}) · page band ${m.top && m.nav ? m.nav.top - m.top.bottom : '?'}px · scrollRestoration ${m.restoration} · members ${m.h.v2.members.count} · prefs GET ×${m.h.prefsGets}`)
    }
  }
} catch (e) {
  fail('gate', 'crash', `gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (pending.length) {
  console.log(`\n[today-shell-v2] PENDING — ${pending.length} shell check(s) NOT MEASURED and NOT PASSED (their slices have not landed):`)
  for (const p of pending) console.log(`  ⏸ ${p}`)
}
if (failures.length) {
  console.error(PROBE_NOTHING ? '\n[today-shell-v2] FAIL — EXPECTED. --probe-nothing blinded every shell anchor and the checks caught it. Exit 1 is correct for this arm.' : '\n[today-shell-v2] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
if (PROBE_NOTHING) { console.error('\n[today-shell-v2] FAIL — the real defect: every shell anchor pointed at nothing and nothing complained.'); process.exit(1) }
console.log(`\n[today-shell-v2] PASS — the shell instrument holds; ${pending.length} shell check(s) PENDING (listed above: not measured, not passed).`)
process.exit(0)
