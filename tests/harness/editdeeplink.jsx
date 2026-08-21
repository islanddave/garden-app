// BUG-EDITDEEPLINKRACE-001 — real-browser reproduction of the /garden?edit=<id> deep link.
//
// Separate entry from main.jsx (which mounts EventNew) so nothing in the layout harness moves.
// Mounts the REAL Garden under the REAL react-router at /garden?edit=plant-2 and reports, in the
// page itself, whether the PlantingEditor opened. Pair it with HARNESS_BASELINE_SHA to serve
// src/** from a git object — baselinePlugin only rewrites src/**, so THIS file is the working
// tree's in both runs and the two runs differ only in the code under test:
//
//   HARNESS_BASELINE_SHA=8e2b821…  → prod v4.40.0's Garden.jsx  → expect NO EDITOR
//   (unset)                        → the fix                    → expect EDITOR OPEN
//
// The network stub adds real macrotask latency for the same reason main.jsx does: a synchronously
// resolved promise hides the ordering a round trip exposes. It is not needed to show the bug (the
// defect is timing-independent) but it makes the run faithful to Dave's phone.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import Garden from '../../src/pages/Garden.jsx'
import PlantingDetail from '../../src/pages/PlantingDetail.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
// PlantingDetail's FavoriteToggle uses the STRICT useAuth, which throws without this provider —
// an uncaught render error that empties #root and reads as a false 'NO EDITOR'. The unit suite
// stubs FavoriteToggle instead; here the real provider runs on the harness's Clerk stub.
import { AuthProvider } from '../../src/context/AuthContext.jsx'

const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null, is_public: true }]
const PLANT = {
  id: 'plant-2', name: 'Krim Plant', project_id: 'proj-1', project_name: 'Spring 2026',
  quantity: 3, status: 'seedling', notes: 'wide-shape notes',
  variety: 'Black Krim', variety_id: 'var-1',
  variety_ref: { id: 'var-1', name: 'Black Krim', species: 'Solanum lycopersicum' },
}

const byIdGets = []
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = []
  if (path === '/api/projects') body = PROJECTS
  else if (path.startsWith('/api/plants?')) body = [PLANT]
  else if (path === '/api/plants/plant-2') { byIdGets.push(Date.now()); body = PLANT }
  await new Promise(r => setTimeout(r, 40))       // a plausible mobile round trip
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// An uncaught render error unmounts the whole tree, leaving an EMPTY #root and a verdict that
// reads "NO EDITOR" for a reason that has nothing to do with the editor. Capture it so the badge
// says so instead of quietly reporting a false negative.
let firstError = null
window.addEventListener('error', e => { firstError ??= e.message })
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

function Probe() {
  const location = useLocation()
  React.useEffect(() => { window.__search = location.search }, [location.search])
  return null
}

// ?surface=planting mounts the PlantingDetail fly-up path (V4-EDITINPLACE-001) instead of the
// /garden?edit= deep link, so one page verifies both the defect and its replacement.
const surface = new URLSearchParams(window.location.search).get('surface')
const entry = surface === 'planting' ? '/plantings/plant-2' : '/garden?edit=plant-2'

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <DismissRegistryProvider>
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/garden" element={<Garden />} />
        <Route path="/plantings/:plantingId" element={<PlantingDetail />} />
      </Routes>
      <Probe />
    </MemoryRouter>
    </DismissRegistryProvider>
  </AuthProvider>
)

// Verdict, burned into the page so a screenshot is self-evidencing rather than trusted.
window.__verdict = () => {
  const editorOpen = !!document.getElementById('planting-editor')
    || /Edit Krim Plant/.test(document.body.textContent || '')
  // For the planting surface: did we stay put, or did Edit navigate us to /garden?
  const leftPage = /GARDEN/.test(document.querySelector('h1')?.textContent || '')
  return { editorOpen, leftPage, search: window.__search, byIdGets: byIdGets.length }
}
// Bounded, NOT a bare setInterval: `chrome --headless --virtual-time-budget --dump-dom` advances
// virtual time until the task queue drains, so an endless interval means the dump never returns.
let ticks = 0
let tapped = false
const paint = () => {
  // On the planting surface the affordance is a tap, not a URL, so the harness performs it.
  if (surface === 'planting' && !tapped) {
    const btn = document.querySelector('[aria-label="Edit this planting"]')
    if (btn) { btn.click(); tapped = true }
  }
  const v = window.__verdict()
  const el = document.getElementById('verdict')
  el.style.background = v.editorOpen ? '#2d6a4f' : '#a4161a'
  const rootEmpty = !document.getElementById('root').firstChild
  el.textContent = `${firstError ? 'ERROR: ' + firstError : rootEmpty ? 'ROOT EMPTY (nothing rendered)' : v.editorOpen ? 'EDITOR OPEN' : 'NO EDITOR'}  ·  ${surface === 'planting' ? (v.leftPage ? 'LEFT THE PAGE' : 'stayed on planting page') : `search="${v.search ?? ''}"`}  ·  by-id GETs=${v.byIdGets}  ·  ${import.meta.env.VITE_HARNESS_BASELINE ?? 'working tree'}`
  if (++ticks < 12) setTimeout(paint, 250)
}
setTimeout(paint, 250)
