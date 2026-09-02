// WAVE 2 S3 — the four /seeds/saved values that produce DEAD SEED if the page is followed as
// shipped. Every one of them is a constant or a comparison, which is exactly why they need a test:
// nothing about a wrong number in a placeholder makes a build red.
//
// (a) the drying note placeholder taught "Dehydrator on low, 95°F" — most dehydrators' low setting
//     runs 105-125°F, so the one worked example on the page was the temperature most likely to kill
//     the lot. (b) a ferment past ~5 days has germinated in the jar and is finished, and rendered
//     in the same grey as a healthy 2-day one. (c) melon was filed under "cleaned dry"; it is a wet
//     extraction. (d) a stage could be dated into the future, which reads as "today" forever.
//
// TIME IS REAL HERE, NOT FAKED — same discipline as SavedSeeds.processAndElapsed.test.jsx: the
// fixtures are offsets from Date.now() at render, so no timer mock can make a threshold pass
// vacuously. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
}))

import SavedSeeds from '../pages/SavedSeeds.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()

// `status` is on the fixture because it is on every real row (NOT NULL, and v_sow_candidates keys
// off it) and because the untracked-packet picker now filters on it — V4-SEEDSTOREDQTY-001.
const ferment = (id, days, over = {}) => ({
  id, name: id, variety_name: id, category: 'seeds', variety_id: 'v-tom', status: 'active',
  seed_stage: 'fermenting', seed_process: 'wet', source_plant_id: null,
  updated_at: daysAgo(0.01), stage_entered_at: days == null ? null : daysAgo(days),
  ...over,
})

const mount = async (items) => {
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method) return Promise.resolve({ ok: true })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items')) return Promise.resolve(items)
    return Promise.resolve([])
  })
  await act(async () => { render(<ToastProvider><SavedSeeds /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText('Saved seeds')).toBeTruthy())
}

const click = async (testId) => {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)) })
}
const cardFor = (id) => screen.getAllByTestId('seed-lot-card')
  .find((c) => c.textContent.startsWith(id))

beforeEach(() => { fetchSpy.mockReset() })

describe('S3b — a ferment past its window does not look like a healthy one', () => {
  it('says nothing at 2 days, warns at 4, and alarms at 6', async () => {
    // All three in ONE render so the negative case is measured against the same chrome as the
    // positives — a "no badge" assertion against a page that never renders badges proves nothing.
    await mount([ferment('healthy', 2), ferment('warned', 4), ferment('alarmed', 6)])

    expect(cardFor('healthy').getAttribute('data-ferment')).toBe(null)
    expect(cardFor('warned').getAttribute('data-ferment')).toBe('warn')
    expect(cardFor('alarmed').getAttribute('data-ferment')).toBe('alarm')

    expect(within(cardFor('healthy')).queryByTestId('ferment-urgency')).toBeNull()
    expect(within(cardFor('warned')).getByTestId('ferment-urgency').textContent).toBe('Check the ferment')
    expect(within(cardFor('alarmed')).getByTestId('ferment-urgency').textContent).toBe('Overdue')
  })

  it('carries the consequence in words, not only in colour', async () => {
    // The defect was a duration rendered without its meaning. Colour alone repeats that for anyone
    // who cannot see it, so the reason has to be readable text.
    await mount([ferment('alarmed', 8)])
    expect(cardFor('alarmed').textContent).toContain('Past 5 days the seed can sprout in the jar.')
  })

  it('paints the three states with three different borders', async () => {
    // The literal complaint: an 8-day ruined lot rendered in the same grey as a healthy 2-day one.
    // Asserted as pairwise DIFFERENCE rather than against hex values so the test survives a palette
    // change but still reds if any state stops being distinguished.
    await mount([ferment('healthy', 2), ferment('warned', 4), ferment('alarmed', 6)])
    const border = (id) => cardFor(id).style.borderColor
    expect(border('healthy')).toBeTruthy()
    expect(border('warned')).not.toBe(border('healthy'))
    expect(border('alarmed')).not.toBe(border('healthy'))
    expect(border('alarmed')).not.toBe(border('warned'))
  })

  it('leaves the elapsed line off P.light — #777 is 4.478:1 on the white card', async () => {
    // Seed-path-only fix; repainting P.light app-wide is Dave's call. Pinned as "not #777" rather
    // than as "is P.mid" so the guard is about the failure, not about one replacement value.
    await mount([ferment('healthy', 2)])
    const line = cardFor('healthy').querySelector('div > div')
    expect(line.textContent).toContain('2 days in fermenting')
    expect(line.style.color).not.toBe('rgb(119, 119, 119)')
  })

  it('does not fire on drying, however long it has sat', async () => {
    // Drying has no cliff — three weeks on a screen is dry, not spoiled. Firing on every stage
    // would make the signal background noise, which is how it stops being read.
    await mount([ferment('dry-lot', 21, { seed_stage: 'drying', seed_process: 'dry' })])
    expect(cardFor('dry-lot').getAttribute('data-ferment')).toBe(null)
    expect(screen.queryByTestId('ferment-urgency')).toBeNull()
  })

  it('does not fire on a lot with no stage entry — an unknown duration is not an overdue one', async () => {
    await mount([ferment('unknown', null)])
    expect(cardFor('unknown').textContent).toContain('In fermenting')
    expect(screen.queryByTestId('ferment-urgency')).toBeNull()
  })
})

describe('S3a/S3d — the advance sheet cannot teach a lethal temperature or a future date', () => {
  it('offers a drying example that is survivable, and never a dehydrator temperature', async () => {
    await mount([ferment('lot', 1)])
    await click('advance-stage')
    const note = screen.getByTestId('stage-note')
    expect(note.getAttribute('placeholder')).toBe('Screen in the shed, 75°F, out of sun')
    // The specific thing that made the old copy dangerous: "on low" is 105-125°F on most units.
    expect(note.getAttribute('placeholder')).not.toContain('Dehydrator')
  })

  it('caps the stage date at today, so a lot cannot be dated into the future', async () => {
    await mount([ferment('lot', 1)])
    await click('advance-stage')
    expect(screen.getByTestId('stage-date').getAttribute('max')).toBe(todayLocalISO())
  })

  it('states the viability ceiling on the drying section itself', async () => {
    // The placeholder is only seen while filling the sheet. The section subtitle is the standing
    // copy for anyone whose lot is already drying.
    await mount([ferment('dry-lot', 3, { seed_stage: 'drying', seed_process: 'dry' })])
    expect(screen.getByTestId('stage-section-drying').textContent).toContain('keep below 95°F')
  })
})

describe('S3c — melon is a wet extraction', () => {
  it('lists melon under wet and not under dry', async () => {
    // The process choice writes a PERMANENT seed_lot_stage_log row, so miscategorising melon here
    // does not just mislead — it records a process the lot never had.
    await mount([ferment('untracked', null, { seed_stage: null, stage_entered_at: null })])
    await click('track-a-lot')
    await click('track-candidate')
    expect(screen.getByTestId('start-process-wet').textContent).toContain('melon')
    expect(screen.getByTestId('start-process-dry').textContent).not.toContain('melon')
  })
})
