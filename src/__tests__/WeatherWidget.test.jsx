// V3-WXFRESH-001 — honest-presentation layer for the Today weather snapshot.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

describe('WeatherWidget — V3-WATERWHY-001 tap-to-explain', () => {
  it('reveals an inline why-panel when a watering pill is tapped, and toggles off on re-tap', () => {
    // clean 'rain coming tomorrow, none today' so the beds reason hits the rainComing branch
    const hydro = { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true }
    render(<WeatherWidget weather={weather} hydrology={hydro} />)
    expect(screen.queryByRole('region', { name: /watering explanation/i })).toBeNull()
    const bedsBtn = screen.getByRole('button', { name: /in-ground bed recommendation/i })
    fireEvent.click(bedsBtn)
    const panel = screen.getByRole('region', { name: /watering explanation/i })
    expect(panel).toBeTruthy()
    expect(panel.textContent.toLowerCase()).toMatch(/soak is coming/)
    expect(panel.textContent.toLowerCase()).toMatch(/hold/)
    // Pill is an inline component (remounts each render); re-query the live node before re-tapping.
    fireEvent.click(screen.getByRole('button', { name: /in-ground bed recommendation/i }))
    expect(screen.queryByRole('region', { name: /watering explanation/i })).toBeNull()
  })
})
