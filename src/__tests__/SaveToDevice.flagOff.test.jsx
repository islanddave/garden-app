// SaveToDevice.flagOff.test.jsx — V4-SNAPDEST-001 (BD0806-08). THE ROLLBACK-LEVER PROOF.
//
// Dave asked to HIDE "Save to Device" app-wide, not delete it, because the underlying capability
// question (V4-SNAPCAPTURE-001 / BD0806-06) may be answered differently later: today a PWA on
// Chrome Android cannot write to the gallery directly — src/lib/saveFileToDevice.js can only reach
// it through navigator.share({files}) plus a download fallback — but that is a platform fact, not a
// permanent one. This file is what makes "flip one const and it comes back" testable rather than
// asserted.
//
// PARTIAL mock (importOriginal + override), matching HarvestQuality.flagOff and deliberately NOT
// the enumerated flag-object style: an enumerated mock makes every future flag arrive as undefined
// inside this file. Its counterpart SaveToDevice.flagOn.test.jsx owns the pin on the SHIPPED value,
// so neither file breaks by construction on a flip.
//
// SCOPE, STATED: this renders CaptureFlow (Snap). The Log-event surface in EventNew.jsx is gated on
// the SAME const at the same import, so a flip moves both — but it is not separately rendered here,
// and that is a real limit of this file rather than something it quietly covers.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  SAVE_TO_DEVICE_HIDDEN: false,
}))

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
  fetchSpy.mockResolvedValue([])
})

async function pickAPhoto() {
  await act(async () => { render(<CaptureFlow />) })
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
}

describe('V4-SNAPDEST-001 flag OFF — Save to device comes back intact', () => {
  it('the control renders on Snap once a photo is attached', async () => {
    await pickAPhoto()
    const btn = screen.getByLabelText('Save photo to device')
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('Save to device')
  })

  it('it is still gated on there being a file, not shown unconditionally', async () => {
    await act(async () => { render(<CaptureFlow />) })
    // no photo picked yet -> no control, flag notwithstanding
    expect(screen.queryByLabelText('Save photo to device')).toBeNull()
  })
})
