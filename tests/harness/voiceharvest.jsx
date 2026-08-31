// V5-HARVESTVOICEFLOW-001 — real-browser look at the voice harvest screen at Dave's geometry.
//
// jsdom proves the flow: what it cannot show is whether the status banner, the three record slots,
// a disambiguation list and a growing session ledger all stay reachable on a 375px phone held in one
// hand, outdoors, with the Start/Stop button the thumb has to find. That is the whole question here.
//
// TWO STUBS, both confined to this file:
//   * `fetch` — serves the picker payload and accepts the harvest POST, so the page runs its real
//     code paths rather than its error card. No Clerk session exists in the harness.
//   * `SpeechRecognition` — absent in the harness browser, so without it the page would render its
//     unsupported state and nothing else. This one is DRIVEN BY BUTTONS below, which also makes the
//     failure states (no match, missing quantity, POST failure) reachable by hand instead of only in
//     a test file.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import VoiceHarvest from '../../src/pages/VoiceHarvest.jsx'

const PLANTS = [
  { id: 'p1', name: 'Suyo Long', archived_at: null, variety_ref: { id: 'v1', name: 'Suyo Long', crop_type_slug: 'cucumber', default_unit: 'count' } },
  { id: 'p2', name: 'Marketmore 76', archived_at: null, variety_ref: { id: 'v2', name: 'Marketmore', crop_type_slug: 'cucumber', default_unit: 'count' } },
  { id: 'p3', name: 'Chinese Red Noodle', archived_at: null, variety_ref: { id: 'v3', name: 'Red Noodle', crop_type_slug: 'bean', default_unit: 'count' } },
  { id: 'p4', name: 'Pineapple Tomatillo', archived_at: null, variety_ref: { id: 'v4', name: 'Pineapple', crop_type_slug: 'tomatillo', default_unit: 'count' } },
  { id: 'p5', name: 'Bitter Melon', archived_at: null, variety_ref: { id: 'v5', name: 'Bitter Melon', crop_type_slug: 'bitter_melon', default_unit: 'count' } },
  // A REAL planting of Dave's, named with digits. Spoken as words it is unreachable by any scorer
  // ("eighteen eighty four" ranks helichrysum 0.353 against it on the live data), so it is the case
  // the teach picker exists for — and the one that proves the learned layer does something fuzzy
  // cannot.
  { id: 'p6', name: '1884', archived_at: null, variety_ref: { id: 'v6', name: '1884', crop_type_slug: 'tomato', default_unit: 'count' } },
]

let failNextSave = false
// V5-VOICEALIAS-001 — the learned-mishearing store, in memory so a teach is observable by hand:
// teach a phrase, say it again, and it should resolve. Starts EMPTY so the first run exercises the
// unlearned path, which is the state every real session starts in.
const ALIASES = []
window.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.includes('/api/varieties/voice-aliases')) {
    if (opts.method === 'POST') {
      const b = JSON.parse(opts.body)
      const i = ALIASES.findIndex((a) => a.heard_key === b.heard_key)
      // Mirrors the server's ON CONFLICT DO UPDATE: re-teaching RETARGETS rather than accumulating.
      if (i >= 0) ALIASES[i] = { ...b, hit_count: 0 }; else ALIASES.push({ ...b, hit_count: 0 })
      return { ok: true, status: 200, json: async () => b }
    }
    return { ok: true, status: 200, json: async () => ({ aliases: ALIASES }) }
  }
  if (u.includes('/api/plants')) return { ok: true, status: 200, json: async () => ({ plants: PLANTS }) }
  if (u.includes('/api/events') && opts.method === 'POST') {
    if (failNextSave) { failNextSave = false; return { ok: false, status: 500, json: async () => ({ error: 'offline' }) } }
    return { ok: true, status: 200, json: async () => ({ eventId: `evt-${Math.round(performance.now())}` }) }
  }
  if (u.includes('/api/events') && opts.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => ({}) }
}

// A SpeechRecognition that only does what this page uses: continuous finals and an onend the page
// re-arms from. `deliver` pushes one final at the next index, which is the shape Chrome dispatches.
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
    // Chrome ends the session after every utterance; the page re-arms from onend, and a DATA final
    // commits on that boundary. Without this the page would look like it heard nothing.
    this.stop()
  }
}
window.SpeechRecognition = HarnessSR
window.webkitSpeechRecognition = HarnessSR

// "studio long" is the REAL transcript Chrome returns for "Suyo Long" on Dave's Android (2026-08-30)
// — it is here so the V5-VOICEFUZZYMATCH-001 rescue is reachable by hand rather than only in a test.
// "chinees red nodle" exercises the same rescue on a name whose damage is spread across two words.
//
// "eighteen eighty four" WAS the teach case — edit distance cannot reach a planting named 1884 (it
// ranks helichrysum 0.353 on the real data), so it fell through to the teach picker. Since
// BUG-VOICENUMWORD-001 it FOLDS to "1884" and resolves directly, announced as a rescue so the swap
// is visible. The teach picker is still reachable behind it: say "rhubarb" for a true miss, or teach
// this phrase deliberately and watch the learned layer take it back — learned still outranks the fold.
//
// "1884 two count" and "eighteen eighty four two count" ARE BUG-VOICENUMSUM-001. Both used to save
// silently and report success — 1886 count and 104 count respectively. classify() still refuses
// both, and parseNumber still cannot reach those numbers; what CHANGED (V5-VOICEONEBREATH-001) is
// that the refusal is no longer the end of the line. The refused sentence is offered to the planting
// vocabulary, which says the name is 1884 and the count is 2. Watch the banner: it reads back the
// split it chose, which is the only way a wrong choice is catchable before "next".
//
// "three" then "count" as two taps IS BUG-VOICECOUNTSPLIT-001 — the shape Chrome produces when it
// ends the session mid-phrase. `deliver()` stops the session after every utterance, so tapping them
// in sequence reproduces the defect exactly. Before the fix the "three" tap searched the plantings
// and the count was lost; now the pair rejoins and the banner says "heard in two parts".
//
// "two" alone is the DANGEROUS half of that defect, and it needs a real screen to see: on Dave's
// live data a stray bare number silently RESELECTED a different planting. Tap Suyo Long, then two —
// the crop slot must not change.
const PHRASES = ['cucumber', 'Suyo Long', 'studio long', 'chinees red nodle',
  'eighteen eighty four', 'three count', '231 grams', 'next', 'rhubarb', 'text', 'done',
  '1884 two count', 'eighteen eighty four two count',
  'three', 'count', 'two', 'Suyo Long two count 231 grams']

function Driver() {
  const [, force] = useState(0)
  const say = (p) => { HarnessSR.live?.deliver(p); setTimeout(() => force((n) => n + 1), 50) }
  return (
    <div style={{ padding: 12, borderTop: '2px dashed #b7532a', marginTop: 16 }}>
      <div style={{ fontSize: '0.75rem', color: '#b7532a', fontWeight: 700, marginBottom: 6 }}>
        HARNESS ONLY — speak for the mic
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {PHRASES.map((p) => (
          <button key={p} type="button" onClick={() => say(p)}
            style={{ minHeight: 36, padding: '4px 10px', fontSize: '0.8rem', borderRadius: 6, border: '1px solid #d4c9be', background: '#fff', cursor: 'pointer' }}>
            {p}
          </button>
        ))}
        <button type="button" onClick={() => { failNextSave = true }}
          style={{ minHeight: 36, padding: '4px 10px', fontSize: '0.8rem', borderRadius: 6, border: '1px solid #b7532a', background: '#fde8e0', cursor: 'pointer' }}>
          fail next save
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <>
    <VoiceHarvest />
    <Driver />
  </>,
)
