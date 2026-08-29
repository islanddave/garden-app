// V4-PHOTOBULK-001 — real-browser look at the bulk upload surfaces, at Dave's geometry.
//
// WHY THIS ENTRY EXISTS. The vitest suite proves the staged strip renders N items, that the inbox
// route writes pending_tag, and that the Untagged chip carries a count. It cannot show any of the
// things that decide whether this is usable on a phone:
//   • jsdom returns zero for every getBoundingClientRect(), so "the target pickers are still
//     reachable under a 20-photo strip" is unfalsifiable there — and that is the exact regression
//     this design worried about, since the whole point of this form's ordering is that you choose
//     the target AFTER seeing the photo. A strip that pushes the pickers off screen defeats it.
//   • The strip wraps. Whether 20 tiles at 84px wrap into a reasonable block or a wall inside a
//     390px column is a layout question with no jsdom answer.
//   • The remove buttons are 20px inside an 84px tile. Whether that is tappable, and whether it
//     collides with its neighbour once wrapped, only a real browser can say.
//
// It renders the upload form in FOUR states side by side, because the interesting comparisons are
// between states rather than within one: the shipped single-photo look must be unchanged, and the
// batch states must not have eaten the form below them.
//
// The page self-fetches /api/projects, /api/locations/with-path and /api/photos through
// useApiFetch. Stubbed at the NETWORK layer so the REAL page and its REAL state machine run —
// mocking the page's own modules would measure the harness instead of the code.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import PhotoLibrary from '../../src/pages/PhotoLibrary.jsx'

const PROJECTS = [
  { id: 'proj-1', name: 'Peppers 2026', status: 'growing' },
  { id: 'proj-2', name: 'Tomatoes 2026', status: 'growing' },
]
const LOCATIONS = [
  { id: 'loc-1', full_path: 'Pasture Bag Area', is_active: true },
  // Worst-case label: the zone <select> must not blow the 390px column out.
  { id: 'loc-2', full_path: 'Legacy Pasture In-Ground Beds (north row)', is_active: true },
]

// Shaped from the live library rather than invented: most rows are event-attached (735 of 993 in
// prod), so the Untagged count has to pick a small pending set out of a large attached majority —
// which is also what makes the count worth rendering at all.
const PHOTOS = [
  ...Array.from({ length: 14 }, (_, i) => ({
    id: `att-${i}`, storage_path: `s/att-${i}.jpg`, created_at: '2026-08-29T12:00:00Z',
    event_id: 'evt-1', project_name: 'Peppers 2026',
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `pend-${i}`, storage_path: `s/pend-${i}.jpg`, created_at: '2026-08-29T12:00:00Z',
    intake_status: 'pending_tag',
  })),
]

const realFetch = window.fetch
window.fetch = (url, ...rest) => {
  const u = String(url)
  const json = (v) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  if (u.includes('/api/projects')) return json(PROJECTS)
  if (u.includes('/api/locations/with-path')) return json(LOCATIONS)
  if (u.includes('/api/photos')) return json(PHOTOS)
  return realFetch(url, ...rest)
}

// A real File with real bytes, so URL.createObjectURL yields something the browser will actually
// paint — a 1x1 PNG is enough to prove the tile geometry without shipping fixtures.
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0))
const mkFile = (name) => new File([PNG_1PX], name, { type: 'image/png' })

const CASES = [
  { key: 'empty',  label: '1 — form open, nothing staged (shipped baseline)', files: [] },
  { key: 'one',    label: '2 — ONE photo: must be the shipped 260px preview', files: ['bhut-jolokia-2026-08-29.jpg'] },
  { key: 'few',    label: '3 — FOUR photos: strip + "Add more"', files: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'] },
  { key: 'max',    label: '4 — TWENTY photos: the cap. Are the target pickers still reachable?',
    files: Array.from({ length: 20 }, (_, i) => `garden-walk-${String(i + 1).padStart(2, '0')}.jpg`) },
]

function Case({ label, files }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // Drive the REAL controls rather than seeding state: open the form, then fire a change on the
    // real file input. That exercises onStagedPick, which is where the cap and the append live.
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      const root = document.getElementById(`case-${label}`)
      const openBtn = [...(root?.querySelectorAll('button') ?? [])].find(b => b.textContent.includes('+ Upload'))
      openBtn?.click()
      setTimeout(() => {
        if (cancelled || !files.length) { setReady(true); return }
        const input = root?.querySelector('[data-testid="pl-staged-input"]')
        if (input) {
          const dt = new DataTransfer()
          for (const n of files) dt.items.add(mkFile(n))
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
        setTimeout(() => setReady(true), 60)
      }, 60)
    }, 60)
    return () => { cancelled = true; clearTimeout(t) }
  }, [label, files])

  return (
    <div id={`case-${label}`}>
      <div className="case-label">{label}{ready ? '' : ' · staging…'}</div>
      <MemoryRouter><PhotoLibrary /></MemoryRouter>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <>{CASES.map(c => <Case key={c.key} label={c.label} files={c.files} />)}</>
)

// __h — the measurements this entry exists to take. Same shape as the other entries: synchronous
// where it can be, and every answer is a number or a boolean, never a description.
window.__h = {
  // Are the target pickers still on screen under the strip? THE question for case 4.
  pickersReachable() {
    return [...document.querySelectorAll('[data-testid="photo-library-upload-form"]')].map((form, i) => {
      const selects = [...form.querySelectorAll('select')]
      const btn = form.querySelector('[data-testid="pl-staged-upload"]')
      const strip = form.querySelector('[data-testid="pl-staged-strip"]')
      const tiles = form.querySelectorAll('[data-testid="pl-staged-item"]')
      return {
        case: i + 1,
        tiles: tiles.length,
        stripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : null,
        // Distance from the top of the strip to the SEND button — the whole cost the strip imposes
        // on the step that follows it.
        stripToButton: strip && btn
          ? Math.round(btn.getBoundingClientRect().bottom - strip.getBoundingClientRect().top)
          : null,
        selectCount: selects.length,
        soloPreview: !!form.querySelector('[data-testid="pl-staged-preview"]'),
      }
    })
  },
  // Remove buttons are 20px in an 84px tile. Do any two overlap once the strip wraps?
  removeButtonGeometry() {
    const btns = [...document.querySelectorAll('[data-testid="pl-staged-remove"]')]
    const rects = btns.map(b => b.getBoundingClientRect())
    let minGap = Infinity
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j]
        const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right))
        const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom))
        minGap = Math.min(minGap, Math.hypot(dx, dy))
      }
    }
    return {
      count: btns.length,
      size: rects[0] ? { w: Math.round(rects[0].width), h: Math.round(rects[0].height) } : null,
      minGapPx: rects.length > 1 ? Math.round(minGap) : null,
    }
  },
  untaggedChip() {
    return [...document.querySelectorAll('[data-testid="pl-filter-untagged"]')].map(c => c.textContent)
  },
  // Nothing may scroll the PAGE sideways at 390px. A strip that overflows its column is the most
  // likely way this change breaks the layout.
  horizontalOverflow() {
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
  },
}

setTimeout(() => {
  const v = document.getElementById('verdict')
  const ov = window.__h.horizontalOverflow()
  const bad = ov.scrollWidth > ov.clientWidth
  v.style.background = bad ? '#b14a3c' : '#4a7c59'
  v.textContent = `photobulk harness ready · ${ov.scrollWidth}/${ov.clientWidth}px ${bad ? 'H-OVERFLOW' : 'no h-overflow'} · __h.pickersReachable() __h.removeButtonGeometry() __h.untaggedChip()`
}, 1200)
