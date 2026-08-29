// V4-PHOTOBULK-001 — the OTHER two multi-attach strips, at Dave's geometry.
//
// The photobulk entry measured PhotoLibrary and found the defect that motivated this one: a staged
// strip that passes every unit assertion can still push the control it depends on off screen, and
// jsdom cannot see it. Two surfaces shipped with the same shape and were never looked at:
//
//   PLANTING CARD — <PhotoUpload multiple showPreview={false}> inside a card FOOTER. The tightest
//   space of the three. The compact (filename, no thumbnail) rendering exists precisely because
//   88px tiles would wreck this card, and that judgement has not been checked against a real box.
//   The question: does a 10-file strip turn the card into a column of filenames taller than the
//   card, and does the Garden list stay usable when several cards are staging at once?
//
//   LOG EVENT — EventNew's own 96px tiles plus its "Add more" affordance. The question is the same
//   one PhotoLibrary failed: with the cap staged, is the SAVE button still reachable?
//
// Both render at 390x844 with real Files, driving the real controls rather than seeding state.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import PlantingTile from '../../src/components/PlantingTile.jsx'
// FavoriteToggle inside the card calls useAuth, so the card cannot mount bare — same wrapper the
// careneeded entry uses. Clerk itself is already aliased to the stub by the harness vite config.
import { AuthProvider } from '../../src/context/AuthContext.jsx'

const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0))
const mkFile = (name) => new File([PNG_1PX], name, { type: 'image/png' })

// Filenames shaped like a phone's, because the compact strip renders the NAME and a phone's names
// are long. An invented "a.jpg" would make this surface look far better than it is.
const PHONE_NAMES = (n) => Array.from({ length: n }, (_, i) => `PXL_20260829_1${String(40000 + i * 137).padStart(5, '0')}.jpg`)

// The upload hook is stubbed to hang, so the strip stays in its 'uploading'/'staged' state long
// enough to measure. Measuring the settled state would miss the tallest moment.
const realFetch = window.fetch
window.fetch = (url, ...rest) => {
  const u = String(url)
  if (u.includes('/api/photos/upload-url')) return new Promise(() => {})
  if (u.includes('/api/')) return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  return realFetch(url, ...rest)
}

const PLANTING = {
  id: 'pl9', project_id: 'pr3', name: 'Bhut Jolokia', status: 'growing', quantity: 1,
  featured_photo_view_url: null,
}

function TileCase({ label, count }) {
  useEffect(() => {
    const t = setTimeout(() => {
      const input = document.getElementById('plant-list-photo-pl9')
      if (!input || !count) return
      const dt = new DataTransfer()
      for (const n of PHONE_NAMES(count)) dt.items.add(mkFile(n))
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, 120)
    return () => clearTimeout(t)
  }, [count])
  return (
    <div>
      <div className="case-label">{label}</div>
      {/* A sibling card, so "does a staging card shove its neighbour around" is visible rather
          than inferred — the Garden list renders these in a column. */}
      <AuthProvider>
        <MemoryRouter>
          <div id="tile-under-test"><PlantingTile planting={PLANTING} /></div>
          <div id="tile-neighbour"><PlantingTile planting={{ ...PLANTING, id: 'pl10', name: 'Sungold' }} /></div>
        </MemoryRouter>
      </AuthProvider>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <TileCase label="Planting card · 10 staged files (the PhotoUpload cap)" count={10} />
)

window.__h = {
  // The card is the box under pressure. Its height with a full strip, against the viewport, is the
  // whole question — plus whether the neighbour card got pushed off screen entirely.
  cardGeometry() {
    const card = document.getElementById('tile-under-test')?.firstElementChild
    const neigh = document.getElementById('tile-neighbour')?.firstElementChild
    const strip = document.querySelector('[data-testid="photo-upload-staged"]')
    const items = document.querySelectorAll('[data-testid="photo-upload-staged-item"]')
    const r = (el) => el ? el.getBoundingClientRect() : null
    const cr = r(card), nr = r(neigh), sr = r(strip)
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      cardHeight: cr ? Math.round(cr.height) : null,
      stripHeight: sr ? Math.round(sr.height) : null,
      tiles: items.length,
      // A neighbour whose TOP is past the fold means one staging card ate the whole screen.
      neighbourTop: nr ? Math.round(nr.top) : null,
      neighbourOffScreen: nr ? nr.top > window.innerHeight : null,
      // Nothing may scroll the page sideways: the compact strip renders unbroken filenames.
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    }
  },
  // The compact strip renders filenames with wordBreak:'break-all'. Do any of them overflow their
  // 100%-width li, which is what would push the card sideways?
  filenameOverflow() {
    const items = [...document.querySelectorAll('[data-testid="photo-upload-staged-item"]')]
    return items.map(li => {
      const span = li.querySelector('span')
      return span ? { scroll: span.scrollWidth, client: li.clientWidth, overflows: span.scrollWidth > li.clientWidth } : null
    }).filter(Boolean)
  },
}

setTimeout(() => {
  const g = window.__h.cardGeometry()
  const v = document.getElementById('verdict')
  const bad = g.docScrollWidth > g.docClientWidth || g.neighbourOffScreen
  v.style.background = bad ? '#b14a3c' : '#4a7c59'
  v.textContent = `photostrips · card ${g.cardHeight}px · strip ${g.stripHeight}px · ${g.tiles} tiles · neighbour top ${g.neighbourTop} · ${g.docScrollWidth}/${g.docClientWidth}px${bad ? ' PROBLEM' : ' ok'}`
}, 1400)
