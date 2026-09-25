// BUG-VOICEALIASHITCOUNT-001 — does a harvest saved through a TAUGHT name send its use count? Real Chrome.
//
// After 13 voice harvests on prod (2026-09-25), every voice_alias row still read hit_count 0. The unit
// suites prove the page in jsdom with a mocked apiFetch; this entry asks the same question of the real
// browser: the REAL /log/harvest page (HarvestLog -> VoiceHarvest embedded, the door Dave logs from),
// its real useApiFetch/apiFetch, and only the far side of the wire faked.
//
// DATA, both real: the 244 planting names of voiceHarvest.vocabulary.fixture.js (prod ?view=picker,
// 2026-09-23, synthetic ids), and Dave's 33 taught names exactly as prod stores them (public.voice_alias,
// 2026-09-25: the stored heard_key, the heard_text, the variety it names). A taught name only counts
// when the alias is what chose the planting, so the real vocabulary decides which names can count at
// all ("tomatillo" is three plantings' crop type; "cucumber one" is nobody's name).
//
// TWO STUBS, both confined to this file:
//   * window.fetch — records every request as the page made it (the method string as passed, the path,
//     whether a bearer token rode along, the JSON body) and answers the way the Lambdas do. The PATCH is
//     answered like lambda/varieties answers it — the same validation, then +1 only on rows whose
//     heard_key AND variety_id match — so __h.aliases() reads the hit_count the server would now hold.
//   * SpeechRecognition — one final per session, ended at once, as Chrome delivers them; __h.say() speaks.
//
// Query params: aliasDelayMs=<ms> (the taught-name list answers late), aliasFail=1 (it fails),
// failSaves=<n> (the first n harvest POSTs answer 500), holdSaves=1 (each harvest POST waits for
// __h.releaseSave()). Driven by scripts/layout-gate/alias-use-wire.mjs.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import HarvestLog from '../../src/pages/HarvestLog.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { VOCAB } from '../../src/__tests__/voiceHarvest.vocabulary.fixture.js'

const params = new URLSearchParams(location.search)
const ALIAS_DELAY_MS = Number(params.get('aliasDelayMs') || 0)
const ALIAS_FAIL = params.get('aliasFail') === '1'
let failSaves = Number(params.get('failSaves') || 0)
const HOLD_SAVES = params.get('holdSaves') === '1'

// [stored heard_key, heard_text, variety display name] — every row of prod public.voice_alias, 2026-09-25.
const TAUGHT = [
  ['squash', 'squash', 'Zephyr'],
  ['brocoli', 'broccoli', 'Broccoli'],
  ['damnilseyou', "damn i'll see you", 'Cucamelon'],
  ['celebrity', 'celebrity', 'Celebrity'],
  ['pineapletomatilos', 'pineapple tomatillos', 'Pineapple Tomatillo'],
  ['marzano', 'marzano', 'San Marzano Roma'],
  ['speckledroman', 'speckled roman', 'Speckled Roman'],
  ['superswet', 'super sweet', 'Super Sweet 100'],
  ['purpletomatilo', 'purple tomatillo', 'Purple blush'],
  ['superswet100', 'super sweet 100', 'Super Sweet 100'],
  ['cuting', 'cutting', 'Unknown'],
  ['honeydew', 'honeydew', 'Green Flesh'],
  ['rescue', 'rescue', 'Cherry'],
  ['gren', 'green', 'Cherokee Green'],
  ['stripedroman', 'striped roman', 'Speckled Roman'],
  ['strikeroman', 'strike roman', 'Speckled Roman'],
  ['basil', 'basil', "Ocimum basilicum 'Sweet'"],
  ['cherokegren', 'cherokee green', 'Cherokee Green'],
  ['orange', 'orange', 'Tender Sweet Orange'],
  ['pineaple', 'pineapple', 'Pineapple Tomatillo'],
  ['cheroke', 'cherokee', 'Cherokee Green'],
  ['stupidchica', 'stupid chica', 'Stupice'],
  ['sethecoma', 'set the comma', 'Kori Sitakame'],
  ['gumbal', 'gumball', 'Gong Bao (Kung Pao)'],
  ['cayene', 'cayenne', 'Cayenne Blend'],
  ['moskovich', 'moskovich', 'Moskvich Heirloom'],
  ['rush', 'rush', 'Gold Rush'],
  ['cucumberone', 'cucumber one', 'Suyo Long'],
  ['cantaloupe', 'cantaloupe', 'Cantaloupe'],
  ['grencheroke', 'green cherokee', 'Cherokee Green'],
  ['colblush', 'cool blush', 'Purple blush'],
  ['tomatilo', 'tomatillo', 'Pineapple Tomatillo'],
  ['tatley', 'tatley', 'Sweet Sivri'],
]
const varietyIdOf = (name) => VOCAB.find((p) => p.variety_ref?.name === name)?.variety_ref.id ?? null
const ALIASES = TAUGHT.map(([heard_key, heard_text, variety]) => ({
  heard_key, heard_text, variety_id: varietyIdOf(variety), variety, hit_count: 0, last_used_at: null,
}))
const UNMAPPED = ALIASES.filter((a) => !a.variety_id).map((a) => a.heard_text)

// ?view=picker carries the crop-type SLUG only; the aliases arrive with /api/varieties/crop-types.
const PICKER = VOCAB.map(({ crop_aliases: _drop, ...row }) => row)
const CROP_TYPES = [...new Map(VOCAB.filter((p) => p.crop_aliases?.length)
  .map((p) => [p.variety_ref.crop_type_slug, { slug: p.variety_ref.crop_type_slug, search_aliases: p.crop_aliases.join(', ') }])).values()]

// lambda/varieties/index.js, the voice-aliases routes, mirrored: the checks that turn a bad body into a
// 400, and the WHERE that decides what a PATCH counts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const normalisedKey = (k) => k === k.toLowerCase() && !/[\s\p{P}]/u.test(k) && k.length >= 4 && k.length <= 120
const row = (a) => ({ heard_key: a.heard_key, heard_text: a.heard_text, variety_id: a.variety_id, hit_count: a.hit_count, last_used_at: a.last_used_at })

function aliasPatch(body) {
  const used = Array.isArray(body?.used) ? body.used : null
  if (!used || used.length < 1 || used.length > 20) return [400, { error: 'used must list 1-20 { heard_key, variety_id }' }]
  for (const u of used) {
    if (!UUID.test(String(u?.variety_id ?? ''))) return [400, { error: 'variety_id must be a uuid' }]
    if (!normalisedKey(String(u?.heard_key ?? ''))) return [400, { error: 'heard_key must be a normalised 4-120 character key' }]
  }
  const pairs = new Set(used.map((u) => `${u.heard_key}|${u.variety_id}`))
  const hit = ALIASES.filter((a) => a.variety_id && pairs.has(`${a.heard_key}|${a.variety_id}`))
  for (const a of hit) { a.hit_count += 1; a.last_used_at = new Date().toISOString() }
  return [200, { counted: hit.length }]
}

function aliasTeach(body) {
  const key = String(body?.heard_key ?? '')
  const varietyId = String(body?.variety_id ?? '')
  if (!UUID.test(varietyId)) return [400, { error: 'variety_id must be a uuid' }]
  if (!normalisedKey(key)) return [400, { error: 'heard_key must be lowercase with no whitespace or punctuation' }]
  const was = ALIASES.find((a) => a.heard_key === key)
  if (was) {
    // ON CONFLICT: the tally stands only when the meaning did not change.
    if (was.variety_id !== varietyId) { was.hit_count = 0; was.last_used_at = null }
    Object.assign(was, { heard_text: String(body.heard_text), variety_id: varietyId })
    return [200, row(was)]
  }
  const added = { heard_key: key, heard_text: String(body.heard_text), variety_id: varietyId, variety: null, hit_count: 0, last_used_at: null }
  ALIASES.push(added)
  return [200, row(added)]
}

const REQS = []
const HELD = []
const served = { plants: 0, aliases: 0 }
let nextEvent = 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const parse = (s) => { try { return JSON.parse(s) } catch { return s } }

async function answer(path, method, body, signal) {
  if (path.startsWith('/api/varieties/voice-aliases')) {
    if (method === 'GET') {
      if (ALIAS_DELAY_MS) await sleep(ALIAS_DELAY_MS)
      served.aliases += 1
      return ALIAS_FAIL ? [500, { error: 'Internal Server Error' }] : [200, { aliases: ALIASES.filter((a) => a.variety_id).map(row) }]
    }
    if (method === 'POST') return aliasTeach(body)
    if (method === 'PATCH') return aliasPatch(body)
    return [405, { error: 'Method not allowed' }]
  }
  if (path.startsWith('/api/varieties/crop-types')) return [200, CROP_TYPES]
  if (path.startsWith('/api/plants')) { served.plants += 1; return [200, PICKER] }
  if (path === '/api/events' && method === 'POST') {
    if (HOLD_SAVES) {
      await new Promise((res, rej) => {
        HELD.push(res)
        signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    if (failSaves > 0) { failSaves -= 1; return [500, { error: 'Gateway Timeout' }] }
    const id = `00000000-0000-4000-a000-${String(nextEvent++).padStart(12, '0')}`
    return [201, { id, event_type: 'harvest', plant_id: body?.plant_id ?? null }]
  }
  if (path.startsWith('/api/events/') && method === 'DELETE') return [200, { ok: true }]
  if (path.startsWith('/api/projects') || path.startsWith('/api/locations')) return [200, []]
  return [200, {}]
}

window.fetch = async (input, init = {}) => {
  const path = String(typeof input === 'string' ? input : input?.url ?? '')
  const headers = new Headers(init.headers || {})
  // The method AS PASSED. fetch() upper-cases GET/POST/PUT/DELETE/HEAD/OPTIONS but NOT patch, so a
  // lower-case 'patch' would reach the Function URL's CORS check as-is — recorded raw so it would show.
  const rec = {
    at: Math.round(performance.now()), method: init.method ?? 'GET', path,
    bearer: /^Bearer \S+$/.test(headers.get('authorization') || ''), contentType: headers.get('content-type'),
    body: typeof init.body === 'string' ? parse(init.body) : null, status: null, answer: null,
  }
  REQS.push(rec)
  const [status, json] = await answer(path, String(rec.method).toUpperCase(), rec.body, init.signal)
  rec.status = status
  rec.answer = json
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
}

// One final per session, then the session ends, which is the shape Chrome dispatches and the one the
// page's commit rules are built on (a data final commits at the boundary; a save word waits a tick).
class HarnessSR {
  constructor() { this._results = []; this.started = false; HarnessSR.live = this }
  start() { this.started = true; this._results = []; this.onstart?.({}) }
  stop() { this.started = false; this.onend?.({}) }
  abort() { this.started = false; this.onend?.({}) }
  deliver(text) {
    const i = this._results.length
    const r = [{ transcript: text, confidence: 0.9 }]
    r.isFinal = true
    this._results[i] = r
    this.onresult?.({ resultIndex: i, results: this._results.slice() })
    this.stop()
  }
}
window.SpeechRecognition = HarnessSR
window.webkitSpeechRecognition = HarnessSR

const q = (sel) => document.querySelector(sel)
const text = (el) => (el?.textContent ?? '').trim()
const click = (el) => { if (!el) return false; el.click(); return true }

window.__h = {
  ready: () => !!q('[data-testid="voice-harvest-toggle"]') && served.plants > 0,
  served: () => ({ ...served }),
  vw: () => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState }),
  unmapped: () => UNMAPPED,
  start: () => {
    const b = q('[data-testid="voice-harvest-toggle"]')
    return text(b) === 'Start listening' ? click(b) : false
  },
  say: (t) => { if (!HarnessSR.live) return false; HarnessSR.live.deliver(t); return true },
  // A planting on the "Which one?" list, by its name as shown (the crop slug after " · " is ignored).
  tap: (name) => {
    const list = q('[data-testid="voice-harvest-candidates"]')
    const b = [...(list?.querySelectorAll('button') ?? [])].find((x) => text(x.firstChild) === name || text(x).split(' · ')[0] === name)
    return click(b)
  },
  undo: (i = 0) => click([...document.querySelectorAll('button[aria-label^="Undo "]')][i]),
  releaseSave: () => { const r = HELD.shift(); if (r) r(); return !!r },
  heldSaves: () => HELD.length,
  reqs: () => REQS.map((r) => ({ ...r })),
  aliases: () => ALIASES.filter((a) => a.hit_count || a.last_used_at).map(row),
  state: () => ({
    status: text(q('[data-testid="voice-harvest-status"]')),
    rows: [...document.querySelectorAll('[data-testid="voice-harvest-row"]')].map(text),
    misses: [...document.querySelectorAll('[data-testid="voice-harvest-miss"]')].map(text),
    candidates: [...document.querySelectorAll('[data-testid="voice-harvest-candidates"] button')].map((b) => text(b).split(' · ')[0]),
    teach: !!q('[data-testid="voice-harvest-teach"]'),
  }),
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/log/harvest']}>
    <ToastProvider>
      <Routes>
        <Route path="/log/harvest" element={<HarvestLog />} />
      </Routes>
    </ToastProvider>
  </MemoryRouter>,
)
