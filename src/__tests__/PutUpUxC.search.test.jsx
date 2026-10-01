// Put-Up UX pass R1, lane C — the page search field (PLAN-V3 D16; finding F20 "two clear × buttons").
//
// ONE CLEAR BUTTON. A native `type="search"` input draws its own cancel × in Chrome and Safari, beside
// this component's own. jsdom draws neither, so what is pinned here is the cause: the field is a text input
// that carries the searchbox ROLE (so every test and every screen reader finds it exactly as before), and
// the component renders exactly one clear control.
//
// NOT IN THIS LANE'S COMMITS: the field's new name and placeholder ("Search pantry and recipes"). The name is
// pinned by role AND name at six places in Pantry.test.jsx, two of them inside lane A's hunk; see the lane
// report. SEARCH_LABEL is still the one constant the name comes from.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PantrySearchBox, SEARCH_LABEL } from '../components/pantry/PantrySearch.jsx'

function Box({ initial = '', onClear = () => {} }) {
  const [v, setV] = useState(initial)
  return <PantrySearchBox value={v} onChange={setV} onClear={() => { onClear(); setV('') }} />
}

describe('the page search field', () => {
  it('is still a searchbox, found by its role and its name, inside a search landmark', () => {
    render(<Box />)
    const box = screen.getByRole('searchbox', { name: SEARCH_LABEL })
    expect(box.getAttribute('data-testid')).toBe('pantry-search')
    expect(screen.getByRole('search').contains(box)).toBe(true)
    expect(parseInt(box.style.minHeight, 10)).toBe(48)
  })

  it('draws no cancel control of its own: it is not a native search input, and still asks for the search keyboard', () => {
    render(<Box />)
    const box = screen.getByRole('searchbox')
    expect(box.getAttribute('type')).toBe('text')                          // a native type="search" brings a second ×
    expect(box.getAttribute('role')).toBe('searchbox')
    expect(box.getAttribute('inputmode')).toBe('search')
    expect(box.getAttribute('enterkeyhint')).toBe('search')
    expect(document.querySelector('input[type="search"]')).toBeNull()
  })

  it('has NO clear button while empty, and exactly ONE once it holds text', () => {
    const onClear = vi.fn()
    render(<Box onClear={onClear} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reaper' } })
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toBe(screen.getByRole('button', { name: 'Clear the search' }))
    expect(buttons[0].getAttribute('data-testid')).toBe('pantry-search-clear')
    expect(parseInt(buttons[0].style.minHeight, 10)).toBe(48)
    expect(parseInt(buttons[0].style.minWidth, 10)).toBe(48)
    fireEvent.click(buttons[0])
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('searchbox').value).toBe('')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
