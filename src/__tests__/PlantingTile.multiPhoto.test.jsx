// PlantingTile.multiPhoto.test.jsx — V4-PHOTOBULK-001 S1, the payoff call site.
//
// WHY THIS FILE EXISTS SEPARATELY. PlantingTile.test.jsx mocks <PhotoUpload> out entirely (it locks
// the card's LINK topology, not the uploader), so it structurally cannot see this. And the existing
// Garden.photoUpload.test.jsx is a shipped contract suite; pinning a NEW capability by editing it
// would blur which assertions predate this change.
//
// A dormant prop is not a delivered capability: S1 gives <PhotoUpload> a `multiple` mode, and
// without a call site passing it, nothing a user touches behaves differently. This asserts the
// enablement AND the two properties that made it safe here — the plant-list-photo-<id> input-id
// contract survives, and the compact (no-thumbnail) staged surface is what renders in the card
// footer, because 88px tiles there would wreck the layout.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { uploadSpy } = vi.hoisted(() => ({ uploadSpy: vi.fn() }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <button type="button">fav</button> }))
vi.mock('../components/CritterSprite.jsx', () => ({ default: () => <span>sprite</span> }))
vi.mock('../components/PlantStatusBadge.jsx', () => ({ default: ({ status }) => <span>{status}</span> }))
vi.mock('../components/CaretakerBadge.jsx', () => ({ default: ({ caretaker }) => <span>badge:{caretaker?.initial}</span> }))
// The REAL PhotoUpload — that is the whole point of this file.
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: uploadSpy,
    isUploading: false, error: null, photo: null, preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))

import PlantingTile from '../components/PlantingTile.jsx'

const pl = { id: 'pl9', project_id: 'pr3', name: 'Bhut Jolokia', status: 'growing', quantity: 1, featured_photo_view_url: null }

let origCreate, origRevoke

beforeEach(() => {
  uploadSpy.mockReset()
  uploadSpy.mockImplementation(async (f) => ({ photo: { id: f.name } }))
  origCreate = URL.createObjectURL
  origRevoke = URL.revokeObjectURL
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:tile-${++n}`)
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  URL.createObjectURL = typeof origCreate === 'function' ? origCreate : (() => 'blob:noop')
  URL.revokeObjectURL = typeof origRevoke === 'function' ? origRevoke : (() => {})
})

const jpg = (name) => new File(['x'], name, { type: 'image/jpeg' })

describe('PlantingTile — multi-attach to a planting', () => {
  it('the card uploader accepts several photos in one pick', () => {
    render(<PlantingTile planting={pl} />)
    const input = document.getElementById('plant-list-photo-pl9')
    expect(input).toBeTruthy()                       // the id contract, unchanged
    expect(input.hasAttribute('multiple')).toBe(true)
  })

  it('three photos picked at once all upload against THIS planting', async () => {
    const onPhotoUploaded = vi.fn()
    render(<PlantingTile planting={pl} onPhotoUploaded={onPhotoUploaded} />)
    const input = document.getElementById('plant-list-photo-pl9')
    Object.defineProperty(input, 'files', { value: [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg')], configurable: true })
    await act(async () => { fireEvent.change(input) })

    expect(uploadSpy).toHaveBeenCalledTimes(3)
    for (const [, opts] of uploadSpy.mock.calls) {
      expect(opts.keyPrefix).toBe('plants')
      expect(opts.parentId).toBe('pl9')
      expect(opts.linkage).toEqual({ plant_id: 'pl9', project_id: 'pr3' })
    }
    // Garden's refetchPlants ignores its argument, so the array form is a no-op for the consumer —
    // asserted rather than assumed, because that is what made this call site safe to enable.
    expect(onPhotoUploaded).toHaveBeenCalledTimes(1)
    expect(Array.isArray(onPhotoUploaded.mock.calls[0][0])).toBe(true)
  })

  it('renders the COMPACT staged surface — filenames, no 88px tiles in the card footer', async () => {
    render(<PlantingTile planting={pl} />)
    const input = document.getElementById('plant-list-photo-pl9')
    Object.defineProperty(input, 'files', { value: [jpg('a.jpg'), jpg('b.jpg')], configurable: true })
    await act(async () => { fireEvent.change(input) })

    expect(screen.getAllByTestId('photo-upload-staged-item')).toHaveLength(2)
    expect(screen.getByText('a.jpg')).toBeTruthy()
    // showPreview={false} — no staged <img> may render inside this card.
    expect(document.querySelectorAll('[data-testid="photo-upload-staged"] img')).toHaveLength(0)
  })

  it('a per-file failure still names the file that failed', async () => {
    uploadSpy.mockImplementation(async (f) => (f.name === 'b.jpg' ? { error: 'S3 refused' } : { photo: { id: f.name } }))
    render(<PlantingTile planting={pl} />)
    const input = document.getElementById('plant-list-photo-pl9')
    Object.defineProperty(input, 'files', { value: [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg')], configurable: true })
    await act(async () => { fireEvent.change(input) })

    const items = screen.getAllByTestId('photo-upload-staged-item')
    expect(items.map(el => el.getAttribute('data-status'))).toEqual(['done', 'error', 'done'])
    expect(screen.getByTestId('photo-upload-staged-error').textContent).toContain('S3 refused')
  })
})
