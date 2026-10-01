// Put-Up UX pass R1, lane A — the page header's doors (PLAN-V3 D10) and Going now's own (D10, F25), through
// the REAL page and the real segment bodies.
//
// WHAT THIS FILE HOLDS, each with the mutation that proves it:
//   · two conditional header buttons with fixed testids: on Going now a filled "Start a batch"
//     (start-a-batch); on Pantry, Recipes and Log a put-up a filled "Put something up" (putup-door);
//   · on Going now "Put something up" stays ONE tap away, as a quiet 48px link in the row that holds
//     "Walk a place", under the same testid — so there is exactly one putup-door on screen, always;
//   · ONE filled button per screen state, and one min-width for it on every segment;
//   · with search text up the button is Put something up (the results are pantry results);
//   · "Start a batch" opens Put something up when the Start sheet is absent;
//   · Going now's load error offers Try again, which re-reads the list in place.
// MUTATIONS: make the header button one element that only switches its label -> "exactly one putup-door"
// and "start-a-batch is absent on …" red; fill the empty card's button -> "ONE filled button" reds.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182). Nothing here reads a clock.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'pepper', display_name: 'Peppers', category: 'vegetable' }], loading: false }),
}))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'
import { P } from '../lib/constants.js'

const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const GREEN = toRgb(P.green)
const MASH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: '2026-09-20T13:00:00.000Z', start_precision: 'day', first_recorded_at: '2026-09-20T13:00:00.000Z',
  expected_days_min: null, expected_days_max: null, suspended_at: null, closed_at: null,
  current_stage_kind: 'started', current_stage_label: null, current_stage_entered_at: '2026-09-20T13:00:00.000Z',
  input_count: '0', output_count: '0', last_ph_reading: null, last_ph_read_at: null,
}
const RECIPES = [
  { id: 'r1', name: 'Roll for Initiative', kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, batch_count: 2 },
  { id: 'r3', name: 'Mystery mash', kind: null, recipe_type_id: null, type_label: null, batch_count: 0 },
]
let going, goingFails
function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (method !== 'GET') return Promise.resolve(null)
    if (path.startsWith('/api/kitchen-batches?state=going')) {
      return goingFails ? Promise.reject(new Error('502')) : Promise.resolve({ state: 'going', batches: going })
    }
    if (/^\/api\/kitchen-batches\/[^/?]+$/.test(path)) return Promise.resolve({ ...MASH, inputs: [], stages: [], outputs: [] })
    if (path.startsWith('/api/kitchen-batches')) return Promise.resolve({ state: 'all', batches: [] })
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [] })
    if (path === '/api/recipes') return Promise.resolve({ recipes: RECIPES })
    if (path === '/api/recipes/types') return Promise.resolve({ types: [] })
    if (path === '/api/storage-locations') return Promise.resolve([])
    if (path.startsWith('/api/plants?')) return Promise.resolve([])
    if (path.startsWith('/api/harvests')) return Promise.resolve({ aggregates: { crops: [] }, harvests: [] })
    return Promise.resolve(null)
  })
}
const gets = (p) => fetchMock.mock.calls.filter(([path, o]) => path === p && (o?.method ?? 'GET') === 'GET').length

function StubStartSheet({ onClose, initialLabel }) {
  return (
    <div role="dialog" aria-label="Start a batch" data-testid="stub-start" data-initial-label={String(initialLabel ?? '')}>
      <button type="button" onClick={onClose}>Close</button>
    </div>
  )
}
function Probe() {
  const loc = useLocation()
  return (
    <>
      <div data-testid="probe-loc">{loc.pathname + loc.search}</div>
      <div data-testid="probe-state">{JSON.stringify(loc.state ?? null)}</div>
    </>
  )
}
function renderPage(entry = '/put-up', props = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
      <PutUp StartBatchSheet={StubStartSheet} {...props} />
    </MemoryRouter>,
  )
}
const pick = (name) => fireEvent.click(screen.getByRole('radio', { name }))
// A filled BUTTON, as the "one per screen" rule means it: an action painted the CTA green. A chosen chip is
// painted the same green and is not one — it is a selection (aria-pressed), and the Recipes list's "All"
// filter chip is chosen at open.
const filled = () => [...document.body.querySelectorAll('button')]
  .filter(b => b.style.backgroundColor === GREEN && b.getAttribute('aria-pressed') == null && b.getAttribute('role') !== 'radio')
// The segment a bare open settles on is a rule of its own (PutUp.landing.test.jsx): wait for the list read
// to land, then pick the segment by hand, so nothing here rests on it.
async function onSegment(name) {
  await waitFor(() => expect(gets('/api/kitchen-batches?state=going')).toBe(1))
  await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Put-Up view' })).toBeTruthy())
  pick(name)
  await waitFor(() => expect(screen.getByRole('radio', { name }).getAttribute('aria-checked')).toBe('true'))
}

beforeEach(() => { fetchMock.mockReset(); going = [MASH]; goingFails = false; wire(); localStorage.clear(); sessionStorage.clear() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the header\'s filled button follows the segment (PLAN-V3 D10)', () => {
  it('on Going now it is "Start a batch", and "Put something up" is a quiet link beside "Walk a place"', async () => {
    renderPage()
    await onSegment('Going now')
    const start = screen.getByTestId('start-a-batch')
    expect([start.tagName, start.textContent, start.style.backgroundColor]).toEqual(['BUTTON', 'Start a batch', GREEN])
    // Exactly ONE putup-door, and here it is the quiet one: no fill, underlined, 48px, in the walk's row.
    const doors = screen.getAllByTestId('putup-door')
    expect(doors).toHaveLength(1)
    const door = doors[0]
    expect(door.textContent).toBe('Put something up')
    expect([door.style.background, door.style.textDecoration, door.style.minHeight]).toEqual(['none', 'underline', '48px'])
    const walk = screen.getByTestId('putup-walk-door')
    expect(door.parentElement).toBe(walk.parentElement)
    expect(!!(walk.compareDocumentPosition(door) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    // The quiet link wears the walk door's own style: one look for the row.
    expect(door.getAttribute('style')).toBe(walk.getAttribute('style'))
  })

  it.each(['Pantry', 'Recipes', 'Log a put-up'])('on %s it is "Put something up", and there is no Start a batch', async (name) => {
    renderPage()
    await onSegment(name)
    const doors = screen.getAllByTestId('putup-door')
    expect(doors).toHaveLength(1)
    expect([doors[0].tagName, doors[0].textContent, doors[0].style.backgroundColor]).toEqual(['BUTTON', 'Put something up', GREEN])
    expect(screen.queryByTestId('start-a-batch')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start a batch' })).toBeNull()
    // The walk's row holds the walk door alone.
    expect(screen.getByTestId('putup-walk-door').parentElement.querySelectorAll('button')).toHaveLength(1)
  })

  // One filled button per screen state — the rule the empty card's SECONDARY button exists to keep.
  it.each([
    ['Going now, with a batch going', 'Going now', () => {}],
    ['Going now, with nothing going (the empty card and its own Start a batch)', 'Going now', () => { going = [] }],
    ['Pantry', 'Pantry', () => {}],
    ['Recipes', 'Recipes', () => {}],
  ])('ONE filled button on %s', async (_name, seg, arrange) => {
    arrange()
    renderPage()
    await onSegment(seg)
    await waitFor(() => expect(filled()).toHaveLength(1))
    if (_name.includes('nothing going')) {
      // Green control: the second "Start a batch" really is on screen, and it is the one that is not filled.
      expect(screen.getAllByRole('button', { name: 'Start a batch' })).toHaveLength(2)
      expect(filled()[0]).toBe(screen.getByTestId('start-a-batch'))
      expect(screen.getByTestId('going-empty-start').style.backgroundColor).toBe('transparent')
    }
  })

  it('keeps ONE min-width on every segment, so the search box does not jump', async () => {
    renderPage()
    await onSegment('Going now')
    const start = screen.getByTestId('start-a-batch')
    const width = start.style.minWidth
    expect(width).toMatch(/^\d+(\.\d+)?em$/)                     // in em: it follows the text size
    expect([start.style.minHeight, start.style.flexShrink, start.style.whiteSpace]).toEqual(['48px', '0', 'nowrap'])
    for (const name of ['Pantry', 'Recipes', 'Log a put-up']) {
      pick(name)
      const door = screen.getByTestId('putup-door')
      expect({ name, minWidth: door.style.minWidth, style: door.getAttribute('style') })
        .toEqual({ name, minWidth: width, style: start.getAttribute('style') })
    }
  })

  it('with search text up on Going now the button is "Put something up": the results are pantry results', async () => {
    renderPage()
    await onSegment('Going now')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reaper' } })
    await screen.findByTestId('pantry-search-results')
    expect(screen.queryByTestId('start-a-batch')).toBeNull()
    const doors = screen.getAllByTestId('putup-door')
    expect(doors).toHaveLength(1)
    expect(doors[0].style.backgroundColor).toBe(GREEN)
    expect(filled()).toHaveLength(1)
    // …and clearing it brings Start a batch back: the segment was never left.
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }))
    await waitFor(() => expect(screen.getByTestId('start-a-batch')).toBeTruthy())
  })

  it('a mode shows neither button', async () => {
    renderPage('/put-up?batch=kb-1')
    await screen.findByTestId('putup-batch-mode')
    expect(screen.queryByTestId('start-a-batch')).toBeNull()
    expect(screen.queryByTestId('putup-door')).toBeNull()
    expect(screen.queryByTestId('putup-walk-door')).toBeNull()
  })
})

describe('what the header\'s doors open', () => {
  it('"Start a batch" opens the Start sheet, with no name', async () => {
    renderPage()
    await onSegment('Going now')
    fireEvent.click(screen.getByTestId('start-a-batch'))
    expect(screen.getByTestId('stub-start').getAttribute('data-initial-label')).toBe('')
    expect(screen.queryByRole('dialog', { name: 'Put something up' })).toBeNull()
  })

  // The page builds with or without the Start sheet (its glob contract): without it the button still does
  // something true — it opens the door that IS there.
  it('"Start a batch" opens Put something up when the Start sheet is absent', async () => {
    renderPage('/put-up', { StartBatchSheet: null })
    await onSegment('Going now')
    fireEvent.click(screen.getByTestId('start-a-batch'))
    expect(await screen.findByRole('dialog', { name: 'Put something up' })).toBeTruthy()
    expect(screen.queryByTestId('stub-start')).toBeNull()
  })

  it('the quiet "Put something up" on Going now opens the door, empty', async () => {
    renderPage()
    await onSegment('Going now')
    fireEvent.click(screen.getByTestId('putup-door'))
    expect(await screen.findByRole('dialog', { name: 'Put something up' })).toBeTruthy()
    expect(screen.getByTestId('door-what-name').value).toBe('')
  })

  it('the empty card\'s "Start a batch" opens the same Start sheet', async () => {
    going = []
    renderPage()
    await onSegment('Going now')
    fireEvent.click(await screen.findByTestId('going-empty-start'))
    expect(screen.getByTestId('stub-start')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('Going now\'s load error offers Try again (F25)', () => {
  it('says what failed, and the button re-reads the list in place', async () => {
    goingFails = true
    renderPage()
    await waitFor(() => expect(gets('/api/kitchen-batches?state=going')).toBe(1))
    pick('Going now')
    const banner = await screen.findByTestId('going-error')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toBe('Couldn’t load what’s going right now. Try again')
    const retry = within(banner).getByRole('button', { name: 'Try again' })
    expect(retry.style.minHeight).toBe('48px')
    // No empty card beside a failed read: "Nothing going right now." would be a claim the page cannot make.
    expect(screen.queryByTestId('going-empty')).toBeNull()
    goingFails = false
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId('going-batch-title').textContent).toBe('Megatron mash'))
    expect(gets('/api/kitchen-batches?state=going')).toBe(2)
    expect(screen.queryByTestId('going-error')).toBeNull()        // in place: the banner is simply gone
  })

  it('a second failure keeps the banner and its button', async () => {
    goingFails = true
    renderPage()
    await waitFor(() => expect(gets('/api/kitchen-batches?state=going')).toBe(1))
    pick('Going now')
    fireEvent.click(within(await screen.findByTestId('going-error')).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(gets('/api/kitchen-batches?state=going')).toBe(2))
    await waitFor(() => expect(within(screen.getByTestId('going-error')).getByRole('button', { name: 'Try again' }).disabled).toBe(false))
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('words — no banned word on the page shell or on Going now (PLAN-V3 section 2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  const pageText = () => document.body.textContent.replace(screen.getByTestId('probe-loc').textContent, '')
    .replace(screen.getByTestId('probe-state').textContent, '')

  it('INSTRUMENT: the pattern catches a banned word', () => {
    expect('How long it keeps').toMatch(BANNED)
    expect('the default table').toMatch(BANNED)
  })

  it('the header and the segments, on each segment', async () => {
    renderPage()
    await onSegment('Going now')
    for (const name of ['Going now', 'Pantry', 'Recipes']) {
      pick(name)
      await waitFor(() => expect(screen.getByRole('radio', { name }).getAttribute('aria-checked')).toBe('true'))
      expect({ name, hit: pageText().match(BANNED)?.[0] ?? null }).toEqual({ name, hit: null })
    }
    expect(pageText()).toContain('Put something up')              // green control: the page is what is read
  })

  it('Going now: its cards, its empty card, its load error — and the Back of a batch opened from it', async () => {
    renderPage()
    await onSegment('Going now')
    await screen.findByTestId('going-batch')
    expect(screen.getByTestId('going-now-view').textContent).toContain('Megatron mash')
    expect(screen.getByTestId('going-now-view').textContent).not.toMatch(BANNED)
    fireEvent.click(screen.getByTestId('going-open-batch'))
    await screen.findByTestId('putup-mode-back')
    expect(screen.getByTestId('putup-mode-back').textContent).not.toMatch(BANNED)
  })

  it('…with nothing going, and with the read failed', async () => {
    going = []
    const first = renderPage()
    await onSegment('Going now')
    const empty = await screen.findByTestId('going-empty')
    expect(empty.textContent).toContain('Start a batch')
    expect(screen.getByTestId('going-now-view').textContent).not.toMatch(BANNED)
    first.unmount()
    goingFails = true
    fetchMock.mockClear()
    renderPage()
    await waitFor(() => expect(gets('/api/kitchen-batches?state=going')).toBe(1))
    pick('Going now')
    await screen.findByTestId('going-error')
    expect(screen.getByTestId('going-now-view').textContent).not.toMatch(BANNED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PLAN-V3 D16 — recipes join the page search. The page reads GET /api/recipes the first time the search
// holds text, and never before: this page's own rule is that a bare open issues no GET nobody asked for.
// MUTATION (Spare 1): read the recipes at mount -> "a bare open reads no recipes" reds here, and so does
// PutUp.recipesSegment.test.jsx "is one more option; a bare open reads no recipes".
describe('the page search finds recipes (PLAN-V3 D16)', () => {
  const type = (value) => fireEvent.change(screen.getByRole('searchbox'), { target: { value } })
  const hits = () => [...screen.getByTestId('pantry-search-results').querySelectorAll('[data-testid^="pantry-search-hit-"]')]
    .map(b => b.textContent)

  it('a bare open reads no recipes — on Going now and on the Pantry alike', async () => {
    renderPage()
    await onSegment('Going now')
    pick('Pantry')
    await screen.findByTestId('pantry-view')
    pick('Going now')
    await screen.findByTestId('going-now-view')
    expect(gets('/api/recipes')).toBe(0)
    // Green control: the page IS reading, so the zero above is about the recipes and nothing else.
    expect(gets('/api/kitchen-batches?state=going')).toBe(1)
  })

  it('five keystrokes are ONE read', async () => {
    renderPage()
    await onSegment('Pantry')
    for (const text of ['r', 'ro', 'rol', 'roll', 'roll ']) type(text)
    await waitFor(() => expect(hits()).toEqual(['Roll for Initiative · Hot sauce']))
    expect(gets('/api/recipes')).toBe(1)
  })

  it('a recipe hit says what it makes — or that it is a recipe — and a second search does not read again', async () => {
    renderPage()
    await onSegment('Pantry')
    type('m')
    await waitFor(() => expect(hits()).toEqual(['Mystery mash · recipe']))
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }))
    await screen.findByTestId('pantry-view')
    type('init')
    await waitFor(() => expect(hits()).toEqual(['Roll for Initiative · Hot sauce']))
    expect(gets('/api/recipes')).toBe(1)
  })

  it('a tap opens that recipe (?recipe=), the search dropped, and names no origin', async () => {
    renderPage('/put-up?view=pantry')
    await screen.findByTestId('pantry-view')
    type('roll')
    fireEvent.click(await screen.findByTestId('pantry-search-hit-extra:recipe:r1'))
    await waitFor(() => expect(screen.getByTestId('probe-loc').textContent).toBe('/put-up?view=pantry&recipe=r1'))
    expect(JSON.parse(screen.getByTestId('probe-state').textContent)).toBeNull()
    expect(screen.getByTestId('putup-mode-back').textContent).toBe('← Recipes')
  })

  it('a failed read leaves the search working over the Pantry, and the next search asks again', async () => {
    let fail = true
    const base = fetchMock.getMockImplementation()
    fetchMock.mockImplementation((path, options) => (path === '/api/recipes' && fail
      ? Promise.reject(new Error('502')) : base(path, options)))
    renderPage()
    await onSegment('Pantry')
    type('roll')
    await waitFor(() => expect(gets('/api/recipes')).toBe(1))
    // The Pantry's own "no hit" door is there: the search itself did not fail.
    expect((await screen.findByTestId('pantry-search-putup')).textContent).toBe('Put something up: roll →')
    type('rolls')
    await waitFor(() => expect(screen.getByTestId('pantry-search-putup').textContent).toBe('Put something up: rolls →'))
    expect(gets('/api/recipes')).toBe(1)                          // not once per keystroke after a failure, either
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }))
    await screen.findByTestId('pantry-view')
    type('roll')
    await waitFor(() => expect(hits()).toEqual(['Roll for Initiative · Hot sauce']))
    expect(gets('/api/recipes')).toBe(2)
  })

  it('a search param under a mode is not a search: nothing is read', async () => {
    renderPage('/put-up?batch=kb-1&find=roll')
    await screen.findByTestId('putup-batch-mode')
    await waitFor(() => expect(gets('/api/kitchen-batches/kb-1')).toBe(1))
    expect(gets('/api/recipes')).toBe(0)
  })
})
