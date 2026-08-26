// BUG-TIERLESSPHOTOS-001 — real-browser payload measurement for the tier-less photo surfaces.
//
// jsdom never loads an image, so the vitest suite can prove which URL a surface ASKED for and can
// never prove how many bytes moved. This entry exists to answer only the byte question, in real
// Chrome, against fixtures sized to the MEASURED prod medians (2026-08-26, S3 garden-photos-prod
// joined to live Neon: original median 4,147,674 B, thumb median 176,963 B, 24.4x on the mean).
//
// EVERY PHOTO GETS A DISTINCT URL (?p=<n>), exactly as a presigned URL is distinct per photo, so
// the HTTP cache cannot collapse N photos into one request and flatter the result. The static
// server behind imgbase ignores the query and serves the same bytes.
//
// ?surface=today   -> CareNeeded, the post-login landing route (30px row thumbs)
// ?surface=growth  -> GrowthStrip, a planting's milestone strip (64px) + compare stage
// ?tier=none       -> omit the thumb URL from every fixture row. That is byte-for-byte what the
//                     pre-fix code requested (it read featured_photo_view_url / view_url
//                     unconditionally), so it is the honest BEFORE arm when run on this same build.
// ?miss=<n>        -> point the first n rows' thumb URLs at a 404 so the degrade is visible on
//                     screen and in the request log, not merely asserted in jsdom.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CareNeeded from '../../src/components/today/CareNeeded.jsx'
import GrowthStrip from '../../src/components/planting/GrowthStrip.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'

const qs = new URLSearchParams(location.search)
const SURFACE = qs.get('surface') || 'today'
const IMGBASE = qs.get('imgbase') || 'http://localhost:5321'
const WITH_THUMB = qs.get('tier') !== 'none'
const MISS = Number(qs.get('miss') || 0)
const COUNT = Number(qs.get('count') || 20)

const orig = (n) => `${IMGBASE}/orig.jpg?p=${n}`
// A missing thumbs/<key> object presigns fine and 404s on GET — the whole hazard. /missing/ is the
// static server's 404 path, so this reproduces it exactly rather than simulating it.
const thumb = (n) => (n < MISS ? `${IMGBASE}/missing/thumb.jpg?p=${n}` : `${IMGBASE}/thumb.jpg?p=${n}`)

const LOCATIONS = [{ id: 'loc-a', name: 'Pasture Bag Area', full_path: 'Pasture Bag Area' }]
const NAMES = ['Bhut Jolokia', 'Sungold', 'Genovese Basil', 'Lacinato Kale', 'Wild Bergamot']

const WATER = Array.from({ length: COUNT }, (_, i) => ({
  id: 'pl-' + i, name: NAMES[i % 5] + ' ' + (i + 1), crop: 'pepper',
  project: 'Peppers 2026', project_id: 'pr-a',
  overdue_by: [0, 1, 2, 4, 11][i % 5], in_ground: false, interval: 3, days_since: 6,
}))

const PLANTS = WATER.map((w, i) => ({
  id: w.id, location_id: 'loc-a', container_type: 'pot',
  featured_photo_id: 'ph-' + i,
  featured_photo_view_url: orig(i),
  ...(WITH_THUMB ? { featured_photo_thumb_url: thumb(i) } : {}),
}))

const PLAN = {
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10, today_observed_in: 0 },
  rain_skipped: [], water_due: WATER,
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
}

// The shape GET /api/photos?attachedTo= returns, oldest-first as PlantingDetail hands it over.
const GROWTH = Array.from({ length: COUNT }, (_, i) => ({
  id: 'ph-' + i, caption: null, created_at: `2026-0${(i % 8) + 1}-1${i % 9}`,
  view_url: orig(i),
  ...(WITH_THUMB ? { thumb_url: thumb(i) } : {}),
}))

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = []
  if (path === '/api/plants') body = PLANTS
  else if (path === '/api/locations/with-path') body = LOCATIONS
  await new Promise(r => setTimeout(r, 30))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message }, true)
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <MemoryRouter initialEntries={['/today']}>
      {SURFACE === 'growth' ? <GrowthStrip photos={GROWTH} /> : <CareNeeded plan={PLAN} />}
    </MemoryRouter>
  </AuthProvider>
)

// Burned into the page so the screenshot evidences itself rather than being trusted.
window.__h = {
  surface: SURFACE,
  error: () => firstError,
  // An <img> is only counted as SHOWING a photo if it has a src, is laid out, and DECODED — a
  // broken image still has a box and a src, so naturalWidth is the only honest test of "a photo
  // appeared". This is the assertion that separates "smaller" from "blank".
  imgs() {
    return [...document.querySelectorAll('#root img')].map(el => {
      const r = el.getBoundingClientRect()
      const u = el.getAttribute('src') || ''
      return {
        w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100,
        tier: u.includes('/thumb.jpg') ? 'THUMB' : u.includes('/orig.jpg') ? 'ORIG' : 'other',
        missing: u.includes('/missing/'),
        naturalW: el.naturalWidth, naturalH: el.naturalHeight,
        broken: el.complete && el.naturalWidth === 0,
      }
    })
  },
  ready() {
    const n = window.__h.imgs()
    return n.length > 0 && n.every(i => i.naturalW > 0 || i.broken)
  },
}

const paint = (ticks = 0) => {
  const el = document.getElementById('verdict')
  const n = window.__h.imgs()
  const broken = n.filter(i => i.broken).length
  const byTier = n.reduce((a, i) => { a[i.tier] = (a[i.tier] || 0) + 1; return a }, {})
  el.style.background = firstError || broken ? '#a4161a' : '#2d6a4f'
  el.textContent = firstError
    ? 'ERROR: ' + firstError
    : `${SURFACE} @${innerWidth}px · ${n.length} img · ${Object.entries(byTier).map(([k, v]) => k + ':' + v).join(' ')} · broken:${broken}`
  if (ticks < 20) setTimeout(() => paint(ticks + 1), 250)
}
setTimeout(paint, 250)
