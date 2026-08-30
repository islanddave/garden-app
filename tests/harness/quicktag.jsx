// V4-PHOTOBULK-001 S6 — the quick-tag carousel at Dave's geometry.
//
// WHY. Twice today a staged-photo surface passed every unit assertion and was unusable on a phone,
// because jsdom returns zero for getBoundingClientRect and rasterises nothing. This deck is
// full-bleed and its controls sit in a fixed bottom band, which is exactly the arrangement that
// fails: if the photo pane does not yield, the shortcut row and the Skip/Back pair go under the
// fold, and the surface built to make tagging fast becomes one that requires scrolling per photo.
//
// The questions this answers, none of which a vitest run can:
//   1. With SIX shortcuts (the cap) plus the picker button plus Skip/Back, is every control inside
//      the viewport at 390x844?
//   2. Does the photo pane actually shrink to make room, or does it push the band off?
//   3. Do six shortcut chips with real planting names wrap into a scannable block or a wall?
//   4. Is every control at or above the 44px tap floor?
import React from 'react'
import { createRoot } from 'react-dom/client'
import QuickTagCarousel from '../../src/components/photo/QuickTagCarousel.jsx'

// Real planting names from the live garden, long ones included — invented "Plant 1" labels would
// make the chip row look far tidier than it is. These are the shape the MRU actually holds.
const PLANTS = [
  { id: 'pl1', name: 'Bhut Jolokia #3', project_id: 'pr1' },
  { id: 'pl2', name: 'Sungold', project_id: 'pr2' },
  { id: 'pl3', name: 'Genovese Basil #7', project_id: 'pr1' },
  { id: 'pl4', name: 'Lacinato Kale', project_id: 'pr3' },
  { id: 'pl5', name: 'Wild Bergamot (north row)', project_id: 'pr3' },
  { id: 'pl6', name: 'Tie-Dye Tomato #2', project_id: 'pr2' },
  { id: 'pl7', name: 'Armageddon', project_id: 'pr1' },
]

const PHOTOS = Array.from({ length: 17 }, (_, i) => ({
  id: `ph${i + 1}`,
  storage_path: `s/${i + 1}.jpg`,
  created_at: `2026-08-29T${String(8 + Math.floor(i / 4)).padStart(2, '0')}:0${i % 4}:00Z`,
  intake_status: 'pending_tag',
  caption: null,
  // A real data URI so the pane paints something with genuine aspect ratio rather than collapsing
  // to zero height, which would make the layout look fine for the wrong reason.
  view_url: 'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="1200" height="1600" fill="#c9d6c2"/></svg>'
  ),
}))

// Every assignment resolves, so the deck advances and the MRU fills — the cap is what we came to see.
const apiFetch = async () => ({ ok: true })

createRoot(document.getElementById('root')).render(
  <QuickTagCarousel
    photos={PHOTOS}
    plants={PLANTS}
    seedTargets={['pl1', 'pl2', 'pl3', 'pl4', 'pl5', 'pl6', 'pl7']}
    apiFetch={apiFetch}
    onAssigned={() => {}}
    onClose={() => {}}
  />
)

window.__h = {
  // THE question: is the control band inside the viewport, and did the photo pane yield for it?
  bandFits() {
    const root = document.querySelector('[data-testid="quicktag-carousel"]')
    const band = root?.lastElementChild
    const photo = document.querySelector('[data-testid="qt-photo"], img')
    const skip = document.querySelector('[data-testid="quicktag-skip"]')
    const other = document.querySelector('[data-testid="quicktag-other"]')
    const r = (el) => (el ? el.getBoundingClientRect() : null)
    const sr = r(skip), or_ = r(other), pr = r(photo)
    return {
      viewport: { w: innerWidth, h: innerHeight },
      photoHeight: pr ? Math.round(pr.height) : null,
      skipBottom: sr ? Math.round(sr.bottom) : null,
      otherBottom: or_ ? Math.round(or_.bottom) : null,
      // The whole point: nothing may sit below the fold.
      skipBelowFold: sr ? sr.bottom > innerHeight + 0.5 : null,
      otherBelowFold: or_ ? or_.bottom > innerHeight + 0.5 : null,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    }
  },
  // 44px is the project's tap floor (T.tapMinHeight). A shortcut chip below it is a mis-tap on a
  // surface whose whole value is tapping quickly.
  tapTargets() {
    const sel = ['quicktag-shortcut', 'quicktag-other', 'quicktag-skip', 'quicktag-undo', 'quicktag-close']
    const out = {}
    for (const t of sel) {
      const els = [...document.querySelectorAll(`[data-testid="${t}"]`)]
      const hs = els.map(e => Math.round(e.getBoundingClientRect().height))
      out[t] = { count: els.length, heights: hs, under44: hs.filter(h => h < 44).length }
    }
    return out
  },
  shortcutRow() {
    const row = document.querySelector('[data-testid="quicktag-shortcuts"]')
    const chips = [...document.querySelectorAll('[data-testid="quicktag-shortcut"]')]
    return {
      chips: chips.length,
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      labels: chips.map(c => c.textContent),
      // How many visual rows did they wrap into?
      rows: new Set(chips.map(c => Math.round(c.getBoundingClientRect().top))).size,
    }
  },
}

setTimeout(() => {
  const f = window.__h.bandFits()
  const t = window.__h.tapTargets()
  const under = Object.values(t).reduce((n, v) => n + v.under44, 0)
  const bad = f.skipBelowFold || f.otherBelowFold || f.docScrollWidth > f.docClientWidth || under > 0
  const v = document.getElementById('verdict')
  v.style.background = bad ? '#b14a3c' : '#4a7c59'
  v.textContent = `quicktag · photo ${f.photoHeight}px · skip bottom ${f.skipBottom}/${f.viewport.h} · under-44 targets ${under} · ${f.docScrollWidth}/${f.docClientWidth}px ${bad ? 'PROBLEM' : 'ok'}`
}, 1200)
