// Put-Up B′ release 2 — the new Pantry components join the a11y smoke set (V4 §6.6: "new components join
// the a11y smoke set", with `nested-interactive` on the new components' entries), the same way
// a11yGate.test.jsx does it for the 1a/1b/F sheets: each rendered in its FULLEST state, then axe.
// Plus the two §6.6 rules axe cannot see in jsdom: every row target, Used one / Used it up and Undo are
// 48 px (asserted on the inline min-height, the only geometry jsdom has), and the row's open target and
// its action are SIBLINGS, never nested.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: null }) }))

import { expectNoA11yViolations, A11Y_RULES } from './helpers/axe.js'
import PantryView from '../components/pantry/PantryView.jsx'
import PantryRowSheet from '../components/pantry/PantryRowSheet.jsx'
import PutSomethingUpSheet from '../components/pantry/PutSomethingUpSheet.jsx'
import WalkPlace from '../components/pantry/WalkPlace.jsx'

afterEach(() => cleanup())
const NEW_RULES = [...A11Y_RULES, 'nested-interactive']

const FRIDGE = PLACES[2]
const ROWS = [
  jarRow({ stock_id: 'j1', name: 'Megatron reaper', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge', from_garden: true, where_from: 'Petri Dish' }),
  jarRow({ stock_id: 'j2', name: 'Reaper, frozen', stock_mode: 'weighed', grams_left: 92, count_left: null, count_made: null }),
  itemRow({ stock_id: 'i1', name: 'Oat milk', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge', notes: 'barista' }),
]
function wire() {
  const f = pantryFetch({ rows: ROWS, lineSearch: { plantings: [{ plant_id: 'p1', label: 'Megatron jalapeño', crop_type_slug: 'pepper', recent_picks: [] }], put_ups: [] } })
  stableFetch.fn = f
  return f
}

describe('Put-Up B′ — the Pantry components are clean (with nested-interactive)', () => {
  it('the Pantry list: groups, rows, a used row with its Undo, the bridge and a completion line', async () => {
    const f = wire()
    const recent = { 'put_up:j1': { row: ROWS[0], action: 'used_one', use: { id: 'u1' }, jar: { remaining_count: 3 } } }
    const { container } = render(
      <PantryView fetch={f} group="place" onGroupChange={() => {}} rows={ROWS} loading={false} error={false} onReload={() => {}}
        recent={recent} onRecent={() => {}} useSoonOnly onClearUseSoon={() => {}} showBridge onDismissBridge={() => {}}
        completion={{ route: 'jar', saved: { id: 'jar-9', label: 'Corn' }, place: PLACES[0], text: 'Corn — put up · Chest Freezer 1' }}
        onCompletionDone={() => {}} />,
    )
    await screen.findByTestId('pantry-view')
    await expectNoA11yViolations(container, { label: 'PantryView', rules: NEW_RULES })
  })

  it('the row targets, the inline action and Undo are 48 px, and never nested', () => {
    const f = wire()
    const recent = { 'put_up:j1': { row: ROWS[0], action: 'used_one', use: { id: 'u1' }, jar: { remaining_count: 3 } } }
    render(<PantryView fetch={f} group="place" onGroupChange={() => {}} rows={ROWS} loading={false} error={false}
      onReload={() => {}} recent={recent} onRecent={() => {}} />)
    const targets = [
      ...screen.getAllByTestId(/^pantry-row-open-/), ...screen.getAllByTestId(/^pantry-row-action-/), screen.getByTestId('pantry-row-undo-put_up:j1'),
    ]
    expect(targets.length).toBe(3 + 3 + 1)
    for (const t of targets) expect(parseInt(t.style.minHeight, 10), t.getAttribute('data-testid')).toBeGreaterThanOrEqual(48)
    for (const open of screen.getAllByTestId(/^pantry-row-open-/)) expect(open.querySelector('button, a, input')).toBeNull()
    // Names start with the visible text (V4 §6.6).
    expect(screen.getByTestId('pantry-row-action-put_up:j1').getAttribute('aria-label')).toBe('Used one — Megatron reaper')
  })

  it('the row sheet — a put-up with Gave it away open, and a bought item\'s Edit', async () => {
    wire()
    let r = render(<PantryRowSheet row={ROWS[0]} fetch={stableFetch.fn} onClose={() => {}} onHowItWasMade={() => {}} />)
    fireEvent.click(screen.getByTestId('row-give'))
    await screen.findByTestId('give-panel')
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PantryRowSheet give', rules: NEW_RULES })
    cleanup()
    r = render(<PantryRowSheet row={ROWS[2]} fetch={stableFetch.fn} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('row-edit'))
    fireEvent.click(await screen.findByTestId('item-edit-remove'))
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PantryRowSheet item edit', rules: NEW_RULES })
  })

  // Put-Up UX pass R1: the two panels the pass adds to the row sheet, each in its fullest state.
  it('the row sheet — Went bad\'s count panel, and the Move panel with a place tapped and its rule line said', async () => {
    wire()
    let r = render(<PantryRowSheet row={ROWS[0]} fetch={stableFetch.fn} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    await screen.findByTestId('went-bad-panel')
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PantryRowSheet went bad', rules: NEW_RULES })
    cleanup()
    r = render(<PantryRowSheet row={ROWS[0]} fetch={stableFetch.fn} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('row-move'))
    fireEvent.click(await screen.findByTestId('move-place-id:loc-1'))
    fireEvent.click(screen.getByTestId('move-when-earlier'))
    fireEvent.click(await screen.findByTestId('move-when-pickdate'))
    await screen.findByTestId('move-when-date')
    expect(screen.getByTestId('move-rule').textContent).not.toBe('')
    expect(screen.getByRole('group', { name: 'Move it' })).toBeTruthy()
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PantryRowSheet move', rules: NEW_RULES })
  })

  it('Put something up — a planting chosen, a place, a method, More open', async () => {
    wire()
    const r = render(<PutSomethingUpSheet open onClose={() => {}} onSaved={() => {}} stockRows={ROWS} />)
    fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: 'mega' } })
    fireEvent.click(await screen.findByTestId('door-what-hit-planting:p1', {}, { timeout: 2000 }))
    fireEvent.click(await screen.findByTestId('door-place-id:loc-3'))
    fireEvent.click(screen.getByTestId('door-method-hot_sauce'))
    fireEvent.click(screen.getByTestId('door-more'))
    fireEvent.click(screen.getByTestId('door-when-earlier'))
    fireEvent.click(screen.getByTestId('door-when-last_month'))
    fireEvent.click(screen.getByTestId('door-discard-date'))
    fireEvent.click(screen.getByTestId('door-place-new'))
    await screen.findByTestId('door-preview')
    expect(screen.getByRole('dialog', { name: 'Put something up' })).toBeTruthy()
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PutSomethingUpSheet', rules: NEW_RULES })
  })

  it('Walk a place — setup, then a group with More open and "Already logged here" open', async () => {
    wire()
    localStorage.clear()
    const r = render(<MemoryRouter initialEntries={['/put-up?session=putup']}><WalkPlace /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('putup-walk-place-id:loc-3'))
    fireEvent.click(screen.getByTestId('putup-walk-when-unsure'))
    await expectNoA11yViolations(r.container, { label: 'WalkPlace setup', rules: NEW_RULES })
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
    fireEvent.change(screen.getByTestId('walk-what-name'), { target: { value: 'Oat' } })
    fireEvent.click(screen.getByTestId('walk-method-as_is'))
    fireEvent.click(screen.getByTestId('walk-more'))
    fireEvent.click(screen.getByTestId('putup-walk-here-toggle'))
    await screen.findByTestId('putup-walk-here')
    await expectNoA11yViolations(r.container, { label: 'WalkPlace group', rules: NEW_RULES })
  })
})
