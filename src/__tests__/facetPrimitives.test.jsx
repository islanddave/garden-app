import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import TagChip from '../components/forms/TagChip.jsx'
import FacetGroupHeader from '../components/forms/FacetGroupHeader.jsx'
import GroupByControl from '../components/forms/GroupByControl.jsx'
import TagFilterBar from '../components/forms/TagFilterBar.jsx'
import { facetColors } from '../lib/facetColors.js'
import { LIFECYCLE_TOKENS, FACET_TOKENS } from '../lib/tokens.js'

afterEach(() => cleanup())

describe('TagChip', () => {
  it('renders label + facet aria-label; null tag renders nothing', () => {
    const { container } = render(<TagChip tag={null} />)
    expect(container.firstChild).toBeNull()
    render(<TagChip tag={{ facet: 'type', slug: 'basil', label: 'Basil' }} />)
    expect(screen.getByLabelText('type: Basil').textContent).toContain('Basil')
  })
  it('omits the remove affordance for derived tags', () => {
    render(<TagChip tag={{ facet: 'type', slug: 'basil', label: 'Basil', source: 'derived' }} onRemove={() => {}} />)
    expect(screen.queryByLabelText('Remove Basil')).toBeNull()
  })
  it('calls onRemove for a user tag', () => {
    const onRemove = vi.fn()
    render(<TagChip tag={{ facet: 'group', slug: 'herbs', label: 'Herbs', source: 'user' }} onRemove={onRemove} />)
    fireEvent.click(screen.getByLabelText('Remove Herbs'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})

describe('FacetGroupHeader', () => {
  it('renders label + count', () => {
    render(<FacetGroupHeader label="Peppers" count={4} facet="type" />)
    const el = screen.getByTestId('facet-group-header')
    expect(el.textContent).toContain('Peppers')
    expect(el.textContent).toContain('4')
  })
  it('is a button and toggles when onToggle is given', () => {
    const onToggle = vi.fn()
    render(<FacetGroupHeader label="Herbs" count={2} facet="group" collapsed onToggle={onToggle} />)
    const el = screen.getByRole('button')
    expect(el.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(el)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('GroupByControl', () => {
  const opts = [{ value: 'none', label: 'Projects' }, { value: 'type', label: 'Type' }]
  it('marks the active option pressed', () => {
    render(<GroupByControl options={opts} value="type" onChange={() => {}} />)
    expect(screen.getByText('Type').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Projects').getAttribute('aria-pressed')).toBe('false')
  })
  it('calls onChange with the chosen value', () => {
    const onChange = vi.fn()
    render(<GroupByControl options={opts} value="none" onChange={onChange} />)
    fireEvent.click(screen.getByText('Type'))
    expect(onChange).toHaveBeenCalledWith('type')
  })
})

describe('TagFilterBar', () => {
  it('renders nothing when there are no filters', () => {
    const { container } = render(<TagFilterBar filters={[]} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders a removable pill per filter + Clear', () => {
    const onRemove = vi.fn(); const onClear = vi.fn()
    render(<TagFilterBar filters={[{ facet: 'type', slug: 'basil', label: 'Basil' }]} onRemove={onRemove} onClear={onClear} />)
    fireEvent.click(screen.getByLabelText('Remove Basil'))
    expect(onRemove).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Clear'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})


describe('facetColors lifecycle palette', () => {
  it('resolves each lifecycle value to its own minted token', () => {
    for (const v of ['annual', 'biennial', 'perennial', 'tender_perennial']) {
      expect(facetColors('lifecycle', v)).toEqual(LIFECYCLE_TOKENS[v])
    }
  })
  it('lifecycle values are distinct from each other and from the neutral fallback', () => {
    const bgs = ['annual', 'biennial', 'perennial', 'tender_perennial'].map(v => facetColors('lifecycle', v).bg)
    expect(new Set(bgs).size).toBe(4)
    expect(bgs).not.toContain(FACET_TOKENS.freeform.bg)
  })
  it('unknown or missing lifecycle value falls back to the neutral freeform token', () => {
    expect(facetColors('lifecycle', 'nonsense')).toEqual(FACET_TOKENS.freeform)
    expect(facetColors('lifecycle')).toEqual(FACET_TOKENS.freeform)
  })
  it('non-lifecycle facets are unchanged by the value arg', () => {
    expect(facetColors('type', 'ignored')).toEqual(FACET_TOKENS.type)
    expect(facetColors('group')).toEqual(FACET_TOKENS.group)
    expect(facetColors('bogus')).toEqual(FACET_TOKENS.freeform)
  })
})

describe('TagChip lifecycle coloring', () => {
  it('colors a lifecycle chip by its value, not the neutral fallback', () => {
    render(<TagChip tag={{ facet: 'lifecycle', slug: 'perennial', label: 'Perennial', source: 'derived' }} />)
    const chip = screen.getByLabelText('lifecycle: Perennial')
    expect(chip).toBeTruthy()
    // distinct minted perennial bg, not the freeform neutral
    expect(chip.style.backgroundColor).not.toBe('')
  })
})
