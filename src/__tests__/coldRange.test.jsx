// V5-WXCOLDBAND-001 — "as cold as N°" beside Today's low: when it shows (src/lib/coldRange.js) and where
// (the V2 glance row, WeatherWidget for V1 and the V2 open card). Rendered over the gate's own 2026-09-24 plan.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: vi.fn(async () => ({ ok: true })) }) }))

import { coldRangeLow } from '../lib/coldRange.js'
import GlanceCard from '../components/today/v2/GlanceCard.jsx'
import WeatherWidget from '../components/today/WeatherWidget.jsx'
import { agreedTonightLow } from '../lib/tonightLow.js'

const D = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure/dailyplan.dave.json'), 'utf8'))
const PLAN = { ...D.plan, alerts_sent: [], weather: { ...D.plan.weather, callout: null } }
const DAY = D.plan_date                       // 2026-09-24; plan low 47
const RANGE = { night_date: DAY, low_f: 38.6, mid_f: 44.2, init_time: `${DAY}T00:00:00.000Z`, wn3_generated_at: `${DAY}T10:05:00.000Z` }

describe('coldRangeLow — when the range shows', () => {
  const at = { planDate: DAY, lowShown: 42, today: DAY }
  it('rounds the cold end and shows it when colder than the low printed', () => {
    expect(coldRangeLow(RANGE, at)).toBe(39)
  })
  it('is blank when absent, malformed, for another night, or the plan is not today', () => {
    expect(coldRangeLow(null, at)).toBeNull()
    expect(coldRangeLow({ ...RANGE, low_f: '38.6' }, at)).toBeNull()
    expect(coldRangeLow({ ...RANGE, low_f: NaN }, at)).toBeNull()
    expect(coldRangeLow({ ...RANGE, night_date: '2026-09-23' }, at)).toBeNull()
    expect(coldRangeLow(RANGE, { ...at, today: '2026-09-25' })).toBeNull()
    expect(coldRangeLow(RANGE, { ...at, planDate: null })).toBeNull()
  })
  it('is blank when it is not colder than the low printed (equal after rounding included)', () => {
    expect(coldRangeLow(RANGE, { ...at, lowShown: 39 })).toBeNull()
    expect(coldRangeLow(RANGE, { ...at, lowShown: 38.6 })).toBeNull()
    expect(coldRangeLow(RANGE, { ...at, lowShown: 36 })).toBeNull()
    expect(coldRangeLow(RANGE, { ...at, lowShown: undefined })).toBeNull()
  })
  it('reads a cold end at or below zero as a number', () => {
    expect(coldRangeLow({ ...RANGE, low_f: -0.4 }, { ...at, lowShown: 5 })).toBe(0)
    expect(coldRangeLow({ ...RANGE, low_f: -7.5 }, { ...at, lowShown: 5 })).toBe(-7)
  })
})

describe('where it shows', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${DAY}T12:00:00-04:00`)) })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const glance = (props) => rtlRender(
    <MemoryRouter>
      <GlanceCard plan={PLAN} generatedAt={D.generated_at} planDate={DAY} agreed={agreedTonightLow(PLAN)} open={false} onToggle={() => {}} {...props} />
    </MemoryRouter>,
  )

  it('V2 closed glance row: beside the low, inside the toggle button', () => {
    glance({ coldRange: RANGE })
    const note = screen.getByTestId('cold-range')
    expect(note.textContent).toBe('as cold as 39°')
    expect(note.closest('button[aria-expanded="false"]')).toBeTruthy()
  })

  it('V2 closed glance row: nothing at all without a range', () => {
    glance({})
    expect(screen.queryByTestId('cold-range')).toBeNull()
  })

  it('V2 open card: WeatherWidget carries it', () => {
    glance({ coldRange: RANGE, open: true })
    expect(screen.getByTestId('today-weather')).toBeTruthy()
    expect(screen.getAllByTestId('cold-range').map((n) => n.textContent)).toEqual(['as cold as 39°'])
  })

  it('WeatherWidget (V1): beside the low it prints, judged against lowShown when set', () => {
    const { unmount } = rtlRender(<WeatherWidget weather={PLAN.weather} hydrology={PLAN.hydrology} planDate={DAY} coldRange={RANGE} />)
    expect(screen.getByTestId('cold-range').textContent).toBe('as cold as 39°')
    unmount()
    rtlRender(<WeatherWidget weather={PLAN.weather} hydrology={PLAN.hydrology} planDate={DAY} coldRange={RANGE} lowShown={38} />)
    expect(screen.queryByTestId('cold-range')).toBeNull()
  })

  it('a stale day shows nothing', () => {
    vi.setSystemTime(new Date('2026-09-25T09:00:00-04:00'))
    glance({ coldRange: RANGE })
    expect(screen.queryByTestId('cold-range')).toBeNull()
  })
})
