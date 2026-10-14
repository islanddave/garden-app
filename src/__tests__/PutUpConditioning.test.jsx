// V5-PUTUPRULINGGAPS-001 — FOODSAFETY-RULING-V101 §7, the dried-fruit conditioning question.
//
// The pure predicate at its window edges, the card's one-slot choice, the painted card, and the copy
// guard. The ruling's line is that the app RECORDS and PROMPTS and never assesses: the question asks
// about condensation and stops, and nothing here may say a batch is done, safe or ready, count down,
// or number the days. Every assertion below sits on one side of that line.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

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
import {
  conditioningPrompt, cardQuestion, CONDITIONING_PROMPT, CONDITIONING_NOTE, CONDITIONING_KIND,
  CONDITIONING_WINDOW_DAYS, CONDITIONING_CHECK_DAYS, CONDITIONING_ANSWERS,
} from '../components/putup/goingNow.js'

const DAY = 86400000
const NOW = new Date('2026-10-14T09:00:00').getTime()
const ago = (days) => new Date(NOW - days * DAY).toISOString()

// Apricots that went into jars three days ago and were last looked at when they went in.
const DRY = {
  id: 'kb-apricot', user_id: 'user_dave', label: 'Apricots', kind: 'dehydrate',
  started_at: ago(5), start_precision: 'day', first_recorded_at: ago(5),
  expected_days_min: null, expected_days_max: null, suspended_at: null, closed_at: null,
  current_stage_kind: 'tended', current_stage_label: null, current_stage_entered_at: ago(3),
  input_count: 1, output_count: 0, last_ph_reading: null, last_ph_read_at: null,
  conditioning_since: ago(3),
}
// In the jars N days, last looked at when they went in.
const inJars = (days, over = {}) => ({ ...DRY, conditioning_since: ago(days), current_stage_entered_at: ago(days), ...over })

beforeEach(() => { fetchMock.mockReset() })

describe('the constants say what the ruling says', () => {
  it('dehydrator only, the outer bound of 7–10, a daily look', () => {
    expect(CONDITIONING_KIND).toBe('dehydrate')
    expect(CONDITIONING_WINDOW_DAYS).toBe(10)
    expect(CONDITIONING_CHECK_DAYS).toBe(1)
  })
})

describe('conditioningPrompt — the window edges', () => {
  it('day 0: silent — you just put them in', () => {
    expect(conditioningPrompt(inJars(0), NOW)).toBeNull()
  })

  it('just under a day since the last look: silent', () => {
    expect(conditioningPrompt(inJars(1 - 1 / 24), NOW)).toBeNull()
  })

  it('one day after the last look: asks', () => {
    expect(conditioningPrompt(inJars(1), NOW)).toBe(CONDITIONING_PROMPT)
  })

  it('day 10 still asks — the outer bound is inside the window', () => {
    expect(conditioningPrompt(inJars(10), NOW)).toBe(CONDITIONING_PROMPT)
  })

  it('past day 10: silent, and silence is not a verdict', () => {
    expect(conditioningPrompt(inJars(10 + 1 / 24), NOW)).toBeNull()
    expect(conditioningPrompt(inJars(30), NOW)).toBeNull()
  })

  it('a check-in inside the last day silences it until tomorrow', () => {
    expect(conditioningPrompt(inJars(5, { current_stage_entered_at: ago(0.5) }), NOW)).toBeNull()
    expect(conditioningPrompt(inJars(5, { current_stage_entered_at: ago(1) }), NOW)).toBe(CONDITIONING_PROMPT)
  })

  it('counts the last look from conditioning_since when the stage date is missing or unreadable', () => {
    expect(conditioningPrompt(inJars(2, { current_stage_entered_at: null }), NOW)).toBe(CONDITIONING_PROMPT)
    expect(conditioningPrompt(inJars(2, { current_stage_entered_at: 'nope' }), NOW)).toBe(CONDITIONING_PROMPT)
  })
})

describe('conditioningPrompt — when it never asks', () => {
  it('a paused batch is silent', () => {
    expect(conditioningPrompt(inJars(3, { suspended_at: ago(1) }), NOW)).toBeNull()
  })

  it.each(['ferment', 'candy', 'other', null])('kind %s is silent', (kind) => {
    expect(conditioningPrompt(inJars(3, { kind }), NOW)).toBeNull()
  })

  it('no conditioning_since (never put in jars, or back in the dryer) is silent', () => {
    expect(conditioningPrompt(inJars(3, { conditioning_since: null }), NOW)).toBeNull()
    expect(conditioningPrompt(inJars(3, { conditioning_since: 'not a date' }), NOW)).toBeNull()
    expect(conditioningPrompt(null, NOW)).toBeNull()
  })
})

describe('cardQuestion carries it in the one slot', () => {
  it('returns the conditioning shape on a dehydrator batch in its window', () => {
    expect(cardQuestion(inJars(3), NOW)).toEqual({ kind: 'conditioning', text: CONDITIONING_PROMPT })
  })

  it('a NULL kind is asked what it is, never about jars', () => {
    expect(cardQuestion(inJars(3, { kind: null }), NOW)).toEqual({ kind: 'kind' })
  })

  it('nothing in the slot outside the window', () => {
    expect(cardQuestion(inJars(12), NOW)).toBeNull()
  })
})

describe('the card paints the question and the attribution', () => {
  const renderView = (batches) => render(
    <MemoryRouter initialEntries={['/put-up']}>
      <GoingNowView batches={batches} loading={false} error={false} onReload={vi.fn()} now={NOW} />
    </MemoryRouter>,
  )

  it('renders the question as the door to Check on it, with the note beneath', () => {
    renderView([inJars(3)])
    const card = screen.getByTestId('going-batch')
    expect(within(card).getByTestId('going-batch-conditioning').textContent).toBe(CONDITIONING_PROMPT)
    expect(within(card).getByTestId('going-batch-conditioning-note').textContent).toBe(CONDITIONING_NOTE)
    expect(within(card).getAllByTestId('going-question-link')).toHaveLength(1)
    expect(screen.queryByTestId('checkin-sheet')).toBeNull()
    fireEvent.click(within(card).getByTestId('going-question-link'))
    const sheet = screen.getByTestId('checkin-sheet')
    expect(sheet.getAttribute('data-batch-id')).toBe('kb-apricot')
    // The sheet it opens offers the two recorded answers — the question has somewhere to be answered.
    for (const a of CONDITIONING_ANSWERS) expect(sheet.textContent).toContain(a.label)
  })

  it('renders nothing on a dehydrator batch outside the window, nor on a paused one', () => {
    renderView([inJars(12), inJars(3, { id: 'kb-paused', suspended_at: ago(1) })])
    expect(screen.queryByTestId('going-batch-conditioning')).toBeNull()
    expect(screen.queryByTestId('going-batch-conditioning-note')).toBeNull()
  })

  it('the card shows no countdown, day count, progress or verdict', () => {
    renderView([inJars(3)])
    const text = screen.getByTestId('going-batch').textContent
    expect(text).toContain(CONDITIONING_PROMPT)
    expect(text).not.toMatch(/\bday \d+ of \d+\b|\bdays? left\b|\bremaining\b|\d\s?%|\bdue\b|\boverdue\b/i)
    expect(text).not.toMatch(/\bsafe\b|\bsafety\b|\bready\b|\bdone\b|\bconditioned\b|\bcomplete\b/i)
  })
})

describe('the copy makes no claim', () => {
  it.each([['CONDITIONING_PROMPT', CONDITIONING_PROMPT], ['CONDITIONING_NOTE', CONDITIONING_NOTE]])(
    '%s says nothing about safe, ready, done or "day N of"', (_, copy) => {
      expect(copy).not.toMatch(/\bsafe\b|\bsafely\b|\bsafety\b|\bunsafe\b/i)
      expect(copy).not.toMatch(/\bready\b|\bdone\b|\bfinished\b|\bcomplete\b/i)
      expect(copy).not.toMatch(/\bday \d+ of\b/i)
    })

  it('the prompt is a question and stops', () => {
    expect(CONDITIONING_PROMPT.endsWith('?')).toBe(true)
    expect(CONDITIONING_PROMPT).not.toMatch(/\d/)
  })

  it('the note carries NCHFP\'s failure signal verbatim and attributes it', () => {
    expect(CONDITIONING_NOTE).toContain('"If condensation develops in the jar, return the fruit to the dehydrator."')
    expect(CONDITIONING_NOTE).toMatch(/^The National Center for Home Food Preservation says/)
  })

  // The guard is not vacuous: each of its patterns catches the thing it names.
  it('the guard would catch the words it forbids', () => {
    expect('Day 4 of 10').toMatch(/\bday \d+ of\b/i)
    expect('Your fruit is safe').toMatch(/\bsafe\b/i)
    expect('Ready to store').toMatch(/\bready\b/i)
  })
})
