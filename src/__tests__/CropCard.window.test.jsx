// V4-RIPENESSCUES-001 — the harvest colour window RENDERS. This suite exists because this exact
// feature shipped inert in v4.9.x: resolver imported, component defined, nothing called either,
// content tests all green (harvest-surface-redesign §12 "visible-render assertion, same commit").
// Uses the REAL harvestWindows module (no mock): CropCard lazy-loads it in an effect, so every
// first window assertion is an ASYNC findBy* against real dataset fixtures. Fixture expectations
// are read from the dataset itself so the pins track content edits (N points pinned from fixture).
// The 160-line content suite (harvestWindows.test.js) and the sparse-by-design suite
// (ripenessCues.test.js) are deliberately untouched by this slice.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))

import CropCard from '../components/planting/CropCard.jsx'
import { WINDOWS_BY_CULTIVAR } from '../lib/harvestWindows.js'

beforeEach(() => { apiFetchSpy.mockReset(); apiFetchSpy.mockResolvedValue(null) })

const mount = (name, crop_type_slug) =>
  render(<CropCard planting={{ id: 'p', variety_ref: { name, crop_type_slug } }} />)

describe('CropCard — harvest colour window renders (V4-RIPENESSCUES-001)', () => {
  it('renders the window VISIBLY for a windowed cultivar, under the "When you can pick" framing', async () => {
    const rec = WINDOWS_BY_CULTIVAR.cherokeegreen
    mount('Cherokee Green', 'tomato')
    // THE inert-ship mutation target: unrender <HarvestWindow/> and this findBy fails.
    expect(await screen.findByText(rec.window_label)).toBeTruthy()
    expect(screen.getByText('When you can pick')).toBeTruthy()
  })

  it('a ≤3-point window renders ALL points fully expanded by default — no disclosure tap', async () => {
    const rec = WINDOWS_BY_CULTIVAR.cherokeegreen
    expect(rec.window.length).toBeLessThanOrEqual(3) // fixture guard: Cherokee Green ships 3 points
    mount('Cherokee Green', 'tomato')
    await screen.findByText(rec.window_label)
    for (const p of rec.window) expect(screen.getByText(p.at)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /show all/i })).toBeNull()
  })

  it('a >3-point window collapses to first + FINAL point, then expands in place to all N', async () => {
    const rec = WINDOWS_BY_CULTIVAR.piripiri
    const n = rec.window.length
    expect(n).toBeGreaterThan(3) // fixture guard: Piri Piri is the long-end fixture (4 points)
    mount('Piri Piri', 'pepper')
    await screen.findByText(rec.window_label)
    // Collapsed line: first + FINAL — endpoint comparison is the canonical question.
    expect(screen.getByText(rec.window[0].at)).toBeTruthy()
    expect(screen.getByText(rec.window[n - 1].at)).toBeTruthy()
    for (const p of rec.window.slice(1, n - 1)) expect(screen.queryByText(p.at)).toBeNull()
    // The discriminator and the caveat are NEVER hidden by collapse.
    expect(screen.getByText(rec.ripe_vs_unripe)).toBeTruthy()
    expect(screen.getByText(rec.caveat)).toBeTruthy()
    // In-place expansion reveals the middle points; N pinned from the fixture.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`show all ${n} points`, 'i') }))
    for (const p of rec.window) expect(screen.getByText(p.at)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /show all/i })).toBeNull()
  })

  it('an overlap cultivar shows BOTH the corrective cue and the window in one render', async () => {
    const rec = WINDOWS_BY_CULTIVAR.picknpopyellow
    mount('Pick-N-Pop Yellow', 'pepper')
    await screen.findByText(rec.window_label)
    expect(screen.getByText(/When it.s ripe/i)).toBeTruthy()      // cue section (RipenessCue)
    expect(screen.getByText('When you can pick')).toBeTruthy()    // window section, below it
    // The cultivar cue text itself ("bright canary yellow…") also appears in this window's
    // ripe_vs_unripe, so assert presence with getAllByText rather than a unique-match getBy.
    expect(screen.getAllByText(/bright canary yellow/i).length).toBeGreaterThan(0)
  })

  it('a low-confidence caveat is visible IN THE COLLAPSED STATE — collapse never hides honesty', async () => {
    const rec = WINDOWS_BY_CULTIVAR.supersweet100
    expect(rec.confidence).toBe('low')            // fixture guard
    expect(rec.window.length).toBeGreaterThan(3)  // fixture guard: collapsed by default
    mount('Supersweet 100', 'tomato')
    await screen.findByText(rec.window_label)
    expect(screen.getByRole('button', { name: /show all/i })).toBeTruthy() // still collapsed
    expect(screen.getByText(rec.caveat)).toBeTruthy()                      // caveat visible anyway
  })

  it('a high-confidence window with no caveat renders NO caveat line (honesty mirror)', async () => {
    const rec = WINDOWS_BY_CULTIVAR.habanero
    expect(rec.confidence).toBe('high') // fixture guard
    expect(rec.caveat ?? null).toBeNull()
    mount('Habanero', 'pepper')
    await screen.findByText(rec.window_label)
    expect(screen.queryByTestId('harvest-window-caveat')).toBeNull()
  })
})
