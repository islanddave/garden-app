// PhotoImg — deterministic tests (garden-perf-image-plan V102 §A1 + A2b). Verifies the re-mint
// self-heal mechanism without a real network: mock useApiFetch, drive <img> onError / lifecycle
// events, assert exactly-one-remint / swap / failure-class handling / storm dedup / forced re-decode /
// elapsed gate, PLUS A2b: fetch-on-mount (id-only), pending render, terminal a11y semantics,
// stale-heal identity guard (P4), and the viewport-gated proactive path (P5).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, act } from '@testing-library/react'
import React from 'react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))

import PhotoImg, { __resetPhotoImgCache, __seedPhotoImgUrl, PRESIGN_TTL_MS } from '../components/PhotoImg.jsx'
// A cross-origin photo now spends one absorbed CORS attempt before an error reaches the heal.
// failPhotoLoad says "the image failed" and is blind to the flag; PhotoImg.cors.test.jsx owns the retry.
import { failPhotoLoad } from './helpers/photoLoadFailure.js'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const img = (c) => c.querySelector('img')
// Stub the <img> box so the P5 viewport gate can be exercised (jsdom's default rect is 0×0 = off-screen).
const onScreen = (el) => { if (el) el.getBoundingClientRect = () => ({ top: 10, left: 10, bottom: 110, right: 110, width: 100, height: 100, x: 10, y: 10, toJSON() {} }) }

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
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/view-url/p1', { cache: 'no-store' })
  })

  it('a fresh URL that ALSO errors goes terminal (retry budget spent, no loop)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="p1b" initialUrl="https://s3/stale.jpg" alt="x" />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3/fresh.jpg'))
    failPhotoLoad(() => img(container))                               // fresh URL still 403
    await waitFor(() => expect(img(container)).toBeNull())        // terminal placeholder
    expect(fetchSpy).toHaveBeenCalledTimes(1)                     // budget: exactly one re-mint
  })

  it('re-mint 404 (deleted) => terminal placeholder + onError(deleted) signal', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="p2" initialUrl="https://s3/stale.jpg" alt="x" onError={onError} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'deleted', photoId: 'p2' }))
  })

  it('view-url returning no url => terminal placeholder, never src=null', async () => {
    fetchSpy.mockResolvedValue({ view_url: null })
    const { container } = render(<PhotoImg photoId="p3" initialUrl="https://s3/stale.jpg" alt="x" />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('transient mint failure (network, no status) => non-terminal, budget NOT spent; a later error recovers', async () => {
    const neterr = new Error('network')
    fetchSpy.mockRejectedValueOnce(neterr).mockResolvedValueOnce({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="p4" initialUrl="https://s3/stale.jpg" alt="x" />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(img(container)).toBeTruthy()                           // non-terminal (still an img, not a placeholder)
    failPhotoLoad(() => img(container))                              // budget was preserved → re-mints again
    await waitFor(() => expect(img(container).getAttribute('src')).toBe('https://s3/fresh.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('a re-mint returning the SAME url heals via forced re-decode (not a silent no-op → not terminal)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/stale.jpg' })   // identical to initial
    const { container } = render(<PhotoImg photoId="p7" initialUrl="https://s3/stale.jpg" alt="x" />)
    failPhotoLoad(() => img(container))
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
    failPhotoLoad(() => img(container))
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
    failPhotoLoad(() => container.querySelectorAll('img')[0])
    failPhotoLoad(() => container.querySelectorAll('img')[1])
    expect(fetchSpy).toHaveBeenCalledTimes(1)                    // one call for both (module storm map)
    await act(async () => { resolve({ view_url: 'https://s3/fresh.jpg' }) })
    await waitFor(() => container.querySelectorAll('img').forEach((i) => expect(i.getAttribute('src')).toBe('https://s3/fresh.jpg')))
  })
})

describe('PhotoImg — proactive elapsed + viewport gate (NEW-4 + A2b P5)', () => {
  it('a visibilitychange within the presign TTL does NOT re-mint (even for an in-viewport img)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="p8" initialUrl="https://s3/stale.jpg" alt="x" />)   // mount seeds at=now
    onScreen(img(container))                                      // pass the viewport gate so the TTL gate is what's under test
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await Promise.resolve()
    expect(fetchSpy).not.toHaveBeenCalled()                      // within TTL → gated, no flash-on-foreground
  })

  it('a past-TTL foreground re-mints an IN-VIEWPORT photo and adopts the fresh URL', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    __seedPhotoImgUrl('p9', 'https://s3/stale.jpg', Date.now() - PRESIGN_TTL_MS - 1)   // aged so the elapsed gate opens; _seed won't overwrite
    const { container } = render(<PhotoImg photoId="p9" initialUrl="https://s3/stale.jpg" alt="x" />)
    onScreen(img(container))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/fresh.jpg'))
  })

  it('a past-TTL foreground does NOT re-mint an OFF-SCREEN photo (P5 viewport gate bounds the grid storm)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    __seedPhotoImgUrl('p9b', 'https://s3/stale.jpg', Date.now() - PRESIGN_TTL_MS - 1)   // elapsed gate open
    const { container } = render(<PhotoImg photoId="p9b" initialUrl="https://s3/stale.jpg" alt="x" />)
    // do NOT call onScreen() → jsdom default 0×0 rect = off-screen
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await Promise.resolve()
    expect(fetchSpy).not.toHaveBeenCalled()                      // off-screen → skipped (heals reactively on scroll-in)
  })
})

describe('PhotoImg — fetch-on-mount, id-only (A2b P1/P2)', () => {
  it('N1 photoId with no initialUrl mints once on mount and adopts', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/m1.jpg' })
    const { container } = render(<PhotoImg photoId="m1" alt="x" />)
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/m1.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/view-url/m1', { cache: 'no-store' })
  })

  it('N2 id-only mount under StrictMode mints exactly once and still adopts', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/m2.jpg' })
    const { container } = render(<React.StrictMode><PhotoImg photoId="m2" alt="x" /></React.StrictMode>)
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/m2.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('N3 two id-only instances of one photoId share a single mount-mint (dedup)', async () => {
    let resolve
    fetchSpy.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(<div><PhotoImg photoId="m3" alt="a" /><PhotoImg photoId="m3" alt="b" /></div>)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ view_url: 'https://s3/m3.jpg' }) })
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(2))
    container.querySelectorAll('img').forEach((i) => expect(i.getAttribute('src')).toBe('https://s3/m3.jpg'))
  })

  it('N4 id-only mount with a warm (within-TTL) cache adopts with ZERO network', async () => {
    __seedPhotoImgUrl('m4', 'https://s3/warm.jpg')               // at defaults to now (fresh)
    const { container } = render(<PhotoImg photoId="m4" alt="x" />)
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/warm.jpg'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('N5 does NOT mount-mint when initialUrl is present', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/never.jpg' })
    render(<PhotoImg photoId="m5" initialUrl="https://s3/have.jpg" alt="x" />)
    await Promise.resolve(); await Promise.resolve()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('N6 id-only + fallback="none" renders nothing while pending, then the img', async () => {
    let resolve
    fetchSpy.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(<PhotoImg photoId="m6" fallback="none" alt="x" />)
    expect(container.firstChild).toBeNull()                       // pending + none → nothing (no <img src=null>)
    await act(async () => { resolve({ view_url: 'https://s3/m6.jpg' }) })
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/m6.jpg'))
  })

  it('N7 id-only + fallback="placeholder" reserves a box while pending (never <img src=null>)', async () => {
    let resolve
    fetchSpy.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(<PhotoImg photoId="m7" alt="x" />)
    expect(img(container)).toBeNull()                             // NO <img> while pending
    expect(container.querySelector('div')).toBeTruthy()          // placeholder box reserves layout
    await act(async () => { resolve({ view_url: 'https://s3/m7.jpg' }) })
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/m7.jpg'))
  })

  it('N8 id-only mount 404 => terminal + onError(deleted)', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="m8" alt="x" onError={onError} />)
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'deleted', photoId: 'm8' })))
    expect(img(container)).toBeNull()
  })

  it('N10 id-only mount transient network failure stays non-terminal (recoverable)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network'))
    const { container } = render(<PhotoImg photoId="m10" alt="x" />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const box = container.querySelector('div')
    expect(box).toBeTruthy()                                      // pending box, not an img
    expect(box.getAttribute('role')).toBeNull()                  // NOT terminal (no announced role)
  })
})

describe('PhotoImg — terminal a11y semantics (A2b P3)', () => {
  it('a DECORATIVE (alt="") image that goes terminal stays aria-hidden with no role/label; ...rest survives', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const { container } = render(<PhotoImg photoId="a1" initialUrl="https://s3/x.jpg" alt="" data-testid="tt" aria-hidden="true" />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    const box = container.querySelector('div')
    expect(box.getAttribute('aria-hidden')).toBe('true')         // decorative stays silent
    expect(box.getAttribute('role')).toBeNull()
    expect(box.getAttribute('aria-label')).toBeNull()
    expect(box.getAttribute('data-testid')).toBe('tt')           // ...rest preserved through terminal
  })

  it('a MEANINGFUL (alt set) image that goes terminal exposes role=img + aria-label=alt', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const { container } = render(<PhotoImg photoId="a2" initialUrl="https://s3/x.jpg" alt="Tomato" />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    const box = container.querySelector('div')
    expect(box.getAttribute('role')).toBe('img')
    expect(box.getAttribute('aria-label')).toBe('Tomato')
    expect(box.getAttribute('aria-hidden')).toBeNull()
  })
})

describe('PhotoImg — stale-heal identity guard (A2b P4)', () => {
  it('a heal that resolves AFTER the consumer paged to a new photoId does not set the stale URL', async () => {
    let resolveA
    fetchSpy.mockReturnValueOnce(new Promise((r) => { resolveA = r }))
    const { container, rerender } = render(<PhotoImg photoId="A" initialUrl="https://s3/staleA.jpg" alt="x" />)
    failPhotoLoad(() => img(container))                              // starts mintUrl(A), in-flight
    rerender(<PhotoImg photoId="B" initialUrl="https://s3/urlB.jpg" alt="x" />)   // consumer paged to B
    expect(img(container).getAttribute('src')).toBe('https://s3/urlB.jpg')
    await act(async () => { resolveA({ view_url: 'https://s3/freshA.jpg' }) })     // A's heal resolves late
    expect(img(container).getAttribute('src')).toBe('https://s3/urlB.jpg')         // guard: never freshA on B
  })
})
