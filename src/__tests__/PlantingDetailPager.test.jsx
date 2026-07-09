// PLANTING-PAGER integration + Items 2/3 placement tests.
// Verifies: the group-bounded pager renders (buttons + N/M + group label) only when a sequence
// exists; next/prev + ArrowRight navigate to the correct cross-project href; degradation paths
// render no pager and don't throw; Item 2 (exactly one favorite heart — the hero one); Item 3
// (caretaker relocated below the Event log). react-router-dom is REAL (MemoryRouter).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { setPlantingSequence, __resetPlantingSequence } from '../lib/plantingSequence.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
// Identifiable favorite stub so we can assert EXACTLY ONE favorite affordance (Item 2).
vi.mock('../components/FavoriteToggle.jsx', () => ({
  default: ({ entityType, entityId }) => (
    <button data-testid="fav" data-entity={`${entityType}:${entityId}`} />
  ),
}))

import PlantingDetail from '../pages/PlantingDetail.jsx'

const NAMES = { pl1: 'Ancho', pl2: 'Jalapeno', pl3: 'Serrano' }
const PROJ = { pl1: 'proj1', pl2: 'proj1', pl3: 'proj2' }
function plantingById(id) {
  return {
    id, name: NAMES[id] || id, project_id: PROJ[id] || 'proj1', project_name: 'Peppers 2026',
    status: 'fruiting', quantity: 1, variety_ref: null, sown_at: null, transplanted_at: null,
    source_type: null, lineage_note: null, notes: null, location_path: null, featured_photo_view_url: null,
  }
}
function wireApi() {
  apiFetchSpy.mockImplementation((path) => {
    if (typeof path === 'string' && path.startsWith('/api/plants/')) {
      const id = path.split('/').pop().split('?')[0]
      return Promise.resolve(plantingById(id))
    }
    if (typeof path === 'string' && path.startsWith('/api/events')) return Promise.resolve([])
    if (typeof path === 'string' && path.startsWith('/api/members')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

const SEQ = {
  items: [
    { projectId: 'proj1', plantingId: 'pl1', name: 'Ancho' },
    { projectId: 'proj1', plantingId: 'pl2', name: 'Jalapeno' },
    { projectId: 'proj2', plantingId: 'pl3', name: 'Serrano' },
  ],
  ctxLabel: 'Peppers',
}

function renderAt(path = '/projects/proj1/plantings/pl1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/projects/:id" element={<div>PROJECT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  __resetPlantingSequence()
  window.scrollTo = vi.fn()
  wireApi()
})

describe('PLANTING-PAGER — renders + navigates when a sequence exists', () => {
  it('shows the pager with position N/M + group label + prev/next buttons', async () => {
    setPlantingSequence(SEQ)
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    expect(screen.getByRole('navigation', { name: 'Planting pager' })).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByText('Peppers')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Previous planting' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next planting' })).toBeTruthy()
  })

  it('Next button pages to the next sibling in the group', async () => {
    setPlantingSequence(SEQ)
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next planting' })); await Promise.resolve() })
    await screen.findByRole('heading', { name: 'Jalapeno' })
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })

  it('Prev from the first wraps to the last — across a different project', async () => {
    setPlantingSequence(SEQ)
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Previous planting' })); await Promise.resolve() })
    // pl3 lives in proj2 — the ownership guard would 404 if the pager built a wrong project segment.
    await screen.findByRole('heading', { name: 'Serrano' })
    expect(screen.getByText('3 / 3')).toBeTruthy()
  })

  it('ArrowRight key pages next; the aria-live region announces the position', async () => {
    setPlantingSequence(SEQ)
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    expect(screen.getByRole('status').textContent).toContain('Ancho, 1 of 3')
    await act(async () => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); await Promise.resolve() })
    await screen.findByRole('heading', { name: 'Jalapeno' })
  })
})

describe('PLANTING-PAGER — degradation (no pager, no throw)', () => {
  it('no sequence → no pager', async () => {
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    expect(screen.queryByRole('navigation', { name: 'Planting pager' })).toBeNull()
  })
  it('single-item sequence → no pager', async () => {
    setPlantingSequence({ items: [{ projectId: 'proj1', plantingId: 'pl1', name: 'Ancho' }], ctxLabel: 'Solo' })
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    expect(screen.queryByRole('navigation', { name: 'Planting pager' })).toBeNull()
  })
  it('current planting not in the sequence → no pager', async () => {
    setPlantingSequence({ items: [
      { projectId: 'proj1', plantingId: 'pl2', name: 'Jalapeno' },
      { projectId: 'proj2', plantingId: 'pl3', name: 'Serrano' },
    ], ctxLabel: 'Peppers' })
    renderAt() // renders pl1, which is absent from the sequence
    await screen.findByRole('heading', { name: 'Ancho' })
    expect(screen.queryByRole('navigation', { name: 'Planting pager' })).toBeNull()
  })
})

describe('Item 2 — exactly one favorite affordance (the hero heart)', () => {
  it('renders a single FavoriteToggle for the planting (secondary-row duplicate removed)', async () => {
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    const favs = screen.getAllByTestId('fav')
    expect(favs.length).toBe(1)
    expect(favs[0].getAttribute('data-entity')).toBe('plant:pl1')
  })
})

describe('Item 3 — caretaker relocated below the Event log', () => {
  it('renders a Caretaker section positioned AFTER the Event log heading', async () => {
    renderAt()
    await screen.findByRole('heading', { name: 'Ancho' })
    const eventLog = screen.getByRole('heading', { name: /Event log/ })
    const caretaker = screen.getByRole('heading', { name: 'Caretaker' })
    // caretaker heading must FOLLOW the event-log heading in document order.
    expect(eventLog.compareDocumentPosition(caretaker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the caretaker picker itself is present in its new home (disambiguated from the hero
    // StatusPicker combobox by its accessible name).
    expect(screen.getByRole('combobox', { name: /Caretaker/ })).toBeTruthy()
  })
})
