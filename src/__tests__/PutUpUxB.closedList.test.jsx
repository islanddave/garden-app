// Put-Up UX pass R1, lane B — the closed list (ClosedBatchesView.jsx):
//   · D3, the ending said one way: the four literals the decision pins, and the pure rule behind them
//     (closedEnding — the same function writes batch detail's outcome line);
//   · F1, the row opens its batch: onOpenBatch(id, { label: 'Closed batches' }) from a target that is the
//     row's first child, with Reopen its own button beside it — two siblings, neither inside the other;
//   · the prop absent: the row is not a link, and is node for node what it was;
//   · and the banned-word sweep this surface did not have.
// Each assertion names the mutation that reds it. CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import ClosedBatchesView, { closedEnding, CLOSED_ORIGIN, UNKNOWN_OUTCOME_LABEL } from '../components/putup/ClosedBatchesView.jsx'
import { CLOSE_OUTCOMES, OUTCOME_FALLBACK_LABEL, describeOutcome } from '../components/putup/batchClose.js'
import { readFrom, backLabel } from '../components/putup/origin.js'

const NOW = new Date('2026-09-04T09:00:00').getTime()
// NOON UTC: far enough from both midnights that no CI zone moves the calendar day.
const AUG_28 = '2026-08-28T12:00:00.000Z'
const ROW = (o = {}) => ({
  id: 'kb-closed-putup', user_id: 'user_dave', label: 'Pepper mash', kind: 'ferment', kind_other: null,
  suspended_at: null, closed_at: AUG_28, outcome: 'put_up', outcome_note: null, current_stage_kind: 'finished',
  input_count: '3', output_count: '2', ...o,
})
const JEN = ROW({ id: 'kb-closed-jen', user_id: 'user_jen', label: "Jen's plum butter", closed_at: '2026-09-02T12:00:00.000Z', output_count: '6' })

function renderView(batches, extra = {}) {
  return render(<ClosedBatchesView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} {...extra} />)
}
const meta = () => screen.getByTestId('closed-batch-meta').textContent

beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue({}) })

describe('D3 — the ending, said one way', () => {
  // The four literals the decision pins. `output_count` arrives as a STRING (an uncast bigint count).
  // MUTATION: drop the label whenever a count follows -> rows 3 and 4 red (they lose "Gave it away" and
  // "Put it up — but not what I set out to make"); never drop it -> row 1 reads "Put it up · 2 put-ups".
  const FOUR = [
    ['put_up', '2', 'closed Aug 28 · 2 put-ups'],
    ['put_up', '0', 'closed Aug 28 · Put it up'],
    ['given_away', '1', 'closed Aug 28 · Gave it away · 1 put-up'],
    ['put_up_different', '12', 'closed Aug 28 · Put it up — but not what I set out to make · 12 put-ups'],
  ]
  it.each(FOUR)('%s with %s counted: "%s"', (outcome, output_count, literal) => {
    renderView([ROW({ outcome, output_count })])
    expect(meta()).toBe(literal)
    expect(closedEnding(ROW({ outcome, output_count }))).toBe(literal)
  })

  // No new vocabulary: every label is batchClose.js's, verbatim. With a count, only plain `put_up`
  // leaves its label out — the other five keep theirs in front of it.
  it('every other outcome keeps its label when a count follows', () => {
    for (const o of CLOSE_OUTCOMES) {
      const said = closedEnding(ROW({ outcome: o.value, output_count: '3' }))
      expect(said).toBe(o.value === 'put_up' ? 'closed Aug 28 · 3 put-ups' : `closed Aug 28 · ${o.label} · 3 put-ups`)
    }
    expect(CLOSE_OUTCOMES.map(o => o.value)).toHaveLength(6)        // instrument: the loop ran over all six
  })

  it('a count that is zero, missing or unreadable is no count: the label stands', () => {
    for (const output_count of ['0', 0, null, undefined, '', 'many']) {
      expect(closedEnding(ROW({ output_count }))).toBe('closed Aug 28 · Put it up')
    }
  })

  it('a row with no readable closed date invents none', () => {
    expect(closedEnding(ROW({ closed_at: null }))).toBe('2 put-ups')
    expect(closedEnding(ROW({ closed_at: null, output_count: '0' }))).toBe('Put it up')
    expect(closedEnding(ROW({ closed_at: 'not a date', outcome: 'consumed', output_count: '0' }))).toBe('Ate it')
  })

  // Each surface keeps its own word for an outcome this bundle has never seen, and neither echoes the
  // value: the list says "Something else"; batch detail hands in batchClose.js's "Closed".
  it('an unknown outcome falls back to the caller\'s word, never to the value', () => {
    const row = ROW({ outcome: 'composted', output_count: '4' })
    expect(closedEnding(row)).toBe(`closed Aug 28 · ${UNKNOWN_OUTCOME_LABEL} · 4 put-ups`)
    expect(closedEnding(row, { label: describeOutcome(row) })).toBe(`closed Aug 28 · ${OUTCOME_FALLBACK_LABEL} · 4 put-ups`)
    expect([UNKNOWN_OUTCOME_LABEL, OUTCOME_FALLBACK_LABEL]).toEqual(['Something else', 'Closed'])
    expect(closedEnding(row)).not.toContain('composted')
  })

  it('reads nothing as nothing', () => {
    expect(closedEnding(null)).toBe('')
    expect(closedEnding(undefined)).toBe('')
  })
})

describe('F1 — a closed row opens its batch', () => {
  // MUTATION M3 (lane B's half): call onOpenBatch(id) with no origin -> the page's Back reads "← Going
  // now" and lands there instead of on this list. The exact-arguments arm reds.
  it('passes { label: \'Closed batches\' } with the row\'s id', () => {
    const onOpenBatch = vi.fn()
    renderView([ROW()], { onOpenBatch })
    fireEvent.click(screen.getByTestId('closed-batch-open'))
    expect(onOpenBatch.mock.calls).toEqual([['kb-closed-putup', { label: 'Closed batches' }]])
    // The origin is one prep's reader takes whole, and the Back it yields names this list.
    const origin = onOpenBatch.mock.calls[0][1]
    expect(readFrom({ from: origin })).toEqual({ label: 'Closed batches' })
    expect(backLabel({ from: origin }, 'Going now')).toBe('Closed batches')
    expect(CLOSED_ORIGIN).toEqual({ label: 'Closed batches' })
  })

  it('hands each caller its own origin object, so one that edits it cannot change the next', () => {
    const onOpenBatch = vi.fn((id, origin) => { origin.label = 'scribbled on' })
    renderView([ROW()], { onOpenBatch })
    fireEvent.click(screen.getByTestId('closed-batch-open'))
    fireEvent.click(screen.getByTestId('closed-batch-open'))
    expect(onOpenBatch).toHaveBeenCalledTimes(2)
    expect(CLOSED_ORIGIN).toEqual({ label: 'Closed batches' })
  })

  // THE TWO-USER PAIR: both rows on screen, the tap is on the second. An index mix-up binds the first.
  it('opens the row that was tapped, in a two-user household', () => {
    const onOpenBatch = vi.fn()
    renderView([ROW(), JEN], { onOpenBatch })
    const opens = screen.getAllByTestId('closed-batch-open')
    expect(opens.map(b => b.querySelector('[data-testid="closed-batch-title"]').textContent)).toEqual(["Jen's plum butter", 'Pepper mash'])
    fireEvent.click(opens[1])
    expect(onOpenBatch.mock.calls).toEqual([['kb-closed-putup', { label: 'Closed batches' }]])
  })

  // The layout gate reads the row's FIRST child as the title column and checks Reopen clear of it; and a
  // button inside a button is not a thing a screen reader can land on.
  it('is the row\'s first child, 48px tall, holding the title and the ending — with Reopen its own button beside it', () => {
    renderView([ROW()], { onOpenBatch: vi.fn() })
    const row = screen.getByTestId('closed-batch')
    const open = screen.getByTestId('closed-batch-open')
    const reopen = screen.getByTestId('closed-batch-reopen')
    expect(row.firstElementChild).toBe(open)
    expect([...row.children]).toEqual([open, reopen])
    expect(open.tagName).toBe('BUTTON')
    expect(open.style.minHeight).toBe('48px')
    expect(open.textContent).toBe('Pepper mashclosed Aug 28 · 2 put-ups')
    expect(open.querySelector('button, a, input, [role="button"], [tabindex]')).toBeNull()      // nothing interactive inside it
    expect(reopen.closest('[data-testid="closed-batch-open"]')).toBeNull()
    expect(reopen.style.minHeight).toBe('48px')
    expect(reopen.style.backgroundColor).toBe('transparent')                                   // still the secondary
    expect(reopen.getAttribute('aria-label')).toBe('Reopen Pepper mash')
  })

  // Two acts on one row must not fire each other. MUTATION: put the click on the row's wrapper (so a tap
  // on Reopen bubbles into it) -> onOpenBatch is called by the Reopen tap.
  it('Reopen does not open the batch, and opening it does not reopen it', async () => {
    const onOpenBatch = vi.fn()
    const onReload = vi.fn()
    renderView([ROW()], { onOpenBatch, onReload })
    fireEvent.click(screen.getByTestId('closed-batch-reopen'))
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls).toEqual([['/api/kitchen-batches/kb-closed-putup/reopen', { method: 'POST' }]])
    expect(onOpenBatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('closed-batch-open'))
    expect(onOpenBatch).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('the prop absent — the row is not a link', () => {
  // Node for node what the row was before the pass. MUTATION: render the button without the prop -> a
  // dead tap on every row of a host that passes none; the first two arms red.
  it('renders the plain title column it always did, and Reopen', () => {
    renderView([ROW()])
    const row = screen.getByTestId('closed-batch')
    expect(screen.queryByTestId('closed-batch-open')).toBeNull()
    expect(row.querySelectorAll('button')).toHaveLength(1)
    const col = row.firstElementChild
    expect(col.tagName).toBe('DIV')
    expect(col.getAttribute('style')).toBe('min-width: 0; flex: 1 1 60%;')
    expect([...col.children].map(c => `${c.tagName}:${c.getAttribute('data-testid')}:${c.textContent}`))
      .toEqual(['DIV:closed-batch-title:Pepper mash', 'DIV:closed-batch-meta:closed Aug 28 · 2 put-ups'])
    expect([...row.children].map(c => c.getAttribute('data-testid'))).toEqual([null, 'closed-batch-reopen'])
  })

  it('treats a prop that is not a function as absent', () => {
    renderView([ROW()], { onOpenBatch: 'yes' })
    expect(screen.queryByTestId('closed-batch-open')).toBeNull()
  })

  // The title and the ending are the SAME nodes in both variants; only the column around them changes.
  it('says the same words either way', () => {
    const plain = renderView([ROW({ outcome: 'given_away', output_count: '1' })])
    const words = screen.getByTestId('closed-batch').firstElementChild.textContent
    plain.unmount()
    renderView([ROW({ outcome: 'given_away', output_count: '1' })], { onOpenBatch: vi.fn() })
    expect(screen.getByTestId('closed-batch-open').textContent).toBe(words)
    expect(words).toBe('Pepper mashclosed Aug 28 · Gave it away · 1 put-up')
  })
})

describe('words — no banned word on the closed list (V4 §3.2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i

  it('INSTRUMENT: the pattern catches a banned word', () => {
    expect('How long it keeps').toMatch(BANNED)
  })

  it('every ending, the note above the list, and the empty state', () => {
    const { unmount } = renderView(CLOSE_OUTCOMES.map((o, i) => ROW({ id: `kb-${i}`, label: `Batch ${i}`, outcome: o.value, output_count: String(i) })),
      { onOpenBatch: vi.fn() })
    const text = screen.getByTestId('closed-batches-view').textContent
    // GREEN CONTROLS: all six rows and the reopen note were read.
    expect(screen.getAllByTestId('closed-batch')).toHaveLength(6)
    expect(text).toContain('Reopening a batch puts it back in Going now.')
    expect(text).not.toMatch(BANNED)
    for (const el of screen.getByTestId('closed-batches-view').querySelectorAll('[aria-label]')) expect(el.getAttribute('aria-label')).not.toMatch(BANNED)
    unmount()
    renderView([])
    expect(screen.getByTestId('closed-empty').textContent).toContain('Nothing closed yet.')
    expect(screen.getByTestId('closed-batches-view').textContent).not.toMatch(BANNED)
  })
})
