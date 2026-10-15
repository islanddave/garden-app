// V5-TODAYREDESIGN-001 S7 — Layer 1's server copy: the client write path and the cross-device merge rule
// (plan-v2 §2.1, §8 S7 tests; README-BUILD.md of migrations/v5-todaysections-001).
//
// One fake server, applying the critter Lambda's rule: a today_sections PATCH must be ALONE, is merged PER
// TOP-LEVEL KEY onto what is stored (stored || incoming), and answers 409 while the column is missing. Devices
// are separate localStorage contents plus a fresh per-page-load memory in the prefs client (asDevice): what a
// second phone would have. The real notificationPrefsClient does the wire (fetch is the only stub).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'

const D0 = '2026-10-13'
const D = '2026-10-14'
const USER = 'user_2dave'
const KEY = `today-sections:${USER}`

let hook, client, wire
beforeAll(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_API_CRITTERS', 'https://critters.example/')
  client = await import('../lib/notificationPrefsClient.js')
  hook = await import('../hooks/useTodaySections.js')
  wire = await import('../lib/todayV2/sectionsWire.js')
})
afterAll(() => { vi.unstubAllEnvs() })

// ── the fake server ────────────────────────────────────────────────────────────────────────────────────
let server
const patches = () => server.log.filter((r) => r.method === 'PATCH').map((r) => r.body)
function resetServer(stored = null) {
  server = { stored, hasColumn: true, failNext: 0, log: [], hold: null, fromCache: false }
}
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
  headers: { get: (h) => headers[h] ?? null },
})
async function fakeFetch(url, init = {}) {
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(init.body) : null
  server.log.push({ method, url, body, keepalive: !!init.keepalive })
  if (server.hold) await server.hold()
  if (server.failNext > 0) { server.failNext--; throw new TypeError('Failed to fetch') }
  if (method === 'GET') {
    const out = { critter_visit: 'in_app_only' }
    if (server.hasColumn) out.today_sections = server.stored
    return reply(200, out, server.fromCache ? { 'X-From-Cache': '1' } : {})
  }
  if (body && body.today_sections != null) {
    if (Object.keys(body).length !== 1) return reply(400, { error: 'today_sections must be sent alone' })
    if (!server.hasColumn) return reply(409, { error: 'today_sections is not stored on this server yet' })
    server.stored = { ...(server.stored ?? {}), ...body.today_sections }
    return reply(200, { today_sections: server.stored })
  }
  return reply(200, {})
}

// ── devices ────────────────────────────────────────────────────────────────────────────────────────────
const storages = {}
let device = null
function asDevice(name) {
  cleanup()
  if (device) storages[device] = { ...localStorage }
  localStorage.clear()
  for (const [k, v] of Object.entries(storages[name] || {})) localStorage.setItem(k, v)
  client.__resetPrefsFlight()
  client.__resetSectionsSaves()
  device = name
}
const getToken = async () => 'tk'
const boot = () => client.fetchNotificationPrefs({ getToken })
const mount = (prefs) => renderHook((p) => hook.useTodaySections(p), { initialProps: { userId: USER, prefs, getToken } })
const mirror = () => JSON.parse(localStorage.getItem(KEY) || 'null')
const tap = async (r, section, entry) => { await act(async () => { r.result.current.remember(section, entry) }) }

beforeEach(() => {
  resetServer()
  for (const k of Object.keys(storages)) delete storages[k]
  device = null
  localStorage.clear()
  client.__resetPrefsFlight()
  client.__resetSectionsSaves()
  global.fetch = vi.fn(fakeFetch)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the write path — an explicit tap, sent alone', () => {
  it('a tap sends ONLY that section, alone, keepalive; the 200 clears it from dirty', async () => {
    const r = mount(null)
    await tap(r, 'harvest', { open: false, at: D })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    expect(patches()).toEqual([{ today_sections: { v: 1, harvest: { open: false, at: D } } }])
    expect(server.log.find((x) => x.method === 'PATCH').keepalive).toBe(true)
    expect(server.stored).toEqual({ v: 1, harvest: { open: false, at: D } })
    expect(mirror().s.harvest).toEqual({ open: false, at: D })
  })

  it('a mount with nothing dirty sends nothing — rendering, reading and resolving never write', async () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, s: { care: { open: true, at: D } }, dirty: [] }))
    const r = mount({ today_sections: { v: 1, harvest: { open: true, at: D } } })
    r.result.current.resolve('care')
    r.result.current.resolve('harvest')
    await act(async () => {})
    expect(patches()).toEqual([])
  })

  it('no token, no send: the entry waits on the device, dirty', async () => {
    const r = renderHook(() => hook.useTodaySections({ userId: USER, prefs: null }))
    await tap(r, 'putup', { open: true, at: D })
    expect(patches()).toEqual([])
    expect(mirror().dirty).toEqual(['putup'])
  })

  it('409 (column not there yet), a pre-S7 400 and a network failure all keep it dirty; the next mount sends it', async () => {
    server.hasColumn = false
    const r1 = mount(null)
    await tap(r1, 'harvest', { open: true, at: D })
    await waitFor(() => expect(patches()).toHaveLength(1))
    await act(async () => {})
    expect(mirror().dirty).toEqual(['harvest'])
    r1.unmount()

    server.failNext = 1                         // offline at the next visit start
    const r2 = mount(null)
    await waitFor(() => expect(patches()).toHaveLength(2))
    await act(async () => {})
    expect(mirror().dirty).toEqual(['harvest'])
    r2.unmount()

    server.hasColumn = true                     // the DDL lands
    mount(null)
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    expect(patches()).toHaveLength(3)
    expect(patches()[2]).toEqual({ today_sections: { v: 1, harvest: { open: true, at: D } } })
    expect(server.stored).toEqual({ v: 1, harvest: { open: true, at: D } })
  })

  it('one request at a time: taps made while one is on the wire go together next; a re-tapped key stays dirty for it', async () => {
    let release
    server.hold = () => new Promise((res) => { release = res })
    const r = mount(null)
    await tap(r, 'harvest', { open: true, at: D })
    await waitFor(() => expect(server.log).toHaveLength(1))
    await tap(r, 'putup', { open: true, at: D })
    await tap(r, 'harvest', { open: false, at: D })      // the same key again, while its first send is out
    expect(server.log).toHaveLength(1)                    // nothing more sent yet
    server.hold = null
    await act(async () => { release() })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    expect(patches()).toEqual([
      { today_sections: { v: 1, harvest: { open: true, at: D } } },
      { today_sections: { v: 1, harvest: { open: false, at: D }, putup: { open: true, at: D } } },
    ])
    expect(server.stored.harvest).toEqual({ open: false, at: D })
  })

  it('an entry the server would refuse is never put on the wire, and never holds the others back', async () => {
    localStorage.setItem(KEY, JSON.stringify({
      v: 1, s: { 'hh-bad key!': { open: true, at: D }, care: { open: false, at: D, ack: { r: 'small' } } }, dirty: ['hh-bad key!', 'care'],
    }))
    mount(null)
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ today_sections: { v: 1, care: { open: false, at: D, ack: { r: 'small' } } } })
    await waitFor(() => expect(mirror().dirty).toEqual(['hh-bad key!']))
  })

  it('a batched today_skipped is never sent together with it', async () => {
    const r = mount(null)
    await tap(r, 'care', { open: false, at: D, ack: { r: 'small' } })
    await client.saveTodaySkipped({ getToken, date: D, keys: ['water:abc'] })
    await tap(r, 'protect', { open: false, at: D, ack: { t: 'frost' } })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    const all = patches()
    expect(all.some((b) => b.today_skipped)).toBe(true)
    for (const b of all) {
      if (b.today_sections) expect(Object.keys(b)).toEqual(['today_sections'])
      if (b.today_skipped) expect(Object.keys(b)).toEqual(['today_skipped'])
    }
  })
})

describe('the read side — what a visit start sees', () => {
  it('a cached body (service worker, offline) is not adopted', async () => {
    server.stored = { v: 1, care: { open: true, at: D } }
    server.fromCache = true
    const prefs = await boot()
    expect(prefs.today_sections).toEqual({ v: 1, care: { open: true, at: D } })
    const r = mount(prefs)
    expect(r.result.current.resolve('care')).toBeNull()
  })

  it('after a confirmed tap, the next visit reads the tap — not the boot body held since before it', async () => {
    server.stored = { v: 1, harvest: { open: true, at: D0 } }
    const prefs = await boot()                           // PrefsProvider's one read, held for the session
    const r1 = mount(prefs)
    expect(r1.result.current.resolve('harvest')).toEqual({ open: true, at: D0 })
    await tap(r1, 'harvest', { open: false, at: D })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    r1.unmount()
    // The next visit, same held body. KILLING MUTATION: drop sectionPredatesSave from resolve — the boot body's
    // stale `open: true` then beats the now-clean mirror and the closed section springs back open.
    const r2 = mount(prefs)
    expect(r2.result.current.resolve('harvest')).toEqual({ open: false, at: D })
  })

  it('a body read AFTER the save is the server\'s again — another device\'s later tap wins over a clean mirror', async () => {
    const r1 = mount(await boot())
    await tap(r1, 'harvest', { open: false, at: D })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    r1.unmount()
    server.stored = { ...server.stored, harvest: { open: true, at: D } }   // another phone, later
    const fresh = await boot()                                             // e.g. the plan-day refresh
    const r2 = mount(fresh)
    expect(r2.result.current.resolve('harvest')).toEqual({ open: true, at: D })
  })

  it('without the column the GET has no today_sections key, and the device runs on its mirror', async () => {
    server.hasColumn = false
    localStorage.setItem(KEY, JSON.stringify({ v: 1, s: { resting: { open: true, at: D } }, dirty: [] }))
    const prefs = await boot()
    expect(prefs).not.toHaveProperty('today_sections')
    const r = mount(prefs)
    expect(r.result.current.resolve('resting')).toEqual({ open: true, at: D })
  })
})

describe('two devices, one server (plan-v2 §8 S7)', () => {
  it('A closes Harvest; B, booted earlier, opens Put-Up; a cold-booted C shows both', async () => {
    server.stored = { v: 1, harvest: { open: true, at: D0 } }

    asDevice('B')
    const bootB = await boot()                       // B boots first and holds this body

    asDevice('A')
    const a = mount(await boot())
    await tap(a, 'harvest', { open: false, at: D })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    expect(a.result.current.resolve('harvest')).toEqual({ open: false, at: D })

    asDevice('B')
    const b = mount(bootB)
    await tap(b, 'putup', { open: true, at: D })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    // B's own tap holds on B. B learns of A's close at its next read of the server, not mid-session.
    expect(b.result.current.resolve('putup')).toEqual({ open: true, at: D })
    expect(b.result.current.resolve('harvest')).toEqual({ open: true, at: D0 })

    // The merge kept both: B's PATCH carried putup only, so A's harvest survived it.
    expect(server.stored).toEqual({ v: 1, harvest: { open: false, at: D }, putup: { open: true, at: D } })

    asDevice('C')
    const c = mount(await boot())
    expect(c.result.current.resolve('harvest')).toEqual({ open: false, at: D })
    expect(c.result.current.resolve('putup')).toEqual({ open: true, at: D })
    expect(c.result.current.mirrorExists).toBe(false)   // C has tapped nothing: all of it came from the server
    expect(patches().every((p) => Object.keys(p.today_sections).length === 2)).toBe(true)   // v + one section each
  })

  it('same section on two devices: the later delivered PATCH wins (last write per section)', async () => {
    asDevice('A')
    const a = mount(await boot())
    await tap(a, 'care', { open: true, at: D })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    asDevice('B')
    const b = mount(await boot())
    expect(b.result.current.resolve('care')).toEqual({ open: true, at: D })
    await tap(b, 'care', { open: false, at: D, ack: { r: 'small' } })
    await waitFor(() => expect(mirror().dirty).toEqual([]))
    expect(server.stored.care).toEqual({ open: false, at: D, ack: { r: 'small' } })
  })
})

describe('sectionsWire — the pieces the sender is built from', () => {
  it('pendingBody: the dirty entries only, as {v:1, …}; nothing dirty is null', () => {
    const m = { s: { care: { open: true, at: D }, harvest: { open: false, at: D } }, dirty: ['harvest'] }
    expect(wire.pendingBody(m)).toEqual({ v: 1, harvest: { open: false, at: D } })
    expect(wire.pendingBody({ s: m.s, dirty: [] })).toBeNull()
    expect(wire.pendingBody(null)).toBeNull()
  })

  it('confirmedKeys: only keys whose entry is still what was sent', () => {
    const sent = { v: 1, harvest: { open: true, at: D }, putup: { open: true, at: D } }
    const now = { s: { harvest: { open: false, at: D }, putup: { open: true, at: D } }, dirty: ['harvest', 'putup'] }
    expect(wire.confirmedKeys(now, sent)).toEqual(['putup'])
    expect(wire.confirmedKeys(null, sent)).toEqual([])
  })
})
