// BUG-SILENTFAILSWEEP-001 — Tier-1 members 3 and 4: PlantingEditor's Archive and Remove.
//
// Both closed the editor from `finally`, on success and failure alike. Success additionally fired
// onArchived/onDeleted (Garden drops the row, raises the Undo strip); failure fired neither, so the
// planting stayed in the list looking untouched and the editor closed exactly as it does when the
// write lands. Nothing was said on either path — the two outcomes rendered identically.
//
// onClose UNMOUNTS this component (V4-SHEETBUSY-001 note in the source), so "close AND show the
// error" was never on the table: an error set on the way out has nothing left to render. The close
// therefore moved onto the success arms, and failure keeps the editor open with the reason in the
// `err` -> PlantForm ErrorBanner slot handleAdd/handleEdit have always used.
//
// The 404 tolerance on Remove (BUG-DELCLIENT-001) is PRESERVED and is pinned in
// deleteNotFoundTolerance.test.jsx, which owns that branch; this file pins the other direction.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The editor takes its own `fetch` prop, but VarietyPicker (rendered inside PlantForm) reaches for
// useApiFetch -> Clerk's useAuth on its own. Same stub deleteNotFoundTolerance.test.jsx uses — and
// the spy is HOISTED because useVarieties keys an effect on `fetch`: a fresh vi.fn per call gives a
// new identity every render and spins forever.
const { pickerFetch } = vi.hoisted(() => ({ pickerFetch: vi.fn(async () => []) }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: pickerFetch, getToken: vi.fn() }) }))

import PlantingEditor from '../components/PlantingEditor.jsx'

const PLANT = {
  id: 'p1', name: 'Black Krim', quantity: 1, project_id: 'proj1',
  variety_ref: null, notes: '', status: 'seed',
}

function renderEditor(fetchImpl) {
  const handlers = { onDeleted: vi.fn(), onArchived: vi.fn(), onClose: vi.fn() }
  const { unmount } = render(
    <MemoryRouter>
      <PlantingEditor
        mode="edit" plant={PLANT} plants={[PLANT]}
        projects={[{ id: 'proj1', name: 'Beds' }]}
        fetch={fetchImpl} {...handlers}
      />
    </MemoryRouter>,
  )
  return { ...handlers, unmount }
}

// The editor is the surface under test, so "still open" is asserted on its own heading rather than
// on onClose alone — a close that fired without unmounting would be a lie in the other direction.
const editorOpen = () => screen.queryByText(/Edit Black Krim/) !== null
const banner = () => screen.queryByRole('alert')

describe('PlantingEditor Archive — a failure does not render as a success', () => {
  it('failure and success do NOT render the same thing', async () => {
    const fail = vi.fn(() => Promise.reject(new Error('nope')))
    const failed = renderEditor(fail)
    fireEvent.click(screen.getByText('Archive'))
    await waitFor(() => expect(banner()).not.toBeNull())
    // FAILURE: editor still here, reason on screen, Garden never told to drop the row.
    expect(editorOpen()).toBe(true)
    expect(failed.onArchived).not.toHaveBeenCalled()
    expect(failed.onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Archive')).toBeTruthy()   // control back out of its in-flight label

    failed.unmount()

    const okFetch = vi.fn(() => Promise.resolve({ archived_at: '2026-06-12T00:00:00Z' }))
    const ok = renderEditor(okFetch)
    fireEvent.click(screen.getByText('Archive'))
    // SUCCESS: no banner, Garden told, editor closed.
    await waitFor(() => expect(ok.onArchived).toHaveBeenCalledWith(PLANT))
    expect(ok.onClose).toHaveBeenCalled()
    expect(banner()).toBeNull()
  })

  it('names the archive and the state the planting is left in, and announces it', async () => {
    renderEditor(vi.fn(() => Promise.reject(new Error('nope'))))
    fireEvent.click(screen.getByText('Archive'))
    const b = await screen.findByRole('alert')
    expect(b.textContent).toMatch(/Couldn't archive this planting/)
    // Its own state, not Remove's: a failed archive leaves the planting ACTIVE, not "in your garden
    // but deleted-ish". Reusing the remove line would send the reader looking for a different thing.
    expect(b.textContent).toMatch(/still active/)
    expect(b.textContent).not.toMatch(/remove/i)
  })

  it('a retry clears the stale banner while in flight, and re-reports if it fails again', async () => {
    // Asserted MID-FLIGHT: a clear that only happened on success is indistinguishable from no clear
    // at all once the retry has landed, and this button is its own arm (nothing sits between the
    // tap and the request).
    let release
    let archiveCalls = 0
    // Routed by URL, not by call order: the editor's mount effect spends a call on
    // /api/locations/with-path before any button is touched, so mockImplementationOnce would hand
    // the first attempt's rejection to that effect (which swallows it) instead of to Archive.
    const fetchImpl = vi.fn((url) => {
      if (!String(url).includes('/archive')) return Promise.resolve([])
      archiveCalls += 1
      if (archiveCalls === 1) return Promise.reject(new Error('nope'))
      return new Promise((_, rej) => { release = () => rej(new Error('nope again')) })
    })
    renderEditor(fetchImpl)
    fireEvent.click(screen.getByText('Archive'))
    await screen.findByRole('alert')

    fireEvent.click(screen.getByText('Archive'))
    await waitFor(() => expect(banner()).toBeNull())     // in flight: stale line gone
    release()
    await waitFor(() => expect(banner()).not.toBeNull()) // failed again: said again
  })
})

describe('PlantingEditor Remove — a failure does not render as a success', () => {
  it('failure and success do NOT render the same thing', async () => {
    const fail = vi.fn(() => Promise.reject(new Error('nope')))
    const failed = renderEditor(fail)
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(banner()).not.toBeNull())
    expect(editorOpen()).toBe(true)
    expect(failed.onDeleted).not.toHaveBeenCalled()
    expect(failed.onClose).not.toHaveBeenCalled()

    failed.unmount()

    const ok = renderEditor(vi.fn(() => Promise.resolve({})))
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(ok.onDeleted).toHaveBeenCalledWith('p1'))
    expect(ok.onClose).toHaveBeenCalled()
    expect(banner()).toBeNull()
  })

  it('names the removal and the state the planting is left in', async () => {
    renderEditor(vi.fn(() => Promise.reject(new Error('nope'))))
    fireEvent.click(screen.getByText('Remove'))
    const b = await screen.findByRole('alert')
    expect(b.textContent).toMatch(/Couldn't remove this planting/)
    expect(b.textContent).toMatch(/still in your garden/)
    expect(b.textContent).not.toMatch(/archive/i)
  })
})
