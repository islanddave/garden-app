#!/usr/bin/env node
// phototier-bytes.mjs — BUG-TIERLESSPHOTOS-001. Counts the image REQUESTS and BYTES the Today care
// list and a planting's growth strip actually pull, in real Chrome at phone geometry.
//
//   node scripts/layout-gate/phototier-bytes.mjs [--surface today|growth] [--tier none] \
//        [--miss N] [--count N] [--out path.png] [--label TEXT] [--max-bytes N]
//
// REPORTER vs GATE — read this before wiring it anywhere. Without --max-bytes this run PRINTS a
// payload number and fails only on instrument faults (emulation refused, a broken <img>, fixtures
// off the prod medians). That is the right shape for a comparison run and the WRONG shape for CI: a
// step that cannot fail on the thing it measures is decoration. --max-bytes is the assertion, and
// it is what npm run gate:phototier-bytes passes. `npm run phototier-bytes:before` is the same
// budget against the pre-fix request shape and is EXPECTED to fail — it is how the ceiling gets
// re-proven non-vacuous, deliberately kept out of the `gate:` namespace so nothing wires it.
//
// WHAT IT DOES NOT COVER, stated so a green run is not over-read: the harness mounts CareNeeded
// (--surface today) and GrowthStrip (--surface growth) and NOTHING ELSE. The PlantingDetail photo
// grid, the Lightbox filmstrip, EventDetail's thumbs and ProjectDetail's 40px rows are guarded by
// photoPrimitive.static.test.js clauses 3 and 4, not by a byte measurement.
//
// WHY THIS EXISTS: jsdom never loads an image, so the whole vitest suite can prove which URL a
// surface asked for and can never prove a byte moved. The unit tests are the correctness gate; this
// is the only thing in the lane that produces a payload number, and it produces it from CDP's
// Network.loadingFinished encodedDataLength — the transferred size on the wire, not a fixture
// constant a report could quote back at itself.
//
// FIXTURES ARE SIZED TO MEASURED PROD, not invented. 2026-08-26, `aws s3 ls garden-photos-prod`
// joined to live Neon (1351 live rows): originals median 4,147,674 B / mean 4,272,086 B; thumbs
// median 176,963 B / mean 175,425 B; 24.4x on the mean; 1314 of 1351 rows (97.3%) have a thumb
// object and 37 (2.7%) do NOT and would 404. The generated JPEGs are real, decodable images padded
// to those exact medians, so encodedDataLength here is what prod would move for the same shape.
//
// THREE MEASUREMENT TRAPS THIS AVOIDS (each yields a confident wrong number):
//   1. macOS Chrome floors an OS window at ~500px, so --window-size=390 lays out at ~500 and CROPS
//      to 390 — a plausible-looking mobile shot of a desktop layout. Geometry comes from
//      Emulation.setDeviceMetricsOverride and the run REFUSES to report unless the page
//      self-reports innerWidth 390.
//   2. Identical URLs collapse in the HTTP cache, so a fixture that reuses one URL turns N photos
//      into one request. Every fixture photo carries a distinct ?p=<n>, as a presigned URL does.
//   3. A 404 has a body and a loadingFinished event, so counting requests alone would score a page
//      of broken images as a win. The run reads back naturalWidth per <img> and FAILS if any photo
//      is broken — a blank photo is a worse outcome than a slow one.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
// Transport, not decoration: CI pins node-version '20.19.0', which has NO global WebSocket, so the
// bare `new WebSocket()` this file used to open its CDP session with threw at attach() — after
// paying for a Vite boot and a Chrome launch. That is the same blocker that kept gate:save-band and
// gate:log-chooser out of CI (OPS-LAYOUTGATESUNWIRED-001), and it is why this instrument could not
// simply be added to the workflow as it stood.
import { resolveWebSocket } from './cdp-socket.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.GATE_HARNESS_PORT || 5316)
const IMG_PORT = Number(process.env.GATE_IMG_PORT || 5321)
const CDP_PORT = Number(process.env.GATE_CDP_PORT || 9427)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Same seam the sibling gates use — CI needs --no-sandbox and resolves CHROME_PATH in its own step.
const EXTRA_CHROME_FLAGS = (process.env.GATE_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)

// Dave is Android-only; 390x844 at dpr 2.625 is his geometry and what the sibling gates measure at.
const VIEWPORT = { w: 390, h: 844, dpr: 2.625 }
const PROD_ORIG_MEDIAN = 4_147_674
const PROD_THUMB_MEDIAN = 176_963

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : dflt }
const SURFACE = arg('surface', 'today')
const TIER = arg('tier', '')
const MISS = arg('miss', '0')
const COUNT = arg('count', '20')
const LABEL = arg('label', TIER === 'none' ? 'BEFORE (no thumb field)' : 'AFTER (thumb tier)')
const OUT = arg('out', '')
// The budget that turns this from a reporter into a gate. Absent => report only.
//
// THE CI CEILING IS 4,000,000 B (package.json gate:phototier-bytes, surface=today, count=20) and it
// is derived from two runs of this instrument, not chosen. MEASURED on this harness 2026-08-28:
//   thumb tier  3,542,820 B  (20 x 200, 0 orig / 20 thumb)   <- the ceiling sits ~13% above this
//   full tier  82,957,060 B  (--tier none, the pre-fix request shape)  <- 21x ABOVE the ceiling
// Nothing lives between those two numbers: a SINGLE tile falling back to an original overshoots by
// ~4.15 MB, so the band needs no tolerance and a passing run cannot be a near-miss. Re-derive it
// from a measurement if COUNT or the prod medians move; do not nudge it to make a run pass.
const MAX_BYTES = Number(arg('max-bytes', '')) || 0

const failures = []
const fail = m => failures.push(m)

// Real JPEGs at the measured prod medians. PIL renders decodable content; the tail pad lands the
// byte count exactly on the median without hunting for a quality setting that happens to hit it.
// Trailing bytes after EOI are transferred and ignored by every decoder, so the image still paints.
function makeFixtures(dir) {
  const py = `
from PIL import Image
import random, sys
def make(path, w, h, target):
    random.seed(7)
    im = Image.new('RGB', (w, h))
    px = im.load()
    for y in range(0, h, 8):
        for x in range(0, w, 8):
            c = (40 + (x * 7 + y * 3) % 120, 90 + (y * 5) % 110, 40 + (x * 3) % 80)
            for dy in range(8):
                for dx in range(8):
                    if x + dx < w and y + dy < h: px[x + dx, y + dy] = c
    im.save(path, 'JPEG', quality=70)
    n = target - len(open(path, 'rb').read())
    if n > 0:
        with open(path, 'ab') as f: f.write(b'\\x00' * n)
make(sys.argv[1], 2560, 1920, ${PROD_ORIG_MEDIAN})
make(sys.argv[2], 800, 600, ${PROD_THUMB_MEDIAN})
`
  const r = spawn('python3', ['-c', py, join(dir, 'orig.jpg'), join(dir, 'thumb.jpg')], { stdio: 'inherit' })
  return new Promise((res, rej) => r.on('exit', c => c === 0 ? res() : rej(new Error('fixture generation failed'))))
}

function startImageServer(dir) {
  const srv = createServer((req, res) => {
    const path = req.url.split('?')[0]
    // /missing/* reproduces the real hazard: a thumbs/<key> object that does not exist presigns
    // fine and 404s on GET, which is the ONLY signal a surface gets that a thumb is absent.
    if (path.startsWith('/missing/')) { res.writeHead(404); res.end('no such object'); return }
    const f = join(dir, path.replace(/^\//, ''))
    if (!existsSync(f)) { res.writeHead(404); res.end(); return }
    const body = readFileSync(f)
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
    res.end(body)
  })
  return new Promise(r => srv.listen(IMG_PORT, () => r(srv)))
}

async function startHarness() {
  const bin = resolve(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(bin)) throw new Error(`vite not installed at ${bin} — run npm ci --legacy-peer-deps`)
  // Through vite's own bin, NOT `npx vite`: npx is a wrapper, so killing it orphans the real server.
  const proc = spawn(process.execPath, [bin, '--config', 'tests/harness/vite.harness.config.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/tests/harness/phototier.html`)).ok) return proc } catch { /* not up */ }
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
    // Deliberately LARGER than the viewport under test — emulation imposes the geometry (trap 1).
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
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return { proc, version: await r.json() } } catch { /* not up */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT} within ${CDP_WAIT_TRIES * 250}ms`)
}

async function attach(wsUrl, onEvent) {
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
    } else if (m.method) onEvent(m)
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
  await send('Network.enable', {}, sessionId)
  const evalIn = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  return { ws, send, sessionId, evalIn }
}

let harness, chrome, cdp, imgSrv
const udd = mkdtempSync(join(tmpdir(), 'phototier-'))
const fixDir = mkdtempSync(join(tmpdir(), 'phototier-img-'))
// requestId -> { url, status }. Populated from Network.responseReceived, closed out by
// loadingFinished, which is the ONLY event carrying the transferred size.
const reqs = new Map()
const done = []
try {
  await makeFixtures(fixDir)
  const origB = statSync(join(fixDir, 'orig.jpg')).size
  const thumbB = statSync(join(fixDir, 'thumb.jpg')).size
  if (origB !== PROD_ORIG_MEDIAN || thumbB !== PROD_THUMB_MEDIAN) {
    fail(`fixtures are ${origB}/${thumbB} B, expected the prod medians ${PROD_ORIG_MEDIAN}/${PROD_THUMB_MEDIAN} — every byte figure below would be off`)
  }
  imgSrv = await startImageServer(fixDir)
  harness = await startHarness()
  chrome = await startChrome(udd)
  cdp = await attach(chrome.version.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Network.responseReceived') {
      const u = m.params.response.url
      if (u.startsWith(`http://localhost:${IMG_PORT}/`)) reqs.set(m.params.requestId, { url: u, status: m.params.response.status })
    } else if (m.method === 'Network.loadingFinished') {
      const r = reqs.get(m.params.requestId)
      if (r) done.push({ ...r, bytes: m.params.encodedDataLength })
    }
  })

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: VIEWPORT.dpr, mobile: true,
  }, cdp.sessionId)

  const url = `http://localhost:${PORT}/tests/harness/phototier.html`
    + `?surface=${SURFACE}&count=${COUNT}&miss=${MISS}&imgbase=http://localhost:${IMG_PORT}`
    + (TIER ? `&tier=${TIER}` : '')
  await cdp.send('Page.navigate', { url }, cdp.sessionId)
  await cdp.evalIn(`(async()=>{for(let i=0;i<300;i++){if(window.__h&&window.__h.ready())return 1;await new Promise(r=>setTimeout(r,100))}throw new Error('no image ever settled')})()`)
  await cdp.evalIn(`new Promise(r=>setTimeout(r,1500))`)   // let every in-flight load finish

  const m = await cdp.evalIn(`({ vw: innerWidth, dpr: devicePixelRatio, err: window.__h.error(), imgs: window.__h.imgs() })`)

  // ── Instrument first: an unproven viewport voids every number below it ──
  if (m.vw !== VIEWPORT.w) fail(`page reports innerWidth ${m.vw}, expected ${VIEWPORT.w} — emulation did not take, measurement void`)
  if (m.err) fail(`the page raised an error while mounting: ${m.err}`)
  if (!m.imgs.length) fail('zero <img> rendered — "no bytes moved" would be true for the wrong reason')

  // ── The point of the whole lane: smaller must not mean blank ──
  const broken = m.imgs.filter(i => i.broken)
  if (broken.length) fail(`${broken.length} of ${m.imgs.length} <img> are BROKEN (naturalWidth 0) — a blank photo is worse than a slow one`)

  const ok = done.filter(d => d.status === 200)
  const notFound = done.filter(d => d.status === 404)
  const bytes = ok.reduce((a, d) => a + d.bytes, 0)
  const nOrig = ok.filter(d => d.url.includes('/orig.jpg')).length
  const nThumb = ok.filter(d => d.url.includes('/thumb.jpg')).length
  const tiers = m.imgs.reduce((a, i) => { a[i.tier] = (a[i.tier] || 0) + 1; return a }, {})
  const boxes = [...new Set(m.imgs.map(i => `${i.w}x${i.h}`))].join(', ')

  console.log(`\n[phototier-bytes] ${LABEL} — surface=${SURFACE} count=${COUNT} miss=${MISS}`)
  console.log(`  viewport      ${m.vw}x${VIEWPORT.h} @dpr ${m.dpr} (page self-reported)`)
  console.log(`  <img> boxes   ${m.imgs.length} elements: ${boxes}`)
  console.log(`  rendered tier ${Object.entries(tiers).map(([k, v]) => `${k}=${v}`).join(' ')} · broken=${broken.length}`)
  console.log(`  requests      ${ok.length} x 200 (${nOrig} orig, ${nThumb} thumb) + ${notFound.length} x 404`)
  console.log(`  BYTES         ${bytes.toLocaleString()} (${(bytes / 1048576).toFixed(2)} MB) transferred`)

  // ── The budget. Everything above is a report; this is the gate ──
  //
  // A CEILING ON THE WIRE, not a tier census, and the difference is the point: a surface can regress
  // to full-tier bytes in ways a `src` inspection does not see (an extra hero, a duplicated request,
  // a degrade storm from thumbs that 404), and all of them show up here as bytes. The ceiling is set
  // in the caller (package.json) against the measured thumb median, so a single tile falling back to
  // an original is ~4.15 MB — a 23x overshoot, not a rounding error. There is no tolerance band
  // because there is nothing near the boundary to be tolerant of.
  //
  // ALSO ASSERTS A FLOOR, and that is not paranoia: `bytes` is a sum over requests, so a page that
  // rendered nothing scores a perfect zero. The imgs.length and broken checks above already refuse
  // that case; this one refuses the subtler version where images render from somewhere other than
  // the instrumented server and the byte count silently measures nothing.
  if (MAX_BYTES) {
    if (bytes > MAX_BYTES) {
      fail(`${bytes.toLocaleString()} B transferred, budget ${MAX_BYTES.toLocaleString()} B — ${nOrig} of ${ok.length} requests were full originals`)
    }
    if (!ok.length) fail('the budget passed on ZERO successful image requests — nothing was measured')
  }

  if (OUT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, cdp.sessionId)
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
    console.log(`  wrote         ${OUT}`)
  }
} catch (e) {
  fail(`run could not complete: ${e.message}`)
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  chrome?.proc.kill('SIGKILL')
  harness?.kill('SIGKILL')
  imgSrv?.close()
  try { rmSync(udd, { recursive: true, force: true }) } catch { /* best effort */ }
  try { rmSync(fixDir, { recursive: true, force: true }) } catch { /* best effort */ }
}

if (failures.length) {
  console.error('\n[phototier-bytes] FAIL')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('[phototier-bytes] PASS\n')
