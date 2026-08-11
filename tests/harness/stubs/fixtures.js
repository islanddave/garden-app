// Deterministic fixture data for the layout harness. Shapes copied from what the real components
// read, NOT from prod rows — this is layout measurement, not a data contract test.
//
// LONGEST_LABEL matters: measurement C ("does the chip row wrap at its longest label") needs the
// worst-case chip content, and the planting label needs to be long enough to exercise the picker's
// ellipsis path rather than a short happy-path string.

export const PROJECTS = [
  { id: 'proj-1', name: 'Kitchen Garden', status: 'active', archived_at: null },
  { id: 'proj-2', name: 'Hoop House', status: 'active', archived_at: null },
]

export const LOCATIONS = [
  { id: 'loc-1', name: 'Upper Beds', path: 'Gardens at Mathews Ridge / Upper Beds', is_active: true },
]

const CROPS = [
  ['Sungold Cherry Tomato', 'tomato'],
  ['Costoluto Genovese Tomato', 'tomato'],
  ['Jimmy Nardello Sweet Pepper', 'pepper'],
  ['Marketmore 76 Cucumber', 'cucumber'],
  ['Provider Bush Bean', 'bean'],
  ['Dragon Tongue Bush Bean', 'bean'],
  ['Bloomsdale Long-Standing Spinach', 'spinach'],
  ['Nantes Coreless Carrot', 'carrot'],
]

// 24 plantings — enough that the picker listbox is genuinely scrollable, which is the real
// condition under which the sticky Save / listbox overlap was a problem.
export const PLANTS = Array.from({ length: 24 }, (_, i) => {
  const [name, slug] = CROPS[i % CROPS.length]
  return {
    id: `plant-${i + 1}`,
    project_id: i % 2 === 0 ? 'proj-1' : 'proj-2',
    project_name: i % 2 === 0 ? 'Kitchen Garden' : 'Hoop House',
    name: `${name} — bed ${Math.floor(i / 4) + 1}`,
    quantity: (i % 5) + 1,
    status: 'active',
    archived_at: null,
    location_id: 'loc-1',
    location_path: 'Gardens at Mathews Ridge / Upper Beds',
    variety_id: `var-${(i % CROPS.length) + 1}`,
    variety_ref: { id: `var-${(i % CROPS.length) + 1}`, name, crop_type_slug: slug },
  }
})

let eventSeq = 0
export function nextEventId() { return `evt-harness-${++eventSeq}` }
export function resetEventSeq() { eventSeq = 0 }

// Response bodies keyed by a coarse path match. Anything unmatched returns [] so an unmodelled
// GET degrades to "empty list" rather than an exception that would silently change the layout.
export function fixtureFor(path, method) {
  if (method === 'POST' && path.startsWith('/api/events')) {
    return { id: nextEventId(), plant_id: 'plant-1', project_id: 'proj-1', event_type: 'harvest' }
  }
  if (method === 'DELETE' || method === 'PATCH') return { ok: true }
  if (path.startsWith('/api/plants')) return PLANTS
  if (path.startsWith('/api/projects')) return PROJECTS
  if (path.startsWith('/api/locations')) return LOCATIONS
  if (path.startsWith('/api/harvests')) return { aggregates: { season_total: 41, unit: 'count' }, rows: [] }
  if (path.startsWith('/api/inventory-items')) return []
  if (path.startsWith('/api/varieties')) return []
  if (path.startsWith('/api/ux-events')) return { ok: true }
  return []
}
