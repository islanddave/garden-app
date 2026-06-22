// V3-WXFRESH-001 — honest-presentation layer for the Today weather snapshot.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import WeatherWidget from '../components/today/WeatherWidget.jsx'

const weather = { tonightLow: 50, highToday: 78, code: 3, hot: false }
const hydrology = { recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true }

describe('WeatherWidget — honest snapshot presentation', () => {
  it('shows an "As of … · Open-Meteo" stamp when generatedAt is provided', () => {
    // 06:00:41Z == 02:00 ET (EDT) on 2026-06-22 → same ET day as the plan → no stale warning
    render(<WeatherWidget weather={weather} hydrology={hydrology} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/As of/i)).toBeTruthy()
    expect(screen.getByText(/Open-Meteo/i)).toBeTruthy()
    expect(screen.queryByText(/older snapshot/i)).toBeNull()
  })

  it('omits the stamp entirely when generatedAt is absent (back-compat with callers that pass none)', () => {
    render(<WeatherWidget weather={weather} hydrology={hydrology} />)
    expect(screen.queryByText(/As of/i)).toBeNull()
  })

  it('warns when the snapshot is from an earlier ET day than the plan (missed nightly run)', () => {
    render(<WeatherWidget weather={weather} hydrology={hydrology} generatedAt="2026-06-20T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/older snapshot/i)).toBeTruthy()
    expect(screen.getByText(/out of date/i)).toBeTruthy()
  })
})
