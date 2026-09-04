// V4-SOURCEREG-001 — SourcePicker: the shared provenance combobox with an inline mint.
//
// EVERY NEEDLE IN THIS FIXTURE IS UNIQUE. `textContent.includes` makes every row a candidate to
// satisfy every assertion, so a mutation keying on row text instead of the row's identity can
// survive a whole file of "shows(X)" assertions. Rows are therefore asserted by their `data-testid`
// (`sp-opt-<id>`), which names WHICH row satisfied the assertion, not merely that one did.
// No jest-dom (L-182): assert with plain DOM reads — getAttribute / .value / .textContent.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import SourcePicker from '../components/forms/SourcePicker.jsx'

// Server order: WHERE deleted_at IS NULL ORDER BY name ASC.
const SOURCES = [
  { id: 'src-baker', name: 'Baker Creek', kind: 'seed_company', locality: 'Mansfield, MO', address: null, website_url: null, notes: null },
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME', address: null, website_url: 'https://fedcoseeds.com', notes: null },
  { id: 'src-hadley', name: 'Hadley Garden Center', kind: 'garden_center', locality: 'Hadley, MA', address: null, website_url: null, notes: null },
  { id: 'src-jen', name: 'Jen', kind: 'person', locality: null, address: null, website_url: null, notes: null },
]
const KINDS = [
  { slug: 'seed_company', display_name: 'Seed company', sort_order: 10 },
  { slug: 'garden_center', display_name: 'Garden center', sort_order: 30 },
  { slug: 'person', display_name: 'Person', sort_order: 80 },
]

let postSource
let postKind

beforeEach(() => {
  postSource = vi.fn(() => Promise.reject(new Error('no POST expected')))
  postKind = vi.fn(() => Promise.reject(new Error('no POST expected')))
  fetchMock.mockReset()
  fetchMock.mockImplementation((path, init) => {
    if (init?.method === 'POST' && path === '/api/varieties/sources') return postSource(JSON.parse(init.body))
    if (init?.method === 'POST' && path === '/api/varieties/source-kinds') return postKind(JSON.parse(init.body))
    if (path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    if (path === '/api/varieties/source-kinds') return Promise.resolve(KINDS)
    return Promise.resolve([])
  })
})

const getPaths = () => fetchMock.mock.calls.filter(c => !c[1]).map(c => c[0])
const optionIds = () => screen.getAllByRole('option').map(o => o.getAttribute('data-testid'))

async function openPicker(props = {}) {
  const onChange = vi.fn()
  const utils = render(<SourcePicker onChange={onChange} {...props} />)
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  await screen.findByTestId('sp-opt-src-baker')
  return { input, onChange, ...utils }
}

// Drive the picker to the mint form for `query`, which must not exactly match a live source.
async function openMint(query, props = {}) {
  const ctx = await openPicker(props)
  fireEvent.change(ctx.input, { target: { value: query } })
  fireEvent.click(screen.getByTestId('sp-create-row'))
  await screen.findByTestId('sp-mint')
  return ctx
}

describe('SourcePicker — list + type-ahead', () => {
  it('loads sources on mount and lists every row, WITHOUT fetching the kind vocabulary', async () => {
    await openPicker()
    expect(optionIds()).toEqual([
      'sp-opt-src-baker', 'sp-opt-src-fedco', 'sp-opt-src-hadley', 'sp-opt-src-jen',
    ])
    expect(getPaths()).toEqual(['/api/varieties/sources'])
  })

  it('narrows by name, by locality, and by kind — and to the RIGHT row each time', async () => {
    const { input } = await openPicker()

    fireEvent.change(input, { target: { value: 'hadley' } })            // name + locality
    expect(optionIds()).toEqual(['sp-opt-src-hadley', 'sp-create-row'])

    fireEvent.change(input, { target: { value: 'clinton' } })           // locality only
    expect(optionIds()).toEqual(['sp-opt-src-fedco', 'sp-create-row'])

    fireEvent.change(input, { target: { value: 'garden center' } })     // kind slug, '_' folded
    expect(optionIds()).toEqual(['sp-opt-src-hadley', 'sp-create-row'])

    fireEvent.change(input, { target: { value: 'fed co' } })            // looseKey drops separators
    expect(optionIds()).toEqual(['sp-opt-src-fedco', 'sp-create-row'])
  })

  it('selecting a row hands the host BOTH the id and the row', async () => {
    const { onChange } = await openPicker()
    fireEvent.click(screen.getByTestId('sp-opt-src-hadley'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe('src-hadley')
    expect(onChange.mock.calls[0][1]).toMatchObject({ id: 'src-hadley', name: 'Hadley Garden Center' })
  })

  it('aria-selected marks the COMMITTED value, not the keyboard highlight', async () => {
    render(<SourcePicker value="src-hadley" onChange={() => {}} />)
    await screen.findByTestId('sp-chip')
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    await screen.findByTestId('sp-opt-src-hadley')

    // Highlight starts at index 0 (Baker) while the committed value is Hadley. Conflating the two —
    // VarietyPicker's mistake — would put aria-selected on Baker and false on Hadley.
    expect(screen.getByTestId('sp-opt-src-hadley').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('sp-opt-src-baker').getAttribute('aria-selected')).toBe('false')
  })

  it('the aria-live count node pre-exists its content, then reports the filtered count', async () => {
    const { container } = render(<SourcePicker onChange={() => {}} />)
    // A live region created together with its text is never announced — so it must be in the DOM
    // BEFORE the list opens.
    const live = container.querySelector('[aria-live="polite"]')
    expect(live).toBeTruthy()
    expect(live.textContent).toBe('')

    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    await screen.findByTestId('sp-opt-src-baker')
    expect(live.textContent).toBe('4 sources available')

    fireEvent.change(input, { target: { value: 'hadley' } })
    expect(live.textContent).toBe('1 source available, or create one')
  })
})

describe('SourcePicker — the create footer row', () => {
  it('is absent with no query, and absent when the query already names a live source', async () => {
    const { input } = await openPicker()
    expect(screen.queryByTestId('sp-create-row')).toBeNull()

    // Same looseKey fold the server's match_key collision uses: separators and case do not matter.
    fireEvent.change(input, { target: { value: 'fedco seeds' } })
    expect(screen.queryByTestId('sp-create-row')).toBeNull()
    expect(optionIds()).toEqual(['sp-opt-src-fedco'])

    fireEvent.change(input, { target: { value: 'FEDCO  SEEDS' } })
    expect(screen.queryByTestId('sp-create-row')).toBeNull()
  })

  it('renders whenever the query can change the answer — capability, not volume', async () => {
    const { input } = await openPicker()

    // Zero matches.
    fireEvent.change(input, { target: { value: 'Agway' } })
    expect(optionIds()).toEqual(['sp-create-row'])

    // A partial match still offers the mint: "Fedco" is not "Fedco Seeds", and burying the create
    // path behind "no results" would make a second source with a similar name unmintable.
    fireEvent.change(input, { target: { value: 'Fedco' } })
    expect(optionIds()).toEqual(['sp-opt-src-fedco', 'sp-create-row'])
    expect(screen.getByTestId('sp-create-row').textContent).toContain('Create “Fedco”')
  })

  it('allowCreate={false} suppresses it entirely', async () => {
    const { input } = await openPicker({ allowCreate: false })
    fireEvent.change(input, { target: { value: 'Agway' } })
    expect(screen.queryByTestId('sp-create-row')).toBeNull()
  })

  it('COUNTS toward keyboard nav: ArrowDown past the last source reaches it and Enter opens the mint', async () => {
    const { input, onChange } = await openPicker()
    fireEvent.change(input, { target: { value: 'Fedco' } })
    // One source row (index 0) + the create row (index 1).
    expect(optionIds()).toEqual(['sp-opt-src-fedco', 'sp-create-row'])

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant'))
      .toBe(screen.getByTestId('sp-create-row').id)

    fireEvent.keyDown(input, { key: 'Enter' })
    // The positive assertion: the mint form is on screen. If the create row did not count, the
    // highlight would have clamped to the Fedco row and Enter would have SELECTED it.
    expect(screen.getByTestId('sp-mint')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('SourcePicker — the mint form', () => {
  it('prefills the name from the query, posts the whole payload, and CONTINUES by selecting the new source', async () => {
    const created = { id: 'src-agway', name: 'Agway', kind: 'garden_center', locality: 'Greenfield, MA', address: null, website_url: null, notes: null }
    postSource = vi.fn(() => Promise.resolve(created))

    const { onChange } = await openMint('Agway')
    expect(screen.getByTestId('sp-mint-name').value).toBe('Agway')

    fireEvent.change(screen.getByTestId('sp-mint-kind'), { target: { value: 'garden_center' } })
    fireEvent.change(screen.getByTestId('sp-mint-locality'), { target: { value: 'Greenfield, MA' } })
    fireEvent.click(screen.getByTestId('sp-mint-submit'))

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(postSource).toHaveBeenCalledWith({ name: 'Agway', kind: 'garden_center', locality: 'Greenfield, MA' })
    expect(onChange.mock.calls[0][0]).toBe('src-agway')
    expect(onChange.mock.calls[0][1]).toMatchObject({ id: 'src-agway', name: 'Agway' })
    // Continued, not stopped at "created": the panel is closed and the mint form is gone.
    expect(screen.queryByTestId('sp-mint')).toBeNull()
  })

  it('the kind vocabulary is fetched only once the mint opens, and its options render', async () => {
    await openPicker()
    expect(getPaths()).toEqual(['/api/varieties/sources'])

    const { input } = { input: screen.getByRole('combobox') }
    fireEvent.change(input, { target: { value: 'Agway' } })
    fireEvent.click(screen.getByTestId('sp-create-row'))
    await screen.findByTestId('sp-mint')

    await waitFor(() => expect(getPaths()).toContain('/api/varieties/source-kinds'))
    await waitFor(() =>
      expect([...screen.getByTestId('sp-mint-kind').options].map(o => o.value))
        .toEqual(['', 'seed_company', 'garden_center', 'person']))
  })

  it('a steer renders a real Use "<name>" button that ADOPTS the existing row', async () => {
    postSource = vi.fn(() => Promise.reject(Object.assign(
      new Error('“Baker Creek” is already in your sources.'),
      { body: { reason: 'exists', existing: SOURCES[0] } },
    )))

    const { onChange } = await openMint('Bakers Creek')
    fireEvent.click(screen.getByTestId('sp-mint-submit'))

    const adopt = await screen.findByTestId('sp-adopt')
    // Adopting is the CORRECT outcome, so it is a button naming the row — not a dead error string.
    expect(adopt.textContent).toContain('Use “Baker Creek”')
    expect(screen.getByRole('alert').textContent).toContain('already in your sources')

    fireEvent.click(adopt)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe('src-baker')
    expect(onChange.mock.calls[0][1]).toMatchObject({ id: 'src-baker', name: 'Baker Creek' })
  })

  it('mints a KIND from inside the mint form and selects it — display_name only, never a slug', async () => {
    const mintedKind = { slug: 'seed_library', display_name: 'Seed Library', sort_order: 130 }
    postKind = vi.fn(() => Promise.resolve(mintedKind))

    await openMint('Amherst Seed Library')
    await waitFor(() => expect(getPaths()).toContain('/api/varieties/source-kinds'))

    fireEvent.click(screen.getByTestId('sp-kind-add'))
    fireEvent.change(screen.getByTestId('sp-kind-name'), { target: { value: 'Seed Library' } })
    fireEvent.click(screen.getByTestId('sp-kind-submit'))

    await waitFor(() => expect(screen.getByTestId('sp-mint-kind').value).toBe('seed_library'))
    // The slug is a PRIMARY KEY and an FK target — server-derived, never sent by the client.
    expect(postKind).toHaveBeenCalledWith({ display_name: 'Seed Library' })
    // Minted at max+10, so it lands at the TAIL of the select, below the common seeded kinds.
    expect([...screen.getByTestId('sp-mint-kind').options].map(o => o.value))
      .toEqual(['', 'seed_company', 'garden_center', 'person', 'seed_library'])
    // The sub-panel closed behind itself rather than leaving a half-filled form open.
    expect(screen.queryByTestId('sp-kind-name')).toBeNull()
  })

  it('a kind steer offers its own adopt button', async () => {
    postKind = vi.fn(() => Promise.reject(Object.assign(
      new Error('“Garden centre” folds onto “Garden center”.'),
      { body: { reason: 'label', existing: KINDS[1] } },
    )))

    await openMint('Amherst Nursery Co')
    fireEvent.click(screen.getByTestId('sp-kind-add'))
    fireEvent.change(screen.getByTestId('sp-kind-name'), { target: { value: 'Garden centre' } })
    fireEvent.click(screen.getByTestId('sp-kind-submit'))

    const adopt = await screen.findByTestId('sp-kind-adopt')
    expect(adopt.textContent).toContain('Use “Garden center”')
    fireEvent.click(adopt)
    await waitFor(() => expect(screen.getByTestId('sp-mint-kind').value).toBe('garden_center'))
  })

  it('lives inside a host <form> without submitting it — every mint button is type="button"', async () => {
    const created = { id: 'src-agway', name: 'Agway', kind: null, locality: null }
    postSource = vi.fn(() => Promise.resolve(created))
    const onSubmit = vi.fn(e => e.preventDefault())

    render(
      <form onSubmit={onSubmit}>
        <SourcePicker onChange={() => {}} />
      </form>,
    )
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    await screen.findByTestId('sp-opt-src-baker')
    fireEvent.change(input, { target: { value: 'Agway' } })
    fireEvent.click(screen.getByTestId('sp-create-row'))
    await screen.findByTestId('sp-mint')

    fireEvent.click(screen.getByTestId('sp-kind-add'))
    fireEvent.click(screen.getByTestId('sp-mint-submit'))

    // Positive: the mint actually ran. Negative: it did not save the host's plant on the way.
    await waitFor(() => expect(postSource).toHaveBeenCalled())
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('SourcePicker — exits and the disabled state', () => {
  it('Escape closes the panel and KEEPS focus in the combobox (APG)', async () => {
    const { input } = await openPicker()
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    // Escape must not read as "leave the field entirely" — a blur here drops the TalkBack cursor.
    expect(document.activeElement).toBe(input)
  })

  it('the visible ✕ closes the panel — an invisible dismissal is not a discoverable exit', async () => {
    const { input, onChange } = await openPicker()
    fireEvent.click(screen.getByTestId('sp-close'))

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    // Closing is not choosing.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disabled says WHY and cannot be opened', async () => {
    render(<SourcePicker onChange={() => {}} disabled disabledHint="— add the plant first —" />)
    const input = screen.getByRole('combobox')
    expect(input.disabled).toBe(true)
    expect(input.getAttribute('placeholder')).toBe('— add the plant first —')

    fireEvent.focus(input)
    fireEvent.click(input)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByTestId('sp-close')).toBeNull()
  })

  it('label names the field, so both axes can sit on one form', async () => {
    render(
      <>
        <SourcePicker onChange={() => {}} />
        <SourcePicker onChange={() => {}} label="Acquired from" />
      </>,
    )
    expect(screen.getByRole('combobox', { name: 'Source' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Acquired from' })).toBeTruthy()

    // Option ids are namespaced per instance, so aria-activedescendant on one picker can never
    // resolve to the other's row.
    const [a, b] = screen.getAllByRole('combobox')
    fireEvent.focus(a)
    await screen.findAllByTestId('sp-opt-src-baker')
    fireEvent.keyDown(a, { key: 'ArrowDown' })
    fireEvent.focus(b)
    await waitFor(() => expect(screen.getAllByRole('listbox')).toHaveLength(2))
    fireEvent.keyDown(b, { key: 'ArrowDown' })
    expect(a.getAttribute('aria-activedescendant'))
      .not.toBe(b.getAttribute('aria-activedescendant'))
  })
})
