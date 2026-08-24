// BD-032 — the Snap dead tap. Tapping the Snap circle used to navigate to /capture and land on a
// screen whose ONLY control was a "Choose photo" button. A screen with one option is a dead tap, and
// Dave hit it twice per burst: once on arrival and again after every save, because resetForNext()
// returned to the same step.
//
// It could not be fixed inside CaptureFlow. A file input needs transient activation and the
// navigation gesture that got you there is already spent, so opening the picker on mount is blocked
// by Android Chrome — CaptureFlow's own comment records that. The fix moves the picker into the tap
// that is still trusted: the header button.
//
// These cases pin the handoff, not the styling. Two halves, and BOTH matter:
//   * the tap opens the picker (not a navigation)
//   * a cancelled picker still navigates — <input type=file> fires no cancel event, so "navigate
//     only on pick" would strand the tap silently for anyone who backs out
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { navigateSpy, setPendingSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  setPendingSpy: vi.fn(),
}))

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig()),
  useNavigate: () => navigateSpy,
}))
vi.mock('../lib/pendingCapture.js', () => ({
  setPendingCapture: setPendingSpy,
  takePendingCapture: vi.fn(() => null),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import TopChrome from '../components/TopChrome.jsx'

const renderAt = (path = '/today') =>
  render(<MemoryRouter initialEntries={[path]}><TopChrome /></MemoryRouter>)

beforeEach(() => { cleanup(); navigateSpy.mockReset(); setPendingSpy.mockReset() })

describe('BD-032 — Snap opens the picker in-tap', () => {
  it('the Snap control is a button with a hidden image file input, not a link', () => {
    renderAt()
    const snap = screen.getByTestId('topchrome-snap')
    expect(snap.tagName).toBe('BUTTON')
    expect(snap.getAttribute('href')).toBe(null)
    const input = screen.getByTestId('topchrome-snap-input')
    expect(input.getAttribute('type')).toBe('file')
    expect(input.getAttribute('accept')).toBe('image/*')
    // No `capture` attribute: V4-HIDECAPTURE-001 made in-app camera the app-wide non-default, and
    // adding it here would reintroduce the arm that silently loses the photo outside this app.
    expect(input.getAttribute('capture')).toBe(null)
  })

  it('tapping Snap opens the picker and does NOT navigate on its own', () => {
    renderAt()
    const input = screen.getByTestId('topchrome-snap-input')
    const clickSpy = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByTestId('topchrome-snap'))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    // The navigation belongs to the PICK, not the tap. Navigating here would land on /capture with
    // the gesture spent — the exact dead end this change removes.
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('picking a photo parks the file and then navigates to /capture', () => {
    renderAt()
    const file = new File(['x'], 'tomato.jpg', { type: 'image/jpeg' })
    const input = screen.getByTestId('topchrome-snap-input')
    fireEvent.change(input, { target: { files: [file] } })
    expect(setPendingSpy).toHaveBeenCalledTimes(1)
    expect(setPendingSpy.mock.calls[0][0]).toBe(file)
    expect(navigateSpy).toHaveBeenCalledWith('/capture')
  })

  it('cancelling the picker still navigates, and parks nothing', () => {
    renderAt()
    const input = screen.getByTestId('topchrome-snap-input')
    fireEvent.change(input, { target: { files: [] } })
    expect(setPendingSpy).not.toHaveBeenCalled()
    // Deliberate: there is no cancel event to hang a "do nothing" branch on, so the fallback is the
    // old behaviour — land on the photo step, which still has a working Choose button.
    expect(navigateSpy).toHaveBeenCalledWith('/capture')
  })

  it('clears the input value so re-picking the SAME file refires onChange', () => {
    renderAt()
    const input = screen.getByTestId('topchrome-snap-input')
    const file = new File(['x'], 'same.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })
    // Same idiom, same reason, as CaptureFlow.onPick and QuickActions.onPhotoPicked: <input
    // type=file> fires NO change event when you pick the identical file again, so a burst of photos
    // from one folder would silently stall on the second identical pick.
    expect(input.value).toBe('')
  })
})
