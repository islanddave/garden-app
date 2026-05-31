import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import LoveMehPopover from '../components/LoveMehPopover.jsx'
import { BY_ID } from '../lib/critterSpecies.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const SPECIES = BY_ID[3] // blue jay

describe('LoveMehPopover', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<LoveMehPopover open={false} species={SPECIES} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when species is null', () => {
    const { container } = render(<LoveMehPopover open={true} species={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders role=dialog with species-specific aria-label', () => {
    render(<LoveMehPopover open={true} species={SPECIES} />)
    const el = screen.getByTestId('love-meh-popover')
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('aria-label')).toBe('a blue jay preferences')
  })

  it('renders 3 action buttons: love / meh / cancel', () => {
    render(<LoveMehPopover open={true} species={SPECIES} />)
    expect(screen.getByTestId('prefs-love')).toBeDefined()
    expect(screen.getByTestId('prefs-meh')).toBeDefined()
    expect(screen.getByTestId('prefs-cancel')).toBeDefined()
  })

  it('Cancel click fires onPick(cancel) + onClose immediately (no pulse)', () => {
    const onPick = vi.fn(); const onClose = vi.fn()
    render(<LoveMehPopover open={true} species={SPECIES} onPick={onPick} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('prefs-cancel'))
    expect(onPick).toHaveBeenCalledWith('cancel')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Love click pulses 300ms then fires onPick(love) + onClose', () => {
    const onPick = vi.fn(); const onClose = vi.fn()
    render(<LoveMehPopover open={true} species={SPECIES} onPick={onPick} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('prefs-love'))
    expect(onPick).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(310) })
    expect(onPick).toHaveBeenCalledWith('love')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Meh click pulses 300ms then fires onPick(meh)', () => {
    const onPick = vi.fn(); const onClose = vi.fn()
    render(<LoveMehPopover open={true} species={SPECIES} onPick={onPick} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('prefs-meh'))
    act(() => { vi.advanceTimersByTime(310) })
    expect(onPick).toHaveBeenCalledWith('meh')
  })

  it('Escape key dismisses (fires onClose, NOT onPick)', () => {
    const onPick = vi.fn(); const onClose = vi.fn()
    render(<LoveMehPopover open={true} species={SPECIES} onPick={onPick} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })
})
