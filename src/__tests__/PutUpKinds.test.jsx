// Put-Up 1a (V4 §2.3) — "What kind of batch?": the kind chips, the card's one-tap question, and the
// ferment prompts it wakes.
//
// WHY THIS FILE IS MOSTLY NEGATIVES. The positive (a PUT goes out) stays true under every design the
// plan forbids. What the plan actually rules is: kind is OPTIONAL, the question appears on a NULL
// kind ONLY and is NEVER ASKED AGAIN, "Other" still needs its short name in 1a (the live CHECK), and
// the shipped submersion / pH / stall prompts appear only when kind = 'ferment'. Each of those has
// an assertion that goes red when the rule is removed, and the mutation that proves it is named
// beside it.
//
// CI LANE: `npm test` plus the blocking TZ=America/New_York re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => vi.fn() }
})

import GoingNowView from '../components/putup/GoingNowView.jsx'
import KindChips, { KIND_CHIPS, kindBody } from '../components/kitchen/KindChips.jsx'
import {
  KIND_QUESTION, kindQuestionVisible, SUBMERSION_PROMPT, PH_PROMPT, FERMENT_STALL_PROMPT,
} from '../components/putup/goingNow.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NOW = new Date('2026-09-04T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()

// The pepper mash: kind NULL because nothing in the client could ever write one, never touched since
// it was started a fortnight ago. Stale on EVERY ferment clock at once — the submersion cadence, the
// pH cadence and the one-week stall deadline — so the only thing keeping the prompts off its card is
// the kind gate, which is the thing under test.
const MASH = {
  id: 'kb-mash', user_id: 'user_dave', label: 'Pepper mash', kind: null, kind_other: null,
  started_at: local('2026-08-21T09:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-08-21T09:00:00'), expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: null, current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: local('2026-08-21T09:00:00'), input_count: '0', output_count: '0',
  last_ph_reading: null, last_ph_read_at: null,
}
const JEN_MASH = { ...MASH, id: 'kb-jen', user_id: 'user_jen', label: "Jen's kraut", started_at: local('2026-08-22T09:00:00') }

function renderView(batches, extra = {}) {
  return render(
    <MemoryRouter initialEntries={['/put-up']}>
      <GoingNowView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} {...extra} />
    </MemoryRouter>,
  )
}

beforeEach(() => { fetchMock.mockReset() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('kinds — the six chips are the live vocabulary, and `age` stays valid', () => {
  const KB = readFileSync(resolve(REPO, 'lambda/preservation/kitchenBatch.js'), 'utf8')
  const server = [...(/export const KITCHEN_BATCH_KINDS = \[([^\]]*)\]/.exec(KB)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)]
    .map(m => m[1])

  it('offers Ferment · Dry · Candy · Cure · Infuse · Other, in that order, stored as the column values', () => {
    expect(KIND_CHIPS.map(c => [c.value, c.label])).toEqual([
      ['ferment', 'Ferment'], ['dehydrate', 'Dry'], ['candy', 'Candy'],
      ['cure', 'Cure'], ['infuse', 'Infuse'], ['other', 'Other'],
    ])
  })

  it('stores only values the server accepts — and does not offer `age`, which it still accepts', () => {
    // Instrument check: the parse found the server's list, or every assertion below is over nothing.
    expect(server).toEqual(['ferment', 'dehydrate', 'candy', 'cure', 'infuse', 'age', 'other'])
    for (const c of KIND_CHIPS) expect(server).toContain(c.value)
    expect(KIND_CHIPS.map(c => c.value)).not.toContain('age')
    expect(server).toContain('age')
  })
})

describe('kindBody — what a chosen kind puts on the wire', () => {
  it('sends the kind alone, and nothing at all for an unanswered question', () => {
    expect(kindBody('ferment')).toEqual({ kind: 'ferment' })
    expect(kindBody('dehydrate')).toEqual({ kind: 'dehydrate' })
    expect(kindBody(null)).toEqual({})
    expect(kindBody(undefined)).toEqual({})
  })

  // MUTATION: drop kind_other from the 'other' branch -> the first literal reds, and the live CHECK
  // (chk_kitchen_batch_kind_other) would refuse every such PUT.
  it('"Other" carries its short name, trimmed, and cannot be built without one (1a CHECK)', () => {
    expect(kindBody('other', '  vinegar ')).toEqual({ kind: 'other', kind_other: 'vinegar' })
    expect(kindBody('other', '   ')).toBeNull()
    expect(kindBody('other', '')).toBeNull()
    expect(kindBody('other')).toBeNull()
  })

  it('refuses a value that is not a chip', () => {
    expect(kindBody('pickle')).toBeNull()
    expect(kindBody('age')).toBeNull()
  })
})

describe('KindChips — an optional single-select, 48px touch chips, 8px apart', () => {
  it('is a named group of pressed/unpressed buttons, never a radiogroup', () => {
    render(<KindChips value="candy" onChange={vi.fn()} />)
    const group = screen.getByRole('group', { name: 'What kind of batch?' })
    const chips = within(group).getAllByRole('button')
    expect(chips.map(b => b.textContent)).toEqual(['Ferment', 'Dry', 'Candy', 'Cure', 'Infuse', 'Other'])
    expect(chips.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false', 'false', 'false'])
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(chips.every(b => b.style.minHeight === '48px')).toBe(true)
    expect(group.style.gap).toBe('8px')
  })

  it('toggles: a tap chooses, a second tap on the same chip un-chooses', () => {
    const onChange = vi.fn()
    const { rerender } = render(<KindChips value={null} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('kind-infuse'))
    expect(onChange).toHaveBeenLastCalledWith('infuse')
    rerender(<KindChips value="infuse" onChange={onChange} />)
    fireEvent.click(screen.getByTestId('kind-infuse'))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('asks the short name only once Other is chosen', () => {
    const { rerender } = render(<KindChips value="cure" onChange={vi.fn()} />)
    expect(screen.queryByTestId('kind-other-text')).toBeNull()
    rerender(<KindChips value="other" onChange={vi.fn()} otherText="" onOtherTextChange={vi.fn()} />)
    expect(screen.getByLabelText('What kind is it?')).toBe(screen.getByTestId('kind-other-text'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the card asks "What kind of batch? →" on a NULL kind, and never again', () => {
  it('asks once, as one quiet door, on an unclassified batch', () => {
    renderView([MASH])
    const q = screen.getAllByTestId('going-kind-question')
    expect(q).toHaveLength(1)
    expect(q[0].textContent).toBe('What kind of batch? →')
    expect(KIND_QUESTION).toBe('What kind of batch?')
    expect(q[0].style.minHeight).toBe('44px')
  })

  // MUTATION: kindQuestionVisible -> `batch.kind == null || batch.kind === 'other'` (or any widening)
  // reds this, because every kind below is an ANSWER, including the two no chip offers.
  it('is never asked of a batch that already has any kind — `age` and `other` included', () => {
    const kinds = ['ferment', 'dehydrate', 'candy', 'cure', 'infuse', 'age', 'other']
    renderView(kinds.map((kind, i) => ({ ...MASH, id: `kb-${kind}`, kind, kind_other: kind === 'other' ? 'vinegar' : null,
      started_at: local(`2026-08-${String(10 + i).padStart(2, '0')}T09:00:00`) })))
    expect(screen.getAllByTestId('going-batch')).toHaveLength(7)   // instrument: seven cards rendered
    expect(screen.queryByTestId('going-kind-question')).toBeNull()
    for (const kind of kinds) expect(kindQuestionVisible({ ...MASH, kind })).toBe(false)
    // GREEN CONTROL: the same fixture with the kind removed IS asked.
    expect(kindQuestionVisible(MASH)).toBe(true)
  })

  it('is not asked of a closed batch or of nothing', () => {
    expect(kindQuestionVisible({ ...MASH, closed_at: '2026-09-01T12:00:00.000Z' })).toBe(false)
    expect(kindQuestionVisible(null)).toBe(false)
  })

  it('one tap on a chip IS the answer: exactly {kind} through the shipped merge PUT', async () => {
    fetchMock.mockResolvedValue({ ...MASH, kind: 'ferment' })
    const onReload = vi.fn()
    renderView([MASH], { onReload })
    fireEvent.click(screen.getByTestId('going-kind-question'))
    fireEvent.click(screen.getByTestId('going-kind-ferment'))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-mash', {
      method: 'PUT', body: JSON.stringify({ kind: 'ferment' }),
    })
    // Answered: the question is gone at once, before the re-read carries the new kind back.
    expect(screen.queryByTestId('going-kind-question')).toBeNull()
    expect(screen.queryByTestId('going-kind-editor')).toBeNull()
  })

  it('"Other" asks its short name first and sends it with the kind', async () => {
    fetchMock.mockResolvedValue({})
    const onReload = vi.fn()
    renderView([MASH], { onReload })
    fireEvent.click(screen.getByTestId('going-kind-question'))
    fireEvent.click(screen.getByTestId('going-kind-other'))
    expect(fetchMock).not.toHaveBeenCalled()             // Other alone commits nothing
    fireEvent.click(screen.getByTestId('going-kind-save'))
    expect(screen.getByTestId('going-kind-error').textContent).toBe('Give it a short name first.')
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('going-kind-other-text'), { target: { value: 'Shrub' } })
    fireEvent.click(screen.getByTestId('going-kind-save'))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-mash', {
      method: 'PUT', body: JSON.stringify({ kind: 'other', kind_other: 'Shrub' }),
    })
  })

  it('keeps the question open, un-pressed, and says so when the write fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    renderView([MASH])
    fireEvent.click(screen.getByTestId('going-kind-question'))
    fireEvent.click(screen.getByTestId('going-kind-cure'))
    await waitFor(() => expect(screen.getByTestId('going-kind-error').textContent).toBe("Couldn't save that — try again."))
    // A retry is one tap, not a toggle-off then a tap.
    expect(screen.getByTestId('going-kind-cure').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('going-kind-error').getAttribute('role')).toBe('alert')
  })

  // MUTATION: remove the writingRef early-return in KindQuestion.save -> two PUTs. Both taps land
  // inside ONE act(), so `busy` has not committed between them and the disabled attribute cannot be
  // what refuses the second — only the synchronous ref can (memory: disabled cannot prove a guard).
  it('two taps inside one frame send ONE PUT', async () => {
    let settle
    fetchMock.mockImplementation(() => new Promise(r => { settle = r }))
    renderView([MASH])
    fireEvent.click(screen.getByTestId('going-kind-question'))
    const ferment = screen.getByTestId('going-kind-ferment')
    const dry = screen.getByTestId('going-kind-dehydrate')
    act(() => { ferment.click(); dry.click() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { settle({}) })
  })

  it('writes to the card that was tapped, in a two-user list', async () => {
    fetchMock.mockResolvedValue({})
    renderView([MASH, JEN_MASH])
    const cards = screen.getAllByTestId('going-batch')
    expect(cards.map(c => c.getAttribute('data-batch-id'))).toEqual(['kb-jen', 'kb-mash'])
    fireEvent.click(within(cards[1]).getByTestId('going-kind-question'))
    fireEvent.click(within(cards[1]).getByTestId('going-kind-candy'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/kitchen-batches/kb-mash')
  })

  it('"Not now" closes the question without writing, and it is still there next time', () => {
    renderView([MASH])
    fireEvent.click(screen.getByTestId('going-kind-question'))
    fireEvent.click(screen.getByTestId('going-kind-cancel'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('going-kind-question')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE POINT OF THE KIND: the shipped ferment prompts, at their shipped timing, on kind = 'ferment'
// ONLY. MASH is past every ferment clock at NOW, so one fixture with the kind flipped is the whole
// proof — nothing else about the row changes between the two renders.
describe('the ferment prompts appear only when kind = Ferment', () => {
  const promptsOn = (batch) => {
    const { unmount } = renderView([batch])
    const card = screen.getByTestId('going-batch')
    const seen = ['going-batch-submersion', 'going-batch-ph-prompt', 'going-batch-stall']
      .filter(id => within(card).queryByTestId(id))
    const text = card.textContent
    unmount()
    return { seen, text }
  }

  // MUTATION: submersionPrompt / phPrompt / fermentStallPrompt admitting `kind == null` reds the first
  // assertion; the kind gate is the only thing between a stale unclassified crock and three questions.
  it('asks nothing of the same stale batch until it is classified, then asks', () => {
    const before = promptsOn(MASH)
    expect(before.seen).toEqual([])
    expect(before.text).toContain('What kind of batch? →')
    const after = promptsOn({ ...MASH, kind: 'ferment' })
    expect(after.seen.length).toBeGreaterThan(0)
    expect(after.text).not.toContain('What kind of batch?')
    expect(after.text).toMatch(new RegExp([SUBMERSION_PROMPT, PH_PROMPT, FERMENT_STALL_PROMPT]
      .map(s => s.replace(/[.?*+^$()[\]{}|\\]/g, '\\$&')).join('|')))
  })

  it('stays silent on every other kind, at the same staleness', () => {
    for (const kind of ['dehydrate', 'candy', 'cure', 'infuse', 'age', 'other']) {
      expect({ kind, seen: promptsOn({ ...MASH, kind }).seen }).toEqual({ kind, seen: [] })
    }
  })

  it('keeps the shipped timing: a ferment touched yesterday and measured yesterday is not asked', () => {
    const fresh = {
      ...MASH, kind: 'ferment', started_at: local('2026-09-02T09:00:00'),
      current_stage_kind: 'tended', current_stage_entered_at: local('2026-09-03T09:00:00'),
      last_ph_reading: '4.1', last_ph_read_at: local('2026-09-03T09:00:00'),
    }
    expect(promptsOn(fresh).seen).toEqual([])
  })
})

describe('the kind surface uses none of the banned words (V4 §3.2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it('in the question, the open chips and the Other name field', () => {
    renderView([MASH])
    fireEvent.click(screen.getByTestId('going-kind-question'))
    fireEvent.click(screen.getByTestId('going-kind-other'))
    const card = screen.getByTestId('going-batch')
    // GREEN CONTROL: the whole editor is on screen, so the sweep reads a populated surface.
    expect(card.textContent).toContain('FermentDryCandyCureInfuseOther')
    expect(screen.getByTestId('going-kind-save')).toBeTruthy()
    expect(card.textContent).not.toMatch(BANNED)
    expect(screen.getByTestId('going-kind-other-text').getAttribute('placeholder')).not.toMatch(BANNED)
  })
})
