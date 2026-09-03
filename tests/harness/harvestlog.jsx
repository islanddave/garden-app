// V5-HARVESTONEDOOR-001 — real-browser look at the COMBINED harvest page at Dave's geometry.
//
// WHY A NEW ENTRY RATHER THAN A `surface` ON main.jsx. main.jsx stubs auth and network for EventNew,
// but not SpeechRecognition, so the voice half would render its unsupported card and the one thing
// this page exists to check — that the two modes look like one surface — would be unmeasurable. It
// is also a file several concurrent lanes are editing; a new entry perturbs nobody.
//
// What only a real browser can answer here: whether the sticky selector bar and the surface beneath
// it read as ONE page rather than a strip bolted over two unrelated screens, whether the mode swap
// shifts anything that should have stayed put, and whether the weigh-in session's own chrome
// collides with the bar at 390px.
//
// THREE STUBS, all confined to this file: fetch (picker payload, projects, locations, the harvest
// POST), SpeechRecognition (absent in the harness browser), and the router — HarvestLog reads its
// mode from useSearchParams, so a MemoryRouter seeded from the real query string is what makes
// ?mode=manual reachable by hand.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import HarvestLog from '../../src/pages/HarvestLog.jsx'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import { P, BOTTOM_NAV_HEIGHT_PX } from '../../src/lib/constants.js'

const PLANTS = [
  { id: 'p1', name: 'Suyo Long', archived_at: null, variety_ref: { id: 'v1', name: 'Suyo Long', crop_type_slug: 'cucumber', default_unit: 'count' } },
  { id: 'p2', name: 'Marketmore 76', archived_at: null, variety_ref: { id: 'v2', name: 'Marketmore', crop_type_slug: 'cucumber', default_unit: 'count' } },
  { id: 'p3', name: 'Chinese Red Noodle', archived_at: null, variety_ref: { id: 'v3', name: 'Red Noodle', crop_type_slug: 'bean', default_unit: 'count' } },
  { id: 'p4', name: 'Pineapple Tomatillo', archived_at: null, variety_ref: { id: 'v4', name: 'Pineapple', crop_type_slug: 'tomatillo', default_unit: 'count' } },
  { id: 'p5', name: 'Armageddon F1', archived_at: null, variety_ref: { id: 'v5', name: 'Armageddon F1', crop_type_slug: 'pepper', default_unit: 'count' } },
  { id: 'p6', name: '1884', archived_at: null, variety_ref: { id: 'v6', name: '1884', crop_type_slug: 'tomato', default_unit: 'count' } },
]
const PROJECTS = [{ id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }]
const ALIASES = []

window.fetch = async (url, opts = {}) => {
  const u = String(url)
  const ok = (json) => ({ ok: true, status: 200, json: async () => json })
  if (u.includes('/api/varieties/voice-aliases')) {
    if (opts.method === 'POST') { const b = JSON.parse(opts.body); ALIASES.push(b); return ok(b) }
    return ok({ aliases: ALIASES })
  }
  if (u.includes('/api/varieties/crop-types')) return ok({ crop_types: [] })
  if (u.includes('/api/projects')) return ok(PROJECTS)
  if (u.includes('/api/locations')) return ok([])
  // A BARE ARRAY, which is what every other harness entry serves and what the real endpoint returns.
  // voiceharvest.jsx serves `{plants:[...]}` and gets away with it because VoiceHarvest unwraps
  // either shape (`r?.plants ?? r ?? []`); EventNew does not, and it threw
  // `(pickerCache.data ?? []).filter is not a function` the first time Manual mounted here. The
  // fixture, not the product, was wrong — but a page hosting BOTH surfaces has to serve the shape
  // the stricter one needs.
  if (u.includes('/api/plants')) return ok(PLANTS)
  if (u.includes('/api/events') && opts.method === 'POST') return ok({ eventId: `evt-${Math.round(performance.now())}` })
  return ok({})
}

// Only what VoiceHarvest uses: continuous finals plus an onend it re-arms from.
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

const PHRASES = ['Suyo Long', 'three count', '231 grams', 'next', 'rhubarb']

// __h.measure() reports what a screenshot cannot: whether the sticky bar actually stays at the top,
// and whether the two modes agree on where content starts. A bar that scrolls away, or a 20px jump
// between modes, is the "bolted together" failure this page exists to catch — and both are invisible
// in jsdom, where every rect is zero.
window.__h = {
  measure () {
    const root = document.querySelector('[data-testid="harvest-log"]')
    const bar = root?.children[0]
    const mode = document.querySelector('[data-testid="harvest-log-mode"]')
    const voice = document.querySelector('[data-testid="voice-harvest"]')
    const session = document.querySelector('[data-testid="harvest-session-lock"]')
    // THE SURFACE CONTAINER, not a mode-specific landmark. The first draft of this helper anchored
    // `body` on voice-harvest OR harvest-session-lock and reported gapUnderBar 0 for voice and 94
    // for manual — which reads as 94px of dead space under the bar in one mode and is FALSE. The
    // lock strip simply is not the first thing the session renders; the planting chooser is. Both
    // modes actually start flush at the bar. A measurement helper that answers a layout question
    // with the wrong anchor is worse than no helper, because it is believed.
    const body = root?.children[1]
    const rect = el => el ? el.getBoundingClientRect() : null
    const r = { bar: rect(bar), mode: rect(mode), body: rect(body) }
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      mounted: voice ? 'voice' : session ? 'manual' : 'neither',
      barTop: r.bar?.top ?? null,
      barBottom: r.bar?.bottom ?? null,
      barHeight: r.bar?.height ?? null,
      // The selector must be a real tap target. The app's own floor is 44px.
      modeHeight: r.mode?.height ?? null,
      modeRight: r.mode?.right ?? null,
      overflowsWidth: r.mode ? r.mode.right > window.innerWidth : null,
      bodyTop: r.body?.top ?? null,
      // The number that says "one page": how far the surface sits below the bar.
      gapUnderBar: (r.body && r.bar) ? Math.round(r.body.top - r.bar.bottom) : null,
    }
  },
}

function Harness () {
  const [, force] = useState(0)
  const search = location.search || ''
  const say = (p) => { HarnessSR.live?.deliver(p); setTimeout(() => force((n) => n + 1), 50) }
  return (
    <MemoryRouter initialEntries={[`/log/harvest${search}`]}>
      <ToastProvider>
        <Routes>
          <Route path="/log/harvest" element={<HarvestLog />} />
        </Routes>
        <div style={{ padding: 12, borderTop: '2px dashed #b7532a', marginTop: 16, paddingBottom: BOTTOM_NAV_HEIGHT_PX + 16 }}>
          <div style={{ fontSize: '0.75rem', color: '#b7532a', fontWeight: 700, marginBottom: 6 }}>
            HARNESS ONLY — speak for the mic (voice mode)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {PHRASES.map((p) => (
              <button key={p} type="button" onClick={() => say(p)}
                style={{ minHeight: 36, padding: '4px 10px', fontSize: '0.8rem', borderRadius: 6, border: `1px solid ${P.border}`, background: '#fff', cursor: 'pointer' }}>
                {p}
              </button>
            ))}
          </div>
        </div>
      </ToastProvider>
    </MemoryRouter>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
