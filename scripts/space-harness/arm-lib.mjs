// C-HARNESS (step 1.12) arm: ONE non-dry daily-plan run() against ONE branch, with every outbound
// effect recorded instead of sent. harness.py runs one arm per branch (A, then B) and compares them.
//
// Each arm imports the handler.js of ITS OWN tree (the base or the candidate worktree), so a code
// change is measured by running the two SHAs, not by flags. Nothing leaves the process:
//   * publishAlert, fetchStation (AWN) and the weather fetchers are recording stubs fed from one
//     fixture file, and each call records its DESTINATION (SNS topic, station, grid cell);
//   * global fetch is replaced by a guard that records the destination (Graph, AWN or any host) and
//     answers 503, so a code path that fetches by itself is seen and never reaches the network.
// A station MAC is recorded only as a short sha256 tag, and a grid cell at 1 decimal, so an arm's
// output can be kept beside a public repo without a device id or a precise location in it.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { format } from 'node:util'

export const tag = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12)
const cell = (lat, lng) => (Number.isFinite(+lat) && Number.isFinite(+lng)
  ? `grid:${(+lat).toFixed(1)},${(+lng).toFixed(1)}` : 'grid:none')

export function makeRecorder() {
  const calls = []
  return { calls, record: (stub, destination, detail = {}) => { calls.push({ stub, destination, ...detail }) } }
}

// The run() injections, all served from `fixture` (see fixtures/fetchers.default.json).
export function recordingStubs(rec, fixture = {}, stationConfig = () => []) {
  let published = 0
  const served = (stub, destination, value) => {
    rec.record(stub, destination)
    if (value === undefined || value === null) return null
    return structuredClone(value)
  }
  return {
    publishAlert: async ({ topic, subject, message } = {}) => {
      rec.record('publishAlert', `sns:${topic}`, { subject, message })
      published += 1
      return { topicArn: `recorded:${topic}`, messageId: `recorded-${published}` }
    },
    fetchStation: async () => {
      const mac = (stationConfig()[0] || {}).mac
      return served('fetchStation', mac ? `awn:${tag(mac)}` : 'awn:none', fixture.station)
    },
    geocodeZip: async (zip) => {
      rec.record('geocodeZip', `zip:${tag(zip)}`)
      if (!fixture.geocode) throw new Error('space-harness: no geocode in the fixture')
      return structuredClone(fixture.geocode)
    },
    fetchNWS: async (lat, lng) => served('fetchNWS', cell(lat, lng), fixture.nws),
    fetchPrecip: async (lat, lng) => served('fetchPrecip', cell(lat, lng), fixture.precip),
    fetchRainForecast: async (lat, lng) => served('fetchRainForecast', cell(lat, lng), fixture.rainForecast),
  }
}

export function fetchDestination(input) {
  let url
  try { url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input)) } catch (_) {
    return { stub: 'fetch', destination: 'fetch:unparseable' }
  }
  const segs = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'graph.facebook.com') {
    // /<version>/<node>/<edge>: the node (a page or IG user id) is the destination. Query (token) never kept.
    const rest = /^v\d+(\.\d+)?$/.test(segs[0] || '') ? segs.slice(1) : segs
    return { stub: 'graph', destination: `graph:${rest.join('/') || '/'}` }
  }
  if (url.hostname === 'api.ambientweather.net') {
    const i = segs.indexOf('devices')
    return { stub: 'awn', destination: i >= 0 && segs[i + 1] ? `awn:${tag(decodeURIComponent(segs[i + 1]))}` : 'awn:devices' }
  }
  return { stub: 'fetch', destination: `fetch:${url.hostname}` }
}

export function installFetchGuard(rec, target = globalThis) {
  const orig = target.fetch
  target.fetch = async (input, init = {}) => {
    const { stub, destination } = fetchDestination(input)
    rec.record(stub, destination, { method: (init && init.method) || 'GET', via: 'global-fetch' })
    return new Response(JSON.stringify({ error: 'space-harness: network refused' }),
      { status: 503, headers: { 'content-type': 'application/json' } })
  }
  return () => { target.fetch = orig }
}

export function parseJsonLine(line) {
  const t = String(line).trim()
  if (!t.startsWith('{')) return null
  try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null } catch (_) { return null }
}

export function captureConsole(sink, { echo = null, target = console } = {}) {
  const saved = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[level] = target[level]
    target[level] = (...args) => {
      const line = format(...args)
      sink.push({ level, line, json: parseJsonLine(line) })
      if (echo) echo(`${line}\n`)
    }
  }
  return () => { Object.assign(target, saved) }
}

// Offline only: the Lambda's own driver speaks Postgres over a WebSocket, so a local PG cluster is reached
// through this in-process proxy. It forwards to ONE host:port (the arm's own DSN) and to nothing else.
export async function startLocalWsProxy(WebSocketServer, allowHost, allowPort) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject) })
  wss.on('connection', (ws, req) => {
    const addr = new URL(req.url, 'http://x').searchParams.get('address') || ''
    if (addr !== `${allowHost}:${allowPort}`) { ws.close(1008, 'space-harness: address refused'); return }
    const sock = net.connect(Number(allowPort), allowHost)
    const queued = []
    sock.on('connect', () => { for (const d of queued.splice(0)) sock.write(d) })
    ws.on('message', (d) => { if (sock.connecting) queued.push(d); else sock.write(d) })
    sock.on('data', (d) => { if (ws.readyState === 1) ws.send(d) })
    const end = () => { sock.destroy(); if (ws.readyState <= 1) ws.close() }
    ws.on('close', end); ws.on('error', end); sock.on('close', end); sock.on('error', end)
  })
  return { port: wss.address().port, close: () => new Promise((r) => wss.close(() => r())) }
}

export function treeHead(tree) {
  try { return execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (_) { return null }
}

export async function loadDriver(tree, { driverDir, wsDir } = {}) {
  const lambdaModules = path.join(tree, 'lambda', 'daily-plan', 'node_modules')
  const dDir = driverDir || path.join(lambdaModules, '@neondatabase', 'serverless')
  const wDir = wsDir || path.join(lambdaModules, 'ws')
  let driver, wsMod
  try {
    driver = await import(pathToFileURL(path.join(dDir, 'index.mjs')).href)
    wsMod = createRequire(path.join(wDir, 'package.json'))(wDir)
  } catch (e) {
    throw new Error(`space-harness: cannot load the Lambda's driver from ${dDir} / ${wDir} (${e.message}). ` +
      `Run: npm install --prefix ${path.join(tree, 'lambda', 'daily-plan')} --no-save --legacy-peer-deps`)
  }
  return { Pool: driver.Pool, neonConfig: driver.neonConfig, ws: wsMod.WebSocket || wsMod, WebSocketServer: wsMod.WebSocketServer }
}

// One arm. `handlerModule` lets a test pass a fake; a real arm requires <tree>/lambda/daily-plan/handler.js.
export async function runArm({ tree, dsn, today, fixture = {}, localPg = false, driverDir, wsDir, echo = null,
  handlerModule = null, poolFactory = null, etHour = undefined }) {
  const handlerPath = path.join(tree, 'lambda', 'daily-plan', 'handler.js')
  const out = {
    tree, head: treeHead(tree), handler_path: handlerPath, today, dryRun: false,
    handler_sha256: null, result: null, error: null, console: [], calls: [], ms: null,
  }
  const rec = makeRecorder()
  out.calls = rec.calls
  const restoreFetch = installFetchGuard(rec)
  const restoreConsole = captureConsole(out.console, { echo })
  let pool = null
  let proxy = null
  const t0 = Date.now()
  try {
    let handler = handlerModule
    if (!handler) {
      out.handler_sha256 = createHash('sha256').update(readFileSync(handlerPath)).digest('hex')
      handler = createRequire(handlerPath)(handlerPath)
    }
    let stationConfig = () => []
    try { stationConfig = createRequire(handlerPath)(path.join(tree, 'lambda', 'daily-plan', 'station.js')).stationConfig } catch (_) { /* fake tree */ }
    const stubs = recordingStubs(rec, fixture, stationConfig)
    if (poolFactory) {
      pool = await poolFactory()
    } else {
      const d = await loadDriver(tree, { driverDir, wsDir })
      d.neonConfig.webSocketConstructor = d.ws
      let conn = dsn
      if (localPg) {
        const u = new URL(dsn)
        if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) throw new Error('--local-pg takes a loopback DSN only')
        proxy = await startLocalWsProxy(d.WebSocketServer, u.hostname, u.port || '5432')
        d.neonConfig.wsProxy = (host, port) => `127.0.0.1:${proxy.port}/v1?address=${host}:${port}`
        d.neonConfig.useSecureWebSocket = false
        d.neonConfig.pipelineConnect = false
        d.neonConfig.pipelineTLS = false
        u.searchParams.set('sslmode', 'disable')
        conn = u.toString()
      }
      pool = new d.Pool({ connectionString: conn })
    }
    const fx = fixture.etHour ?? etHour
    const res = await handler.run({ pg: pool, today, dryRun: false, ...stubs, ...(fx === undefined ? {} : { etHour: fx }) })
    out.result = {
      rows: res && res.rows,
      plans: ((res && res.plans) || []).map((p) => ({ user_id: p.user_id ?? null, space_id: p.space_id ?? null, counts: (p.plan && p.plan.counts) || null })),
    }
  } catch (e) {
    out.error = String((e && e.stack) || e).split('\n').slice(0, 4).join('\n')
  } finally {
    out.ms = Date.now() - t0
    restoreConsole()
    restoreFetch()
    if (pool && pool.end) await pool.end().catch(() => {})
    if (proxy) await proxy.close()
  }
  return out
}
