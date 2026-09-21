// V5-SEEDSPOLISH-001 — PhotoImg's `onTerminal` event (FROZEN CONTRACT delta (5), Dave-approved 2026-09-21).
//
// onTerminal fires ONCE at each entry into TERMINAL and never otherwise. The T cases drive one entry
// each, named for the setTerminal(true) site that fires it; the N cases are the states it must stay
// silent for — pending, a heal that lands, a transient 503 on either path, a source whose consumer
// degrades instead, and the fallback="none" heal that never enters TERMINAL at all. The V cases prove
// it reaches PhotoImg through PhotoView on BOTH arms with no PhotoView change (it rides `...rest`),
// and that a mid-chain rung's failure is not reported as the photo's. T0 is the static half: a
// terminal entry added later without the event beside it reds here even if no behaviour test drives it.
//
// WHAT THIS CANNOT CATCH: jsdom never loads an image, so an <img> "failing" is always a synthetic
// error event (failPhotoLoad). These prove when the event fires, not that a picture failed to paint.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))

import PhotoImg, { __resetPhotoImgCache } from '../components/PhotoImg.jsx'
import PhotoView from '../components/photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'
// A cross-origin photo spends one absorbed CORS attempt before an error reaches the heal; failPhotoLoad
// says "the image failed" either way. PhotoImg.cors.test.jsx owns the retry itself.
import { failPhotoLoad } from './helpers/photoLoadFailure.js'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const __dirname = dirname(fileURLToPath(import.meta.url))
const img = (c) => c.querySelector('img')
const failure = (status) => { const e = new Error(`status ${status}`); e.status = status; return e }
const requested = () => fetchSpy.mock.calls.map((c) => String(c[0]))
// Lets every queued promise and state update land, so "called once" cannot be "a second call not yet
// arrived" and "not called" cannot be "not called yet".
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
// With a meaningful alt, TERMINAL is the only state that announces (role=img); PENDING stays silent.
// That is how the mount-path cases below observe the state without reading the event under test.
const announced = (c) => c.firstChild?.getAttribute('role') === 'img'

describe('T0. every entry into TERMINAL reports it (static census of PhotoImg.jsx)', () => {
  const SRC_TEXT = readFileSync(resolve(__dirname, '../components/PhotoImg.jsx'), 'utf8')
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const BODY = stripComments(SRC_TEXT.slice(SRC_TEXT.indexOf('export default function PhotoImg')))

  it('T0 each setTerminal(true) in the component body has onTerminal?.(photoId) right beside it', () => {
    const entries = BODY.match(/setTerminal\(true\)/g) ?? []
    const reported = BODY.match(/setTerminal\(true\);\s*onTerminal\?\.\(photoId\)/g) ?? []
    expect(entries.length).toBeGreaterThan(0)                    // not vacuous: the scan found the entries
    expect(reported.length, 'a setTerminal(true) without onTerminal beside it: a terminal no consumer hears').toBe(entries.length)
  })
})

describe('T. each entry into TERMINAL fires onTerminal exactly once, with the photo id', () => {
  it('T1 heal exhausted — the re-minted URL fails too (the retriedRef branch of handleError)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="t1" initialUrl="https://s3/stale.jpg" alt="" onTerminal={onTerminal} onError={onError} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/fresh.jpg'))
    expect(onTerminal).not.toHaveBeenCalled()                   // the heal landed: live, not terminal
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    await settle()
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith('t1')
    // The event does not ride on onError: one onError per failed load, nothing extra at terminal.
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('T1b heal exhausted with no photo id — nothing to re-mint by, so the first error is terminal', async () => {
    const onTerminal = vi.fn()
    const { container } = render(<PhotoImg initialUrl="https://s3/no-id.jpg" alt="" onTerminal={onTerminal} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    await settle()
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith(undefined)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('T2 re-mint 404 (deleted) — and the existing onError(deleted) signal still goes out', async () => {
    fetchSpy.mockRejectedValue(failure(404))
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="t2" initialUrl="https://s3/stale.jpg" alt="" onTerminal={onTerminal} onError={onError} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    await settle()
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith('t2')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'deleted', photoId: 't2' }))
  })

  it('T3 re-mint 403 — a fresh URL that is still forbidden', async () => {
    fetchSpy.mockRejectedValue(failure(403))
    const onTerminal = vi.fn()
    const { container } = render(<PhotoImg photoId="t3" initialUrl="https://s3/stale.jpg" alt="" onTerminal={onTerminal} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    await settle()
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith('t3')
  })

  it('T4 mount-mint 404 (an id-only photo that is gone) — and onError(deleted) still goes out', async () => {
    fetchSpy.mockRejectedValue(failure(404))
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="t4" alt="Packet" onTerminal={onTerminal} onError={onError} />)
    await waitFor(() => expect(announced(container)).toBe(true))
    await settle()
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith('t4')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'deleted', photoId: 't4' }))
  })

  it('T5 mount-mint 403 — zero other callbacks here, which is why the event had to exist', async () => {
    fetchSpy.mockRejectedValue(failure(403))
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const onRemint = vi.fn()
    const { container } = render(<PhotoImg photoId="t5" alt="Packet" onTerminal={onTerminal} onError={onError} onRemint={onRemint} />)
    await waitFor(() => expect(announced(container)).toBe(true))
    await settle()
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith('t5')
    expect(onError).not.toHaveBeenCalled()
    expect(onRemint).not.toHaveBeenCalled()
  })

  it('T6 once PER ENTRY: a reset to a new photo that also goes terminal fires again, naming the new photo', async () => {
    fetchSpy.mockRejectedValue(failure(404))
    const onTerminal = vi.fn()
    const { container, rerender } = render(<PhotoImg photoId="t6a" alt="Packet" onTerminal={onTerminal} />)
    await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1))
    rerender(<PhotoImg photoId="t6b" alt="Packet" onTerminal={onTerminal} />)
    await waitFor(() => expect(requested()).toContain('/api/photos/view-url/t6b'))
    await waitFor(() => expect(announced(container)).toBe(true))
    await settle()
    expect(onTerminal.mock.calls).toEqual([['t6a'], ['t6b']])
  })
})

describe('N. onTerminal stays silent for everything that is not TERMINAL', () => {
  it('N1 pending — a mount-mint that has not answered fires nothing', async () => {
    fetchSpy.mockReturnValue(new Promise(() => {}))
    const onTerminal = vi.fn()
    const { container } = render(<PhotoImg photoId="n1" alt="Packet" onTerminal={onTerminal} />)
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(img(container)).toBeNull()
    expect(announced(container)).toBe(false)                    // the pending box, not the terminal one
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('N2 a heal that lands — a mount-mint that answers, then a re-mint after an error — fires nothing', async () => {
    fetchSpy.mockResolvedValueOnce({ view_url: 'https://s3/n2-first.jpg' }).mockResolvedValueOnce({ view_url: 'https://s3/n2-fresh.jpg' })
    const onTerminal = vi.fn()
    const onRemint = vi.fn()
    const { container } = render(<PhotoImg photoId="n2" alt="" onTerminal={onTerminal} onRemint={onRemint} />)
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/n2-first.jpg'))
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/n2-fresh.jpg'))
    await settle()
    expect(onRemint).toHaveBeenCalledTimes(2)
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('N3 a re-mint 503 keeps the retry budget and the <img>, and fires nothing', async () => {
    fetchSpy.mockRejectedValue(failure(503))
    const onTerminal = vi.fn()
    const { container } = render(<PhotoImg photoId="n3" initialUrl="https://s3/stale.jpg" alt="" onTerminal={onTerminal} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await settle()
    expect(img(container)).toBeTruthy()
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('N4 a mount-mint 503 stays pending and fires nothing', async () => {
    fetchSpy.mockRejectedValue(failure(503))
    const onTerminal = vi.fn()
    const { container } = render(<PhotoImg photoId="n4" alt="Packet" onTerminal={onTerminal} />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await settle()
    expect(announced(container)).toBe(false)
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('N5 a source whose consumer holds a fallback (hasFallback) stands down on error and fires nothing', async () => {
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const { container } = render(<PhotoImg photoId="n5" initialUrl="https://s3/rung1.jpg" hasFallback alt="" onTerminal={onTerminal} onError={onError} />)
    failPhotoLoad(() => img(container))
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)                    // the consumer is told, and degrades itself
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('N6 fallback="none": an exhausted heal keeps its broken <img>, never enters TERMINAL, fires nothing', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/n6-fresh.jpg' })
    const onTerminal = vi.fn()
    const { container } = render(<PhotoImg photoId="n6" initialUrl="https://s3/stale.jpg" fallback="none" alt="" onTerminal={onTerminal} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/n6-fresh.jpg'))
    failPhotoLoad(() => img(container))
    await settle()
    expect(img(container)).toBeTruthy()
    expect(onTerminal).not.toHaveBeenCalled()
  })
})

describe('V. through PhotoView — both arms forward it untouched, and only the photo\'s end is reported', () => {
  it('V1 URL arm, one rung (the My seeds device-thumb hit): terminal after the re-mint fails fires once', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://photos.test/thumbs/v1.jpg?X-Amz-Signature=fresh' })
    const onTerminal = vi.fn()
    const { container } = render(
      <PhotoView photo={{ id: 'v1', featured_photo_thumb_url: 'https://photos.test/thumbs/v1.jpg?x-id=GetObject' }} tier={TIER.THUMB} alt="" onTerminal={onTerminal} />,
    )
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)?.getAttribute('src')).toContain('Signature=fresh'))
    expect(onTerminal).not.toHaveBeenCalled()
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(img(container)).toBeNull())
    await settle()
    expect(onTerminal.mock.calls).toEqual([['v1']])
    expect(requested()).toEqual(['/api/photos/view-url/v1?tier=thumb'])
  })

  it('V2 id-only arm, thumb then original: the thumb failing fires nothing; the original\'s exhausted heal fires once', async () => {
    let n = 0
    fetchSpy.mockImplementation((p) => Promise.resolve({ view_url: `https://photos.test/${String(p).includes('tier=thumb') ? 'thumbs/' : ''}v2.jpg?s=${++n}` }))
    const onTerminal = vi.fn()
    const { container } = render(<PhotoView photo={{ id: 'v2' }} tier={TIER.THUMB} resolveById alt="" onTerminal={onTerminal} />)
    await waitFor(() => expect(img(container)?.getAttribute('src')).toContain('/thumbs/'))
    failPhotoLoad(() => img(container))                             // rung 1 (thumb) fails -> PhotoView degrades
    await waitFor(() => expect(img(container)?.getAttribute('src') || '').toMatch(/photos\.test\/v2\.jpg/))
    expect(onTerminal).not.toHaveBeenCalled()
    const firstFull = img(container).getAttribute('src')
    failPhotoLoad(() => img(container))                             // rung 2 (original) fails -> one re-mint
    await waitFor(() => expect(img(container)?.getAttribute('src') || firstFull).not.toBe(firstFull))
    expect(onTerminal).not.toHaveBeenCalled()
    failPhotoLoad(() => img(container))                             // the re-mint fails too -> TERMINAL
    await waitFor(() => expect(img(container)).toBeNull())
    await settle()
    expect(onTerminal.mock.calls).toEqual([['v2']])
    expect(requested()).toEqual(['/api/photos/view-url/v2?tier=thumb', '/api/photos/view-url/v2', '/api/photos/view-url/v2'])
  })

  it('V3 id-only arm, a deleted photo (every mint 404s): reported from the thumb rung, and again from the original if the consumer stays', async () => {
    // view-url 404s only a missing/foreign/deleted photo ROW, never a missing derivative, so the thumb
    // rung's 404 is already true of the photo. A consumer that reacts (My seeds) stops at the first call.
    fetchSpy.mockRejectedValue(failure(404))
    const onTerminal = vi.fn()
    const { container } = render(<PhotoView photo={{ id: 'v3' }} tier={TIER.THUMB} resolveById alt="Packet" onTerminal={onTerminal} />)
    await waitFor(() => expect(requested()).toEqual(['/api/photos/view-url/v3?tier=thumb', '/api/photos/view-url/v3']))
    await waitFor(() => expect(announced(container)).toBe(true))
    await settle()
    expect(onTerminal.mock.calls).toEqual([['v3'], ['v3']])
  })
})
