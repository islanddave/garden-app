// V4-PICKERGATE-001 — FeedPage's event-type <select> is a READ FILTER and must show EVERYTHING.
//
// THIS IS THE TEST FOR GETTING THE LANE BACKWARDS. Four surfaces read SELECTABLE_EVENT_TYPES and
// three of them are creation pickers that had to be narrowed. This one is not: it filters an
// activity feed of rows that ALREADY EXIST. Narrowing it does not prevent a bad save — there is no
// save — it hides real history. A user who logged "Plants failed" from Log Event and then cannot
// select it here to find that row is looking at an activity feed that lies by omission, and the
// symptom (a row you know you wrote, absent from a filtered view) reads as data loss.
//
// It is also the mistake a plausible "fix the class" patch makes: sweep the five call sites,
// replace SELECTABLE_EVENT_TYPES with creatableEventTypes() everywhere, ship. Every creation
// assertion would still pass.
//
// The three capture-panel types are named EXPLICITLY as well as derived: `harvest` has always been
// filterable here, and V4-LOSSUI-001 landed failed / given_away precisely so their rows could be
// found. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import FeedPage from '../pages/FeedPage.jsx'
import { EVENT_TYPES, SELECTABLE_EVENT_TYPES, CAPTURE_PANEL_REQUIRED_TYPES } from '../lib/eventTypes.js'

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/events')) return Promise.resolve([])
    if (path.startsWith('/api/projects')) return Promise.resolve([])
    return Promise.resolve([])
  })
})
afterEach(() => cleanup())

// '' is the "All event types" placeholder, not a vocabulary member.
const typeValues = (sel) => Array.from(sel.querySelectorAll('option')).map((o) => o.value).filter(Boolean)

async function openFeed() {
  await act(async () => { render(<FeedPage />) })
  await waitFor(() => expect(screen.getByLabelText('Filter by event type')).toBeTruthy())
  return screen.getByLabelText('Filter by event type')
}

describe('V4-PICKERGATE-001 — FeedPage keeps the WHOLE vocabulary (read filter, not a creation picker)', () => {
  it('offers every event type, with nothing dropped by the creation gate', async () => {
    const values = typeValues(await openFeed())
    expect(values).toEqual([...SELECTABLE_EVENT_TYPES])
    expect(values.length).toBe(EVENT_TYPES.length)
  })

  it('offers the three capture-panel types the creation surfaces drop', async () => {
    const values = typeValues(await openFeed())
    expect(CAPTURE_PANEL_REQUIRED_TYPES.length).toBeGreaterThan(0)
    for (const t of CAPTURE_PANEL_REQUIRED_TYPES) {
      expect(values, `${t} rows exist and must stay findable`).toContain(t)
    }
    expect(values).toContain('failed')
    expect(values).toContain('given_away')
    expect(values).toContain('harvest')
  })

  it('keeps the "All event types" placeholder as the default', async () => {
    const sel = await openFeed()
    expect(sel.value).toBe('')
    expect(screen.getByText('All event types')).toBeTruthy()
  })
})
