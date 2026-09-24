// BUG-VARIETYEDITUNREACHABLE-001 — the variety editor's only door.
//
// WHY THIS FILE EXISTS. `/varieties/:varietyId/edit` has been a registered, working, tested route
// since V4-EDITCOMPLETE-001 and, until this change, NOTHING in the app linked to it: a repo-wide
// search for the path returned the route registration, two source comments and two `source_url`
// strings — no `to=`, no `navigate(`, no `href=`. Dave is Android-only in an installed PWA with no
// address bar, so an unlinked route is not "hard to find", it is unreachable. `VarietyEditor.jsx:1`
// calls itself "the variety edit surface that did not exist"; it was built and never connected.
//
// That is not a cosmetic gap. It is the mechanism that leaves columns inert in this codebase —
// `inventory_items.year_harvested` and `lot_number` are in live prod with no reader and no writer —
// and it is the reason V5-VARIETYHYBRIDFLAG-001 is blocked on this row: the maintenance writer for
// a variety-level field is a page nobody can open.
//
// So this guard is about REACHABILITY, not about markup. It fails if the link is removed, if it
// stops pointing at the edit route, or if it stops carrying the variety's own id — the three ways
// the door silently closes again. A future tidy-up that deletes it as "an unused link" is exactly
// what this file exists to stop.
//
// Harness mirrors PlantingDetail.allFields.test.jsx. No jest-dom (L-182): text/role assertions only.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { T } from '../components/forms/formStyles.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'

const VARIETY_ID = 'var-9f3c1e77-0000-4000-8000-000000000001'

// `id` is the FIRST key of the by-id GET's variety_ref jsonb_build_object
// (lambda/plants/index.js — 'id', pv.id), so a joined variety always carries it. The fixture
// reflects that rather than inventing a shape.
const BASE = {
  id: 'pl1',
  name: 'Ghost Pepper',
  project_id: 'proj1',
  project_name: 'Peppers 2026',
  status: 'fruiting',
  location_path: null,
  container_type: null,
  container_size: null,
  featured_photo_view_url: null,
  variety_ref: { id: VARIETY_ID, name: 'Ghost', species: 'Capsicum chinense' },
}

let PLANTING = BASE

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/varieties/:varietyId/edit" element={<div>VARIETY EDIT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function openBasics() {
  renderPage()
  await screen.findByRole('heading', { name: PLANTING.name })
  fireEvent.click(screen.getByRole('button', { name: /Details/ }))
  fireEvent.click(screen.getByRole('radio', { name: 'Basics' }))
}

beforeEach(() => {
  PLANTING = BASE
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => {
    if (/\/api\/plants\/pl1(\?|$)/.test(url)) return Promise.resolve(PLANTING)
    return Promise.resolve([])
  })
})

describe('BUG-VARIETYEDITUNREACHABLE-001 — the variety editor has a door', () => {
  it('renders an Edit variety link on the planting page', async () => {
    await openBasics()
    expect(screen.getByTestId('planting-variety-edit-link')).toBeTruthy()
  })

  it('points at THIS variety\'s edit route — the assertion that catches a wrong or stale id', async () => {
    await openBasics()
    const link = screen.getByTestId('planting-variety-edit-link')
    expect(link.getAttribute('href')).toBe(`/varieties/${VARIETY_ID}/edit`)
  })

  it('actually navigates — reachability, not just markup', async () => {
    await openBasics()
    fireEvent.click(screen.getByTestId('planting-variety-edit-link'))
    expect(screen.getByText('VARIETY EDIT PAGE')).toBeTruthy()
  })

  it('still shows the variety NAME beside the link', async () => {
    // The door must not cost the information the row existed to show.
    await openBasics()
    expect(screen.getByText('Ghost')).toBeTruthy()
  })
})

// ── BUG-VARIETYDOORTAPFLOOR-001 — the door is reachable, but only by a thumb that can hit it ────
// The link shipped as bare inline text at T.type.xs and measured 66.3 × 17.3 px in a real browser at
// a genuine 390×844 (lane varietyeditdrive-20260908, CDP device emulation — macOS Chrome cannot open
// a sub-500px window, so a --window-size run would have measured a cropped 500px layout). 17.3px is
// under WCAG SC 2.5.8's 24px minimum and under half the 44px floor T.tapMinHeight already names.
//
// WHAT THIS CAN AND CANNOT PROVE, same honesty scoping as VarietyPicker.tapFloor.test.js: jsdom has
// no layout engine, so nothing here measures 44 rendered CSS px. It pins the DECLARATION on two
// independent axes — the computed style of the REAL rendered link (which catches the style object
// being detached from the element, something a source grep cannot see) and the source text (which
// catches a literal creeping back in at a number that is 44 today and drifts tomorrow).
const __dirname = dirname(fileURLToPath(import.meta.url))
const decomment = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
const PAGE_SRC = decomment(readFileSync(resolve(__dirname, '../pages/PlantingDetail.jsx'), 'utf8'))

function styleBlock(name) {
  const start = PAGE_SRC.indexOf(`const ${name} = {`)
  if (start === -1) return null
  const end = PAGE_SRC.indexOf('\n}', start)
  return end === -1 ? null : PAGE_SRC.slice(start, end)
}

describe('BUG-VARIETYDOORTAPFLOOR-001 — the door clears the tap floor', () => {
  // INSTRUMENT CHECK. Every assertion below is worthless if the token is not actually 44: routing
  // the door "through the token" satisfies a grep just as well at 20.
  it('T.tapMinHeight is 44 — the floor this file is about', () => {
    expect(T.tapMinHeight).toBe(44)
  })

  it('the rendered link carries the floor on BOTH axes', async () => {
    // WCAG 2.5.8 measures the SMALLER dimension, so a 44px-tall strip of 66px text is still a miss
    // on the axis that was actually failing. Read off the real element, not the style object.
    await openBasics()
    const cs = getComputedStyle(screen.getByTestId('planting-variety-edit-link'))
    expect(cs.minHeight).toBe(`${T.tapMinHeight}px`)
    expect(cs.minWidth).toBe(`${T.tapMinHeight}px`)
    // A minHeight on an inline element is ignored by the box model — the fix only works because the
    // link is also a block-ish box. This is the assertion that catches "the number is there but does
    // nothing", which is how the original 17.3px happened.
    expect(cs.display).toBe('inline-flex')
  })

  it('is no longer typeset at the smallest size on the ramp', async () => {
    // T.type.xs (0.72rem) is the caption size the row LABELS use. The door read as one of them.
    await openBasics()
    expect(getComputedStyle(screen.getByTestId('planting-variety-edit-link')).fontSize)
      .not.toBe(T.type.xs)
  })

  it('carries its own accessible name — "Edit variety" alone repeats down a list', async () => {
    await openBasics()
    expect(screen.getByRole('link', { name: `Edit variety ${BASE.variety_ref.name}` })).toBeTruthy()
  })

  // NON-VACUITY. If the const is renamed or inlined back into the JSX, styleBlock returns null and
  // every toContain below would pass against an empty string. Fail loudly instead.
  it('the varietyEditLinkStyle declaration is findable', () => {
    expect(styleBlock('varietyEditLinkStyle'),
      'varietyEditLinkStyle not found — renamed or re-inlined? update this guard').toBeTruthy()
  })

  it('routes both floors through T.tapMinHeight, not a literal', () => {
    const block = styleBlock('varietyEditLinkStyle')
    expect(block).toContain('minHeight: T.tapMinHeight')
    expect(block).toContain('minWidth: T.tapMinHeight')
    expect(block).not.toMatch(/min(Height|Width):\s*\d/)
  })

  it('does NOT use the chip token — this is a control, not a chip', () => {
    // chipMinHeight is 40 and is correct for chips. Aliasing the door to it would still be under the
    // floor while looking tokenized, which is exactly how BUG-ADOPTTAPFLOOR-001 shipped.
    expect(styleBlock('varietyEditLinkStyle')).not.toContain('chipMinHeight')
  })
})

describe('degrades without an id rather than linking somewhere wrong', () => {
  it('renders the name and no link when variety_ref carries no id', async () => {
    // Older cached payloads and the grid projection carry a narrower variety_ref. A link built from
    // an absent id would resolve to `/varieties/undefined/edit` — a 404 door is worse than none.
    PLANTING = { ...BASE, variety_ref: { name: 'Ghost', species: 'Capsicum chinense' } }
    await openBasics()
    expect(screen.getByText('Ghost')).toBeTruthy()
    expect(screen.queryByTestId('planting-variety-edit-link')).toBeNull()
  })

  it('renders no Variety row at all when the planting has no variety', async () => {
    PLANTING = { ...BASE, name: 'Bare Row', variety_ref: null }
    await openBasics()
    expect(screen.queryByTestId('planting-variety-edit-link')).toBeNull()
  })
})
