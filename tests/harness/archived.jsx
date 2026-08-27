// V4-ARCHIVEBROWSE-001 — real-browser look at the archived-plantings page at Dave's geometry.
//
// jsdom has no layout engine, so the unit tests can prove a row EXISTS, carries a 44px Unarchive
// button and prints the right subtitle — and still cannot show whether a long name plus a status
// badge plus that button fit on a 390px phone, which is the only device this page is for. That is
// the one question this entry answers.
//
// The fixture is the REAL archived set read off prod 2026-08-27 (30 rows, 9 crop types, statuses
// failed/ended/vegetative, and the 9 rows where the variety name differs from the display name) —
// including the longest name in the set, because the layout question is decided by the worst row,
// not the average one.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ArchivedPlantings from '../../src/pages/ArchivedPlantings.jsx'

const RAW = [
  ['Culantro', 'failed', 'culantro', 'Culantro', '2026-08-23'],
  ['Asparagus', 'failed', 'asparagus', 'Asparagus', '2026-08-23'],
  ['Emerald Green', 'failed', 'pepper', 'Emerald Green', '2026-08-21'],
  ['Tabasco', 'failed', 'pepper', 'Tabasco', '2026-08-17'],
  ['Sweet Chocolate', 'failed', 'pepper', 'Sweet Chocolate', '2026-08-17'],
  ['Purple Tiger', 'failed', 'pepper', 'Purple Tiger', '2026-08-17'],
  ['Piquin', 'failed', 'pepper', 'Piquin', '2026-08-17'],
  ['Orange Sun', 'failed', 'pepper', 'Orange Sun', '2026-08-17'],
  ['New Mexico', 'failed', 'pepper', 'New Mexico (Hatch-type)', '2026-08-17'],
  ['King of the North', 'failed', 'pepper', 'King of the North', '2026-08-17'],
  ['Golden California Wonder', 'failed', 'pepper', 'Golden California Wonder', '2026-08-17'],
  ['Biquinho', 'failed', 'pepper', 'Biquinho Yellow F1', '2026-08-17'],
  ['Lettuce', 'ended', 'lettuce', 'Buttercrunch', '2026-08-02'],
  ['Spinach', 'ended', 'spinach', 'Bloomsdale Long Standing', '2026-07-28'],
  ['Cilantro', 'ended', 'cilantro', 'Santo', '2026-07-14'],
  ['Luffa', 'vegetative', 'luffa', 'Luffa', '2026-07-02'],
  ['Lithops', 'ended', 'lithops', 'Lithops', '2026-06-18'],
]

const plants = RAW.map(([name, status, crop, variety, day], i) => ({
  id: `0000000${i}-0000-4000-8000-00000000000${i % 10}`,
  name, status, crop_type_slug: crop, variety_name: variety,
  archived_at: `${day}T14:00:00Z`,
  created_at: '2026-05-01T00:00:00Z',
}))

// Stub the network at the window boundary rather than aliasing src/lib/api.js: the page under
// measurement should run its REAL fetch path, error handling and all, so the only thing faked is
// the far side of the wire.
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? '')
  if (url.includes('/api/plants/archived')) {
    return new Response(JSON.stringify({ plants, truncated: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (/\/api\/plants\/[^/]+\/archive$/.test(url) && (init.method ?? 'GET') === 'PATCH') {
    return new Response(JSON.stringify({ id: 'x', archived_at: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(input, init)
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter><ArchivedPlantings /></MemoryRouter>
)
