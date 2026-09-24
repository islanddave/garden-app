// V5-NAVCUSTOM-001 — real-browser look at the per-person tab bar and the pinned More sheet at Dave's
// geometry (426×836 CSS px). jsdom proves the rows, pins and doors exist; it cannot show whether a pin
// button beside every More row, a Pinned block and a moved tab still fit and read on a phone.
//
// The REAL chain runs: AuthProvider (Clerk stubbed by the harness config) → PrefsProvider → the real
// fetchNotificationPrefs → NavPrefsProvider → BottomNav. Only the far side of the wire is faked.
// Start with VITE_API_CRITTERS set to any base (e.g. https://critter.invalid) so the prefs client has
// a URL to call; the stub below answers it.
//
// Query string: ?layout=default|putup|garden|two  &pins=0|2|4|5  &edit=0|1
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { ModeProvider } from '../../src/context/ModeContext.jsx'
import { PrefsProvider } from '../../src/context/PrefsContext.jsx'
import { NavPrefsProvider } from '../../src/context/NavPrefsContext.jsx'
import BottomNav from '../../src/components/BottomNav.jsx'

const q = new URLSearchParams(location.search)
const ORDER = ['today', 'garden', 'create', 'harvests', 'put-up']
const LAYOUTS = {
  default: null,
  putup: { order: ORDER, hidden: ['put-up'] },
  garden: { order: ORDER, hidden: ['garden'] },
  two: { order: ORDER, hidden: ['garden', 'put-up'] },
}
const PINS = { 0: null, 2: ['photos', 'seeds'], 4: ['photos', 'seeds', 'put-up', 'settings'], 5: ['photos', 'seeds', 'inventory', 'dashboard', 'helper'] }
const layout = LAYOUTS[q.get('layout') ?? 'putup'] ?? null
const pins = PINS[q.get('pins') ?? '2'] ?? null
const canEdit = q.get('edit') !== '0'

// A first launch on this device: no launch cache, so the server layout applies at once.
for (const k of ['nav.barLayout.v1', 'nav.morePins.v1', 'nav.morePins.pending.v1']) localStorage.removeItem(k)

const patches = []
window.__navPatches = patches
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '')
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  if (url.includes('/api/notifications/prefs')) {
    await new Promise(r => setTimeout(r, 40))
    if ((init.method ?? 'GET') === 'PATCH') { patches.push(JSON.parse(init.body)); return json({ ...JSON.parse(init.body) }) }
    return json({ critter_visit: 'in_app_only', more_pins: pins, bar_layout: layout, can_edit_bar: canEdit })
  }
  if (url.includes('/api/critters/active')) return json([])
  return realFetch(input, init)
}

function Page() {
  return (
    <div style={{ padding: 16, paddingBottom: 120, fontFamily: 'system-ui', color: '#333' }}>
      <p id="badge" style={{ fontSize: 12, background: '#fff3', margin: 0 }} />
      {Array.from({ length: 30 }, (_, i) => <p key={i} style={{ margin: '8px 0' }}>Page content row {i + 1}</p>)}
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ModeProvider>
      <MemoryRouter initialEntries={['/today']}>
        <PrefsProvider>
          <NavPrefsProvider>
            <Page />
            <BottomNav />
          </NavPrefsProvider>
        </PrefsProvider>
      </MemoryRouter>
    </ModeProvider>
  </AuthProvider>
)

// Burn the measurement into the page so a screenshot proves its own viewport.
setInterval(() => {
  const nav = document.querySelector('nav[aria-label="Main navigation"]')
  const slots = nav ? nav.children.length : 0
  const b = document.getElementById('badge')
  if (b) b.textContent = `vw ${innerWidth} · vh ${innerHeight} · scrollW ${document.documentElement.scrollWidth} · bar slots ${slots} · patches ${patches.length}`
}, 250)
