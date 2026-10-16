// C-HARNESS arm (scripts/space-harness/arm-lib.mjs). No network and no database: the handler and the pool
// are fakes, and the WebSocket proxy is exercised against a loopback echo server.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import {
  tag, makeRecorder, recordingStubs, fetchDestination, installFetchGuard, captureConsole, parseJsonLine,
  startLocalWsProxy, runArm,
} from './arm-lib.mjs'

const FAKE_MAC = Array.from({ length: 6 }, (_, i) => `0${i}`).join(':') // built at run time: no MAC-shaped literal in the file
const fixture = { geocode: { lat: 42.5, lng: -72.7 }, nws: { tonightLow: 50 }, precip: { today_precip_in: 0 }, rainForecast: null, station: null }

describe('recording stubs', () => {
  it('publishAlert records its SNS destination and subject, and sends nothing', async () => {
    const rec = makeRecorder()
    const s = recordingStubs(rec, fixture)
    const r = await s.publishAlert({ topic: 'ops', subject: 'Garden ops - x', message: 'm' })
    expect(r.topicArn).toBe('recorded:ops')
    expect(rec.calls).toEqual([{ stub: 'publishAlert', destination: 'sns:ops', subject: 'Garden ops - x', message: 'm' }])
  })

  it('fetchStation records the station as a tag, never the device id', async () => {
    const rec = makeRecorder()
    const s = recordingStubs(rec, fixture, () => [{ mac: FAKE_MAC }])
    expect(await s.fetchStation()).toBeNull()
    expect(rec.calls[0]).toEqual({ stub: 'fetchStation', destination: `awn:${tag(FAKE_MAC)}` })
    expect(JSON.stringify(rec.calls)).not.toContain(FAKE_MAC)
  })

  it('weather fetchers serve the fixture and record a 2-decimal grid cell', async () => {
    const rec = makeRecorder()
    const s = recordingStubs(rec, fixture)
    const nws = await s.fetchNWS(42.51, -72.71)
    nws.tonightLow = 1
    expect((await s.fetchNWS(42.5, -72.7)).tonightLow).toBe(50) // a copy each time
    expect(rec.calls[0].destination).toBe('grid:42.51,-72.71') // two Spaces a few km apart stay apart
    expect(rec.calls[1].destination).toBe('grid:42.50,-72.70')
    await expect(recordingStubs(rec, {}).geocodeZip('01001')).rejects.toThrow(/no geocode/)
  })
})

describe('global fetch guard', () => {
  let restore = null
  afterEach(() => { if (restore) restore(); restore = null })

  it('names Graph, AWN and any other host, keeps no query string, and answers 503', async () => {
    expect(fetchDestination('https://graph.facebook.com/v21.0/12345/feed?access_token=SECRET'))
      .toEqual({ stub: 'graph', destination: 'graph:12345/feed' })
    const awn = fetchDestination(`https://api.ambientweather.net/v1/devices/${encodeURIComponent(FAKE_MAC)}?apiKey=K&applicationKey=A`)
    expect(awn).toEqual({ stub: 'awn', destination: `awn:${tag(FAKE_MAC)}` })
    expect(fetchDestination('https://api.weather.gov/points/1,2')).toEqual({ stub: 'fetch', destination: 'fetch:api.weather.gov' })
    const rec = makeRecorder()
    const target = { fetch: () => { throw new Error('the real fetch ran') } }
    restore = installFetchGuard(rec, target)
    const res = await target.fetch('https://graph.facebook.com/v21.0/999/photos?access_token=SECRET', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(rec.calls).toEqual([{ stub: 'graph', destination: 'graph:999/photos', method: 'POST', via: 'global-fetch' }])
    expect(JSON.stringify(rec.calls)).not.toContain('SECRET')
  })
})

describe('console capture', () => {
  it('keeps every line and parses the JSON ones', () => {
    const sink = []
    const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
    const restore = captureConsole(sink, { target })
    target.log(JSON.stringify({ msg: 'space-wx', space: 's1' }))
    target.warn('plain %s', 'text')
    restore()
    expect(sink.map((c) => c.json && c.json.msg)).toEqual(['space-wx', null])
    expect(sink[1]).toMatchObject({ level: 'warn', line: 'plain text' })
    expect(parseJsonLine('{bad')).toBeNull()
  })
})

function fakeTree(body) {
  const tree = mkdtempSync(path.join(os.tmpdir(), 'space-harness-tree-'))
  mkdirSync(path.join(tree, 'lambda', 'daily-plan'), { recursive: true })
  writeFileSync(path.join(tree, 'lambda', 'daily-plan', 'handler.js'), body)
  return tree
}

const HANDLER = (label) => `
module.exports = { async run(o) {
  if (o.dryRun !== false) throw new Error('arm must be non-dry');
  await o.pg.query('select 1');
  console.log(JSON.stringify({ msg: 'space-wx', space: '${label}' }));
  await o.fetchNWS(42.5, -72.7);
  await o.publishAlert({ topic: 'frost', subject: 'frost ${label}', message: 'm' });
  await fetch('https://graph.facebook.com/v21.0/77/feed?access_token=T');
  return { rows: 1, plans: [{ user_id: 'u', space_id: 's', plan: { counts: { water: 1 } } }] };
} };`

describe('runArm', () => {
  const pool = () => ({ queries: 0, async query() { this.queries += 1; return { rows: [] } }, async end() {} })

  it('runs each tree\'s OWN handler.js non-dry and records console and destinations', async () => {
    const base = fakeTree(HANDLER('base'))
    const cand = fakeTree(HANDLER('candidate'))
    const fetchBefore = globalThis.fetch
    const a = await runArm({ tree: base, dsn: 'x', today: '2026-10-16', fixture, poolFactory: pool })
    const b = await runArm({ tree: cand, dsn: 'x', today: '2026-10-16', fixture, poolFactory: pool })
    expect(globalThis.fetch).toBe(fetchBefore)
    expect(a.error).toBeNull()
    expect(a.handler_path).toBe(path.join(base, 'lambda', 'daily-plan', 'handler.js'))
    expect(a.handler_sha256).not.toBe(b.handler_sha256)
    expect(a.console.map((c) => c.json.space)).toEqual(['base'])
    expect(b.console.map((c) => c.json.space)).toEqual(['candidate'])
    expect(b.calls.map((c) => [c.stub, c.destination])).toEqual([
      ['fetchNWS', 'grid:42.50,-72.70'], ['publishAlert', 'sns:frost'], ['graph', 'graph:77/feed']])
    expect(b.result).toEqual({ rows: 1, plans: [{ user_id: 'u', space_id: 's', counts: { water: 1 } }] })
  })

  it('writes the run nonce and the names (never values) of its environment', async () => {
    const r = await runArm({ tree: fakeTree(HANDLER('n')), dsn: 'x', today: '2026-10-16', fixture, poolFactory: pool, nonce: 'run-1-a' })
    expect(r.nonce).toBe('run-1-a')
    expect(r.env_keys).toEqual(Object.keys(process.env).sort())
  })

  // Reserved names and TEST-NET addresses only: even a run without the guard reaches nothing real.
  it('refuses and records any connection but its own database: https, http, net, a second pg client', async () => {
    const tree = fakeTree(`
const https = require('node:https'), http = require('node:http'), net = require('node:net')
module.exports = { async run(o) {
  const tries = [
    () => https.request('https://sns.aws.example/').end(),
    () => http.get('http://192.0.2.1/latest/meta-data/'),
    () => net.connect(5432, 'ep-somewhere.neon.example'),
    () => net.connect({ host: '192.0.2.2', port: 443 }),
  ]
  const errs = []
  for (const t of tries) { try { t() } catch (e) { errs.push(e.message) } }
  console.log(JSON.stringify({ msg: 'tries', errs }))
  const own = net.connect(1, '127.0.0.1'); own.on('error', () => {}); own.destroy()
  throw new Error(errs[0])
} }`)
    const before = net.Socket.prototype.connect
    const r = await runArm({ tree, dsn: 'postgresql://u@127.0.0.1:1/d', today: '2026-10-16', fixture, poolFactory: pool, localPg: true })
    expect(net.Socket.prototype.connect).toBe(before)
    expect(r.calls.filter((c) => c.stub === 'net').map((c) => c.destination)).toEqual([
      'net:sns.aws.example:443', 'net:192.0.2.1:80',
      'net:ep-somewhere.neon.example:5432', 'net:192.0.2.2:443'])
    expect(r.console[0].json.errs).toHaveLength(4)
    expect(r.error).toMatch(/network refused/)
  })

  it('records a run() failure instead of throwing', async () => {
    const tree = fakeTree('module.exports = { async run() { throw new Error("frost publish failed") } }')
    const r = await runArm({ tree, dsn: 'x', today: '2026-10-16', fixture, poolFactory: pool })
    expect(r.error).toMatch(/frost publish failed/)
    expect(r.result).toBeNull()
  })

  it('without the Lambda driver, says how to install it', async () => {
    const tree = fakeTree(HANDLER('x'))
    const r = await runArm({ tree, dsn: 'postgresql://u@127.0.0.1:1/d', today: '2026-10-16', fixture })
    expect(r.error).toMatch(/npm install --prefix/)
  })
})

describe('local WebSocket proxy (offline only)', () => {
  it('forwards bytes to its one allowed address and refuses any other', async () => {
    const echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))))
    await new Promise((r) => echo.listen(0, '127.0.0.1', r))
    const port = echo.address().port
    const proxy = await startLocalWsProxy(WebSocketServer, '127.0.0.1', String(port))
    try {
      const got = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1?address=127.0.0.1:${port}`)
        ws.on('open', () => ws.send(Buffer.from('ping')))
        ws.on('message', (d) => { resolve(String(d)); ws.close() })
        ws.on('error', reject)
      })
      expect(got).toBe('echo:ping')
      const code = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1?address=10.0.0.1:5432`)
        ws.on('close', (c) => resolve(c))
        ws.on('error', () => {})
      })
      expect(code).toBe(1008)
    } finally {
      await proxy.close()
      echo.close()
    }
  })
})
