#!/usr/bin/env node
// photo-cors-probe.mjs — V4-PHOTOCORS-001's REAL-BROWSER instrument.
//
//   node scripts/photo-cors-probe.mjs [--photo /path/to/a/real/thumb.jpg]
//
// Answers, in real Chrome against real Cache Storage and the REAL bytes of public/sw.js, the three
// questions no vitest suite can:
//
//   A. VARY. S3 sends `Vary: Origin` on a CORS photo GET (verified live 2026-08-26). Cache Storage
//      `match()` honours a stored response's Vary against the stored REQUEST. sw.js caches under a
//      normalized URL STRING, so both the stored and the querying request are header-less and the
//      comparison is null-vs-null — but that is a spec reading, and the whole approach dies if it is
//      wrong. src/__tests__/*.js CANNOT answer it: makeFakeCache is a Map keyed on the URL string
//      and models no Vary at all. This is the instrument for that claim; nothing else is.
//   B. THE WIN. Load a photo grid twice with the SW active, with a FRESH presign on the second load,
//      and count the requests and bytes that actually reach the origin.
//   C. THE FAILURE MODE. Re-run with the origin refusing CORS and confirm what a user would see.
//
// WHY A LOCAL ORIGIN AND NOT S3 ITSELF. S3's CORS allow-list is exactly
// [https://garden.futureishere.net] (and the staging distribution) — MEASURED, and localhost is
// deliberately not in it, so a CORS <img> from any local harness is refused by design. Origin B
// below therefore replays the response headers captured VERBATIM from a live presigned GET against
// garden-photos-prod, serving REAL thumb bytes, from a genuinely different origin (127.0.0.1:PORT_B
// vs localhost:PORT_A are different origins per the URL spec). Everything that matters is real: real
// cross-origin CORS, real opaque-vs-cors responses, real Cache Storage, the real service worker, real
// bytes. The one thing simulated is WHICH machine emits headers this script did not invent.
//
// SCOPE. This measures the SW + the crossOrigin attribute. PhotoImg's control flow around them (when
// the attribute is set, the retry-without-it, the latch) is proven in src/__tests__/PhotoImg.cors.test.jsx;
// arm C here proves the browser PRIMITIVE that fallback is built on — that a refused CORS <img> fires
// error and paints nothing, and that the same URL without the attribute then loads.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT_A = Number(process.env.PROBE_PORT_A || 5391)   // the "app" origin
const PORT_B = Number(process.env.PROBE_PORT_B || 5392)   // the "S3" origin
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9424)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_ORIGIN = `http://localhost:${PORT_A}`
const PHOTO_ORIGIN = `http://127.0.0.1:${PORT_B}`
const N_PHOTOS = 24                                        // enough to be a grid, few enough to be quick
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const photoArg = process.argv.indexOf('--photo')
const PHOTO_PATH = photoArg > -1 ? process.argv[photoArg + 1] : null
// 142,528 bytes is the exact size of the real thumb this was developed against; the measured median
// for thumbs/plants/ is ~163 KB. A synthetic body of the same order keeps the script runnable with
// no AWS access, and the byte numbers are then clearly labelled as synthetic.
const PHOTO_BYTES = PHOTO_PATH && existsSync(PHOTO_PATH)
  ? readFileSync(PHOTO_PATH)
  : Buffer.alloc(142528, 0x42)
const PHOTO_IS_REAL = !!(PHOTO_PATH && existsSync(PHOTO_PATH))

// ── Origin B: the photo origin. Replays the live S3 header set. ────────────────────────────────
// `corsEnabled` is the arm switch. When false it behaves like S3 does for an origin that is NOT in
// the bucket's allow-list — 200 with the bytes and NO Access-Control-Allow-Origin — which is the
// exact shape MEASURED against garden-photos-prod with `Origin: http://localhost:5173`.
const photoState = { corsEnabled: true, requests: 0, bytes: 0, urls: [] }
function startPhotoOrigin() {
  const srv = createServer((req, res) => {
    photoState.requests++
    photoState.bytes += PHOTO_BYTES.length
    photoState.urls.push(req.url)
    const headers = {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(PHOTO_BYTES.length),
      // Verbatim from the live response, and the reason this script exists.
      Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
      ETag: '"3ff9a0dadbe5c8b3b1c31582f845c78f"',
      'x-amz-server-side-encryption': 'AES256',
      // No Cache-Control: S3 sends none either, so the HTTP cache cannot be what makes a second load
      // cheap. Any hit measured below is Cache Storage, which is the thing under test.
    }
    if (photoState.corsEnabled && req.headers.origin === APP_ORIGIN) {
      headers['Access-Control-Allow-Origin'] = APP_ORIGIN
      headers['Access-Control-Allow-Methods'] = 'GET, PUT, POST, HEAD'
      headers['Access-Control-Expose-Headers'] = 'ETag'
      headers['Access-Control-Allow-Credentials'] = 'true'
      headers['Access-Control-Max-Age'] = '3000'
    }
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : PHOTO_BYTES)
  })
  return new Promise(r => srv.listen(PORT_B, '127.0.0.1', () => r(srv)))
}

// ── Origin A: the app. Serves the REAL public/sw.js, unmodified. ───────────────────────────────
const SW_SRC = readFileSync(resolve(ROOT, 'public/sw.js'), 'utf8')
const PAGE = `<!doctype html><meta charset=utf-8><title>probe</title><body><div id=g></div>
<script>
window.__loaded = 0; window.__errored = 0;
window.__paint = (urls, cors) => new Promise((done) => {
  const g = document.getElementById('g'); g.innerHTML = '';
  window.__loaded = 0; window.__errored = 0;
  let settled = 0;
  const tick = () => { if (++settled === urls.length) done({ loaded: window.__loaded, errored: window.__errored }); };
  for (const u of urls) {
    const im = document.createElement('img');
    if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => { window.__loaded++; tick(); };
    im.onerror = () => { window.__errored++; tick(); };
    im.src = u; g.appendChild(im);
  }
  if (!urls.length) done({ loaded: 0, errored: 0 });
});
</script></body>`

function startAppOrigin() {
  const srv = createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/sw.js') {
      // Served from the app origin at the root so its scope covers the page — same as production.
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
      return res.end(SW_SRC)
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    res.end(PAGE)
  })
  return new Promise(r => srv.listen(PORT_A, '127.0.0.1', () => r(srv)))
}

// ── Chrome over CDP (same pattern as scripts/layout-gate/*). ───────────────────────────────────
async function startChrome(userDataDir) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`)
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=900,900', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
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
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)) } }, 60000)
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

// Rotating presigns of the SAME N objects — the churn that made the old cache key useless.
// `i` is the OBJECT and `epoch` is the mint, so batch(1) and batch(2) are two presigns of one set.
const mint = (i, epoch) =>
  `${PHOTO_ORIGIN}/thumbs/plants/P${i}/a.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
  `&X-Amz-Credential=ASIAEXAMPLE%2F2026082${epoch}%2Fus-east-1%2Fs3%2Faws4_request` +
  `&X-Amz-Date=2026082${epoch}T21334${epoch}Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host` +
  `&X-Amz-Signature=sig${epoch}${i}`
const batch = (epoch, base = 0) => Array.from({ length: N_PHOTOS }, (_, i) => mint(base + i, epoch))

const reset = () => { photoState.requests = 0; photoState.bytes = 0; photoState.urls = [] }
const kb = (b) => `${(b / 1024).toFixed(0)} KB`

let appSrv, photoSrv, chrome, cdp, userDataDir
const out = []
const say = (s) => { out.push(s); console.log(s) }

try {
  photoSrv = await startPhotoOrigin()
  appSrv = await startAppOrigin()
  userDataDir = mkdtempSync(resolve(tmpdir(), 'photo-cors-probe-'))
  chrome = await startChrome(userDataDir)
  cdp = await attach(chrome.version.webSocketDebuggerUrl)

  await cdp.send('Page.navigate', { url: `${APP_ORIGIN}/` }, cdp.sessionId)
  await cdp.evalIn(`(async()=>{for(let i=0;i<200;i++){if(window.__paint)return 1;await new Promise(r=>setTimeout(r,50))}throw new Error('probe page never loaded')})()`)

  // Register the REAL sw.js and wait until it CONTROLS the page. Without controller!==null every
  // number below would be measured with the SW inert — the classic "instrument was off" result.
  const controlled = await cdp.evalIn(`(async()=>{
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    for (let i=0;i<200;i++){ if (navigator.serviceWorker.controller) return true; await new Promise(r=>setTimeout(r,50)); }
    return false;
  })()`)
  if (!controlled) throw new Error('service worker never took control — every measurement below would be vacuous')
  say(`instrument: sw.js registered and CONTROLLING (${SW_SRC.length} bytes, unmodified)`)
  say(`photo body: ${PHOTO_IS_REAL ? 'REAL prod thumb' : 'SYNTHETIC'} ${PHOTO_BYTES.length} bytes; ${N_PHOTOS} objects per paint`)
  say('')

  // ── A. VARY ────────────────────────────────────────────────────────────────────────────────
  // The single most important result here. If a normalized string key cannot be matched back out of
  // real Cache Storage when the stored response carries Vary: Origin, the entire approach is dead.
  const vary = await cdp.evalIn(`(async()=>{
    const c = await caches.open('probe-vary');
    const KEY = '${PHOTO_ORIGIN}/thumbs/plants/V/a.jpg';
    const mk = () => new Response('BYTES', { status:200, headers:{ 'Content-Type':'image/jpeg', 'Vary':'Origin, Access-Control-Request-Headers, Access-Control-Request-Method' } });
    // (1) sw.js's actual discipline: put and match under the same normalized STRING.
    await c.put(KEY, mk());
    const stringHit = !!(await c.match(KEY));
    // (2) The counter-example that shows Vary is genuinely being enforced and (1) is not vacuous:
    //     store under a REQUEST that carries an Origin header, then query with the bare string.
    const c2 = await caches.open('probe-vary-2');
    await c2.put(new Request(KEY, { headers: { 'X-Probe-Origin': 'https://example.invalid' } }), new Response('BYTES', { status:200, headers:{ 'Content-Type':'image/jpeg', 'Vary':'X-Probe-Origin' } }));
    const headerKeyedHit = !!(await c2.match(KEY));
    await caches.delete('probe-vary'); await caches.delete('probe-vary-2');
    return { stringHit, headerKeyedHit };
  })()`)
  say(`A. VARY  string-keyed put/match with Vary present -> HIT: ${vary.stringHit}`)
  say(`A. VARY  header-keyed put, string match           -> HIT: ${vary.headerKeyedHit}  (false = Vary IS enforced, so the line above is not vacuous)`)
  if (!vary.stringHit) throw new Error('FATAL: Vary defeats the normalized string key — the whole approach fails')
  say('')

  // ── B. THE WIN ─────────────────────────────────────────────────────────────────────────────
  // BEFORE = today: plain <img>, no-cors, opaque responses, nothing cacheable.
  reset()
  const b1 = await cdp.evalIn(`window.__paint(${JSON.stringify(batch(1))}, false)`)
  const beforeFirst = { req: photoState.requests, bytes: photoState.bytes, ...b1 }
  reset()
  const b2 = await cdp.evalIn(`window.__paint(${JSON.stringify(batch(2))}, false)`)
  const beforeSecond = { req: photoState.requests, bytes: photoState.bytes, ...b2 }

  // AFTER = the flag on: crossOrigin="anonymous", CORS responses, cacheable, key normalized.
  photoState.corsEnabled = true
  reset()
  const a1 = await cdp.evalIn(`window.__paint(${JSON.stringify(batch(3))}, true)`)
  const afterFirst = { req: photoState.requests, bytes: photoState.bytes, ...a1 }
  reset()
  const a2 = await cdp.evalIn(`window.__paint(${JSON.stringify(batch(4))}, true)`)
  const afterSecond = { req: photoState.requests, bytes: photoState.bytes, ...a2 }

  say(`B. BEFORE (flag off, no-cors)  load 1: ${beforeFirst.req} requests / ${kb(beforeFirst.bytes)} — ${beforeFirst.loaded} painted, ${beforeFirst.errored} failed`)
  say(`B. BEFORE (flag off, no-cors)  load 2: ${beforeSecond.req} requests / ${kb(beforeSecond.bytes)} — ${beforeSecond.loaded} painted, ${beforeSecond.errored} failed`)
  say(`B. AFTER  (flag on,  cors)     load 1: ${afterFirst.req} requests / ${kb(afterFirst.bytes)} — ${afterFirst.loaded} painted, ${afterFirst.errored} failed`)
  say(`B. AFTER  (flag on,  cors)     load 2: ${afterSecond.req} requests / ${kb(afterSecond.bytes)} — ${afterSecond.loaded} painted, ${afterSecond.errored} failed`)
  say('')

  // Non-vacuity: the win must come from the PHOTO cache specifically, under stripped keys.
  const cacheState = await cdp.evalIn(`(async()=>{
    const names = await caches.keys();
    const read = async (n) => names.includes(n) ? (await (await caches.open(n)).keys()).map(r => r.url) : [];
    const photo = await read('photos-v1');
    const imgs = (await read('images-v16-20260524')).filter(u => u.includes('${PHOTO_ORIGIN}'));
    return { names, n: photo.length, sample: photo.slice(0,1), strayInImageCache: imgs.length };
  })()`)
  say(`B. caches present: ${JSON.stringify(cacheState.names)}`)
  say(`B. photos-v1 holds ${cacheState.n} entries; sample key: ${cacheState.sample[0] ?? '(none)'}`)
  say(`B. photos that leaked into the app-image cache: ${cacheState.strayInImageCache} (must be 0 — the BEFORE arm's opaque responses are refused, which is why today's photo cache is empty)`)
  say('')

  // ── C. THE FAILURE MODE ────────────────────────────────────────────────────────────────────
  // The origin stops emitting CORS headers (a bucket-policy edit, a new app origin, a CDN flip).
  //
  // TWO PRECONDITIONS, both learned the hard way on the first run of this script: arm B left 24
  // photos in photos-v1, so re-using its object set measured a CACHE HIT and reported "24 painted,
  // 0 failed, 0 requests" — a confident false PASS that looked exactly like a working fallback. The
  // cache is dropped AND a disjoint object set (base=100) is used, so the origin is genuinely the
  // only possible source of these bytes.
  await cdp.evalIn(`caches.delete('photos-v1')`)
  const cleared = await cdp.evalIn(`(async()=>(await caches.keys()).includes('photos-v1'))()`)
  if (cleared) throw new Error('photo cache survived the reset — arm C would measure a cache hit and call it a fallback')
  photoState.corsEnabled = false
  reset()
  const cCors = await cdp.evalIn(`window.__paint(${JSON.stringify(batch(5, 100))}, true)`)
  const corsBroken = { req: photoState.requests, ...cCors }
  reset()
  const cPlain = await cdp.evalIn(`window.__paint(${JSON.stringify(batch(5, 100))}, false)`)
  const plainRetry = { req: photoState.requests, ...cPlain }
  say(`C. CORS refused, crossOrigin SET:  ${corsBroken.loaded} painted, ${corsBroken.errored} failed (${corsBroken.req} requests reached the origin)`)
  say(`C. same URLs, attribute REMOVED:   ${plainRetry.loaded} painted, ${plainRetry.errored} failed (${plainRetry.req} requests)`)
  say('C. => a refused CORS <img> paints NOTHING even though the bytes arrived; the same url without')
  say('C.    the attribute paints normally. That gap is what PhotoImg\'s retry-without-crossOrigin recovers.')

  const ok = vary.stringHit && afterSecond.req === 0 && beforeSecond.req === N_PHOTOS
    && afterFirst.loaded === N_PHOTOS && plainRetry.loaded === N_PHOTOS
    && corsBroken.loaded === 0 && corsBroken.errored === N_PHOTOS
    && cacheState.strayInImageCache === 0
  say('')
  say(ok ? 'PROBE OK' : 'PROBE INCONCLUSIVE — read the numbers above, do not assume')
  process.exitCode = ok ? 0 : 1
} catch (err) {
  console.error(`PROBE FAILED: ${err.message}`)
  process.exitCode = 2
} finally {
  try { cdp?.ws.close() } catch { /* already gone */ }
  try { chrome?.proc.kill('SIGKILL') } catch { /* already gone */ }
  try { appSrv?.close() } catch { /* already gone */ }
  try { photoSrv?.close() } catch { /* already gone */ }
  if (userDataDir) { try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best effort */ } }
}
