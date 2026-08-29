// PlantingTile.noMultiPhoto.test.jsx — V4-PHOTOBULK-001, pinning a REVERT.
//
// `multiple` was enabled on this card's uploader and then taken back out. This file exists so the
// next person who reaches for it — and someone will, because "several photos of one planting" is the
// most obviously right use of the whole feature — has to read why first.
//
// THE ABSENCE IS THE THING BEING PINNED, and it is invisible in a diff: re-adding one prop would
// look like an addition rather than a reversal, and without this nothing would go red.
//
// WHY IT CAME OUT. Measured in a real browser at 390x844 (tests/harness/photostrips.jsx): ten staged
// files grew the card from ~250px to 802px and pushed the NEXT planting card to y=905, off the
// screen entirely — one card staging photos consumed the whole Garden list. Capping the strip fixed
// the geometry (485px, neighbour back at 588) and then the screenshot showed the real defect: the
// compact filename rows collide with the card's own status badge and trigger, because this footer is
// a flex row sized for a 34px circle, not a scrolling list.
//
// NEITHER HALF IS REACHABLE FROM A UNIT TEST. jsdom returns zero for every getBoundingClientRect and
// renders no pixels, so it can see neither the height nor the collision. That is exactly why the
// guard here is a flat assertion about the prop rather than an attempt to re-measure the outcome.
//
// The capability itself is fine and still lives on <PhotoUpload> — it is enabled where there is room
// (the Photo Library upload form). "Batch to THIS planting" wants its own surface, a sheet rather
// than an inline strip, which is a Dave decision recorded in photobulk-drain-design-V100-20260829.md.

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
  URL.createObjectURL = vi.fn(() => 'blob:tile')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  URL.createObjectURL = typeof origCreate === 'function' ? origCreate : (() => 'blob:noop')
  URL.revokeObjectURL = typeof origRevoke === 'function' ? origRevoke : (() => {})
})

const jpg = (name) => new File(['x'], name, { type: 'image/jpeg' })

describe('PlantingTile — the card uploader stays single-file', () => {
  it('does NOT set `multiple` on the card uploader (reverted — see the header)', () => {
    render(<PlantingTile planting={pl} />)
    const input = document.getElementById('plant-list-photo-pl9')
    expect(input).toBeTruthy()                       // the id contract, unchanged
    expect(input.hasAttribute('multiple')).toBe(false)
  })

  it('takes only the first file even if several arrive, and renders no staged strip in the card', async () => {
    render(<PlantingTile planting={pl} />)
    const input = document.getElementById('plant-list-photo-pl9')
    Object.defineProperty(input, 'files', { value: [jpg('a.jpg'), jpg('b.jpg')], configurable: true })
    await act(async () => { fireEvent.change(input) })

    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0][0].name).toBe('a.jpg')
    // The strip is what overflowed the card. Its absence here is the second half of the revert.
    expect(screen.queryByTestId('photo-upload-staged')).toBeNull()
  })
})
