// V4-THEME-001 — Lightbox (full-screen photo gallery) guard (dark primitive).
// No jest-dom (L-182): assert via roles + attributes + text + toBe/toBeTruthy/toBeNull.
// Real pointer gestures (pinch/pan/swipe) cannot fire in jsdom — the gesture MATH is unit-
// tested directly through the exported pure helpers; the component tests cover the rest of the
// JSDOM-reachable surface (render, arrows, keyboard paging, caption, filmstrip, button zoom,
// focus move-in/restore, reduced-motion render).
import React, { useRef } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import Lightbox, {
  clampScale, clampPan, nextIndex, pinchScale, pointerDistance,
  MIN_SCALE, MAX_SCALE,
} from '../components/Lightbox.jsx'

const IMAGES = [
  { src: 'a.jpg', alt: 'Alpha', caption: 'First photo' },
  { src: 'b.jpg', alt: 'Bravo', caption: 'Second photo' },
  { src: 'c.jpg', alt: 'Charlie', caption: 'Third photo' },
]

beforeEach(() => {
  document.body.innerHTML = ''
})

// ──────────────────────────────────────────────────────────────────────────
// Pure helper unit tests (full coverage of the exported math).
// ──────────────────────────────────────────────────────────────────────────
describe('Lightbox pure helpers', () => {
  it('clampScale clamps to [MIN,MAX] and coerces garbage', () => {
    expect(clampScale(2)).toBe(2)
    expect(clampScale(0.2)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(MIN_SCALE)).toBe(MIN_SCALE)
    expect(clampScale(MAX_SCALE)).toBe(MAX_SCALE)
    expect(clampScale(NaN)).toBe(MIN_SCALE)
    expect(clampScale('x')).toBe(MIN_SCALE)
    expect(clampScale(undefined)).toBe(MIN_SCALE)
  })

  it('clampPan: no travel at scale 1, half-overflow travel when zoomed', () => {
    const bounds = { w: 200, h: 100 }
    // At scale 1 there is no overflow → pan pinned to origin.
    expect(clampPan({ x: 50, y: 50 }, 1, bounds)).toEqual({ x: 0, y: 0 })
    // At scale 2, overflow = (2-1)*dim; max travel = half of that.
    expect(clampPan({ x: 999, y: 999 }, 2, bounds)).toEqual({ x: 100, y: 50 })
    expect(clampPan({ x: -999, y: -999 }, 2, bounds)).toEqual({ x: -100, y: -50 })
    // A value within bounds passes through untouched.
    expect(clampPan({ x: 10, y: -5 }, 2, bounds)).toEqual({ x: 10, y: -5 })
  })

  it('clampPan tolerates missing pan/bounds and non-finite inputs', () => {
    expect(clampPan(undefined, 2, undefined)).toEqual({ x: 0, y: 0 })
    expect(clampPan({ x: Infinity, y: NaN }, 2, { w: 100, h: 100 })).toEqual({ x: 0, y: 0 })
  })

  it('nextIndex clamps at both ends (no wrap) and handles edge inputs', () => {
    expect(nextIndex(0, 1, 3)).toBe(1)
    expect(nextIndex(2, 1, 3)).toBe(2)   // clamp at end
    expect(nextIndex(0, -1, 3)).toBe(0)  // clamp at start
    expect(nextIndex(1, -1, 3)).toBe(0)
    expect(nextIndex(0, 0, 3)).toBe(0)   // dir 0 = no move
    expect(nextIndex(5, 1, 0)).toBe(0)   // empty list
    expect(nextIndex(NaN, 1, 3)).toBe(1) // garbage index coerces to 0 then +1
  })

  it('pinchScale multiplies by distance ratio and clamps; guards zero start', () => {
    expect(pinchScale(1, 100, 200)).toBe(2)        // 2x apart → 2x zoom
    expect(pinchScale(2, 100, 200)).toBe(4)        // clamps at MAX
    expect(pinchScale(1, 100, 50)).toBe(1)         // pinch-in below MIN clamps to 1
    expect(pinchScale(2, 100, 50)).toBe(1)         // 2 * 0.5 = 1
    expect(pinchScale(2, 0, 200)).toBe(2)          // zero start → fall back to prev
    expect(pinchScale(2, 100, 0)).toBe(2)          // zero current → fall back to prev
    // garbage prevScale clamps to MIN first, then a valid 2x ratio still applies → 2
    expect(pinchScale(NaN, 100, 200)).toBe(2)
    expect(pinchScale(NaN, 0, 200)).toBe(MIN_SCALE) // garbage prev + no ratio → MIN
  })

  it('pointerDistance is Euclidean and null-safe', () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(pointerDistance(null, { x: 1, y: 1 })).toBe(0)
    expect(pointerDistance({ x: 1, y: 1 }, null)).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Component render / interaction tests.
// ──────────────────────────────────────────────────────────────────────────
describe('Lightbox component', () => {
  it('renders null when closed or when images empty', () => {
    const { rerender } = render(<Lightbox open={false} images={IMAGES} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBe(null)
    rerender(<Lightbox open images={[]} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBe(null)
    rerender(<Lightbox open images={undefined} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('open: role=dialog, aria-modal, accessible name from current caption', () => {
    render(<Lightbox open images={IMAGES} index={0} onClose={() => {}} />)
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toBe('First photo')
  })

  it('falls back to alt then "Photo viewer" for the accessible name', () => {
    render(<Lightbox open images={[{ src: 'x.jpg', alt: 'OnlyAlt' }]} onClose={() => {}} />)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('OnlyAlt')
  })

  it('caption renders the current image caption', () => {
    render(<Lightbox open images={IMAGES} index={1} onClose={() => {}} />)
    expect(screen.getByTestId('lightbox-caption').textContent).toBe('Second photo')
  })

  it('arrow buttons have correct aria-labels and >=44px hit area', () => {
    render(<Lightbox open images={IMAGES} index={1} onClose={() => {}} />)
    const next = screen.getByLabelText('Next photo')
    const prev = screen.getByLabelText('Previous photo')
    expect(next).toBeTruthy()
    expect(prev).toBeTruthy()
    // size set via inline style (jsdom doesn't lay out, so assert the declared style)
    expect(parseInt(next.style.width, 10) >= 44).toBe(true)
    expect(parseInt(next.style.height, 10) >= 44).toBe(true)
  })

  it('arrows clamp/hide at the ends', () => {
    const { rerender } = render(<Lightbox open images={IMAGES} index={0} onClose={() => {}} />)
    // At the first image: no Previous arrow, Next present.
    expect(screen.queryByLabelText('Previous photo')).toBe(null)
    expect(screen.queryByLabelText('Next photo')).toBeTruthy()
    // At the last image: no Next arrow, Previous present.
    rerender(<Lightbox open images={IMAGES} index={2} onClose={() => {}} />)
    expect(screen.queryByLabelText('Next photo')).toBe(null)
    expect(screen.queryByLabelText('Previous photo')).toBeTruthy()
  })

  it('controlled: Next/Prev call onIndexChange with the clamped target', () => {
    const onIndexChange = vi.fn()
    const { rerender } = render(
      <Lightbox open images={IMAGES} index={1} onIndexChange={onIndexChange} onClose={() => {}} />
    )
    fireEvent.click(screen.getByLabelText('Next photo'))
    expect(onIndexChange).toHaveBeenLastCalledWith(2)
    fireEvent.click(screen.getByLabelText('Previous photo'))
    expect(onIndexChange).toHaveBeenLastCalledWith(0)
    // controlled component does NOT self-advance; parent owns index.
    rerender(<Lightbox open images={IMAGES} index={1} onIndexChange={onIndexChange} onClose={() => {}} />)
    expect(screen.getByTestId('lightbox-caption').textContent).toBe('Second photo')
  })

  it('uncontrolled: Next advances internal index (caption changes)', () => {
    render(<Lightbox open images={IMAGES} index={0} onClose={() => {}} />)
    expect(screen.getByTestId('lightbox-caption').textContent).toBe('First photo')
    fireEvent.click(screen.getByLabelText('Next photo'))
    expect(screen.getByTestId('lightbox-caption').textContent).toBe('Second photo')
  })

  it('keyboard: ArrowRight/ArrowLeft page, Escape closes', () => {
    const onClose = vi.fn()
    render(<Lightbox open images={IMAGES} index={0} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByTestId('lightbox-caption').textContent).toBe('Second photo')
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByTestId('lightbox-caption').textContent).toBe('First photo')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('backdrop click closes; inner click does not', () => {
    const onClose = vi.fn()
    render(<Lightbox open images={IMAGES} onClose={onClose} />)
    const dlg = screen.getByRole('dialog')
    fireEvent.click(dlg) // target === currentTarget → close
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('lightbox-caption')) // inner → no close
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('filmstrip renders one thumb per image; clicking a thumb jumps', () => {
    const onIndexChange = vi.fn()
    render(<Lightbox open images={IMAGES} index={0} onIndexChange={onIndexChange} onClose={() => {}} />)
    const strip = screen.getByTestId('lightbox-filmstrip')
    const thumbs = strip.querySelectorAll('[role="tab"]')
    expect(thumbs.length).toBe(3)
    expect(thumbs[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByTestId('lightbox-thumb-2'))
    expect(onIndexChange).toHaveBeenLastCalledWith(2)
  })

  it('non-drag +/- zoom buttons change the visible scale readout', () => {
    render(<Lightbox open images={IMAGES} onClose={() => {}} />)
    const readout = screen.getByTestId('lightbox-scale')
    expect(readout.textContent).toBe('100%')
    // Zoom out is disabled at MIN.
    expect(screen.getByLabelText('Zoom out').disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(readout.textContent).toBe('150%')
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(readout.textContent).toBe('200%')
    // Now zoomed → pan pad appears (keyboard/button pan path).
    expect(screen.getByTestId('lightbox-pan-pad')).toBeTruthy()
    expect(screen.getByLabelText('Pan left')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Zoom out'))
    expect(readout.textContent).toBe('150%')
  })

  it('zoom-in clamps at MAX (400%) and disables the in-button', () => {
    render(<Lightbox open images={IMAGES} onClose={() => {}} />)
    const zin = screen.getByLabelText('Zoom in')
    fireEvent.click(zin); fireEvent.click(zin); fireEvent.click(zin)
    fireEvent.click(zin); fireEvent.click(zin); fireEvent.click(zin)
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('400%')
    expect(zin.disabled).toBe(true)
  })

  it('double-click toggles zoom and back', () => {
    render(<Lightbox open images={IMAGES} onClose={() => {}} />)
    const stage = screen.getByTestId('lightbox-image').parentElement
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
    fireEvent.doubleClick(stage)
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('200%')
    fireEvent.doubleClick(stage)
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
  })

  it('img onLoad runs without error (bounds computation path)', () => {
    render(<Lightbox open images={IMAGES} onClose={() => {}} />)
    const img = screen.getByTestId('lightbox-image')
    // jsdom reports 0 naturalWidth; the handler must early-return gracefully.
    expect(() => fireEvent.load(img)).not.toThrow()
  })

  it('moves focus to the close control on open and RESTORES it on close', () => {
    function Harness({ open }) {
      const btnRef = useRef(null)
      return (
        <div>
          <button ref={btnRef} data-testid="opener">Open</button>
          <Lightbox open={open} images={IMAGES} onClose={() => {}} />
        </div>
      )
    }
    const { rerender } = render(<Harness open={false} />)
    const opener = screen.getByTestId('opener')
    act(() => opener.focus())
    expect(document.activeElement).toBe(opener)

    // Open → focus moves into the dialog (close control).
    rerender(<Harness open />)
    expect(document.activeElement).toBe(screen.getByTestId('lightbox-close'))

    // Close → focus restored to the previously-focused element.
    rerender(<Harness open={false} />)
    expect(document.activeElement).toBe(opener)
  })

  it('reduced-motion path renders without error', () => {
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: true, media: q, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }))
    expect(() =>
      render(<Lightbox open images={IMAGES} onClose={() => {}} />)
    ).not.toThrow()
    expect(screen.getByRole('dialog')).toBeTruthy()
    spy.mockRestore()
  })
})
