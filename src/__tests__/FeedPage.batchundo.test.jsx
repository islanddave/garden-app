// V4-BATCHUNDO-001 — the durable batch undo on /feed, tested against the LIVE API shapes.
//
// The batches payload below is the handler's own SELECT list (lambda/events/index.js,
// `/api/events/batches`): id, event_type, scope_json, item_count, event_date, created_at, wrapped in
// `{ batches: [...] }`. The feed payload is `/api/events/feed`'s: raw member rows carrying
// `metadata->>'batch_id' AS batch_id` plus the joined `item_count`, which is what collapseFeed folds
// into one entry. Neither is guessed.
//
// THE TWO TESTS THAT MATTER MOST are the confirm gate and the delete call, because between them
// they hold the property this feature must not break while fixing another: a 157-row batch cannot
// vanish on a mis-tap, and when it IS undone it is the batch the user pointed at. Both are
// mutation-proven in the lane report.
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import FeedPage from '../pages/FeedPage.jsx'

const B1 = '11111111-1111-4111-8111-111111111111'   // undoable: in the server's set
const B2 = '22222222-2222-4222-8222-222222222222'   // NOT in the set (aged past the server's ten)

const batchRow = (batchId, count, over = {}) => ({
  id: `${batchId}-member-${over.n ?? 1}`,
  batch_id: batchId,
  item_count: count,
  event_type: 'watering',
  event_date: '2026-08-18',
  created_at: '2026-08-18T14:02:00.000Z',
  project_id: 'p1',
  project_name: 'Bed 3',
  notes: null,
})

// Two members of each batch — collapseFeed must fold each pair into ONE entry, and batch_count comes
// from the joined item_count, not from how many members happened to be on this page.
const FEED_EVENTS = [
  batchRow(B1, 30, { n: 1 }), batchRow(B1, 30, { n: 2 }),
  batchRow(B2, 8, { n: 1 }), batchRow(B2, 8, { n: 2 }),
]

const BATCHES_PAYLOAD = {
  batches: [
    { id: B1, event_type: 'watering', scope_json: { plant_ids: [] }, item_count: 30, event_date: '2026-08-18', created_at: '2026-08-18T14:02:00.000Z' },
  ],
}

// Route the mocked fetch the way api.js's own prefix table would. `/api/events/batch/` is tested
// FIRST because `/api/events/batches` would otherwise swallow it.
function install({ batches = BATCHES_PAYLOAD, events = FEED_EVENTS, onDelete } = {}) {
  fetchSpy.mockImplementation((path, options) => {
    if (path.startsWith('/api/events/batch/')) return (onDelete ?? (() => Promise.resolve({ undone: true })))(path, options)
    if (path.startsWith('/api/events/batches')) return typeof batches === 'function' ? batches() : Promise.resolve(batches)
    if (path.startsWith('/api/events/feed')) return Promise.resolve({ events, has_more: false })
    if (path.startsWith('/api/projects')) return Promise.resolve([])
    return Promise.resolve([])
  })
}

const deleteCalls = () => fetchSpy.mock.calls.filter(([p]) => String(p).startsWith('/api/events/batch/'))

async function openFeed() {
  await act(async () => { render(<FeedPage />) })
  await waitFor(() => expect(screen.getByLabelText('Filter by event type')).toBeTruthy())
}

beforeEach(() => { fetchSpy.mockReset(); install() })
afterEach(() => cleanup())

describe('V4-BATCHUNDO-001 — which rows get the affordance', () => {
  it('offers Undo only for batches the server says are still undoable', async () => {
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    // B2 is a batch row with a batch_id and a count — everything except membership. It must NOT get
    // a button, because DELETE would 404 on it.
    expect(screen.queryByTestId(`batch-undo-open-${B2}`)).toBe(null)
  })

  it('drops the affordance when the same row leaves the server set — the guard is not vacuous', async () => {
    install({ batches: { batches: [] } })
    await openFeed()
    await waitFor(() => expect(screen.getByTestId('batch-undo-notice')).toBeTruthy())
    expect(screen.queryByTestId(`batch-undo-open-${B1}`)).toBe(null)
  })

  it('names the row count on the affordance for a screen reader', async () => {
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    expect(screen.getByLabelText('Undo this bulk log of 30 entries')).toBeTruthy()
  })
})

describe('V4-BATCHUNDO-001 — the confirmation genuinely gates the delete', () => {
  it('opening the confirm issues NO delete, and dismissing it still issues none', async () => {
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())

    await act(async () => { fireEvent.click(screen.getByTestId(`batch-undo-open-${B1}`)) })
    // The sheet is up and states the real count from the batches endpoint...
    expect(screen.getByTestId('batch-undo-count').textContent).toBe('all 30 entries')
    // ...and nothing has been deleted.
    expect(deleteCalls().length).toBe(0)

    await act(async () => { fireEvent.click(screen.getByTestId('batch-undo-cancel')) })
    expect(screen.queryByTestId('batch-undo-body')).toBe(null)
    // The dismissal is the whole assertion: a confirm that fires on its way out is not a confirm.
    expect(deleteCalls().length).toBe(0)
    // And the row is still there.
    expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy()
  })

  it('states the count on the destructive button face too, not only in the prose', async () => {
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`batch-undo-open-${B1}`)) })
    expect(screen.getByTestId('batch-undo-confirm').textContent).toBe('Undo 30 entries')
    expect(deleteCalls().length).toBe(0)
  })
})

describe('V4-BATCHUNDO-001 — confirming undoes THAT batch', () => {
  it('DELETEs /api/events/batch/:id with the id of the row that was tapped', async () => {
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`batch-undo-open-${B1}`)) })
    await act(async () => { fireEvent.click(screen.getByTestId('batch-undo-confirm')) })

    const calls = deleteCalls()
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toBe(`/api/events/batch/${B1}`)
    expect(calls[0][1]?.method).toBe('DELETE')
  })

  it('removes the collapsed row and closes the sheet once the server confirms', async () => {
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`batch-undo-open-${B1}`)) })
    await act(async () => { fireEvent.click(screen.getByTestId('batch-undo-confirm')) })

    await waitFor(() => expect(screen.queryByTestId('batch-undo-body')).toBe(null))
    expect(screen.queryByTestId(`batch-undo-open-${B1}`)).toBe(null)
    // The other batch is untouched — the undo is scoped to one batch, not to batches.
    expect(screen.getByText('watering × 8')).toBeTruthy()
  })
})

describe('V4-BATCHUNDO-001 — a failed undo must not look like a successful one', () => {
  it('surfaces the error in the sheet and leaves the row exactly where it was', async () => {
    install({ onDelete: () => Promise.reject(Object.assign(new Error('boom'), { status: 500 })) })
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`batch-undo-open-${B1}`)) })
    await act(async () => { fireEvent.click(screen.getByTestId('batch-undo-confirm')) })

    await waitFor(() => expect(screen.getByTestId('batch-undo-error')).toBeTruthy())
    // NOT optimistically removed: the entries are still in the database, so they are still on screen.
    expect(screen.getByTestId('batch-undo-body')).toBeTruthy()
    expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy()
    expect(screen.getByText('watering × 30')).toBeTruthy()
  })

  it('explains a 404 instead of echoing the Lambda’s bare "Not found"', async () => {
    install({ onDelete: () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 })) })
    await openFeed()
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`batch-undo-open-${B1}`)) })
    await act(async () => { fireEvent.click(screen.getByTestId('batch-undo-confirm')) })

    await waitFor(() => expect(screen.getByTestId('batch-undo-error')).toBeTruthy())
    const txt = screen.getByTestId('batch-undo-error').textContent
    expect(txt).toContain('can’t be undone any more')
    expect(txt).not.toBe('Not found')
    expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy()
  })
})

describe('V4-BATCHUNDO-001 — the three honest states of the undoable set', () => {
  it('says it is still checking while the batches request is in flight', async () => {
    let release
    install({ batches: () => new Promise((res) => { release = () => res(BATCHES_PAYLOAD) }) })
    await openFeed()
    await waitFor(() => expect(screen.getByTestId('batch-undo-notice')).toBeTruthy())
    expect(screen.getByTestId('batch-undo-notice').textContent).toContain('Checking which bulk logs')
    expect(screen.queryByTestId(`batch-undo-open-${B1}`)).toBe(null)
    await act(async () => { release() })
    await waitFor(() => expect(screen.getByTestId(`batch-undo-open-${B1}`)).toBeTruthy())
    expect(screen.queryByTestId('batch-undo-notice')).toBe(null)
  })

  it('says the check FAILED rather than silently showing no buttons', async () => {
    install({ batches: () => Promise.reject(new Error('offline')) })
    await openFeed()
    await waitFor(() => expect(screen.getByTestId('batch-undo-notice')).toBeTruthy())
    expect(screen.getByTestId('batch-undo-notice').textContent).toContain('Couldn’t check')
    expect(screen.queryByTestId(`batch-undo-open-${B1}`)).toBe(null)
  })

  it('says none are undoable when the set comes back empty', async () => {
    install({ batches: { batches: [] } })
    await openFeed()
    await waitFor(() => expect(screen.getByTestId('batch-undo-notice')).toBeTruthy())
    expect(screen.getByTestId('batch-undo-notice').textContent).toContain('None of the bulk logs below')
  })

  it('says nothing at all when the feed shows no bulk logs', async () => {
    install({ events: [{ id: 'solo', event_type: 'watering', created_at: '2026-08-18T14:02:00.000Z', project_id: 'p1', project_name: 'Bed 3' }], batches: { batches: [] } })
    await openFeed()
    // 'watering' also appears as a filter <option>, so count the badge occurrences rather than
    // querying for a single node.
    await waitFor(() => expect(screen.getAllByText('watering').length).toBeGreaterThan(1))
    expect(screen.queryByTestId('batch-undo-notice')).toBe(null)
  })
})
