// SaveToDevice.flagOn.test.jsx — V4-SNAPDEST-001 (BD0806-08), the SHIPPED posture.
//
// This file owns the single pin on the shipped value of SAVE_TO_DEVICE_HIDDEN, via importActual, so
// a future flip is a deliberate decision that fails HERE rather than a scatter of suites that
// quietly need fixing. No flag mock: this renders the real module exactly as users get it.
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
  fetchSpy.mockResolvedValue([])
})

describe('V4-SNAPDEST-001 flag ON — the shipped posture', () => {
  it('SAVE_TO_DEVICE_HIDDEN is true in source (the one pin on the shipped value)', async () => {
    const actual = await vi.importActual('../lib/featureFlags.js')
    expect(actual.SAVE_TO_DEVICE_HIDDEN).toBe(true)
  })

  it('Save to device is absent on Snap even with a photo attached', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    // the preview IS rendered (proving we are past the gate that would trivially hide the button)
    expect(screen.getByAltText('capture preview')).toBeTruthy()
    expect(screen.queryByLabelText('Save photo to device')).toBeNull()
  })
})
