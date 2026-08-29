#!/usr/bin/env node
// iconwire4-shot.mjs — V4-ICON-001 slice 4. Renders the five rewired surfaces in real Chrome at
// phone geometry, asserts what the vitest lock cannot, and writes five PNGs.
//
//   node scripts/layout-gate/iconwire4-shot.mjs [--outdir DIR]
//
// ASSERTS, at a TRUE 390x844 with a real layout engine:
//   (a) no pictographic character survives inside the rewired subtree (and REPORTS any outside it);
//   (b) every mark renders at a non-zero size, is really visible, and sits inside the viewport;
//   (c) every mark is CONTAINED by the card / chip / row it labels — the replaced-box question an
//       emoji-to-SVG swap actually raises, and the one jsdom answers 0 to. Baseline skew is NOT the
//       measure here: three of these five surfaces stack the mark above its text or centre it in a
//       fixed circular node, so there is no shared line box and a skew number would be noise;
//   (d) no mark is alone — each has text in an ancestor, so nothing reads by glyph or hue alone;
//   (e) the document does not scroll sideways, and the page raised no error while mounting.
//
// TWO MEASUREMENT TRAPS THIS AVOIDS (both produce a confident wrong answer), inherited from the
// sibling gates because they are properties of this Mac, not of any one gate:
//   1. macOS Chrome floors an OS window at ~500px wide, so `--window-size=390` lays the page out at
//      ~500 and CROPS the capture to 390 — a plausible-looking mobile screenshot of a desktop-width
//      layout. Geometry comes from Emulation.setDeviceMetricsOverride, and the run REFUSES TO PASS
//      unless the page self-reports innerWidth 390.
//   2. A backgrounded renderer never fires requestAnimationFrame, so a React page can sit
//      half-mounted forever. --disable-renderer-backgrounding (plus siblings) is why this drives
//      headless Chrome directly.
//
// NON-VACUITY. "every mark passes" is true of a page with no marks, which is the exact shape of
// failure these gates exist to refuse. Each surface declares the minimum it must yield first.
//
// TRANSPORT. resolveWebSocket(), not a bare global: CI pins node 20.19.0, which has no global
// WebSocket — see cdp-socket.mjs for the measurement that established this.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5317)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9428)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI needs --no-sandbox and resolves CHROME_PATH in its own step.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)

// Dave is Android-only; 390x844 is the common Android logical viewport and the geometry the sibling
// gates in this directory already measure at.
const VIEWPORT = { w: 390, h: 844 }

// REPO-RELATIVE default, not the authoring machine's scratch dir. The old default was an absolute
// /Users/davenichols/... path; on a Linux runner /Users does not exist and cannot be created at /,
// so the mkdirSync below threw INSIDE the try and became fail('gate could not complete') -> exit 1
// AFTER the Vite boot, the Chrome launch and every real assertion had already passed. A gate that
// reds on where it writes its by-product, having found nothing wrong, is worse than no gate.
const outArg = process.argv.indexOf('--outdir')
const OUTDIR = outArg > -1 ? process.argv[outArg + 1] : resolve(ROOT, 'artifacts/layout-gate')

// minIcons is the non-vacuity floor, one per surface:
//   overwinter    4 regime marks (+ the selected row's check once one is picked)
//   inventory     2 type cards
//   water-depth   1+2+3 drops on the full group, again on the small one
//   life-story    5 milestones
//   notify        3 tiles, one bell each
const SURFACES = [
  { name: 'overwinter', minIcons: 4, open: true, out: 'iconwire4-overwinter-390x844.png' },
  { name: 'inventory-type', minIcons: 2, open: false, out: 'iconwire4-inventory-type-390x844.png' },
  { name: 'water-depth', minIcons: 12, open: false, out: 'iconwire4-water-depth-390x844.png' },
  { name: 'life-story', minIcons: 5, open: false, out: 'iconwire4-life-story-390x844.png' },
  { name: 'notify', minIcons: 3, open: false, out: 'iconwire4-notify-390x844.png' },
]

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
      const r = await fetch(`http://localhost:${PORT}/tests/harness/iconwire4.html`)
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
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation below, so
    // the window only has to be big enough not to clip it. See trap 1 in the header.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
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

const failures = []
const fail = m => failures.push(m)

let harness, chrome, cdp
const udd = mkdtempSync(join(tmpdir(), 'iconwire4-shot-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  // THE VIEWPORT, imposed by devtools emulation rather than by the OS window (header trap 1).
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 2, mobile: true,
  }, cdp.sessionId)

  for (const s of SURFACES) {
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/iconwire4.html?surface=${s.name}` }, cdp.sessionId)
    await cdp.evalIn(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('${s.name} never rendered')})()`)
    if (s.open) {
      await cdp.evalIn('window.__h.openSheet()')
      await cdp.evalIn('new Promise(r=>setTimeout(r,500))')   // the sheet animates in
    }
    await cdp.evalIn('new Promise(r=>setTimeout(r,600))')     // let the verdict strip settle

    const m = await cdp.evalIn(`({
      vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth,
      err: window.__h.error(), icons: window.__h.icons(), emoji: window.__h.pictographic(),
      outside: window.__h.pictographicOutside(), sideways: window.__h.docOverflows(),
      rows: window.__h.textOf('button, li'),
    })`)

    // ── Instrument first: an unproven viewport voids every number below it ──
    if (m.vw !== VIEWPORT.w) fail(`${s.name}: page reports innerWidth ${m.vw}, expected ${VIEWPORT.w} — emulation did not take, measurement void`)
    if (m.err) fail(`${s.name}: the page raised an error while mounting: ${m.err}`)

    // ── Non-vacuity: "every mark passes" must not be true of a page with no marks ──
    if (m.icons.length < s.minIcons) fail(`${s.name}: only ${m.icons.length} marks rendered, expected >=${s.minIcons} — the surface did not fully mount`)

    // ── (a) the whole point of the lane ──
    if (m.emoji.length) fail(`${s.name}: ${m.emoji.length} pictographic character(s) still rendered inside the rewired subtree: ${m.emoji.join('')}`)

    // ── (b)/(c)/(d) each mark, AS RENDERED ──
    for (const i of m.icons) {
      if (!i.w || !i.h) fail(`${s.name}: mark in "${i.label}" renders ${i.w}x${i.h}`)
      if (!i.visible) fail(`${s.name}: mark in "${i.label}" checkVisibility() false`)
      if (!i.fits) fail(`${s.name}: mark in "${i.label}" sits outside the ${VIEWPORT.w}px viewport`)
      if (!i.contained) fail(`${s.name}: mark in "${i.label}" escapes the row/card/chip it belongs to`)
      if (!i.label || i.label === '?') fail(`${s.name}: a mark has no text in any ancestor — reads by mark alone`)
    }

    // ── (e) ──
    if (m.sideways) fail(`${s.name}: document scrollWidth ${m.scrollW} > ${m.vw} — the page scrolls sideways`)

    console.log(`[iconwire4-shot] ${s.name} ${m.vw}x${m.vh} (page self-reports) · ${m.icons.length} marks · sizes ${[...new Set(m.icons.map(i => `${i.w}x${i.h}`))].join(',')} · emoji-in-scope ${m.emoji.length}`)
    if (m.outside.length) console.log(`[iconwire4-shot] ${s.name} NOTE — ${m.outside.length} pictographic char(s) OUTSIDE this lane's subtree: ${m.outside.join('')} (reported, not failed)`)
    console.log(`[iconwire4-shot] ${s.name} rows: ${m.rows.filter(Boolean).slice(0, 6).join(' | ')}`)

    // ── The artifact ──
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, cdp.sessionId)
    const out = join(OUTDIR, s.out)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log(`[iconwire4-shot] wrote ${out}`)
  }
} catch (e) {
  fail(`gate could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* chrome still unlinking */ }
}

if (failures.length) {
  console.error('\n[iconwire4-shot] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[iconwire4-shot] PASS')
