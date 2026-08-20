// V4-HARVPOSTPHOTOS-001 — the composer's photo half, wired end to end.
//
// THE DEFECT THIS CLOSES: the composer shipped the caption and stopped, so every photo of tonight's
// harvest was still re-added by hand in the Facebook composer. Each test below is named for the way
// that fix could go wrong instead: fetching at tap time (activation is gone), losing the caption to
// attach a picture, downloading photos nobody asked for, or going quiet while it works.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }) }))
const shareMock = vi.fn()
const canShareFilesMock = vi.fn()
vi.mock('../lib/shareEntity.js', () => ({
  shareEntity: (...a) => shareMock(...a),
  canShareFiles: (...a) => canShareFilesMock(...a),
}))
vi.mock('../components/Icon.jsx', () => ({ default: () => null }))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => ({ user: null, profile: { id: 'user_dave' }, loading: false }),
}))

import ComposeHarvestBand from '../components/ComposeHarvestBand.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

const DAVE = 'user_dave'
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString()

const entry = (created_at, planting_name, crop_name, quantity, extra = {}) => ({
  event_id: `ev-${planting_name}`,
  event_type: 'harvest',
  created_at,
  created_by: DAVE,
  planting_name,
  variety_name: planting_name,
  crop_name,
  quantity,
  unit: 'count',
  note_excerpt: null,
  photos: [],
  ...extra,
})

const photo = (id) => ({ id, caption: null, taken_at: null })

const BATCH = [
  entry(ago(20), '1884', 'Tomato', 3, { photos: [photo('ph-1')] }),
  entry(ago(19), 'Cubanelle', 'Pepper', 1, { photos: [photo('ph-2')] }),
]
const AGGREGATES = { crops: [] }

// The composer makes exactly two kinds of request: the harvests read, and one view-url mint per
// photo. Routing by URL keeps them apart — a blanket mockResolvedValue would answer a mint with the
// harvests payload and look like a photo failure.
function wireApi({ entries = BATCH, mintFails = [] } = {}) {
  fetchMock.mockImplementation(async (url) => {
    if (url.startsWith('/api/harvests')) return { entries, aggregates: AGGREGATES }
    const m = url.match(/^\/api\/photos\/view-url\/([^?]+)/)
    if (m) {
      if (mintFails.includes(m[1])) { const e = new Error('mint 500'); e.status = 500; throw e }
      return { view_url: `https://s3.example/${m[1]}?X-Amz-Signature=sig`, tier: 'full' }
    }
    throw new Error(`unexpected fetch ${url}`)
  })
}

// The presigned GET is a bare cross-origin fetch, NOT useApiFetch — an Authorization header would
// make S3 reject the signature. So it is window.fetch that gets stubbed here, not fetchMock.
function wireS3({ fail = [], bytes = 4096 } = {}) {
  const calls = []
  globalThis.fetch = vi.fn(async (url) => {
    const id = String(url).split('/')[3].split('?')[0]
    calls.push(id)
    if (fail.includes(id)) return { ok: false, status: 403, blob: async () => null }
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }) }
  })
  return calls
}

const openComposer = async (user) => user.click(await screen.findByRole('button', { name: /Compose post/i }))
const note = () => screen.getByTestId('compose-photo-note').textContent

beforeEach(() => {
  fetchMock.mockReset()
  shareMock.mockReset()
  shareMock.mockResolvedValue('shared')
  canShareFilesMock.mockReset()
  canShareFilesMock.mockImplementation((f) => Array.isArray(f) && f.length > 0)
  __resetPhotoImgCache()
})

describe('ComposeHarvestBand — photos ride with the post', () => {
  it('hands the batch photos to the share sheet as Files, alongside the words', async () => {
    wireApi(); wireS3()
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(note()).toMatch(/2 photos will go with it/))

    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    const arg = shareMock.mock.calls[0][0]
    expect(arg.text).toContain('Cubanelle')
    expect(arg.files).toHaveLength(2)
    expect(arg.files[0]).toBeInstanceOf(File)
    expect(arg.files[0].type).toBe('image/jpeg')
  })

  it('fetches the photos when the composer OPENS, not when Share is tapped', async () => {
    // navigator.share needs transient user activation and Chrome Android drops it across an await.
    // A handler that fetched first would find the activation gone and reject silently.
    wireApi(); const s3 = wireS3()
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(s3).toEqual(['ph-1', 'ph-2']))

    globalThis.fetch.mockClear()
    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('downloads NOTHING until the composer is opened — the band stays ambient on Today', async () => {
    wireApi(); const s3 = wireS3()
    render(<ComposeHarvestBand />)
    expect(await screen.findByText(/2 picks/)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 0))
    expect(s3).toEqual([])
  })

  it('costs no photo requests at all for a batch with no photos', async () => {
    wireApi({ entries: [entry(ago(20), '1884', 'Tomato', 3), entry(ago(19), 'Cubanelle', 'Pepper', 1)] })
    const s3 = wireS3()
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(screen.getByTestId('compose-share')).toBeTruthy())
    expect(s3).toEqual([])
    expect(note()).toBe('')
  })
})

describe('ComposeHarvestBand — the caption is never lost', () => {
  it('still shares the words when the browser cannot attach files', async () => {
    canShareFilesMock.mockReturnValue(false)
    wireApi(); wireS3()
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(note()).toMatch(/can.t attach photos/))

    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    expect(shareMock.mock.calls[0][0].text).toContain('Cubanelle')
    expect(await screen.findByText('Sent to your share sheet.')).toBeTruthy()
  })

  it('still shares the words when every photo fails to load', async () => {
    wireApi(); wireS3({ fail: ['ph-1', 'ph-2'] })
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(note()).toMatch(/Photos didn.t load — the words will still go/))

    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    expect(shareMock.mock.calls[0][0].text).toContain('Cubanelle')
    expect(shareMock.mock.calls[0][0].files).toEqual([])
  })

  it('offers a direct clipboard copy for a share target that keeps the images and drops the text', async () => {
    wireApi(); wireS3()
    // userEvent.setup() installs its own working navigator.clipboard, so the assertion reads the
    // clipboard itself rather than a spy — a stub defined here would be replaced by it.
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await user.click(screen.getByTestId('compose-copy'))
    expect(await screen.findByText('Copied.')).toBeTruthy()
    expect(await navigator.clipboard.readText()).toContain('Cubanelle')
  })
})

describe('ComposeHarvestBand — partial and excluded', () => {
  it('sends the one that loaded and NAMES the one that did not', async () => {
    wireApi(); wireS3({ fail: ['ph-2'] })
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(note()).toBe('1 photo will go with it · 1 didn’t load'))

    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1)
  })

  it('drops a line’s photo when that line is left out of the post', async () => {
    wireApi(); wireS3()
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(note()).toMatch(/2 photos/))

    await user.click(screen.getByRole('button', { name: /What.s in the post/ }))
    await user.click(screen.getByRole('button', { name: /1 Cubanelle/ }))
    await waitFor(() => expect(note()).toBe('1 photo will go with it'))

    await user.click(screen.getByTestId('compose-share'))
    await waitFor(() => expect(shareMock).toHaveBeenCalled())
    expect(shareMock.mock.calls[0][0].files).toHaveLength(1)
    expect(shareMock.mock.calls[0][0].text).not.toContain('Cubanelle')
  })

  it('says what it is doing while it works, in context and without a modal, toast or badge', async () => {
    wireApi()
    let release
    const gate = new Promise((r) => { release = r })
    globalThis.fetch = vi.fn(async () => {
      await gate
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(64)], { type: 'image/jpeg' }) }
    })
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(note()).toBe('Getting 2 photos…'))
    expect(screen.getByTestId('compose-photo-note').getAttribute('aria-live')).toBe('polite')
    // Share is never disabled while photos load: an early tap sends the words, as it does today.
    expect(screen.getByTestId('compose-share').disabled).toBe(false)
    release()
    await waitFor(() => expect(note()).toMatch(/2 photos will go with it/))
  })

  it('reports the photo count back after the share', async () => {
    wireApi(); wireS3()
    const user = userEvent.setup()
    render(<ComposeHarvestBand />)
    await openComposer(user)
    await waitFor(() => expect(note()).toMatch(/2 photos/))
    await user.click(screen.getByTestId('compose-share'))
    expect(await screen.findByText('Sent to your share sheet with 2 photos.')).toBeTruthy()
  })
})
