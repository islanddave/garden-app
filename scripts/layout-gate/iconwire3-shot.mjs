#!/usr/bin/env node
// iconwire3-shot.mjs — V4-ICON-001 slice 3. Renders Favorites and the Locations action menu in
// real Chrome at phone geometry, asserts what the vitest lock cannot, and writes two PNGs.
//
//   node scripts/layout-gate/iconwire3-shot.mjs [--outdir DIR]
//
// ASSERTS, at a TRUE 390x844 with a real layout engine:
//   (a) no pictographic character survives on either rendered surface;
//   (b) every icon sits ON the text line it shares (|centre skew| <= 3px) — the question the swap
//       actually raises, since an emoji is a text glyph on the baseline and an inline SVG is a
//       replaced box, and jsdom reports 0 for every rect involved;
//   (c) every icon renders at a non-zero size, inside the viewport, and is really visible;
//   (d) no icon is alone in its row — each one has text beside it, so nothing reads by mark alone;
//   (e) the document does not scroll sideways, and the page raised no error while mounting.
//
// TWO MEASUREMENT TRAPS THIS AVOIDS (both produce a confident wrong answer), copied from
// inventory-list-shot.mjs because they are properties of this Mac, not of that gate:
//   1. macOS Chrome floors an OS window at ~500px wide, so `--window-size=390` lays the page out
//      at ~500 and CROPS the capture to 390 — a plausible-looking mobile screenshot of a
//      desktop-width layout. Geometry comes from Emulation.setDeviceMetricsOverride, and the run
//      REFUSES TO PASS unless the page self-reports innerWidth 390.
//   2. A backgrounded renderer never fires requestAnimationFrame, so a React page can sit
//      half-mounted forever. --disable-renderer-backgrounding (plus siblings) is why this drives
//      headless Chrome directly.
//
// NON-VACUITY. "every icon passes" is true of a page with no icons, which is exactly the shape of
// failure these gates exist to refuse. Each surface declares the minimum it must yield before
// anything is asserted about it.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5316)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9427)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Dave is Android-only; 390x844 is the common Android logical viewport and the geometry the
// sibling gates in this directory already measure at.
const VIEWPORT = { w: 390, h: 844 }
const SKEW_FLOOR = 3          // px of centre-to-centre drift tolerated between an icon and its text

const outArg = process.argv.indexOf('--outdir')
const OUTDIR = outArg > -1 ? process.argv[outArg + 1]
  : '/Users/davenichols/AI/Claude/Projects/Gardening/_perfdesign_20260826'

// minIcons is the non-vacuity floor: Favorites draws a title heart plus three section marks;
// the open Locations menu draws four rows plus whatever the list itself carries.
const SURFACES = [
  { name: 'favorites', minIcons: 4, open: false, out: 'iconwire3-favorites-390x844.png' },
  // The empty state is the one place an icon sits inside a sentence, and the only one carrying an
  // announced name rather than aria-hidden — so it gets its own frame rather than being assumed.
  { name: 'favorites-empty', minIcons: 2, open: false, out: 'iconwire3-favorites-empty-390x844.png' },
  { name: 'locations', minIcons: 4, open: true, out: 'iconwire3-locations-menu-390x844.png' },
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
      const r = await fetch(`http://localhost:${PORT}/tests/harness/iconwire3.html`)
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
    // Deliberately LARGER than the viewport under test: geometry is imposed by emulation below,
    // so the window only has to be big enough not to clip it. See trap 1 in the header.
    '--window-size=900,1000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
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
const udd = mkdtempSync(join(tmpdir(), 'iconwire3-shot-'))
try {
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  // THE VIEWPORT, imposed by devtools emulation rather than by the OS window (header trap 1).
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 2, mobile: true,
  }, cdp.sessionId)

  for (const s of SURFACES) {
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/tests/harness/iconwire3.html?surface=${s.name}` }, cdp.sessionId)
    await cdp.evalIn(`(async()=>{for(let i=0;i<200;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('${s.name} never rendered')})()`)
    if (s.open) await cdp.evalIn(`window.__h.openMenu()`)
    await cdp.evalIn(`new Promise(r=>setTimeout(r,600))`)   // let the verdict strip settle

    const m = await cdp.evalIn(`({
      vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth,
      err: window.__h.error(), icons: window.__h.icons(), emoji: window.__h.pictographic(),
      sideways: window.__h.docOverflows(),
      rows: window.__h.textOf('${s.name === 'locations' ? 'button' : 'h1,h2'}'),
    })`)

    // ── Instrument first: an unproven viewport voids every number below it ──
    if (m.vw !== VIEWPORT.w) fail(`${s.name}: page reports innerWidth ${m.vw}, expected ${VIEWPORT.w} — emulation did not take, measurement void`)
    if (m.err) fail(`${s.name}: the page raised an error while mounting: ${m.err}`)

    // ── Non-vacuity: "every icon passes" must not be true of a page with no icons ──
    if (m.icons.length < s.minIcons) fail(`${s.name}: only ${m.icons.length} icons rendered, expected >=${s.minIcons} — the surface did not fully mount`)

    // ── (a) the whole point of the lane ──
    if (m.emoji.length) fail(`${s.name}: ${m.emoji.length} pictographic character(s) still rendered`)

    // ── (b)/(c) each icon, AS RENDERED ──
    for (const i of m.icons) {
      if (!i.w || !i.h) fail(`${s.name}: icon "${i.label}" renders ${i.w}x${i.h}`)
      if (!i.visible) fail(`${s.name}: icon "${i.label}" checkVisibility() false`)
      if (!i.fits) fail(`${s.name}: icon "${i.label}" sits outside the ${VIEWPORT.w}px viewport`)
      if (Math.abs(i.baselineSkew) > SKEW_FLOOR) fail(`${s.name}: icon "${i.label}" sits ${i.baselineSkew}px off its text line`)
    }

    // ── (d) never mark-alone: every icon's row carries text too ──
    for (const i of m.icons) {
      if (!i.label || i.label === '?') fail(`${s.name}: an icon has no text beside it — reads by mark alone`)
    }

    // ── (e) ──
    if (m.sideways) fail(`${s.name}: document scrollWidth ${m.scrollW} > ${m.vw} — the page scrolls sideways`)

    const skew = m.icons.map(i => Math.abs(i.baselineSkew))
    console.log(`[iconwire3-shot] ${s.name} ${m.vw}x${m.vh} (page self-reports) · ${m.icons.length} icons · worst baseline skew ${Math.max(...skew)}px (floor ${SKEW_FLOOR}px) · emoji ${m.emoji.length}`)
    console.log(`[iconwire3-shot] ${s.name} rows: ${m.rows.filter(Boolean).join(' | ')}`)
    console.log(`[iconwire3-shot] ${s.name} a11y: ${m.icons.filter(i => i.named).map(i => `"${i.named}"`).join(', ') || '(all decorative)'} · ${m.icons.filter(i => i.hidden).length} aria-hidden`)

    // ── The artifact ──
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, cdp.sessionId)
    const out = join(OUTDIR, s.out)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log(`[iconwire3-shot] wrote ${out}`)
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
  console.error('\n[iconwire3-shot] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[iconwire3-shot] PASS')
