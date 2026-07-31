// PhotoImg — §A5 deterministic tests (garden-perf-image-plan V102). Verifies the re-mint self-heal
// mechanism without a real network: mock useApiFetch, drive <img> onError / lifecycle events, assert
// exactly-one-remint / swap / failure-class handling / storm dedup / forced re-decode / elapsed gate.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, act } from '@testing-library/react'
import React from 'react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))

import PhotoImg, { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const img = (c) => c.querySelector('img')

describe('PhotoImg — render contract', () => {
  it('renders initialUrl and forwards className/alt to the inner img', () => {
    const { container } = render(<PhotoImg photoId="p0" initialUrl="https://s3/a.jpg" alt="hero" className="c" style={{ borderRadius: 12 }} />)
    expect(img(container).getAttribute('src')).toBe('https://s3/a.jpg')
    expect(img(container).getAttribute('alt')).toBe('hero')
    expect(img(container).className).toBe('c')
  })

  it('empty (no photoId + no url) renders a placeholder box; fallback="none" renders nothing', () => {
    const { container, rerender } = render(<PhotoImg photoId={null} initialUrl={null} alt="x" />)
    expect(img(container)).toBeNull()
    expect(container.querySelector('div')).toBeTruthy()          // aspect-reserving placeholder box
    rerender(<PhotoImg photoId={null} initialUrl={null} alt="x" fallback="none" />)
    expect(container.firstChild).toBeNull()                       // silent collapse (PutUpPhotoThumb contract)
  })
})

describe('PhotoImg — reactive self-heal', () => {
  it('an <img> error triggers exactly one re-mint and swaps to the fresh URL (no placeholder)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg', expires_in: 900 })
    const { container } = render(<PhotoImg photoId="p1" initialUrl="https://s3/stale.jpg" alt="x" />)
    expect(img(container).getAttribute('src')).toBe('https://s3/stale.jpg')
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/view-url/p1', { cache: 'no-store' })
  })

  it('a fresh URL that ALSO errors goes terminal (retry budget spent, no loop)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="p1b" initialUrl="https://s3/stale.jpg" alt="x" />)
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3/fresh.jpg'))
    fireEvent.error(img(container))                               // fresh URL still 403
    await waitFor(() => expect(img(container)).toBeNull())        // terminal placeholder
    expect(fetchSpy).toHaveBeenCalledTimes(1)                     // budget: exactly one re-mint
  })

  it('re-mint 404 (deleted) => terminal placeholder + onError(deleted) signal', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="p2" initialUrl="https://s3/stale.jpg" alt="x" onError={onError} />)
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'deleted', photoId: 'p2' }))
  })

  it('view-url returning no url => terminal placeholder, never src=null', async () => {
    fetchSpy.mockResolvedValue({ view_url: null })
    const { container } = render(<PhotoImg photoId="p3" initialUrl="https://s3/stale.jpg" alt="x" />)
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('transient mint failure (network, no status) => non-terminal, budget NOT spent; a later error recovers', async () => {
    const neterr = new Error('network')
    fetchSpy.mockRejectedValueOnce(neterr).mockResolvedValueOnce({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="p4" initialUrl="https://s3/stale.jpg" alt="x" />)
    fireEvent.error(img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(img(container)).toBeTruthy()                           // non-terminal (still an img, not a placeholder)
    fireEvent.error(img(container))                              // budget was preserved → re-mints again
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('a re-mint returning the SAME url heals via forced re-decode (not a silent no-op → not terminal)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/stale.jpg' })   // identical to initial
    const { container } = render(<PhotoImg photoId="p7" initialUrl="https://s3/stale.jpg" alt="x" />)
    fireEvent.error(img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/stale.jpg'))
  })
})

describe('PhotoImg — storm control + StrictMode', () => {
  it('StrictMode double-invoke still fires exactly one re-mint', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(
      <React.StrictMode><PhotoImg photoId="p5" initialUrl="https://s3/stale.jpg" alt="x" /></React.StrictMode>,
    )
    fireEvent.error(img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('two instances of one photoId share a single in-flight re-mint (dedup)', async () => {
    let resolve
    fetchSpy.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(
      <div>
        <PhotoImg photoId="p6" initialUrl="https://s3/a.jpg" alt="hero" />
        <PhotoImg photoId="p6" initialUrl="https://s3/a.jpg" alt="thumb" />
      </div>,
    )
    const imgs = container.querySelectorAll('img')
    fireEvent.error(imgs[0])
    fireEvent.error(imgs[1])
    expect(fetchSpy).toHaveBeenCalledTimes(1)                    // one call for both (module storm map)
    await act(async () => { resolve({ view_url: 'https://s3/fresh.jpg' }) })
    await waitFor(() => container.querySelectorAll('img').forEach((i) => expect(i.getAttribute('src')).toBe('https://s3/fresh.jpg')))
  })
})

describe('PhotoImg — proactive elapsed gate (NEW-4)', () => {
  it('a visibilitychange within the presign TTL of the last mint does NOT re-mint', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    render(<PhotoImg photoId="p8" initialUrl="https://s3/stale.jpg" alt="x" />)   // mount seeds lastMintedAt=now
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await Promise.resolve()
    expect(fetchSpy).not.toHaveBeenCalled()                      // within TTL → gated, no flash-on-foreground
  })

  it('a foreground with no prior mint (past-TTL path) DOES re-mint and adopts the fresh URL', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="p9" initialUrl={null} alt="x" />)   // no seed → gate open
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/fresh.jpg'))
  })
})
