// PutUpPhotoThumb — A2b: delegates to <PhotoImg> fetch-on-mount (photoId, no initialUrl). Verifies the
// lazy view-url resolve + the silent-collapse contract (renders NOTHING while pending / on failure —
// a broken thumb would read as data loss when the put-up record is intact).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))

import PutUpPhotoThumb from '../components/PutUpPhotoThumb.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })
const img = (c) => c.querySelector('img')

describe('PutUpPhotoThumb — fetch-on-mount via PhotoImg', () => {
  it('renders nothing when photoId is absent', () => {
    const { container } = render(<PutUpPhotoThumb photoId={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('mints the view-url on mount and renders the thumb (silent while pending)', async () => {
    let resolve
    fetchSpy.mockReturnValue(new Promise((r) => { resolve = r }))
    const { container } = render(<PutUpPhotoThumb photoId="pu1" size={36} alt="Put-up photo" />)
    expect(container.firstChild).toBeNull()                       // fallback='none' → nothing while pending
    await act(async () => { resolve({ view_url: 'https://s3/putup.jpg' }) })
    await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('https://s3/putup.jpg'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos/view-url/pu1', { cache: 'no-store' })
    expect(img(container).getAttribute('width')).toBe('36')       // size threaded through ...rest
  })

  it('renders nothing (never a broken glyph) when the photo is gone (404)', async () => {
    const err = new Error('gone'); err.status = 404; fetchSpy.mockRejectedValue(err)
    const { container } = render(<PutUpPhotoThumb photoId="pu2" />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.firstChild).toBeNull())  // terminal + fallback='none' → collapse
  })
})
