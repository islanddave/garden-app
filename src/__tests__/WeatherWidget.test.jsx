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


describe('WeatherWidget — DRG-WX Phase 2 snapshot-volatility caveat', () => {
  const uncertainHydro = (extra = {}) => ({
    recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88,
    tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true,
    status: { ok: true, uncertainty: { flag: true, reason: 'showery today (88% on 0.21")' } },
    ...extra,
  })

  it('shows the showery caveat + softened ("could climb") note when the engine flags uncertainty', () => {
    render(<WeatherWidget weather={weather} hydrology={uncertainHydro()} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/Showery pattern/i)).toBeTruthy()
    expect(screen.getByText(/could climb/i)).toBeTruthy()
    expect(screen.getByText(/plays it safe/i)).toBeTruthy()
  })

  it('shows the chance-forward note even when the snapshot has a trace amount (88% / 0")', () => {
    const h = uncertainHydro({ today_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 5,
      status: { ok: true, uncertainty: { flag: true, reason: 'rain likely today (88%) ... may climb' } } })
    render(<WeatherWidget weather={weather} hydrology={h} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/88% chance today/i)).toBeTruthy()
    expect(screen.getByText(/Showery pattern/i)).toBeTruthy()
  })

  it('does NOT show the caveat when no uncertainty status is present (back-compat)', () => {
    const h = { recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }
    render(<WeatherWidget weather={weather} hydrology={h} generatedAt="2026-06-22T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()
    expect(screen.getByText(/rain expected/i)).toBeTruthy()
  })

  it('prior-day stale warning takes precedence over the showery caveat (no double-up)', () => {
    render(<WeatherWidget weather={weather} hydrology={uncertainHydro()} generatedAt="2026-06-20T06:00:41Z" planDate="2026-06-22" />)
    expect(screen.getByText(/older snapshot/i)).toBeTruthy()
    expect(screen.queryByText(/Showery pattern/i)).toBeNull()
  })
})
