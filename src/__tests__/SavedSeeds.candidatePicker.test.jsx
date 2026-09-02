// BUG-SEEDCANDIDATEAMBIG-001 — the untracked-packet picker on /seeds/saved.
//
// THE DEFECT, measured against prod rather than imagined: ~260 untracked seed rows rendered
// unfiltered and uncapped (~41 phone-screens of scroll), and 51 of them across 24 groups rendering a
// BYTE-IDENTICAL label — the row printed `{i.variety_name || i.name}` and nothing else. Choosing the
// right packet was not hard, it was undecidable, and the choice writes a permanent
// seed_lot_stage_log row against whichever row the thumb landed on.
//
// THE ACCEPTANCE CRITERION IS THE FIRST TEST BELOW: every rendered row reads differently from every
// other. It is written as a pairwise-distinctness assertion over the rendered text rather than as
// "the detail line is present", because the property that matters is the one the user has — two rows
// they can tell apart — not the mechanism that happens to deliver it today.
//
// AND IT CARRIES ITS OWN INSTRUMENT CHECK. A fixture with no collisions in it would score a perfect
// pass against the BROKEN implementation, so the same test asserts that the titles alone DO collide.
// Without that line this file proves nothing (the gate-criteria lesson: a constant scores 100%).
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// An UNTRACKED packet as the list endpoint returns it: `i.*` plus variety_name. seed_stage null is
// what makes it untracked; status 'active' is what makes it offerable.
const packet = (over = {}) => ({
  id: 'inv-x', name: 'Brandywine', variety_name: 'Brandywine', category: 'seeds',
  type: 'consumable', unit: 'packet', status: 'active', quantity_on_hand: 1,
  variety_id: 'v-brandywine', seed_stage: null, seed_process: null, source_plant_id: null,
  source: null, purchase_date: null, stage_entered_at: null,
  ...over,
})

// THE REAL COLLISION SHAPE, transcribed from the prod finding: one cultivar, several packets, the
// same rendered name, differing in count and vendor. Two of them (dup-c / dup-d) are identical in
// EVERY recorded fact, which is the residue the facts line cannot separate — the case the ordinal
// exists for, and the one that would otherwise leave the criterion with an exception.
const COLLIDING = [
  packet({ id: 'dup-a', quantity_on_hand: 3, source: 'Fedco' }),
  packet({ id: 'dup-b', quantity_on_hand: 1, source: 'Johnny’s' }),
  packet({ id: 'dup-c', quantity_on_hand: 2, source: 'Baker Creek', purchase_date: '2026-01-14' }),
  packet({ id: 'dup-d', quantity_on_hand: 2, source: 'Baker Creek', purchase_date: '2026-01-14' }),
  packet({ id: 'other', name: 'Cherokee Purple', variety_name: 'Cherokee Purple',
           quantity_on_hand: 5, source: 'Fedco' }),
]

const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}

const openPicker = async () => {
  await act(async () => { fireEvent.click(screen.getByTestId('track-a-lot')) })
}
const rows = () => screen.queryAllByTestId('track-candidate')
const rowText = () => rows().map(r => r.textContent.replace(/\s+/g, ' ').trim())
const type = async (q) => {
  await act(async () => { fireEvent.change(screen.getByTestId('candidate-filter'), { target: { value: q } }) })
}
const dupes = (xs) => xs.filter((x, i) => xs.indexOf(x) !== i)

beforeEach(() => { fetchSpy.mockReset() })

describe('BUG-SEEDCANDIDATEAMBIG-001 — no two rows in the picker read alike', () => {
  it('renders pairwise-distinct rows for packets whose NAMES are identical', async () => {
    await mount(COLLIDING)
    await openPicker()

    // INSTRUMENT CHECK, and it runs first on purpose. It asserts the fixture actually reproduces the
    // defect — four of these five rows share one title — so the distinctness assertion below cannot
    // pass because the input was easy. Neutralise this line and the test can go vacuous.
    const titles = COLLIDING.map(p => p.variety_name)
    expect(dupes(titles).length).toBeGreaterThan(0)

    const texts = rowText()
    expect(texts).toHaveLength(COLLIDING.length)
    expect(dupes(texts)).toEqual([])
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('separates them on facts a person can act on — count, vendor, purchase date', async () => {
    await mount(COLLIDING)
    await openPicker()
    const texts = rowText()
    // Not "a second line exists": the specific facts, because a disambiguator made of an opaque id
    // would satisfy distinctness and tell the user nothing about which jar to reach for.
    expect(texts.some(t => t.includes('3 packet') && t.includes('Fedco'))).toBe(true)
    expect(texts.some(t => t.includes('1 packet') && t.includes('Johnny’s'))).toBe(true)
    expect(texts.some(t => t.includes('Jan 14, 2026'))).toBe(true)
  })

  it('says so out loud when two packets are identical in every recorded fact', async () => {
    // dup-c and dup-d differ in nothing but their row id. Printing the same string twice would leave
    // the user believing the list is repeating itself; naming the group size is the honest answer.
    await mount(COLLIDING)
    await openPicker()
    const texts = rowText()
    expect(texts.filter(t => t.includes('1 of 2 with identical details'))).toHaveLength(1)
    expect(texts.filter(t => t.includes('2 of 2 with identical details'))).toHaveLength(1)
  })

  it('holds the property for a WHOLE prod-scale list, not just the tidy fixture', async () => {
    // 60 packets over 12 cultivars, five each, with counts and vendors that repeat on purpose so
    // roughly a fifth of them are fully identical rows. If distinctness only held for hand-picked
    // inputs it would not be a property.
    const vendors = ['Fedco', 'Baker Creek', 'Johnny’s']
    const bulk = []
    for (let c = 0; c < 12; c++) {
      for (let n = 0; n < 5; n++) {
        bulk.push(packet({
          id: `bulk-${c}-${n}`,
          name: `Cultivar ${c}`, variety_name: `Cultivar ${c}`,
          quantity_on_hand: n % 3, source: vendors[n % 3],
        }))
      }
    }
    await mount(bulk)
    await openPicker()
    // Narrowed to one cultivar so the whole group is inside the render cap and the property is
    // measured over rows that are actually on screen.
    await type('Cultivar 7')
    const texts = rowText()
    expect(texts).toHaveLength(5)
    expect(dupes(texts)).toEqual([])
  })
})

describe('BUG-SEEDCANDIDATEAMBIG-001 — the list is filtered, capped and honest about it', () => {
  const many = Array.from({ length: 40 }, (_, n) => packet({
    id: `p-${n}`, name: `Packet ${n}`, variety_name: `Packet ${n}`, quantity_on_hand: n,
  }))

  it('caps the rendered rows and SAYS how many it is holding back', async () => {
    await mount(many)
    await openPicker()
    expect(rows()).toHaveLength(25)
    // Silent truncation is the failure this replaces, not a lesser version of it: a list that simply
    // stopped at 25 would read as "that is all of them".
    expect(screen.getByTestId('candidate-truncation').textContent)
      .toContain('Showing 25 of 40')
  })

  it('drops the truncation notice once the filter brings the list inside the cap', async () => {
    await mount(many)
    await openPicker()
    await type('Packet 3')
    // "Packet 3", "Packet 30".."Packet 39" — 11 rows, comfortably under the cap.
    expect(rows()).toHaveLength(11)
    expect(screen.queryByTestId('candidate-truncation')).toBeNull()
  })

  it('matches on variety, on name, and on source', async () => {
    await mount([
      packet({ id: 'a', name: 'row-a', variety_name: 'Sungold', source: 'Fedco' }),
      packet({ id: 'b', name: 'Kousa dogwood seed', variety_name: null, source: null }),
      packet({ id: 'c', name: 'row-c', variety_name: 'Costoluto', source: 'Baker Creek' }),
    ])
    await openPicker()
    await type('sungold')
    expect(rowText()).toHaveLength(1)
    await type('kousa')
    expect(rowText()[0]).toContain('Kousa dogwood seed')
    await type('baker')
    expect(rowText()[0]).toContain('Costoluto')
  })

  it('never offers a packet that is not active', async () => {
    // The server already decides a packet is live this way — v_sow_candidates' predicate is a strict
    // `i.status = 'active'` — so a retired or used-up row must not be trackable here either.
    await mount([
      packet({ id: 'live', name: 'Live', variety_name: 'Live' }),
      packet({ id: 'gone', name: 'Retired', variety_name: 'Retired', status: 'retired' }),
      packet({ id: 'used', name: 'Used up', variety_name: 'Used up', status: 'used_up' }),
    ])
    await openPicker()
    expect(rowText()).toHaveLength(1)
    expect(rowText()[0]).toContain('Live')
    // The count in the placeholder is the offerable set, not the raw seed list — it would otherwise
    // promise rows the filter can never reach.
    expect(screen.getByTestId('candidate-filter').getAttribute('placeholder')).toBe('Search 1 packet…')
  })

  it('tells "you have none" apart from "none match what you typed"', async () => {
    // The two send the user opposite ways, and one message for both teaches the wrong one.
    await mount([packet({ id: 'only' })])
    await openPicker()
    expect(screen.queryByTestId('candidate-no-match')).toBeNull()
    await type('zzzz')
    expect(rows()).toHaveLength(0)
    expect(screen.getByTestId('candidate-no-match').textContent).toContain('zzzz')
  })

  it('forgets the query when the sheet is closed, so re-opening never hides the packet', async () => {
    await mount([packet({ id: 'only', name: 'Brandywine', variety_name: 'Brandywine' })])
    await openPicker()
    await type('zzzz')
    expect(rows()).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByLabelText('Close')) })
    await openPicker()
    expect(screen.getByTestId('candidate-filter').value).toBe('')
    expect(rows()).toHaveLength(1)
  })

  it('still hands the CHOSEN row to the process step', async () => {
    // The picker's whole job. A filtered list that selected by index rather than by row would pick
    // the wrong packet the moment the filter reordered anything.
    await mount(COLLIDING)
    await openPicker()
    await type('Cherokee')
    await act(async () => { fireEvent.click(rows()[0]) })
    expect(screen.getByTestId('start-process-step').textContent).toContain('Cherokee Purple')
  })
})
