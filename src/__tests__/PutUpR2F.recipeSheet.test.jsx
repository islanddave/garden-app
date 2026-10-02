// Put-Up R2a, lane F — the recipe sheet (RecipeSheet.jsx), two follow-ups from the R1 render review:
//   · M4: "How long, and where" says what the length is counted from —
//         `optional — from put-up day to its discard date` in place of the bare `optional`
//         (the literal is the amended pin in RecipeSheet.r1.test.jsx; here: one constant, on an edit too).
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))

import RecipeSheet from '../components/recipes/RecipeSheet.jsx'
import { KEEPS_LABEL, KEEPS_HELP } from '../components/recipes/recipes.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const RECIPE = {
  id: 'r1', user_id: 'user_dave', name: 'Roll for Initiative', kind: 'ferment', recipe_type_id: null, type_label: null,
  link_url: null, notes: 'Blend.', keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge', lines: [], batches: [],
}
const mount = (props = {}) => render(<RecipeSheet open types={[]} fetch={fetchSpy} onClose={() => {}} onSaved={() => {}} {...props} />)
const legend = () => screen.getByTestId('recipe-keeps').querySelector('legend')

beforeEach(() => {
  fetchSpy.mockReset(); fetchSpy.mockImplementation(() => Promise.resolve(null))
  localStorage.clear(); clearReloadBlocks()
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('the recipe sheet — "How long, and where" says what it counts (M4)', () => {
  it('the helper is one constant, read after "optional — ", on a new recipe and on an edit', () => {
    expect([KEEPS_LABEL, KEEPS_HELP]).toEqual(['How long, and where', 'from put-up day to its discard date'])
    mount()
    expect(legend().textContent).toBe(`${KEEPS_LABEL} optional — ${KEEPS_HELP}`)
    cleanup()
    mount({ recipe: RECIPE })
    expect(legend().textContent).toBe('How long, and where optional — from put-up day to its discard date')
    // The helper is the quiet part of the legend, as "optional" was: the label keeps its own weight.
    const quiet = legend().querySelector('span')
    expect(quiet.textContent).toBe('optional — from put-up day to its discard date')
    expect(quiet.style.fontWeight).toBe('400')
  })
})
