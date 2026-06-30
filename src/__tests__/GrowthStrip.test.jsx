// GrowthStrip unit tests (V200 Slice 5b). role/attr/text + toBe/toBeTruthy/toBeNull (no jest-dom).
// The reduced-motion path is exercised by mocking the critterArt prefersReducedMotion helper.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Controllable reduced-motion flag (default OFF). Mocked at module scope so each block can flip it.
const motionState = { reduced: false }
vi.mock('../lib/critterArt.js', () => ({
  prefersReducedMotion: () => motionState.reduced,
}))

import GrowthStrip from '../components/planting/GrowthStrip.jsx'

const PHOTOS = [
  { id: 'p1', view_url: 'https://img/1.jpg', caption: 'First', taken_at: '2026-03-01' },
  { id: 'p2', view_url: 'https://img/2.jpg', caption: 'Mid', taken_at: '2026-04-15' },
  { id: 'p3', view_url: 'https://img/3.jpg', caption: 'Latest', taken_at: '2026-06-01' },
]

beforeEach(() => { motionState.reduced = false; vi.useRealTimers() })

describe('GrowthStrip — <2 photos', () => {
  it('renders the grow-prompt and no slider when zero photos', () => {
    render(<GrowthStrip photos={[]} />)
    expect(screen.getByText('Add photos to watch this plant grow')).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('renders the grow-prompt when only one photo (still no compare/play)', () => {
    render(<GrowthStrip photos={[PHOTOS[0]]} onOpen={() => {}} />)
    expect(screen.getByText('Add photos to watch this plant grow')).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByLabelText('Play time-lapse')).toBeNull()
  })
})

describe('GrowthStrip — >=2 photos', () => {
  it('exposes a range slider keyboard alternative with an aria-valuetext', () => {
    render(<GrowthStrip photos={PHOTOS} onOpen={() => {}} />)
    const range = screen.getByRole('slider', { name: 'Before/after comparison position' })
    expect(range).toBeTruthy()
    expect(range.getAttribute('type')).toBe('range')
    expect(range.getAttribute('aria-valuetext')).toBeTruthy()
  })

  it('the range alternative updates position via keyboard/change (no drag required)', () => {
    render(<GrowthStrip photos={PHOTOS} onOpen={() => {}} />)
    const range = screen.getByRole('slider', { name: 'Before/after comparison position' })
    fireEvent.change(range, { target: { value: '25' } })
    expect(range.value).toBe('25')
  })

  it('Play -> Pause toggles the time-lapse controls (no autoplay)', () => {
    render(<GrowthStrip photos={PHOTOS} onOpen={() => {}} />)
    // No autoplay: a Play control is present, Pause is not, on first render.
    const play = screen.getByLabelText('Play time-lapse')
    expect(play).toBeTruthy()
    expect(screen.queryByLabelText('Pause time-lapse')).toBeNull()
    act(() => { fireEvent.click(play) })
    // After pressing Play it becomes Pause/Stop.
    expect(screen.getByLabelText('Pause time-lapse')).toBeTruthy()
    expect(screen.getByLabelText('Stop time-lapse')).toBeTruthy()
  })

  it('milestone thumbnails call onOpen with the photo gallery index', () => {
    const onOpen = vi.fn()
    render(<GrowthStrip photos={PHOTOS} onOpen={onOpen} indexBase={0} />)
    const thumb = screen.getByRole('button', { name: /Open growth photo 2/ })
    fireEvent.click(thumb)
    expect(onOpen).toHaveBeenCalledWith(1)  // second photo -> indexBase + 1
  })
})

describe('GrowthStrip — reduced motion', () => {
  it('suppresses Play (no required motion) but keeps the static slider + thumbnails', () => {
    motionState.reduced = true
    render(<GrowthStrip photos={PHOTOS} onOpen={() => {}} />)
    expect(screen.queryByLabelText('Play time-lapse')).toBeNull()
    // Still operable without motion: the range alternative + milestone thumbs remain.
    expect(screen.getByRole('slider', { name: 'Before/after comparison position' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open growth photo 1/ })).toBeTruthy()
  })
})
