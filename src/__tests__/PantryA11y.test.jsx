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

  // Put-Up UX pass R1: the door's two new targets (the way out to a batch, the preview's Change), with a
  // bought item chosen and the options open; and the Walk's Raw · In oil beside its discard choice.
  it('Put something up — the way out to a batch, As is chosen, the preview\'s Change, the options open', async () => {
    wire()
    const r = render(<PutSomethingUpSheet open onClose={() => {}} onSaved={() => {}} stockRows={ROWS} onStartBatchInstead={() => {}} />)
    fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: 'Garlic' } })
    fireEvent.click(await screen.findByTestId('door-place-id:loc-3'))
    fireEvent.click(screen.getByTestId('door-method-as_is'))
    fireEvent.click(screen.getByTestId('door-preview-change'))
    await screen.findByTestId('door-more-panel')
    expect(screen.getByTestId('door-start-batch-instead')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change — the date' })).toBeTruthy()
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PutSomethingUpSheet R1', rules: NEW_RULES })
  })

  it('Walk a place — a put-up group with Raw · In oil showing beside the discard choice', async () => {
    wire()
    localStorage.clear()
    const r = render(<MemoryRouter initialEntries={['/put-up?session=putup']}><WalkPlace /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('putup-walk-place-id:loc-3'))
    fireEvent.click(screen.getByTestId('putup-walk-when-unsure'))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
    fireEvent.change(screen.getByTestId('walk-what-name'), { target: { value: 'Reaper sauce' } })
    fireEvent.click(screen.getByTestId('walk-method-hot_sauce'))
    fireEvent.click(screen.getByTestId('walk-more'))
    fireEvent.click(screen.getByTestId('walk-raw'))
    expect(screen.getByRole('group', { name: 'Raw or in oil' })).toBeTruthy()
    await expectNoA11yViolations(r.container, { label: 'WalkPlace Raw · In oil', rules: NEW_RULES })
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

// R2 lane Df additions go directly under this line
// Put-Up R2a: the door's new fields, each in its fullest state, and the Walk's two additions.
describe('Put-Up R2a — the door\'s new fields and the Walk\'s exit question are clean (with nested-interactive)', () => {
  const tap = (id) => fireEvent.click(screen.getByTestId(id))
  async function door(props = {}) {
    wire()
    const r = render(<PutSomethingUpSheet open onClose={() => {}} onSaved={() => {}} stockRows={ROWS} {...props} />)
    fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: 'Reaper sauce' } })
    fireEvent.click(await screen.findByTestId('door-place-id:loc-3'))
    return r
  }

  it('Put something up — Raw and its line, the size with every unit and its echo, both disclosures, every where-from chip, "Which one?"', async () => {
    const r = await door()
    tap('door-method-hot_sauce'); tap('door-raw')
    tap('door-count-plus')
    tap('door-size-open'); tap('door-size-unit-more'); tap('door-size-unit-qt')
    fireEvent.change(screen.getByTestId('door-size-value'), { target: { value: '1' } })
    tap('door-more'); tap('door-inoil')
    tap('door-from'); tap('door-source-more'); tap('door-source-csa')
    expect(screen.getByTestId('door-size-echo').textContent).toBe('2 × 1 qt = 2 qt in all')
    expect(screen.getByRole('radiogroup', { name: 'Made with produce from' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /^Which one\?/ })).toBeTruthy()
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PutSomethingUpSheet R2a put-up', rules: NEW_RULES })
  })

  it('Put something up — the canning line and its link; How dry?; a half-filled size refused', async () => {
    const r = await door()
    tap('door-method-more'); tap('door-method-can_water_bath')
    expect(screen.getByRole('note')).toBe(screen.getByTestId('door-canning-line'))
    expect(screen.getByRole('link', { name: 'National Center for Home Food Preservation — opens in a new tab' })).toBeTruthy()
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PutSomethingUpSheet R2a canning line', rules: NEW_RULES })
    tap('door-method-dehydrate'); tap('door-texture-bends')
    expect(screen.getByRole('group', { name: 'How dry?' })).toBeTruthy()
    tap('door-size-open')
    fireEvent.change(screen.getByTestId('door-size-value'), { target: { value: '2' } })
    tap('door-save')
    expect(screen.getByTestId('door-error').textContent).toBe('Pick a unit for the size — or clear the size.')
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PutSomethingUpSheet R2a how dry, a size refused', rules: NEW_RULES })
  })

  it('Put something up — As is with How much and every unit, where-from as "Where it\'s from", Other with no name refused', async () => {
    const r = await door()
    tap('door-method-as_is')
    tap('door-amount-open'); tap('door-amount-unit-more'); tap('door-amount-unit-bag')
    fireEvent.change(screen.getByTestId('door-amount-value'), { target: { value: '2' } })
    tap('door-from'); tap('door-source-more'); tap('door-source-other')
    tap('door-save')
    expect(screen.getByRole('radiogroup', { name: "Where it's from" })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /^Where exactly\?/ }).getAttribute('aria-invalid')).toBe('true')
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PutSomethingUpSheet R2a as is', rules: NEW_RULES })
  })

  it('Put something up — opened from a planting: no where-from row, the second disclosure reads Notes', async () => {
    wire()
    const r = render(<PutSomethingUpSheet open onClose={() => {}} onSaved={() => {}}
      initialWhat={{ source: 'planting', name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper' }} />)
    fireEvent.click(await screen.findByTestId('door-place-id:loc-3'))
    tap('door-method-as_is'); tap('door-from')
    expect(screen.getByTestId('door-from').textContent).toBe('▾ Notes')
    expect(screen.queryByTestId('door-source')).toBeNull()
    await expectNoA11yViolations(r.container.ownerDocument.body, { label: 'PutSomethingUpSheet R2a planting', rules: NEW_RULES })
  })

  it('Walk a place — the canning line under the method row, and the exit asking about a typed name', async () => {
    wire()
    localStorage.clear()
    const r = render(<MemoryRouter initialEntries={['/put-up?session=putup']}><WalkPlace /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('putup-walk-place-id:loc-3'))
    tap('putup-walk-when-unsure'); tap('putup-walk-start')
    await screen.findByTestId('putup-walk-group')
    fireEvent.change(screen.getByTestId('walk-what-name'), { target: { value: 'Tomatoes' } })
    tap('walk-method-more'); tap('walk-method-can_pressure')
    expect(screen.getByRole('note')).toBe(screen.getByTestId('walk-canning-line'))
    tap('putup-walk-exit')
    expect(screen.getByTestId('putup-walk-unsaved-text').textContent).toBe('"Tomatoes" isn\'t saved.')
    expect(screen.getByRole('button', { name: 'Save it' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'End without it' })).toBeTruthy()
    await expectNoA11yViolations(r.container, { label: 'WalkPlace R2a canning line and exit question', rules: NEW_RULES })
  })
})
// R2 lane P additions go directly under this line
