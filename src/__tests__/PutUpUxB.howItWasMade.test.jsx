// Put-Up UX pass R1, lane B — "How it was made →" (HowItWasMadeSheet.jsx, howItWasMade.js):
//   · D2, the UNADDED-LINE GUARD: Save with a name still sitting in the adder does not save — it puts
//     the cursor back in the adder and says "Add “garlic” first — or clear it.";
//   · D15: the start is the earliest jar picked (the pure rule, earliestStart); the made count is a
//     placeholder, never a value; the jars' "Next time…" lines read as they do everywhere else;
//   · and the banned-word sweep this sheet did not have.
// (The two tests that pinned "the start is the door jar's date" are amended where they live, in
// PutUpHowItWasMade.test.jsx.) Each assertion names the mutation that reds it.
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }), apiFetch: (...a) => fetchSpy(...a) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import { P } from '../lib/constants.js'
import HowItWasMadeSheet from '../components/putup/HowItWasMadeSheet.jsx'
import { earliestStart, jarStart } from '../components/putup/howItWasMade.js'
import { addFirstWords } from '../components/putup/LineAdder.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { validateFromJars } from '../../lambda/preservation/batchBuilder.js'

const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const FILLED = toRgb(P.green)
const PLACE = 'loc-fridge'
const JAR = {
  id: 'j-1', label: 'Megatron plain', batch_id: null, harvest_log_id: null, storage_location_id: PLACE,
  preserved_at: '2026-09-08', preserved_at_precision: 'day', package_count: 6, remaining_count: 2, stock_mode: 'counted',
  notes: 'Next time (2026-09-02): less basil',
}
const OTHER = { ...JAR, id: 'j-2', label: 'Megatron reaper', preserved_at: '2026-09-01', notes: 'Next time: less reaper' }

function wire(records = [JAR, OTHER]) {
  fetchSpy.mockImplementation((path) => {
    if (String(path).startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [{ label: 'Fridge', records }] })
    if (path === '/api/kitchen-batches/from-jars') return Promise.resolve({ id: 'kb-new', label: 'Megatron plain' })
    if (String(path).includes('line-search')) return Promise.resolve({ plantings: [], put_ups: [] })
    return Promise.resolve(null)
  })
}
const posted = () => fetchSpy.mock.calls.filter(([p, o]) => p === '/api/kitchen-batches/from-jars' && o?.method === 'POST').map(([, o]) => JSON.parse(o.body))
const mount = (props = {}) => render(
  <DismissRegistryProvider><HowItWasMadeSheet jar={JAR} open onClose={() => {}} onSaved={() => {}} {...props} /></DismissRegistryProvider>,
)
const adderName = () => screen.getByTestId('how-add-name')
const save = () => act(async () => { fireEvent.click(screen.getByTestId('how-submit')) })

beforeEach(() => {
  fetchSpy.mockReset(); wire(); clearReloadBlocks()
  // The date words are read against the wall clock; pin it inside the fixtures' year. Date only.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T09:00:00'))
})
afterEach(() => { vi.useRealTimers(); cleanup(); clearReloadBlocks() })

describe('the unadded-line guard — a typed line is never dropped without a word', () => {
  // MUTATION (the guard): let Save proceed with pending adder text -> a body is posted with no such
  // line in it; the "nothing was sent" arm reds, and so do the focus and the sentence.
  it('Save with a name still in the adder does not save: the cursor goes to the adder and one line says what to do', async () => {
    const onSaved = vi.fn()
    mount({ onSaved })
    await waitFor(() => screen.getByTestId('how-jar-j-2'))
    fireEvent.change(adderName(), { target: { value: 'garlic' } })
    screen.getByTestId('how-label').focus()                            // somewhere else, as it is when he taps Save
    await save()
    expect(posted()).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(adderName())
    const line = screen.getByTestId('how-add-first')
    expect(line.textContent).toBe('Add “garlic” first — or clear it.')
    expect(line.textContent).toBe(addFirstWords('garlic'))
    expect(line.getAttribute('role')).toBe('alert')
    // Said AT the adder (inside What went in), not in the sheet's own error line a screen below.
    expect(screen.getByTestId('how-lines').contains(line)).toBe(true)
    expect(screen.queryByTestId('how-error')).toBeNull()
    expect(screen.getByTestId('how-sheet')).toBeTruthy()               // the sheet is still open
  })

  it('follows the text: the line names what is in the adder NOW', async () => {
    mount()
    fireEvent.change(adderName(), { target: { value: 'garlic' } })
    await save()
    fireEvent.change(adderName(), { target: { value: 'garlic scapes' } })
    expect(screen.getByTestId('how-add-first').textContent).toBe('Add “garlic scapes” first — or clear it.')
  })

  it('"or clear it": emptying the adder takes the line away, and Save then saves — without that name', async () => {
    const onSaved = vi.fn()
    mount({ onSaved })
    fireEvent.change(adderName(), { target: { value: 'garlic' } })
    await save()
    expect(screen.getByTestId('how-add-first')).toBeTruthy()
    fireEvent.change(adderName(), { target: { value: '' } })
    expect(screen.queryByTestId('how-add-first')).toBeNull()
    await save()
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0].inputs).toBeUndefined()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('"Add it first": adding the line takes the line away, and Save then saves WITH it', async () => {
    mount()
    fireEvent.change(adderName(), { target: { value: 'garlic' } })
    await save()
    await act(async () => { fireEvent.click(screen.getByTestId('how-add-submit')) })
    expect(screen.queryByTestId('how-add-first')).toBeNull()
    expect(screen.getAllByTestId('how-line').map(l => l.textContent)).toEqual(['garlicTake out'])
    await save()
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0].inputs.map(l => l.label)).toEqual(['garlic'])
  })

  // A new name typed after a clear does not bring the line back by itself: it is said when Save stops.
  it('does not nag: no line until Save has actually stopped for the name on screen', async () => {
    mount()
    fireEvent.change(adderName(), { target: { value: 'garlic' } })
    expect(screen.queryByTestId('how-add-first')).toBeNull()
    await save()
    fireEvent.change(adderName(), { target: { value: '' } })
    fireEvent.change(adderName(), { target: { value: 'onion' } })
    expect(screen.queryByTestId('how-add-first')).toBeNull()
    await save()
    expect(screen.getByTestId('how-add-first').textContent).toBe('Add “onion” first — or clear it.')
    expect(posted()).toEqual([])
  })

  it('an empty adder never stops a Save', async () => {
    mount()
    await save()
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(screen.queryByTestId('how-add-first')).toBeNull()
  })
})

describe('one filled button at open — the adder\'s Add is the secondary until it holds something', () => {
  const filled = () => [...screen.getByRole('dialog').querySelectorAll('button')]
    .filter(b => b.style.backgroundColor === FILLED && !b.hasAttribute('aria-pressed') && !b.hasAttribute('aria-checked'))
    .map(b => b.getAttribute('data-testid'))

  // The finding (F7): a filled Add sat right above the filled Save. MUTATION: keep Add filled always ->
  // the first list has two.
  it('at open the only filled button is Save how it was made; with a name typed, Add is filled too', async () => {
    mount()
    expect(filled()).toEqual(['how-submit'])
    expect(screen.getByTestId('how-submit').textContent).toBe('Save how it was made')
    fireEvent.change(adderName(), { target: { value: 'garlic' } })
    // TWO, on purpose (D2): with a name typed, Add is that task's commit — and the guard above is what
    // stops the other one from dropping the line.
    expect(filled()).toEqual(['how-add-submit', 'how-submit'])
  })
})

describe('the start is the earliest jar picked — the pure rule (howItWasMade.js)', () => {
  const j = (preserved_at, o = {}) => ({ id: `j-${preserved_at}`, preserved_at, preserved_at_precision: 'day', ...o })

  it('one jar: its own date', () => {
    expect(earliestStart([j('2026-09-08')])).toEqual({ date: '2026-09-08', precision: 'day' })
    expect(earliestStart([j('2026-09-08')])).toEqual(jarStart(j('2026-09-08')))
  })

  // MUTATION: take the first jar's date (the door's) -> the first arm reds; take the LATEST -> both do.
  it('several: the earliest date, whichever order they are handed in — with THAT jar\'s precision', () => {
    expect(earliestStart([j('2026-09-08'), j('2026-09-01'), j('2026-09-05')])).toEqual({ date: '2026-09-01', precision: 'day' })
    expect(earliestStart([j('2026-09-01'), j('2026-09-08')])).toEqual({ date: '2026-09-01', precision: 'day' })
    expect(earliestStart([j('2026-09-08'), j('2026-09-01', { preserved_at_precision: 'month' })])).toEqual({ date: '2026-09-01', precision: 'month' })
    // Across a year boundary the dates still order as dates.
    expect(earliestStart([j('2026-01-03'), j('2025-12-30')])).toEqual({ date: '2025-12-30', precision: 'day' })
  })

  // A floor ('after'), a logged day ('unknown') and a pre-1b approximate date are not starts anyone knows
  // (jarStart): they offer no date, so a jar that HAS one decides.
  it('a jar with no start anyone knows is passed over; with none dated the start is Not sure', () => {
    const undated = [j('2026-08-01', { preserved_at_precision: 'after' }), j('2026-08-02', { preserved_at_precision: 'unknown' }),
      j('2026-08-03', { preserved_at_precision: null, preserved_at_approx: true }), { id: 'j-none', preserved_at: null }]
    expect(earliestStart([...undated, j('2026-09-08')])).toEqual({ date: '2026-09-08', precision: 'day' })
    expect(earliestStart(undated)).toEqual({ date: null, precision: 'unknown' })
    expect(earliestStart([])).toEqual({ date: null, precision: 'unknown' })
    expect(earliestStart(null)).toEqual({ date: null, precision: 'unknown' })
  })

  it('a tie keeps the first jar handed in', () => {
    expect(earliestStart([j('2026-09-01', { preserved_at_precision: 'week' }), j('2026-09-01')])).toEqual({ date: '2026-09-01', precision: 'week' })
  })
})

describe('the made count is a placeholder, and the Next time lines read as they do everywhere', () => {
  // The finding (F7): "How many did you make?" was blank though the jar says 6 were made. A PLACEHOLDER,
  // not a value: an untouched field must still send nothing, or opening the sheet would rewrite the count.
  // MUTATION: put the count in as the field's value -> `value` is "6" and the body carries made_count.
  it('shows what the jar already says ("6, from the jar") and sends nothing unless a number is typed', async () => {
    mount()
    await waitFor(() => screen.getByTestId('how-jar-j-2'))
    const made = screen.getByTestId('how-made')
    expect(made.getAttribute('placeholder')).toBe('6, from the jar')
    expect(made.value).toBe('')
    await save()
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0]).not.toHaveProperty('made_count')
    expect(validateFromJars({ ...posted()[0], jar_ids: ['cccccccc-1111-2222-3333-444444444444'] })).toBeNull()
  })

  it('a jar that says nothing about how many shows no placeholder at all', () => {
    cleanup()
    render(<DismissRegistryProvider><HowItWasMadeSheet jar={{ ...JAR, package_count: null }} open onClose={() => {}} /></DismissRegistryProvider>)
    expect(screen.getByTestId('how-made').getAttribute('placeholder')).toBe('')
  })

  // The stored line is "Next time (2026-09-02): less basil"; it reads "Next time: less basil · Sep 2".
  // Display only — the server copies the jars' own lines, so nothing reworded is sent.
  it('a jar\'s dated Next time line reads as words, and is not sent reworded', async () => {
    mount()
    await waitFor(() => screen.getByTestId('how-jar-j-2'))
    const items = () => [...screen.getByTestId('how-copied-next-time').querySelectorAll('li')].map(li => li.textContent)
    expect(items()).toEqual(['Next time: less basil · Sep 2'])
    fireEvent.click(screen.getByTestId('how-jar-j-2'))
    expect(items()).toEqual(['Next time: less basil · Sep 2', 'Next time: less reaper'])
    await save()
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0]).not.toHaveProperty('next_time')
    expect(JSON.stringify(posted()[0])).not.toContain('less basil')
  })
})

describe('words — no banned word on How it was made (V4 §3.2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i

  it('INSTRUMENT: the pattern catches a banned word', () => {
    expect('How long it keeps').toMatch(BANNED)
  })

  it('the sheet with every optional part open, a second jar chosen, and the guard\'s line showing', async () => {
    mount()
    await waitFor(() => screen.getByTestId('how-jar-j-2'))
    fireEvent.click(screen.getByTestId('how-jar-j-2'))
    fireEvent.click(screen.getByTestId('how-kind-toggle'))
    fireEvent.click(screen.getByTestId('how-add-more'))
    fireEvent.change(adderName(), { target: { value: 'garlic' } })
    await save()
    const sheet = screen.getByRole('dialog')
    const text = sheet.textContent
    // GREEN CONTROLS: the new copy was on screen when the sweep read it.
    for (const said of ['Name it', 'Sep 1 · the earliest of these jars', 'Add “garlic” first — or clear it.', 'Next time: less basil · Sep 2', 'Save how it was made']) {
      expect(`sweep saw "${said}": ${text.includes(said)}`).toBe(`sweep saw "${said}": true`)
    }
    expect(text).not.toMatch(BANNED)
    for (const el of sheet.querySelectorAll('[placeholder], [aria-label]')) {
      expect(`${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`).not.toMatch(BANNED)
    }
  })

  it('…and with one jar: its count as the placeholder', async () => {
    mount()
    await waitFor(() => screen.getByTestId('how-jar-j-2'))
    expect(screen.getByTestId('how-made').getAttribute('placeholder')).toBe('6, from the jar')
    expect(screen.getByTestId('how-made').getAttribute('placeholder')).not.toMatch(BANNED)
    expect(screen.getByRole('dialog').textContent).not.toMatch(BANNED)
  })
})
