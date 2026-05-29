import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import CritterSprite from '../components/CritterSprite.jsx'

// Mock IntersectionObserver — fires intersecting=true immediately on observe.
class MockIO {
  constructor(cb) { this.cb = cb }
  observe(node) { setTimeout(() => this.cb([{ isIntersecting: true, target: node }]), 0) }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IntersectionObserver', MockIO) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function critter(over = {}) {
  return {
    id: 'c1',
    species_id: 3,
    earned_at: new Date().toISOString(),
    viewed_at: null,
    dot_visible_after: new Date().toISOString(),
    ...over,
  }
}

describe('CritterSprite', () => {
  it('renders nothing for null critter', () => {
    const { container } = render(<CritterSprite critter={null} prefersReducedMotion={true} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for unknown species_id', () => {
    const { container } = render(<CritterSprite critter={critter({ species_id: 255 })} prefersReducedMotion={true} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders role=img with species aria_announce_name', () => {
    render(<CritterSprite critter={critter({ species_id: 3 })} prefersReducedMotion={true} />)
    const el = screen.getByTestId('critter-sprite')
    expect(el.getAttribute('role')).toBe('img')
    expect(el.getAttribute('aria-label')).toBe('a blue jay')
    expect(el.getAttribute('data-species-id')).toBe('3')
  })

  it('renders the species sprite filename', () => {
    render(<CritterSprite critter={critter({ species_id: 8 })} prefersReducedMotion={true} />)
    const img = screen.getByTestId('critter-sprite').querySelector('img')
    expect(img.getAttribute('src')).toBe('/critters/C007-ruby-throated-hummingbird.svg')
  })

  it('applies filter: saturate(0.7) when earned_at is >24h ago (freshness fade)', () => {
    const oldEarned = new Date(Date.now() - 26 * 3600 * 1000).toISOString()
    render(<CritterSprite critter={critter({ earned_at: oldEarned })} prefersReducedMotion={true} />)
    const el = screen.getByTestId('critter-sprite')
    expect(el.style.filter).toBe('saturate(0.7)')
  })

  it('skips landing animation when prefersReducedMotion=true (data-landed=true immediately)', () => {
    render(<CritterSprite critter={critter()} prefersReducedMotion={true} />)
    const el = screen.getByTestId('critter-sprite')
    expect(el.getAttribute('data-landed')).toBe('true')
  })

  it('skips landing animation when inQuietHours=true', () => {
    render(<CritterSprite critter={critter()} inQuietHours={true} prefersReducedMotion={false} />)
    const el = screen.getByTestId('critter-sprite')
    expect(el.getAttribute('data-landed')).toBe('true')
  })

  it('fires onLongPress after ≥500ms pointer hold', () => {
    const onLongPress = vi.fn()
    render(<CritterSprite critter={critter()} prefersReducedMotion={true} onLongPress={onLongPress} />)
    const el = screen.getByTestId('critter-sprite')
    fireEvent.pointerDown(el)
    act(() => { vi.advanceTimersByTime(600) })
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onLongPress.mock.calls[0][0].id).toBe('c1')
  })

  it('does NOT fire onLongPress when pointer released before 500ms', () => {
    const onLongPress = vi.fn()
    render(<CritterSprite critter={critter()} prefersReducedMotion={true} onLongPress={onLongPress} />)
    const el = screen.getByTestId('critter-sprite')
    fireEvent.pointerDown(el)
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.pointerUp(el)
    act(() => { vi.advanceTimersByTime(600) })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('fires onIntersect ONCE when sprite enters viewport', () => {
    const onIntersect = vi.fn()
    render(<CritterSprite critter={critter()} prefersReducedMotion={true} onIntersect={onIntersect} />)
    act(() => { vi.advanceTimersByTime(100) })
    expect(onIntersect).toHaveBeenCalledTimes(1)
    expect(onIntersect.mock.calls[0][0].id).toBe('c1')
  })
})
