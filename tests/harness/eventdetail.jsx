// V4-REANCHORFLAG-001 — real-browser look at the re-anchor picker inside EventDetail's edit form.
//
// Why this entry exists: the vitest suite proves the control renders, seeds, confirms and moves —
// jsdom returns a zero rect for everything, so it cannot answer the ONE question the recon left
// open for the device (§5 item 4): does adding a field to an already-long form push "Save changes"
// somewhere Dave cannot reach, and does the picker's listbox open over the Save row.
//
// Load it through the shared iframe host so the layout viewport is genuinely 390 rather than a
// cropped 500 (see the badge in eventdetail.html):
//   /tests/harness/plantingphotosheet.viewport.html?page=eventdetail.html&vw=390&vh=844
//
// `?open=1` opens the planting listbox; `?read=1` stays on the read view.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
import EventDetail from '../../src/pages/EventDetail.jsx'

const q = new URLSearchParams(location.search)

// The prod shape of the row this control exists for: a harvest, anchored, in a project.
const EVENT = {
  id: 'e1', project_id: 'p1', plant_id: 'pl-1', location_id: null,
  event_type: 'harvest', event_date: '2026-08-29T12:00:00.000Z',
  title: '', notes: '', private_notes: '', quantity: '', is_public: false,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  created_at: '2026-08-29T12:00:00.000Z', updated_at: '2026-08-29T12:00:00.000Z',
  project_name: 'Tomatoes 2026', planting_name: 'Cherry Rescue 1',
  harvest: { id: 'h1', quantity: 4, unit: 'count', quality_rating: null, weight_grams: null, weight_estimated: null, weight_basis: null, disposition: null },
  photos: [],
}

// Enough rows that the listbox is a real list rather than a two-line box — the height that decides
// whether it lands on the Save row is a function of how many candidates there are.
const PLANTS = [
  'Cherry Rescue 1', 'Black Cherry', 'Celebrity', 'Celebrity Rescue', 'Sun Sugar',
  'Super Sweet 100', 'Super Sweet 100 Rescue', 'Yellow Pear', 'Red Grape', 'Big Boy',
  'Manitoba', 'Stupice', 'Thessaloniki', 'Mountain Fresh Plus', 'New Yorker',
].map((name, i) => ({
  id: `pl-${i + 1}`, name, quantity: 1,
  project_id: 'p1', project_name: 'Tomatoes 2026',
  sown_at: '2026-04-10', succession_order: null,
  variety_id: `v-${i + 1}`, archived_at: null,
  variety_ref: { id: `v-${i + 1}`, name, crop_type_slug: 'tomato', default_unit: 'count', species: null },
}))

// Stub at the network layer, not at src/lib/api.js: the page then runs its REAL fetch path, real
// error handling and real PlantingSelect self-fetch, and only the far side of the wire is faked.
const realFetch = window.fetch
const json = (body) => Promise.resolve(new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
}))
window.fetch = (url, ...rest) => {
  const u = String(url)
  if (u.includes('/api/events/e1')) return json(EVENT)
  if (u.includes('/api/projects/p1')) return json({ id: 'p1', name: 'Tomatoes 2026', display_name: 'Tomatoes 2026' })
  if (u.includes('/api/plants')) return json(PLANTS)
  return realFetch(url, ...rest)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const byText = (sel, re) => [...document.querySelectorAll(sel)].find(el => re.test(el.textContent || ''))

async function run() {
  createRoot(document.getElementById('root')).render(
    <AuthProvider>
      <DismissRegistryProvider>
        <MemoryRouter initialEntries={['/projects/p1/events/e1']}>
          <Routes><Route path="/projects/:id/events/:eventId" element={<EventDetail />} /></Routes>
        </MemoryRouter>
      </DismissRegistryProvider>
    </AuthProvider>,
  )
  await sleep(600)

  if (!q.get('read')) {
    byText('button', /^Edit$/)?.click()
    await sleep(400)
    if (q.get('open')) {
      // Chip -> list. The picker arrives collapsed onto the event's current planting.
      byText('button', /^Change$/)?.click()
      await sleep(400)
    }
  }

  const badge = document.getElementById('vpbadge')
  const de = document.documentElement
  const save = byText('button', /Save changes/)
  const list = document.querySelector('[role="listbox"]')
  const saveR = save?.getBoundingClientRect()
  const listR = list?.getBoundingClientRect()
  const overlap = saveR && listR &&
    listR.bottom > saveR.top && listR.top < saveR.bottom &&
    listR.right > saveR.left && listR.left < saveR.right
  window.__h = {
    ready: () => true,
    all: () => ({
      vw: window.innerWidth, docScrollW: de.scrollWidth, docClientW: de.clientWidth,
      hscroll: de.scrollWidth > de.clientWidth,
      pageH: de.scrollHeight,
      saveTop: saveR ? Math.round(saveR.top) : null,
      saveH: saveR ? Math.round(saveR.height) : null,
      listTop: listR ? Math.round(listR.top) : null,
      listH: listR ? Math.round(listR.height) : null,
      listOverlapsSave: !!overlap,
    }),
  }
  const m = window.__h.all()
  badge.textContent =
    `vw ${m.vw} · scrollW ${m.docScrollW} · hscroll ${m.hscroll ? 'YES' : 'no'} · page ${m.pageH}px` +
    ` · save@${m.saveTop} h${m.saveH}` +
    (listR ? ` · list@${m.listTop} h${m.listH} overSave ${m.listOverlapsSave ? 'YES' : 'no'}` : '')
  badge.style.background = (m.hscroll || m.listOverlapsSave) ? '#b94a3a' : '#2f3b2f'
}

run()
