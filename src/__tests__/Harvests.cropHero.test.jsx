// V4-HARVCROPPHOTO-001 — the crop photo on Harvest Totals.
//
// What these pin, in order of what would actually hurt:
//   * the THUMB is requested, not the original. The id-only resolve defaults to the full-size
//     object, and the 31 live crop heroes measured 134 MB as originals against 5.6 MB as thumbs
//     (live S3, 2026-08-24). Nothing on screen distinguishes the two — jsdom never loads an image
//     and a 24x payload regression is invisible to every other test in this suite.
//   * ONE request per crop, not one per render. The resolve rides PhotoImg's module cache; a
//     re-render that re-mints would multiply that 24x by however often the page re-renders.
//   * an older Lambda (no hero_photo_id) renders nothing — the frontend deploys ahead and a
//     rollback must hold, the same contract weekly[]/aggregates.weight carry.
//   * silent collapse, not a placeholder box: on a 31-row list a lone grey square reads as breakage.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), searchParamsRef: { current: new URLSearchParams() },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))

import Harvests from '../pages/Harvests.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache(); searchParamsRef.current = new URLSearchParams() })

const MINTED = 'https://s3.example.invalid/thumbs/plants/P/a.jpg?sig=x'

const crop = (extra) => ({
  crop_type_slug: 'tomato', crop_name: 'Tomato',
  units: [{ unit: 'count', unit_key: 'count', total: 14, count: 3 }], unquantified: 0, varieties: [],
  ...extra,
})

// The 7d snapshot strip is answered EMPTY so nothing it renders can be mistaken for a Totals row.
async function renderTotals(crops, { viewUrl = { view_url: MINTED } } = {}) {
  fetchSpy.mockImplementation((url) => {
    const s = String(url)
    if (s.includes('/api/photos/view-url/')) return Promise.resolve(viewUrl)
    if (s.includes('timeframe=7d')) return Promise.resolve({ aggregates: { crops: [], other: [] } })
    return Promise.resolve({ entries: [], aggregates: { crops, other: [], first_pick: [] }, cursor: null })
  })
  render(<Harvests />)
  await waitFor(() => expect(screen.getByText('Totals')).toBeTruthy())
  fireEvent.click(screen.getByText('Totals'))
  await screen.findByText('Tomato')
}

const viewUrlCalls = () => fetchSpy.mock.calls
  .map((c) => String(c[0])).filter((u) => u.includes('/api/photos/view-url/'))

describe('the crop photo on Harvest Totals', () => {
  it('resolves the crop’s hero id through the app’s one signed-URL path and renders it', async () => {
    await renderTotals([crop({ hero_photo_id: 'ph-tom' })])
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    expect(document.querySelector('img').getAttribute('src')).toBe(MINTED)
    expect(viewUrlCalls()[0]).toMatch(/^\/api\/photos\/view-url\/ph-tom\b/)
  })

  it('asks for the THUMB derivative, not the 24x-larger original', async () => {
    await renderTotals([crop({ hero_photo_id: 'ph-tom' })])
    await waitFor(() => expect(viewUrlCalls().length).toBe(1))
    expect(viewUrlCalls()[0]).toBe('/api/photos/view-url/ph-tom?tier=thumb')
  })

  it('spends ONE mint per crop, not one per crop per render', async () => {
    await renderTotals([crop({ hero_photo_id: 'ph-tom' })])
    await waitFor(() => expect(viewUrlCalls().length).toBe(1))
    // Collapse/expand re-renders the row; the module cache must absorb it.
    fireEvent.click(screen.getByText('Tomato'))
    await act(async () => {})
    fireEvent.click(screen.getByText('Tomato'))
    await act(async () => {})
    expect(viewUrlCalls().length).toBe(1)
  })

  it('renders NOTHING — not a placeholder box — when the crop has no photo', async () => {
    await renderTotals([crop({ hero_photo_id: null })])
    await act(async () => {})
    // queryByTestId, not querySelector('img'): PhotoImg's placeholder is a styled DIV carrying the
    // same forwarded props, so an "is there an img" assertion passes for a grey square too and the
    // silent-collapse contract could be deleted with this test still green.
    expect(screen.queryByTestId('crop-hero')).toBeNull()
    expect(viewUrlCalls()).toEqual([])
  })

  it('renders nothing and never fetches when the field is ABSENT (older Lambda / rollback)', async () => {
    await renderTotals([crop({})])
    await act(async () => {})
    expect(screen.getByText('Tomato')).toBeTruthy()   // the totals themselves still render
    expect(screen.queryByTestId('crop-hero')).toBeNull()
    expect(viewUrlCalls()).toEqual([])
  })

  it('collapses rather than reserving a grey box while the mint is still in flight', async () => {
    // The pending state is the one a 31-row list would show most often on a cold load, and it is the
    // state `fallback` governs. A placeholder here is 31 grey squares before the first photo lands.
    await renderTotals([crop({ hero_photo_id: 'ph-tom' })], { viewUrl: new Promise(() => {}) })
    await waitFor(() => expect(viewUrlCalls().length).toBe(1))
    expect(screen.queryByTestId('crop-hero')).toBeNull()
  })

  it('is decorative: the crop name is the label, so the image adds no second announcement', async () => {
    await renderTotals([crop({ hero_photo_id: 'ph-tom' })])
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    expect(document.querySelector('img').getAttribute('alt')).toBe('')
  })

  it('collapses silently when the id cannot be resolved at all', async () => {
    const err = new Error('gone'); err.status = 404
    await renderTotals([crop({ hero_photo_id: 'ph-dead' })], { viewUrl: Promise.reject(err) })
    await waitFor(() => expect(viewUrlCalls().length).toBeGreaterThan(0))
    await act(async () => {})
    expect(screen.queryByTestId('crop-hero')).toBeNull()
    expect(screen.getByText('Tomato')).toBeTruthy()
  })
})
