// V5-SEEDMULTIPARENT-001 release 2b — PlantingSelect's three optional props for the "add a plant" adder:
// excludeIds (the plantings the jar already names), emptyText (why the list is empty) and footerNote (one
// non-option row under the list). With all three absent the picker renders exactly as it did.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'

const PLANTS = [
  { id: 'pl-1', name: 'Carmen east', quantity: 3, variety_id: 'v-car',
    variety_ref: { id: 'v-car', name: 'Carmen', crop_type_slug: 'pepper' } },
  { id: 'pl-2', name: 'Carmen west', quantity: 2, variety_id: 'v-car',
    variety_ref: { id: 'v-car', name: 'Carmen', crop_type_slug: 'pepper' } },
  { id: 'pl-3', name: 'Ajvarski', quantity: 4, variety_id: 'v-ajv',
    variety_ref: { id: 'v-ajv', name: 'Ajvarski', crop_type_slug: 'pepper' } },
  { id: 4, name: 'Sungold', quantity: 1, variety_id: 'v-sun',
    variety_ref: { id: 'v-sun', name: 'Sungold', crop_type_slug: 'tomato' } },
]

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue([])
})

const open = () => {
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  return input
}
const optionIds = () => screen.queryAllByRole('option').map((o) => o.getAttribute('data-testid'))

describe('PlantingSelect — excludeIds', () => {
  it('drops the listed rows and keeps the rest in order', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} excludeIds={['pl-1', 'pl-3']} />)
    open()
    expect(optionIds()).toEqual(['ps-opt-pl-2', 'ps-opt-4'])
  })

  it('compares by String(id): a numeric row id is excluded by its string', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} excludeIds={['4']} />)
    open()
    expect(optionIds()).toEqual(['ps-opt-pl-3', 'ps-opt-pl-1', 'ps-opt-pl-2'])
  })

  it('applies with the crop scope and with the typed query', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} cropSlug="pepper" excludeIds={['pl-1']} />)
    const input = open()
    expect(optionIds()).toEqual(['ps-opt-pl-3', 'ps-opt-pl-2'])
    fireEvent.change(input, { target: { value: 'carmen' } })
    expect(optionIds()).toEqual(['ps-opt-pl-2'])
  })

  it('an excluded row cannot be reached from the keyboard', () => {
    const onChange = vi.fn()
    render(<PlantingSelect plants={PLANTS} onChange={onChange} excludeIds={['pl-3']} />)
    const input = open()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('pl-1', expect.objectContaining({ id: 'pl-1' }))
  })

  it('follows the prop when it changes', () => {
    const { rerender } = render(<PlantingSelect plants={PLANTS} onChange={() => {}} excludeIds={['pl-1']} />)
    open()
    expect(optionIds()).not.toContain('ps-opt-pl-1')
    rerender(<PlantingSelect plants={PLANTS} onChange={() => {}} excludeIds={['pl-2']} />)
    expect(optionIds()).toContain('ps-opt-pl-1')
    expect(optionIds()).not.toContain('ps-opt-pl-2')
  })

  it('an empty array excludes nothing', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} excludeIds={[]} />)
    open()
    expect(optionIds()).toHaveLength(4)
  })
})

describe('PlantingSelect — emptyText', () => {
  it('replaces "No plantings yet." when everything is excluded', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} cropSlug="tomato" excludeIds={['4']}
      emptyText="Every tomato planting is already on this jar." />)
    open()
    expect(screen.getByText('Every tomato planting is already on this jar.')).toBeTruthy()
    expect(screen.queryByText('No plantings yet.')).toBeNull()
  })

  it('does not replace the "no match" text for a typed query', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} emptyText="Nothing left to add." />)
    const input = open()
    fireEvent.change(input, { target: { value: 'zzz-nothing' } })
    expect(screen.getByText(/No plantings match “zzz-nothing”\./)).toBeTruthy()
    expect(screen.queryByText('Nothing left to add.')).toBeNull()
  })

  it('is not shown while there are rows', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} emptyText="Nothing left to add." />)
    open()
    expect(screen.queryByText('Nothing left to add.')).toBeNull()
  })
})

describe('PlantingSelect — footerNote', () => {
  it('is one row under the options, and is not an option', () => {
    render(<PlantingSelect plants={PLANTS} onChange={() => {}} footerNote="Only pepper plantings are listed." />)
    open()
    const note = screen.getByTestId('ps-footer-note')
    expect(note.textContent).toBe('Only pepper plantings are listed.')
    expect(note.getAttribute('role')).toBe('presentation')
    expect(screen.getAllByRole('option')).toHaveLength(4)
    const rows = [...screen.getByRole('listbox').children]
    expect(rows[rows.length - 1]).toBe(note)
  })

  it('shows under the empty text too', () => {
    render(<PlantingSelect plants={[]} onChange={() => {}} emptyText="Nothing left to add." footerNote="Only pepper plantings are listed." />)
    open()
    const rows = [...screen.getByRole('listbox').children].map((li) => li.textContent)
    expect(rows).toEqual(['Nothing left to add.', 'Only pepper plantings are listed.'])
  })
})

describe('PlantingSelect — none of the three passed', () => {
  it('renders the list it always did: every row, "No plantings yet." when empty, no footer row', () => {
    const { unmount } = render(<PlantingSelect plants={PLANTS} onChange={() => {}} />)
    open()
    expect(optionIds()).toEqual(['ps-opt-pl-3', 'ps-opt-pl-1', 'ps-opt-pl-2', 'ps-opt-4'])
    expect(screen.queryByTestId('ps-footer-note')).toBeNull()
    expect([...screen.getByRole('listbox').children]).toHaveLength(4)
    unmount()
    render(<PlantingSelect plants={[]} onChange={() => {}} />)
    open()
    expect([...screen.getByRole('listbox').children].map((li) => li.textContent)).toEqual(['No plantings yet.'])
  })

  it('the markup is byte-identical to the same picker with the three props passed empty', () => {
    // React's useId gives each mount its own listbox id (ps-list-<token>); that token is the one thing
    // two mounts of the same picker differ by, so it is folded before comparing.
    const markup = (r) => r.container.innerHTML.replace(/ps-list-[^"-]+/g, 'ps-list-ID')
    const a = render(<PlantingSelect id="p" plants={PLANTS} onChange={() => {}} />)
    fireEvent.focus(a.getByRole('combobox'))
    const bare = markup(a)
    a.unmount()
    const b = render(<PlantingSelect id="p" plants={PLANTS} onChange={() => {}} excludeIds={undefined} emptyText={undefined} footerNote={undefined} />)
    fireEvent.focus(b.getByRole('combobox'))
    expect(markup(b)).toBe(bare)
    expect(bare).toContain('ps-list-ID')
  })
})
