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
    for (const c of armed) {
      const F = (msg) => fail(at, c.family, msg)
      // S4 — (m) Back round trip through the REAL page-scroll manager: open Bag Area, tap "Red Acre Cabbage"
      // (a planting route, not an overlay: Today unmounts), Back → the visit restores Bag Area open and the
      // manager's POP restore puts the same row at the same screen y (±1 px).
      if (c.family === 'back-restore') {
        const ROW = `[...document.querySelectorAll('[data-testid="care-exceptions-row${SUFFIX}"] a')].find(a => a.textContent.includes('Red Acre Cabbage'))`
        const SPOT = `document.querySelector('[data-testid="care-spot${SUFFIX}"][data-spot="Bag Area"] [aria-expanded]')`
        const r1 = await evalSettled(`(async () => {
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
