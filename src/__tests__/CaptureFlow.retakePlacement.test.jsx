// CaptureFlow.retakePlacement.test.jsx — V4-SNAPDEST-001 (BD0806-08).
//
// Own-file, deliberately: CaptureFlow.test.jsx is shared fleet surface, and its
// BUG-SNAPRETAKE-001 block already pins that the retake control WORKS. What it does not pin — and
// what the ledger row is actually about — is WHERE the control sits. The control used to render
// last in the step-'mode' grid, below all four destination cards; on Chrome Android at 390px that
// puts "this shot is no good" below the fold, behind four choices about a photo the user has
// already rejected. These assert placement, and they assert it structurally (document order and
// containment) rather than by pixel, so they survive styling churn and stay honest under jsdom,
// which models no layout at all.
//
// Also pins the two sub-asks of this row that recon found ALREADY SHIPPED, so "already shipped"
// stops being a claim in a report and becomes a test that fails if it regresses:
//   • Add inventory is the last destination card.
//   • (Save to device hidden is pinned by SaveToDevice.flagOn.test.jsx — not duplicated here.)
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { fetchSpy, uploadSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), uploadSpy: vi.fn(), navigateSpy: vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  fetchSpy.mockResolvedValue([])
})

async function snap() {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
}

describe('V4-SNAPDEST-001 — retake sits with the photo, not under the destination list', () => {
  it('renders the retake control BEFORE the first destination card in document order', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snap()
    const retake = screen.getByTestId('cap-retake')
    const firstCard = screen.getByTestId('mode-planting')
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: firstCard follows retake in the document.
    expect(retake.compareDocumentPosition(firstCard) & 4).toBe(4)
    // …and after the LAST card too, which is what the old placement failed.
    const lastCard = screen.getByTestId('mode-inventory')
    expect(retake.compareDocumentPosition(lastCard) & 4).toBe(4)
  })

  it('renders the retake control inside the preview block, so it moves with the photo', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snap()
    const previewBlock = screen.getByAltText('capture preview').parentElement
    expect(previewBlock.contains(screen.getByTestId('cap-retake'))).toBe(true)
  })

  // The control is OVERLAID on the preview, not stacked beneath it, and that is a measured
  // decision rather than a styling taste: a stacked row costs 56px of layout height, which in the
  // 360x660 harness pushed the last destination card from y=608 to y=705 — off-screen. jsdom has
  // no layout engine so the 705 cannot be asserted here; what CAN be pinned is the property that
  // produces it, namely that the control is taken out of flow. A future edit that re-stacks it
  // fails here and has to re-measure rather than silently re-spending the fold.
  it('is taken out of flow (absolute over the photo) so it costs zero layout height', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snap()
    const wrapper = screen.getByTestId('cap-retake').parentElement
    expect(wrapper.style.position).toBe('absolute')
    expect(screen.getByAltText('capture preview').parentElement.style.position).toBe('relative')
  })

  it('still drives the picker from the new position, and still does not force the camera', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snap()
    const input = screen.getByTestId('capture-input')
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {})
    await act(async () => { fireEvent.click(screen.getByTestId('cap-retake')) })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(input.getAttribute('capture')).toBeNull()
    clickSpy.mockRestore()
  })

  it('is absent before a photo exists and after a destination is chosen (visibility unchanged by the move)', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await waitFor(() => expect(screen.getByTestId('cap-choose')).toBeDefined())
    expect(screen.queryByTestId('cap-retake')).toBeNull()      // step 'photo'
    await snap()
    expect(screen.getByTestId('cap-retake')).toBeTruthy()      // step 'mode'
    await act(async () => { fireEvent.click(screen.getByTestId('mode-planting')) })
    expect(screen.queryByTestId('cap-retake')).toBeNull()      // step 'form' — Back owns this
  })

  // ALREADY-SHIPPED sub-ask, pinned rather than rebuilt: the row asked for Add inventory to be
  // moved to the bottom of the destination list; it has been last since the MODES array was
  // written. Recon called it vacuous. This is the pin that keeps it that way.
  it('Add inventory is the LAST destination card', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snap()
    const inventory = screen.getByTestId('mode-inventory')
    for (const id of ['mode-planting', 'mode-event', 'mode-replace']) {
      expect(screen.getByTestId(id).compareDocumentPosition(inventory) & 4).toBe(4)
    }
  })
})
