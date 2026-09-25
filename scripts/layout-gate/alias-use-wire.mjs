#!/usr/bin/env node
// alias-use-wire.mjs — BUG-VOICEALIASHITCOUNT-001's real-engine check: does a harvest saved through a TAUGHT
// name send PATCH /api/varieties/voice-aliases, with that name's stored key and variety, after the save
// lands? Runnable by hand; not wired into CI.
//
//   node scripts/layout-gate/alias-use-wire.mjs [--only C1,N2] [--json <file>] [--baseline <full sha>]
//
// DRIVES the real /log/harvest page (tests/harness/aliasuse.html: HarvestLog -> VoiceHarvest embedded, the
// real useApiFetch/apiFetch, window.fetch stubbed at the far side of the wire) in headless Chrome at Dave's
// phone viewport — 426x836 CSS px, DPR 3, Emulation.setDeviceMetricsOverride — on the 244 real planting
// names and Dave's 33 taught names as prod stores them. Every scenario is a fresh page load, spoken one
// final per session, as Chrome delivers them.
//
// READS what went over the wire, in order: every harvest POST and its answer, every PATCH (the method string
// as the page passed it, the bearer header, the body) and every teach POST — and the hit_count the stub
// server holds afterwards, which it keeps exactly as lambda/varieties does (+1 only where heard_key AND
// variety_id match). A scenario passes when both the wire and that count are what its door promises.
//
// C scenarios: the taught name chose the planting, so the save must be followed by exactly the count.
// N scenarios: it did not (the planting's own name, its crop, a strict match the taught name shadows, the
// list failed to load), so nothing may be counted — N8 replays this morning's 13 saves by their own names.
//
// NON-VACUITY: --baseline <sha> serves src/** from that commit (HARNESS_BASELINE_SHA). Against
// 7000a45d2f04eaa28bae6875cc4af94eda458115, the commit before the count existed, every C scenario must fail
// and every N scenario still pass — the instrument can see a PATCH that is not sent.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const JSON_OUT = arg('--json')
const BASELINE = arg('--baseline')
const ONLY = (arg('--only') || '').split(',').filter(Boolean)
// Unused elsewhere (2026-09-25): the other gates hold 5312-5329 / 9422-9439 and .claude/launch.json's harness
// previews 5311, 5325 and 5326. --strictPort makes a clash a loud failure, never somebody else's server.
const PORT = Number(process.env.GATE_HARNESS_PORT || 5347)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9457)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
const VIEWPORT = { w: 426, h: 836, dpr: 3 }

if (BASELINE && !/^[0-9a-f]{40}$/.test(BASELINE)) {
  console.error('[alias-use-wire] --baseline needs a full 40-hex sha')
  process.exit(2)
}

// A step is a final said to the mic, or { tap } a planting on the "Which one?" list, { undo } the n-th saved
// row, { release } the oldest held harvest POST, { wait } ms. `counted` is the hit_count the server holds after.
const SUYO = { cucumberone: 1 }
const SCENARIOS = [
  { id: 'C1', door: 'name, amounts, "next" apart', steps: ['cucumber one', '2 count', '126 grams', 'next'], saves: 1, counted: SUYO },
  { id: 'C2', door: 'Chrome\'s digits for the name', steps: ['cucumber 1', '2 count', '126 grams', 'next'], saves: 1, counted: SUYO },
  { id: 'C3', door: 'one breath, units, trailing "next"', steps: ['cucumber one 2 count 126 grams next'], saves: 1, counted: SUYO },
  { id: 'C4', door: 'one breath, units, "next" apart', steps: ['cucumber one 2 count 126 grams', 'next'], saves: 1, counted: SUYO },
  { id: 'C5', door: 'one breath, no units, trailing "next"', steps: ['cucumber one 2 126 next'], saves: 1, counted: SUYO },
  { id: 'C6', door: 'one breath, digits, no units', steps: ['cucumber 1 2 126 next'], saves: 1, counted: SUYO },
  { id: 'C7', door: 'name, then the pair with "next"', steps: ['cucumber one', '2 count 126 grams next'], saves: 1, counted: SUYO },
  { id: 'C8', door: 'run-together amount refused, said again', steps: ['cucumber one 2126 next', '2 count', '126 grams', 'next'], saves: 1, counted: SUYO },
  { id: 'C9', door: '"Which one?" list from a taught name (2 plantings)', steps: ['striped roman', { tap: 'Speckled Roman Rescue' }, '3 count', '40 grams', 'next'], saves: 1, counted: { stripedroman: 1 } },
  { id: 'C10', door: 'list from a one-breath sentence naming 2 plantings', steps: ['striped roman 3 40 next', { tap: 'Speckled Roman' }, '3 count', '40 grams', 'next'], saves: 1, counted: { stripedroman: 1 } },
  { id: 'C11', door: 'save fails, "next" again lands', params: 'failSaves=1', steps: ['cucumber one', '2 count', 'next', 'next'], saves: 1, counted: SUYO },
  { id: 'C12', door: 'said while the taught names were still loading', params: 'aliasDelayMs=1800', waitAliases: false, steps: [{ wait: 100 }, 'cucumber one', { wait: 2200 }, '2 count', 'next'], saves: 1, counted: SUYO },
  { id: 'C13', door: 'saved, then Undo', steps: ['cucumber one', '2 count', 'next', { undo: 0 }], saves: 1, counted: SUYO, deletes: 1 },
  { id: 'C14', door: 'two records, the name said for each', steps: ['cucumber one', '2 count', 'next', 'cucumber one', '3 count', 'next'], saves: 2, counted: { cucumberone: 2 } },
  { id: 'C15', door: 'a word alias', steps: ['stupid chica', '3 count', 'next'], saves: 1, counted: { stupidchica: 1 } },
  { id: 'C16', door: 'slow save; a new amount\'s "next" queued behind it', params: 'holdSaves=1', steps: ['cucumber one', '2 count', '126 grams', 'next', '3 count', 'next', { release: true }, { wait: 1500 }, { release: true }], saves: 2, counted: SUYO },
  { id: 'N1', door: 'the planting\'s own name', steps: ['Suyo Long', '2 count', '126 grams', 'next'], saves: 1, counted: {} },
  { id: 'N2', door: 'its crop (Suyo Long is the only cucumber)', steps: ['cucumber', '2 count', 'next'], saves: 1, counted: {} },
  { id: 'N3', door: 'Chrome\'s "studio long" (fuzzy, nothing taught)', steps: ['studio long', '2 count', 'next'], saves: 1, counted: {} },
  { id: 'N4', door: 'taught "tomatillo" is also 3 plantings\' crop', steps: ['tomatillo', { tap: 'Pineapple Tomatillo' }, '5 count', '7 grams', 'next'], saves: 1, counted: {} },
  { id: 'N5', door: 'taught "marzano" is inside 2 planting names', steps: ['marzano', { tap: 'San Marzano Roma' }, '1 count', '23 grams', 'next'], saves: 1, counted: {} },
  { id: 'N6', door: 'taught "rescue" is inside 6 planting names', steps: ['cherry rescue one', '1 count', '47 grams', 'next'], saves: 1, counted: {} },
  { id: 'N7', door: 'taught-name list failed to load', params: 'aliasFail=1', steps: ['cucumber one', '2 count', 'next'], saves: 0, counted: {}, anySaves: true },
  {
    id: 'N8', door: 'this morning\'s 13 saves, by their own names',
    steps: [
      ['Suyo Long', '2 count', '126 grams'], ['Dragon Roll', '2 count', '22 grams'], ['Ghost', '1 count', '3 grams'],
      ['Piri Piri', '1 count', '1 gram'], ['Pineapple Tomatillo', '5 count', '7 grams'], ['Peach tree', '8 count', '763 grams'],
      ['Black Cherry', '3 count', '43 grams'], ['Cherry Rescue 1', '1 count', '47 grams'], ['Czech\'s Bush', '1 count', '18 grams'],
      ['San Marzano rescue', '1 count', '3 grams'], ['San Marzano Roma', '1 count', '23 grams'], ['Sun Sugar', '3 count', '17 grams'],
      ['Yellow Pear', '1 count', '13 grams'],
    ].flatMap((r) => [...r, 'next']),
    saves: 13, counted: {},
  },
]

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
      const r = await fetch(`http://localhost:${PORT}/tests/harness/aliasuse.html`)
      if (r.ok) {
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
  for (let i = 0; i < 240; i++) {
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
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT} within 60s`)
}

async function attach(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  const consoleErrors = []
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text)
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
  return { ws, send, sessionId, evalIn, consoleErrors }
}

const waitFor = async (cdp, expr, what, ms = 20000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await cdp.evalIn(expr)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function runScenario(cdp, s) {
  const url = `http://localhost:${PORT}/tests/harness/aliasuse.html${s.params ? `?${s.params}` : ''}`
  await cdp.send('Page.navigate', { url }, cdp.sessionId)
  await waitFor(cdp, 'window.__h && window.__h.ready()', 'the page and its plantings')
  if (s.waitAliases !== false) await waitFor(cdp, 'window.__h.served().aliases > 0', 'the taught-name list')
  await sleep(300)
  if (!await cdp.evalIn('window.__h.start()')) throw new Error('Start listening was not there to tap')
  await sleep(200)
  for (const step of s.steps) {
    if (typeof step === 'string') {
      if (!await cdp.evalIn(`window.__h.say(${JSON.stringify(step)})`)) throw new Error(`no live recogniser to say ${JSON.stringify(step)}`)
      // A save word waits out the settle tick and the write cooldown; data commits at the session boundary.
      await sleep(/\bnext$/.test(step) ? 2200 : 900)
    } else if (step.tap) {
      if (!await cdp.evalIn(`window.__h.tap(${JSON.stringify(step.tap)})`)) {
        const st = await cdp.evalIn('window.__h.state()')
        throw new Error(`no "${step.tap}" on the Which-one list (list: ${JSON.stringify(st.candidates)}; banner: ${st.status})`)
      }
      await sleep(700)
    } else if (step.undo != null) {
      if (!await cdp.evalIn(`window.__h.undo(${step.undo})`)) throw new Error(`no Undo #${step.undo}`)
      await sleep(900)
    } else if (step.release) {
      if (!await cdp.evalIn('window.__h.releaseSave()')) throw new Error('no held save to release')
      await sleep(900)
    } else if (step.wait) {
      await sleep(step.wait)
    }
  }
  await sleep(1500)
  const reqs = await cdp.evalIn('window.__h.reqs()')
  const aliases = await cdp.evalIn('window.__h.aliases()')
  const state = await cdp.evalIn('window.__h.state()')
  return { reqs, aliases, state }
}

function judge(s, { reqs, aliases, state }) {
  const problems = []
  const saves = reqs.filter(r => r.path === '/api/events' && String(r.method).toUpperCase() === 'POST' && r.status === 201)
  const patches = reqs.filter(r => r.path === '/api/varieties/voice-aliases' && String(r.method).toUpperCase() === 'PATCH')
  const teaches = reqs.filter(r => r.path === '/api/varieties/voice-aliases' && String(r.method).toUpperCase() === 'POST')
  const deletes = reqs.filter(r => r.path.startsWith('/api/events/') && String(r.method).toUpperCase() === 'DELETE')
  const counted = Object.fromEntries(aliases.map(a => [a.heard_key, a.hit_count]))
  if (!s.anySaves && saves.length !== s.saves) problems.push(`${saves.length} harvest(s) saved, expected ${s.saves}`)
  if (JSON.stringify(counted) !== JSON.stringify(s.counted)) problems.push(`server count ${JSON.stringify(counted)}, expected ${JSON.stringify(s.counted)}`)
  const expectedPatches = Object.values(s.counted).reduce((a, b) => a + b, 0)
  if (patches.length !== expectedPatches) problems.push(`${patches.length} PATCH(es) sent, expected ${expectedPatches}`)
  for (const p of patches) {
    // The wire, as the Function URL would see it.
    if (p.method !== 'PATCH') problems.push(`PATCH passed as ${JSON.stringify(p.method)} — fetch does not upper-case "patch"; CORS AllowMethods would refuse it`)
    if (!p.bearer) problems.push('PATCH carried no bearer token')
    if (!/json/.test(p.contentType || '')) problems.push(`PATCH content-type ${p.contentType}`)
    if (p.status !== 200 || !p.answer?.counted) problems.push(`PATCH answered ${p.status} ${JSON.stringify(p.answer)}`)
    // AFTER a save landed: the POST it follows was answered before the PATCH went out.
    const before = saves.filter(v => v.at <= p.at)
    if (!before.length) problems.push('a PATCH went out before any harvest had landed')
  }
  if (s.deletes != null && deletes.length !== s.deletes) problems.push(`${deletes.length} DELETE(s), expected ${s.deletes}`)
  return {
    id: s.id, door: s.door, ok: problems.length === 0, problems,
    saves: saves.length, patches: patches.map(p => p.body?.used?.map(u => u.heard_key).join('+')),
    teaches: teaches.map(t => `${t.body?.heard_key}(${t.status})`), counted, banner: state.status, misses: state.misses,
  }
}

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'gate-aliasuse-'))
const out = { baseline: BASELINE, viewport: VIEWPORT, results: [] }
let fatal = null
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: VIEWPORT.dpr, mobile: true }, cdp.sessionId)
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/aliasuse.html` }, cdp.sessionId)
  await waitFor(cdp, 'window.__h && window.__h.ready()', 'first mount')
  out.page = await cdp.evalIn('window.__h.vw()')
  out.chrome = chrome.version.Browser
  console.log(`[alias-use-wire] ${out.chrome} · page reports innerWidth ${out.page.vw} x innerHeight ${out.page.vh} @ dpr ${out.page.dpr} · ${out.page.visibility}${BASELINE ? ` · src/** from ${BASELINE}` : ''}`)
  if (out.page.vw !== VIEWPORT.w || out.page.vh !== VIEWPORT.h) throw new Error(`page reports ${out.page.vw}x${out.page.vh}, not ${VIEWPORT.w}x${VIEWPORT.h}`)
  const unmapped = await cdp.evalIn('window.__h.unmapped()')
  if (unmapped.length) throw new Error(`taught names with no variety in the fixture: ${unmapped.join(', ')}`)
  for (const s of SCENARIOS.filter(x => !ONLY.length || ONLY.includes(x.id))) {
    let r
    try { r = judge(s, await runScenario(cdp, s)) } catch (e) { r = { id: s.id, door: s.door, ok: false, problems: [`could not run: ${e.message}`] } }
    out.results.push(r)
    console.log(`[alias-use-wire] ${r.ok ? 'PASS' : 'FAIL'} ${r.id.padEnd(3)} ${r.door}`)
    if (r.saves != null) console.log(`      saves ${r.saves} · PATCH ${JSON.stringify(r.patches)} · teach ${JSON.stringify(r.teaches)} · server hit_count ${JSON.stringify(r.counted)}`)
    if (r.banner != null) console.log(`      banner: ${r.banner}`)
    for (const p of r.problems) console.log(`      ✗ ${p}`)
  }
  if (cdp.consoleErrors.length) out.pageErrors = cdp.consoleErrors
} catch (e) {
  fatal = e.message
  out.fatal = fatal
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.proc.kill('SIGKILL')
  await sleep(300)
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2))
const failed = out.results.filter(r => !r.ok)
if (out.pageErrors?.length) console.log(`[alias-use-wire] page exceptions: ${out.pageErrors.length}\n  ${out.pageErrors.join('\n  ')}`)
if (fatal) { console.error(`[alias-use-wire] could not complete: ${fatal}`); process.exit(1) }
console.log(`[alias-use-wire] ${out.results.length - failed.length}/${out.results.length} scenarios as expected${failed.length ? ` · FAIL: ${failed.map(r => r.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
