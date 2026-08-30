// PlantingPhotoSheet.test.jsx — V4-PHOTOBULK-001 D4b.
//
// "Several photos of THIS planting" was the one route Dave asked for that did not exist. It was
// tried inline on the card, measured, and reverted — ten staged files grew the card to 802px and
// pushed its neighbour off an 844px screen, and the compact rows collided with the card's own
// badge. Dave's ruling: the camera button opens a sheet instead.
//
// TWO CONTRACTS MEET HERE AND THEY PULL AGAINST EACH OTHER, which is the whole reason this file
// exists:
//   1. Dave's: tapping the card's camera button opens the SHEET, not the file picker.
//   2. The standing one: every rendered planting row exposes `input#plant-list-photo-<id>` and
//      automated bulk-attach sessions drive uploads through it (Garden.photoUpload.test.jsx §1).
// Moving <PhotoUpload> into the sheet would satisfy (1) and silently break (2) — the input would
// only exist while a human had the sheet open. So the component stays mounted on the card and only
// its TRIGGER is redirected. Both halves are asserted below, because a future edit that "simplifies"
// one will break the other invisibly.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { uploadSpy } = vi.hoisted(() => ({ uploadSpy: vi.fn() }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <button type="button">fav</button> }))
vi.mock('../components/CritterSprite.jsx', () => ({ default: () => <span>sprite</span> }))
vi.mock('../components/PlantStatusBadge.jsx', () => ({ default: ({ status }) => <span>{status}</span> }))
vi.mock('../components/CaretakerBadge.jsx', () => ({ default: ({ caretaker }) => <span>badge:{caretaker?.initial}</span> }))
// The real <Sheet> brings focus traps, scroll locking and the registry. Stubbed to a plain
// container: this file is about WHAT is in the sheet and what opens it, and Sheet has its own suites.
vi.mock('../components/forms/Sheet.jsx', () => ({
  default: ({ open, title, children }) => (open ? <div data-testid="sheet" data-title={title}>{children}</div> : null),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: uploadSpy,
    isUploading: false, error: null, photo: null, preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))

import PlantingTile from '../components/PlantingTile.jsx'

const pl = { id: 'pl9', project_id: 'pr3', name: 'Bhut Jolokia', status: 'growing', quantity: 1, featured_photo_view_url: null }
const jpg = (n) => new File(['x'], n, { type: 'image/jpeg' })

let origCreate, origRevoke
beforeEach(() => {
  uploadSpy.mockReset()
  uploadSpy.mockImplementation(async (f) => ({ photo: { id: f.name } }))
  origCreate = URL.createObjectURL; origRevoke = URL.revokeObjectURL
  URL.createObjectURL = vi.fn(() => 'blob:sheet')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  URL.createObjectURL = typeof origCreate === 'function' ? origCreate : (() => 'blob:noop')
  URL.revokeObjectURL = typeof origRevoke === 'function' ? origRevoke : (() => {})
})

const cardTrigger = () => screen.getAllByTestId('photo-upload-trigger')[0]

describe('PlantingTile — the camera button opens the batch sheet', () => {
  it('no sheet until the button is tapped', () => {
    render(<PlantingTile planting={pl} />)
    expect(screen.queryByTestId('sheet')).toBeNull()
  })

  it('tapping the camera button opens the sheet, NOT the file picker', () => {
    render(<PlantingTile planting={pl} />)
    const cardInput = document.getElementById('plant-list-photo-pl9')
    const clickSpy = vi.spyOn(cardInput, 'click')

    fireEvent.click(cardTrigger())

    expect(screen.getByTestId('sheet')).toBeTruthy()
    // THE redirect. Firing both would put two surfaces on screen from one tap.
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('the sheet names the planting it will attach to', () => {
    render(<PlantingTile planting={pl} />)
    fireEvent.click(cardTrigger())
    expect(screen.getByTestId('sheet').getAttribute('data-title')).toBe('Add photos — Bhut Jolokia')
    expect(screen.getByText(/attaches to Bhut Jolokia/i)).toBeTruthy()
  })

  it('the sheet accepts SEVERAL photos and attaches every one to this planting', async () => {
    render(<PlantingTile planting={pl} />)
    fireEvent.click(cardTrigger())

    const sheetInput = document.getElementById('planting-sheet-photo-pl9')
    expect(sheetInput.hasAttribute('multiple')).toBe(true)
    Object.defineProperty(sheetInput, 'files', { value: [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg')], configurable: true })
    await act(async () => { fireEvent.change(sheetInput) })

    expect(uploadSpy).toHaveBeenCalledTimes(3)
    for (const [, opts] of uploadSpy.mock.calls) {
      expect(opts.keyPrefix).toBe('plants')
      expect(opts.parentId).toBe('pl9')
      expect(opts.linkage).toEqual({ plant_id: 'pl9', project_id: 'pr3' })
    }
  })

  it('the sheet shows thumbnails while uploading — the card deliberately does not', async () => {
    // The upload is held OPEN on purpose. A successful batch closes the sheet (asserted below), so
    // measuring the strip after settle would find an unmounted sheet and read 0 imgs — a pass for
    // the wrong reason if the assertion were inverted, and a confusing failure as written.
    uploadSpy.mockImplementation(() => new Promise(() => {}))
    render(<PlantingTile planting={pl} />)
    fireEvent.click(cardTrigger())
    const sheetInput = document.getElementById('planting-sheet-photo-pl9')
    Object.defineProperty(sheetInput, 'files', { value: [jpg('a.jpg'), jpg('b.jpg')], configurable: true })
    await act(async () => { fireEvent.change(sheetInput) })

    // showPreview is TRUE in the sheet: it has room, and thumbnails are how you tell which of ten
    // near-identical shots of the same plant you meant to drop.
    expect(document.querySelectorAll('[data-testid="photo-upload-staged"] img').length).toBe(2)
    expect(screen.getAllByTestId('photo-upload-staged-item')).toHaveLength(2)
  })

  it('closes after a successful batch and reports upward', async () => {
    const onPhotoUploaded = vi.fn()
    render(<PlantingTile planting={pl} onPhotoUploaded={onPhotoUploaded} />)
    fireEvent.click(cardTrigger())
    const sheetInput = document.getElementById('planting-sheet-photo-pl9')
    Object.defineProperty(sheetInput, 'files', { value: [jpg('a.jpg'), jpg('b.jpg')], configurable: true })
    await act(async () => { fireEvent.change(sheetInput) })

    await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull())
    expect(onPhotoUploaded).toHaveBeenCalledTimes(1)
    // The array form rides through unchanged — Garden's refetchPlants ignores its argument.
    expect(Array.isArray(onPhotoUploaded.mock.calls[0][0])).toBe(true)
  })
})

describe('PlantingTile — the automation contract survives the redirect', () => {
  it('every row still exposes input#plant-list-photo-<id>, WITHOUT opening the sheet', () => {
    render(<PlantingTile planting={pl} />)
    const input = document.getElementById('plant-list-photo-pl9')
    expect(input).toBeTruthy()
    expect(input.tagName).toBe('INPUT')
    expect(input.type).toBe('file')
    // Present on the CARD, with no sheet open — which is the whole point. An automated session
    // cannot tap a button to reveal it.
    expect(screen.queryByTestId('sheet')).toBeNull()
  })

  it('driving that input directly STILL uploads, single-file, to this planting', async () => {
    render(<PlantingTile planting={pl} />)
    const input = document.getElementById('plant-list-photo-pl9')
    Object.defineProperty(input, 'files', { value: [jpg('auto.jpg')], configurable: true })
    await act(async () => { fireEvent.change(input) })

    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(uploadSpy.mock.calls[0][0].name).toBe('auto.jpg')
    expect(uploadSpy.mock.calls[0][1].linkage).toEqual({ plant_id: 'pl9', project_id: 'pr3' })
    // Redirecting the trigger must not have turned the card's own input into a multi one.
    expect(input.hasAttribute('multiple')).toBe(false)
  })
})
