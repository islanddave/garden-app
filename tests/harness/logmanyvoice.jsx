// V5-VOICECARE-001 — real-browser look at Log many's voice path at Dave's geometry.
//
// jsdom proves the flow (src/__tests__/LogManyVoiceCare.test.jsx); it cannot show whether the mic is on
// the first screen, whether the read-back and the unticked skips are readable at 390px, or whether the
// confirm button sits in the thumb zone. That is what this entry is for. Open it through the iframe
// host so the layout viewport is really 390 wide:
//
//   npx vite --config tests/harness/vite.harness.config.mjs
//   → http://localhost:5311/tests/harness/viewport.html?vw=390&vh=844&page=logmanyvoice.html
//
// TWO STUBS, both confined to this file (the voiceharvest.jsx pattern):
//   * `fetch` — the far side of the wire, backed by the SAME frozen 2026-09-23 snapshot the page test
//     uses (voiceCare.fixture.js: 244 plantings, the live 21-node location tree), so the read-back here
//     is the one Dave would get. The page runs its real api.js path; only the server is faked.
//   * `SpeechRecognition` — the shared fake recogniser, DRIVEN from `window.__vc` (say / end / tap),
//     so every state (read-back, refusal, cancel) is reachable by a script or by hand.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import LogMany from '../../src/pages/LogMany.jsx'
import { FakeSpeechRecognition } from '../../src/__tests__/helpers/fakeSpeechRecognition.js'
import { U, LOCATIONS, byName, dryRunResponse } from '../../src/__tests__/voiceCare.fixture.js'
import { looseKey } from '../../src/lib/comboboxInput.js'

const LOCATIONS_RES = {
  locations: LOCATIONS.map(({ id, name, level, parent_id }, i) => ({ id, name, level, parent_id, sort_order: i })),
  locations_with_path: LOCATIONS.map(({ id, full_path, level }) => ({ id, full_path, level, is_active: true })),
}
const PICKER = U.map(({ crop_aliases: _drop, ...p }) => ({
  ...p, archived_at: null, variety_ref: p.variety_ref && { ...p.variety_ref, default_unit: null },
}))
const CROP_TYPES = [...new Map(U.filter((p) => p.variety_ref?.crop_type_slug).map((p) => [p.variety_ref.crop_type_slug, {
  slug: p.variety_ref.crop_type_slug, display_name: p.variety_ref.crop_type_slug, category: 'vegetable',
  search_aliases: p.crop_aliases?.length ? p.crop_aliases.join(', ') : null,
}])).values()]
const ALIASES = [['cucumber one', 'Suyo Long'], ['studio long', 'Suyo Long'], ["damn i'll see you", 'Cucamelon'],
  ['squash', 'Zephyr Squash'], ['orange', 'Tender Sweet Orange']]
  .map(([heard, name]) => ({ heard_key: looseKey(heard), heard_text: heard, variety_id: byName(name).variety_ref.id, hit_count: 0, last_used_at: null }))
// "All active" for the form underneath: every zone's live set.
const ALL_LIVE = LOCATIONS.filter((l) => l.level === 0).flatMap((z) => dryRunResponse(z.id).plantings)

const writes = []
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body })
window.fetch = async (url, opts = {}) => {
  const u = String(url)
  const path = u.slice(u.indexOf('/api/'))
  if (path === '/api/projects') return reply(200, [])
  if (path === '/api/locations') return reply(200, LOCATIONS_RES)
  if (path.startsWith('/api/plants?view=picker')) return reply(200, { plants: PICKER })
  if (path === '/api/varieties/crop-types') return reply(200, CROP_TYPES)
  if (path === '/api/varieties/voice-aliases') return reply(200, { aliases: ALIASES })
  if (path === '/api/events/batch' && opts.method === 'POST') {
    const body = JSON.parse(opts.body)
    if (body.dry_run) {
      if (body.scope?.type === 'space') return reply(200, dryRunResponse(body.scope.location_id))
      return reply(200, { count: ALL_LIVE.length, capped: false, plantings: ALL_LIVE })
    }
    writes.push(body)
    return reply(200, { batch_id: `b-harness-${writes.length}`, count: body.scope.plant_ids.length, event_ids: [] })
  }
  if (path.startsWith('/api/events/batch/') && opts.method === 'DELETE') return reply(200, { undone: true })
  return reply(404, { error: 'harness: no stub for ' + path })
}

window.SpeechRecognition = FakeSpeechRecognition
window.webkitSpeechRecognition = FakeSpeechRecognition

const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)
const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } }
const latest = () => FakeSpeechRecognition.instances[FakeSpeechRecognition.instances.length - 1]
const badge = () => {
  const b = document.getElementById('vwbadge')
  const sw = document.documentElement.scrollWidth
  if (b) b.textContent = `vw ${window.innerWidth} · scrollW ${sw} · hscroll ${sw > window.innerWidth ? 'YES' : 'no'}`
}
setInterval(badge, 250)

window.__vc = {
  ready: () => !!byTestId('lmv-start'),
  tapMic: () => { byTestId('lmv-start')?.click(); return !!latest()?.started },
  // One utterance the way Chrome Android delivers it: a final, then the session ends.
  say: (text) => { const r = latest(); if (!r?.started) return false; r.deliverFinal(text); r.endSession(); return true },
  listening: () => !!latest()?.started,
  close: () => { byTestId('lmv-close')?.click() },
  openReview: () => {
    const f = byTestId('lmv-frame')
    const b = f && [...f.querySelectorAll('button')].find((x) => /^Review \d+ plantings/.test(x.textContent))
    b?.click()
    return !!b
  },
  // Scroll the frame's middle track so the named row is in view (and inside the review list).
  showRow: (name) => {
    const f = byTestId('lmv-frame')
    const row = f && [...f.querySelectorAll('[data-testid="sc-review-list"] button')].find((b) => b.textContent.replace(/^[✓○]\s*/, '') === name)
    if (!row) return null
    row.scrollIntoView({ block: 'center' })
    return { name, pressed: row.getAttribute('aria-pressed'), rect: rect(row) }
  },
  measure: () => {
    const f = byTestId('lmv-frame')
    const vis = (el) => (el ? el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }) : false)
    const conf = byTestId('lmv-confirm')
    return {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      start: rect(byTestId('lmv-start')),
      frame: rect(f),
      frameTracks: f ? [...f.children].map(rect) : null,
      readback: byTestId('lmv-readback')?.textContent ?? null,
      message: byTestId('lmv-message')?.textContent ?? null,
      status: byTestId('lmv-status')?.textContent ?? null,
      prompt: byTestId('lmv-prompt')?.textContent ?? null,
      confirm: conf ? { ...rect(conf), text: conf.textContent, visible: vis(conf) } : null,
      writes: writes.length,
    }
  },
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/log/many']}>
    <Routes>
      <Route path="/log/many" element={<LogMany />} />
    </Routes>
  </MemoryRouter>,
)
