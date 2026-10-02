// Put-Up R2a, lane F — the recipe sheet (RecipeSheet.jsx), two follow-ups from the R1 render review:
//   · M4: "How long, and where" says what the length is counted from —
//         `optional — from put-up day to its discard date` in place of the bare `optional`
//         (the literal is the amended pin in RecipeSheet.r1.test.jsx; here: one constant, on an edit too).
//   · D6: a field with the cursor in it is kept clear of the pinned Save. The sheet had a sticky footer and
//         nothing that scrolled a focused field out from under it (with the keyboard up, at 426×492, the last
//         fields sat under the Save bar). It now uses kitchen/sheetScroll.js useFieldsClearOfFooter, as Put
//         it up does. jsdom lays nothing out, so the two boxes are stood in for and the ARITHMETIC is what
//         is pinned here; the picture is lane R's state at 426×492 (PLAN-R2-V4-RULINGS F-2).
// MUTATIONS (each run, each red here):
//   the sheet's content not listening for focus         -> "a field focused under the pinned Save…"
//   the footer not handed to the hook                   -> the same test
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
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

describe('the recipe sheet — a focused field is kept clear of the pinned Save (D6)', () => {
  // The sheet's scroller is the dialog panel; the footer's top edge is at y 411 (426×492, keyboard up).
  const FOOTER_TOP = 411
  function standIn() {
    const panel = screen.getByRole('dialog')
    let top = 0
    Object.defineProperty(panel, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v } })
    const footer = screen.getByTestId('recipe-sheet-footer')
    footer.getBoundingClientRect = () => ({ top: FOOTER_TOP, bottom: 492, left: 0, right: 426, width: 426, height: 81 })
    return panel
  }
  // A field whose bottom edge is at `bottom` on screen.
  const at = (el, bottom) => { el.getBoundingClientRect = () => ({ top: bottom - 44, bottom, left: 18, right: 400, width: 382, height: 44 }) }

  it('a field focused under the pinned Save is scrolled up until it sits 8 px above it: an input, a select, the notes', () => {
    mount({ recipe: RECIPE })
    const panel = standIn()
    expect(screen.getByTestId('recipe-sheet-footer').style.position).toBe('sticky')
    for (const id of ['recipe-made-text', 'recipe-bottle-unit', 'recipe-notes']) {
      panel.scrollTop = 0
      const field = screen.getByTestId(id)
      at(field, 489)                                                    // 78 px under the footer's top edge
      act(() => { field.focus() })
      expect([id, panel.scrollTop]).toEqual([id, 489 + 8 - FOOTER_TOP])
      act(() => { field.blur() })
    }
  })

  it('a field already above the footer is left where it is, and a chip is not a field', () => {
    mount({ recipe: RECIPE })
    const panel = standIn()
    const name = screen.getByTestId('recipe-name')
    at(name, 300)
    act(() => { name.focus() })
    expect(panel.scrollTop).toBe(0)
    const chip = screen.getByTestId('recipe-bottle-cooked')
    at(chip, 489)
    act(() => { chip.focus() })
    expect(panel.scrollTop).toBe(0)
  })

  // The keyboard opening is a viewport resize with the field already focused: the correction is made again.
  it('when the viewport shrinks under a focused field, the field is cleared again', async () => {
    mount({ recipe: RECIPE })
    const panel = standIn()
    const field = screen.getByTestId('recipe-made-text')
    at(field, 380)
    act(() => { field.focus() })
    expect(panel.scrollTop).toBe(0)
    at(field, 489)                                                      // the keyboard is up: the footer rose over it
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await new Promise(r => requestAnimationFrame(() => r()))
    })
    expect(panel.scrollTop).toBe(489 + 8 - FOOTER_TOP)
  })
})
