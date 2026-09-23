// BUG-PHOTOIMGSTALECATCH-001 — a late mint FAILURE for a photo this PhotoImg has since been paged away
// from must not touch the photo it shows now. The Lightbox pages one instance across photos; adopt()
// already drops a late SUCCESS for the old photo (the P4/D1 stale-heal guard), but the two catch paths
// checked only that the component was still mounted, so a late 404 for photo A put photo B into its
// TERMINAL box — even after B had loaded — and sent the consumer a 'deleted' while B was on screen.
// Proved in jsdom on 2026-09-21 (lane-seedpacketfallback2 report, R1/R2); these are those two probes,
// asserted.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }) }))

import PhotoImg, { __resetPhotoImgCache } from '../components/PhotoImg.jsx'
import { failPhotoLoad } from './helpers/photoLoadFailure.js'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })
const img = (c) => c.querySelector('img')
const gone = () => { const e = new Error('gone'); e.status = 404; return e }
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('PhotoImg — a late failure for the photo it left does not reach the photo it shows', () => {
  it('reactive heal: A fails, its re-mint is still out when the instance pages to B, then A\'s mint 404s', async () => {
    let rejectA
    fetchSpy.mockReturnValueOnce(new Promise((_, rej) => { rejectA = rej }))
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const { container, rerender } = render(<PhotoImg photoId="A" initialUrl="https://s3/a.jpg" alt="" onTerminal={onTerminal} onError={onError} />)
    failPhotoLoad(() => img(container))                             // A's <img> errors -> one re-mint for A, left pending
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    rerender(<PhotoImg photoId="B" initialUrl="https://s3/b.jpg" alt="" onTerminal={onTerminal} onError={onError} />)
    expect(img(container)?.getAttribute('src')).toBe('https://s3/b.jpg')
    const errorsBefore = onError.mock.calls.length
    await act(async () => { rejectA(gone()) })
    await flush()
    expect(img(container)?.getAttribute('src')).toBe('https://s3/b.jpg')   // B is still drawn
    expect(onTerminal).not.toHaveBeenCalled()
    expect(onError.mock.calls.slice(errorsBefore)).toEqual([])            // no 'deleted' sent while B is on screen
    // And B heals on its own terms afterwards: its first failure re-mints B, not A.
    fetchSpy.mockResolvedValueOnce({ view_url: 'https://s3/b-healed.jpg' })
    failPhotoLoad(() => img(container))
    await flush()
    expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/photos/view-url/B')
    expect(img(container)?.getAttribute('src')).toBe('https://s3/b-healed.jpg')
  })

  it('mount-mint: an id-only A is paged to B, B loads, then A\'s mount-mint 404s', async () => {
    let rejectA
    fetchSpy.mockReturnValueOnce(new Promise((_, rej) => { rejectA = rej })).mockResolvedValueOnce({ view_url: 'https://s3/b-fresh.jpg' })
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const { container, rerender } = render(<PhotoImg photoId="A" alt="" onTerminal={onTerminal} onError={onError} />)
    rerender(<PhotoImg photoId="B" alt="" onTerminal={onTerminal} onError={onError} />)
    await flush()
    expect(img(container)?.getAttribute('src')).toBe('https://s3/b-fresh.jpg')
    await act(async () => { rejectA(gone()) })
    await flush()
    expect(img(container)?.getAttribute('src')).toBe('https://s3/b-fresh.jpg')
    expect(onTerminal).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('the guard is about identity, not timing: a 404 for the photo still on screen still ends TERMINAL', async () => {
    fetchSpy.mockRejectedValueOnce(gone())
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="C" alt="" onTerminal={onTerminal} onError={onError} />)
    await flush()
    expect(img(container)).toBeNull()
    expect(onTerminal).toHaveBeenCalledWith('C')
    expect(onError).toHaveBeenCalledWith({ type: 'deleted', photoId: 'C' })
  })
})
