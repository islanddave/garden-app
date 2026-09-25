#!/usr/bin/env node
// detailscroll.measure.mjs — BUG-DETAILPAGESCARRYSCROLL-001, MEASUREMENT (not a gate: it asserts only that
// the instrument is valid, and prints what each page does). In real Chrome: where does a page land when it
// is opened from a SCROLLED page, and does Back return the scrolled page to its place?
//
//   node tests/harness/detailscroll.measure.mjs [--only id,id] [--out file.json] [--shots dir]
//     env: DS_HARNESS_PORT (5397) DS_CDP_PORT (9497) DS_VIEWPORT (426x836) DS_MS (300) CHROME_PATH
//
// DRIVES tests/harness/detailscroll.{html,jsx} inside tests/harness/viewport.html (the IFRAME HOST: headless
// macOS Chrome floors a window near 500px wide, an iframe is a true layout viewport at any size). Every tap
// and scroll is real input through the browser's pipeline (CDP mouse press/release hit-tested at the
// target's centre; mouse-wheel scrolling), and Back is a real history traversal (history.back() in the
// frame: popstate, as the Android back gesture). Each flow opens in a FRESH TAB (own history,
// sessionStorage, module state). Plumbing copied from scripts/layout-gate/seeds-scroll.mjs.
//
// PER FLOW it reads: the source page's offset and height before the tap; the arriving page's landing
// offset, height and max scroll after its content has landed and the scroll has held still; its h1 and
// whether it is inside the visible band (between the top bar and the nav); what is at the top of the
// band; every script-driven scroll call (scrollTo / scrollIntoView / focus) since the tap; a per-frame
// (rAF) sample of scrollY / document height / h1 top from the tap to the settle; then Back, and whether
// the source page came back to its offset with the tapped row where it was.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from '../../scripts/layout-gate/cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.DS_HARNESS_PORT || 5397)
const CDP_PORT = Number(process.env.DS_CDP_PORT || 9497)
const [VW, VH] = (process.env.DS_VIEWPORT || '426x836').split('x').map(Number)
const MS = Number(process.env.DS_MS ?? 300)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null }
const ONLY = argOf('--only') ? new Set(argOf('--only').split(',')) : null
const OUT = argOf('--out') ? resolve(argOf('--out')) : null
const SHOTS = argOf('--shots') ? resolve(argOf('--shots')) : null
const TOP_CHROME_PX = 52
const NAV_PX = 56

// src: where the flow starts. door: how it leaves. target: the arriving page (detailscroll.jsx's keys).
// depth: the source offset to wheel to before the tap (deep = past anything a loading shell can hold).
const FLOWS = [
  // Real in-page doors.
  { id: 'planting-eventrow>event', src: 'planting', door: 'eventrow', target: 'event', eventIndex: 44 },
  { id: 'locations-row>location', src: 'locations', door: 'locrow', target: 'location', locId: 'loc-blueberry-hedge' },
  // A row in a long list, deep: one flow per arriving page.
  { id: 'deep>event', src: 'deep', door: 'row', target: 'event', depth: 3000 },
  { id: 'deep>planting', src: 'deep', door: 'row', target: 'planting', depth: 3000 },
  { id: 'deep>location', src: 'deep', door: 'row', target: 'location', depth: 3000 },
  { id: 'deep>locations', src: 'deep', door: 'row', target: 'locations', depth: 3000 },
  { id: 'deep>inventory', src: 'deep', door: 'row', target: 'inventory', depth: 3000 },
  { id: 'deep>dashboard', src: 'deep', door: 'row', target: 'dashboard', depth: 3000 },
  { id: 'deep>harvests', src: 'deep', door: 'row', target: 'harvests', depth: 3000 },
  { id: 'deep>achievements', src: 'deep', door: 'row', target: 'achievements', depth: 3000 },
  { id: 'deep>releases', src: 'deep', door: 'row', target: 'releases', depth: 3000 },
  { id: 'deep>about', src: 'deep', door: 'row', target: 'about', depth: 3000 },
  // Shallower: the landing should track the source offset when it is under the page's max.
  { id: 'deep600>event', src: 'deep', door: 'row', target: 'event', depth: 600 },
  { id: 'deep600>dashboard', src: 'deep', door: 'row', target: 'dashboard', depth: 600 },
  { id: 'deep600>locations', src: 'deep', door: 'row', target: 'locations', depth: 600 },
  // BottomNav's doors from a scrolled page: the More sheet (armed; its rows REPLACE) and a tab link (PUSH).
  { id: 'more>dashboard', src: 'deep', door: 'more', target: 'dashboard', depth: 3000 },
  { id: 'more>locations', src: 'deep', door: 'more', target: 'locations', depth: 3000 },
  { id: 'more>inventory', src: 'deep', door: 'more', target: 'inventory', depth: 3000 },
  { id: 'more>achievements', src: 'deep', door: 'more', target: 'achievements', depth: 3000 },
  { id: 'tab>harvests', src: 'deep', door: 'tab', target: 'harvests', depth: 3000 },
  // Mechanism check: scroll anchoring off.
  { id: 'deep>event@anchor-none', src: 'deep', door: 'row', target: 'event', depth: 3000, anchorNone: true },
  { id: 'deep>dashboard@anchor-none', src: 'deep', door: 'row', target: 'dashboard', depth: 3000, anchorNone: true },
  { id: 'planting-eventrow>event@anchor-none', src: 'planting', door: 'eventrow', target: 'event', eventIndex: 44, anchorNone: true },
]

async function assertPortFree(url, what) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }) } catch { return }
  throw new Error(`${what} port is already serving (${url}) — somebody else's process; refusing to measure through it`)
}

let harnessLog = ''
async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  await assertPortFree(`http://localhost:${PORT}/`, 'harness')
  const proc = spawn(process.execPath, [bin, '--config', resolve(ROOT, 'tests/harness/vite.harness.config.mjs'), '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.on('data', (d) => { harnessLog += d })
  proc.stderr.on('data', (d) => { harnessLog += d })
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/tests/harness/detailscroll.html`); if (r.ok) return proc } catch { /* not yet */ }
    if (proc.exitCode != null) throw new Error(`harness vite exited (${proc.exitCode}):\n${harnessLog}`)
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`harness vite never served :${PORT} within 30s:\n${harnessLog}`)
}

async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`)
  await assertPortFree(`http://127.0.0.1:${CDP_PORT}/json/version`, 'CDP')
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  for (let i = 0; i < 240; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Chrome exited before exposing CDP (code=${proc.exitCode})`)
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return { proc, version: await r.json() } } catch { /* not yet */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT}`)
}

async function connect(wsUrl) {
  const WS = await resolveWebSocket()
  const ws = new WS(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id != null && pending.has(m.id)) {
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id); clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 90000)
    pending.set(mid, { res, rej, timer })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { ws, send }
}

const FRAME_VARS = `const f = document.getElementById('frame'), w = f && f.contentWindow, d = w && w.document`
const BAND = `const topBar = d.querySelector('header[data-app-chrome="top"]'), nav = d.querySelector('nav[aria-label="Main navigation"]')
  const bandTop = topBar ? topBar.getBoundingClientRect().bottom : 0, bandBottom = nav ? nav.getBoundingClientRect().top : w.innerHeight`
const CONTEXT_LOST = /navigated or closed|Execution context was destroyed|Cannot find context/i

function tab(cdp, sessionId) {
  const evalIn = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  const ev = async (expr, tries = 25) => {
    let last
    for (let i = 0; i < tries; i++) {
      try { return await evalIn(expr) } catch (err) { if (!CONTEXT_LOST.test(err.message)) throw err; last = err; await sleep(200) }
    }
    throw new Error(`page never held still long enough to evaluate: ${last?.message}`)
  }
  const read = (body) => ev(`(() => { ${FRAME_VARS}; if (!d) return null; ${body} })()`)
  const waitIn = (cond, ms = 15000) => ev(`(async () => {
    const t0 = performance.now()
    while (performance.now() - t0 < ${ms}) {
      ${FRAME_VARS}
      try { if (d && (${cond})) return true } catch { /* not there yet */ }
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  })()`)
  const settle = (stableMs, maxMs) => ev(`(async () => {
    ${FRAME_VARS}
    const t0 = performance.now(); let last = null, since = t0
    while (performance.now() - t0 < ${maxMs}) {
      await new Promise((r) => setTimeout(r, 25))
      const y = Math.round(w.scrollY * 10) + ':' + d.documentElement.scrollHeight
      if (y !== last) { last = y; since = performance.now() }
      else if (performance.now() - since >= ${stableMs}) return { settled: true, ms: Math.round(performance.now() - t0), y: w.scrollY }
    }
    return { settled: false, ms: ${maxMs}, y: w.scrollY }
  })()`)
  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, sessionId)
  const tap = async (sel, what, { chrome = false } = {}) => {
    const p = await read(`const el = ${sel}; if (!el) return { missing: true }
      ${BAND}
      const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect()
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2
      const inBand = y >= ${chrome ? '0' : 'bandTop'} && y <= ${chrome ? 'w.innerHeight' : 'bandBottom'} && x >= 0 && x <= w.innerWidth
      const at = inBand ? d.elementFromPoint(x, y) : null
      return { x: fr.left + x, y: fr.top + y, inBand, hits: !!at && (at === el || el.contains(at)),
        at: at ? (at.getAttribute('data-testid') || at.tagName.toLowerCase()) : 'nothing', box: [Math.round(r.top), Math.round(r.bottom)] }`)
    if (!p || p.missing) return `${what} is not on the page`
    if (!p.inBand) return `${what} is not in the visible band (y${p.box[0]}-${p.box[1]})`
    if (!p.hits) return `${what} does not hit-test at its centre (lands on ${p.at})`
    await mouse('mouseMoved', p.x, p.y)
    await mouse('mousePressed', p.x, p.y, { button: 'left', clickCount: 1 })
    await mouse('mouseReleased', p.x, p.y, { button: 'left', clickCount: 1 })
    return null
  }
  const wheelTo = async (sel, what) => {
    for (let i = 0; i < 120; i++) {
      const s = await read(`const el = ${sel}; if (!el) return { missing: true }
        ${BAND}
        const fr = f.getBoundingClientRect(), r = el.getBoundingClientRect(), mid = (bandTop + bandBottom) / 2
        return { delta: (r.top + r.bottom) / 2 - mid, y: w.scrollY, max: d.documentElement.scrollHeight - w.innerHeight, x: fr.left + w.innerWidth / 2, py: fr.top + mid }`)
      if (!s || s.missing) return `${what} is not on the page`
      if (Math.abs(s.delta) <= 80) return null
      if (s.delta > 0 && s.y >= s.max - 1) return null
      if (s.delta < 0 && s.y <= 0) return null
      await mouse('mouseWheel', s.x, s.py, { deltaX: 0, deltaY: Math.max(-480, Math.min(480, s.delta)) })
      await settle(120, 3000)
    }
    return `${what} could not be wheeled to the middle of the band in 120 steps`
  }
  const shoot = async (path) => {
    const c = await read(`const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }`)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...c, scale: 1 } }, sessionId)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
  }
  return { ev, read, waitIn, settle, tap, wheelTo, shoot }
}

const R = (n) => (n == null ? null : Math.round(n))
const READ_HERE = (doorSel) => `${BAND}
  const h1 = d.querySelector('h1'), r = h1 ? h1.getBoundingClientRect() : null
  const door = ${doorSel || 'null'}, dr = door ? door.getBoundingClientRect() : null
  return { path: w.location.pathname, key: w.__h.key(), idx: w.__h.idx(), page: w.__h.pageKey(), y: w.scrollY,
    docH: d.documentElement.scrollHeight, max: d.documentElement.scrollHeight - w.innerHeight,
    h1: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), text: (h1.textContent || '').trim().slice(0, 50) } : null,
    h1InBand: !!r && r.height > 0 && r.top >= bandTop - 0.5 && r.bottom <= bandBottom + 0.5,
    h1Visible: !!r && r.bottom > bandTop && r.top < bandBottom,
    doorTop: dr ? Math.round(dr.top) : null, top: w.__h.topOfView(), band: [Math.round(bandTop), Math.round(bandBottom)] }`

const SRC_ENTRY = { deep: 'harness-to-deep', planting: 'harness-to-planting', locations: 'harness-to-locations' }

async function runFlow(cdp, flow) {
  const out = { id: flow.id, flow }
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    const t = tab(cdp, sessionId)
    const url = `http://localhost:${PORT}/tests/harness/viewport.html?page=detailscroll.html&vw=${VW}&vh=${VH}&ms=${MS}${flow.anchorNone ? '&anchor=none' : ''}`
    const nav = await cdp.send('Page.navigate', { url }, sessionId)
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`)
    if (!await t.waitIn(`w.__h && w.__h.ready() && d.readyState === 'complete'`, 30000)) throw new Error('the harness never came up in the frame')
    await t.ev(`(async () => { ${FRAME_VARS}; if (d.fonts) await d.fonts.ready; return 1 })()`)
    const boot0 = await t.read(`return w.__h.boot()`)

    // INSTRUMENT CHECK: the frame is the device viewport, the chrome stand-ins are the app's heights.
    const g = await t.read(`${BAND}
      return { vw: w.innerWidth, vh: w.innerHeight, cw: d.documentElement.clientWidth, top: topBar ? topBar.getBoundingClientRect().height : null,
        nav: nav ? nav.getBoundingClientRect().height : null, fixture: w.__h.fixture() }`)
    out.geometry = g
    const geo = []
    if (g.vw !== VW || g.vh !== VH) geo.push(`frame self-reports ${g.vw}x${g.vh}, not ${VW}x${VH}`)
    if (g.cw !== VW) geo.push(`frame clientWidth ${g.cw} (a scrollbar gutter)`)
    if (g.top !== TOP_CHROME_PX) geo.push(`top bar ${g.top}px`)
    if (g.nav !== NAV_PX) geo.push(`nav ${g.nav}px`)
    if (!!g.fixture.anchorNone !== !!flow.anchorNone) geo.push('anchor switch not applied')
    if (geo.length) throw new Error(`instrument: ${geo.join('; ')}`)

    // Into the source page: a real tap on the /today stand-in's link (a PUSH).
    const why0 = await t.tap(`d.querySelector('[data-testid="${SRC_ENTRY[flow.src]}"]')`, `the /today link to ${flow.src}`)
    if (why0) throw new Error(why0)
    if (!await t.waitIn(`w.__h.pageReady('${flow.src}')`, 15000)) throw new Error(`the source page (${flow.src}) never finished loading (errors: ${(await t.read('return w.__h.errors()')).join(' | ') || 'none'})`)
    await t.settle(300, 5000)
    out.sourceArrival = await t.read(READ_HERE(null))

    // Scroll the source page with real wheel input to the door.
    let doorSel
    if (flow.src === 'deep') {
      // The row for this target nearest the requested depth (More / tab doors: any row near it).
      const idx = await t.read(`${BAND}
        const mid = (bandTop + bandBottom) / 2
        const rows = [...d.querySelectorAll('[data-testid="deep-row"]')].filter((r) => ${flow.door === 'row' ? `r.getAttribute('data-target') === '${flow.target}'` : 'true'})
        let best = null, bestD = Infinity
        for (const r of rows) { const b = r.getBoundingClientRect(); const c = (b.top + b.bottom) / 2 + w.scrollY; const dd = Math.abs(c - mid - ${flow.depth}); if (dd < bestD) { bestD = dd; best = r } }
        return best ? best.getAttribute('data-row') : null`)
      if (idx == null) throw new Error('no deep-list row for this target')
      doorSel = `d.querySelector('[data-testid="deep-row"][data-row="${idx}"]')`
    } else if (flow.src === 'planting') {
      doorSel = `d.querySelectorAll('a[href^="/events/"]')[${flow.eventIndex}]`
    } else if (flow.src === 'locations') {
      doorSel = `d.querySelector('a[href="/locations/${flow.locId}"]')`
    }
    const whyW = await t.wheelTo(doorSel, 'the door')
    if (whyW) throw new Error(whyW)
    await t.settle(400, 5000)
    const before = await t.read(READ_HERE(doorSel))
    out.before = before
    const deepMin = flow.depth != null && flow.depth < 1000 ? 300 : 1000
    if (before.y < deepMin) throw new Error(`the source is only ${R(before.y)}px down before the tap (need >= ${deepMin})`)

    // Leave: a real tap on the door.
    let tapSel = doorSel
    let chrome = false
    if (flow.door === 'more') {
      const whyM = await t.tap(`d.querySelector('[data-testid="harness-more"]')`, 'More', { chrome: true })
      if (whyM) throw new Error(whyM)
      if (!await t.waitIn(`d.querySelector('[role="dialog"][aria-label="More navigation options"]') && w.history.state && w.history.state.__backnav`, 8000)) throw new Error('the More sheet never opened with its Back marker pushed')
      await t.settle(300, 3000)
      out.moreOpen = await t.read(`return { y: w.scrollY, key: w.__h.key(), idx: w.__h.idx(), bodyOverflow: d.body.style.overflow }`)
      tapSel = `d.querySelector('[data-testid="harness-more-${flow.target}"]')`
      chrome = true
    } else if (flow.door === 'tab') {
      tapSel = `d.querySelector('[data-testid="harness-tab-${flow.target}"]')`
      chrome = true
    }
    await t.read(`w.__h.mark(); w.__h.startSampling(); return 1`)
    const whyT = await t.tap(tapSel, `the ${flow.door} door`, { chrome })
    if (whyT) throw new Error(whyT)
    if (!await t.waitIn(`w.__h.pageReady('${flow.target}')`, 15000)) {
      const dg = await t.read(`return { path: w.location.pathname, errors: w.__h.errors(), fallback: !!d.querySelector('[data-testid="harness-route-fallback"]'), left: !!d.querySelector('[data-testid="harness-left-page"]') }`)
      throw new Error(`the arriving page never finished loading: ${JSON.stringify(dg)}`)
    }
    const st = await t.settle(600, 8000)
    const samples = await t.read(`return w.__h.stopSampling()`)
    const after = await t.read(READ_HERE(null))
    out.after = { ...after, settled: st }
    out.samples = samples
    out.calls = await t.read(`return w.__h.calls()`)
    out.trace = await t.read(`return w.__h.trace()`)
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await t.shoot(join(SHOTS, `${flow.id.replace(/[^a-z0-9@-]+/gi, '_')}-landed.png`)) }
    out.newEntry = after.key != null && after.key !== before.key
    if (after.page !== flow.target) throw new Error(`landed on ${after.path} (${after.page}), expected ${flow.target}`)

    // Back: a real traversal onto the source's own entry.
    await t.read(`w.__h.mark(); return 1`)
    await t.ev(`(() => { ${FRAME_VARS}; w.history.back(); return 1 })()`)
    if (!await t.waitIn(`w.__h.pageReady('${flow.src}')`, 15000)) throw new Error('Back never brought the source page back')
    const stB = await t.settle(800, 10000)
    const back = await t.read(READ_HERE(doorSel))
    out.back = { ...back, settled: stB, sameKey: back.key === before.key, calls: await t.read(`return w.__h.calls()`) }
    out.errors = await t.read(`return w.__h.errors()`)
    out.unstubbed = [...new Set(await t.read(`return w.__h.unstubbed()`))]
    const boot1 = await t.read(`return w.__h.boot()`)
    if (boot1 !== boot0) throw new Error('the frame RELOADED mid-flow (a new document) — not a measurement')
    out.ok = true
  } catch (err) {
    out.ok = false
    out.error = err.message
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
  return out
}

const compactSamples = (s) => (s || []).map((x) => `t${x.t} ${x.path.replace(/^\/(\w+).*/, '$1')} y${x.y} doc${x.docH}${x.h1 != null ? ` h1@${x.h1}` : ''}${x.loading ? ' LOADING' : ''}`).join(' | ')

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'detailscroll-'))
const results = []
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await connect(chrome.version.webSocketDebuggerUrl)
  console.log(`[detailscroll] ${chrome.version.Browser} · frame ${VW}x${VH} · latency ${MS}ms · harness :${PORT} · CDP :${CDP_PORT}`)
  for (const flow of FLOWS) {
    if (ONLY && !ONLY.has(flow.id)) continue
    const r = await runFlow(cdp, flow)
    results.push(r)
    if (!r.ok) { console.log(`[detailscroll] ${flow.id}: NOT MEASURED — ${r.error}`); continue }
    const b = r.before, a = r.after, k = r.back
    console.log(`[detailscroll] ${flow.id}: before y${R(b.y)} (doc ${b.docH}) → landed y${R(a.y)} of max ${R(a.max)} (doc ${a.docH}); h1 ${a.h1 ? `@${a.h1.top}` : 'none'} ${a.h1InBand ? 'IN band' : a.h1Visible ? 'partly visible' : 'NOT visible'}; top of view: ${a.top ? `${a.top.tag}${a.top.testid ? `[${a.top.testid}]` : ''} "${a.top.text}"` : 'n/a'}; newEntry ${r.newEntry}; script scrolls ${r.calls.length ? JSON.stringify(r.calls) : 'none'} · Back y${R(k.y)} (${k.sameKey ? 'same key' : 'OTHER KEY'}), door top ${b.doorTop}→${k.doorTop}${r.errors.length ? ` · ERRORS ${r.errors.join(' | ')}` : ''}${r.unstubbed.length ? ` · unstubbed ${r.unstubbed.join(', ')}` : ''}`)
    console.log(`    frames: ${compactSamples(r.samples)}`)
  }
} catch (err) {
  console.error(`[detailscroll] could not complete: ${err.message}`)
  process.exitCode = 1
} finally {
  try { cdp?.ws.close() } catch { /* gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
}
if (OUT) { writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), viewport: [VW, VH], ms: MS, results }, null, 1)); console.log(`[detailscroll] wrote ${OUT}`) }
if (results.some((r) => !r.ok)) process.exitCode = 1
