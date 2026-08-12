// V4-WATERMATH-001 F0 — the amount-class contract + the chip component in isolation.
//
// The contract half exists because THREE surfaces (EventNew, LogMany, EventDetail) and one
// server lane build payloads against these exact key names and value strings. A typo in any one
// of them is a silently-unreadable row, so the literal shape is pinned here once.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  WATER_DEPTH_VALUES, WATER_DEPTH_DEFAULT, isWaterDepthType, isWaterDepth,
  readWaterDepth, waterDepthLabel, waterDepthMetadata,
} from '../lib/waterDepth.js'
import WaterDepthChips from '../components/WaterDepthChips.jsx'

describe('waterDepth contract', () => {
  it('is exactly the three ordinal classes, light to deep', () => {
    expect(WATER_DEPTH_VALUES).toEqual(['light', 'normal', 'deep'])
  })

  it('defaults to normal', () => {
    expect(WATER_DEPTH_DEFAULT).toBe('normal')
  })

  it('applies to watering only — rain magnitude comes from the gauge, not the user', () => {
    expect(isWaterDepthType('watering')).toBe(true)
    expect(isWaterDepthType('rain')).toBe(false)
    expect(isWaterDepthType('observation')).toBe(false)
    expect(isWaterDepthType(undefined)).toBe(false)
  })

  it('writes both keys, with the source distinguishing a user pick from the default', () => {
    expect(waterDepthMetadata('deep', true)).toEqual({ water_depth: 'deep', water_depth_source: 'user' })
    expect(waterDepthMetadata('normal', false)).toEqual({ water_depth: 'normal', water_depth_source: 'default' })
  })

  it('coerces an unknown class to the default rather than writing garbage', () => {
    expect(waterDepthMetadata('soaking', true)).toEqual({ water_depth: 'normal', water_depth_source: 'user' })
    expect(isWaterDepth('soaking')).toBe(false)
  })

  it('reads absent / historical / malformed metadata as the default the engine already assumes', () => {
    expect(readWaterDepth(null)).toBe('normal')
    expect(readWaterDepth(undefined)).toBe('normal')
    expect(readWaterDepth({})).toBe('normal')
    expect(readWaterDepth({ water_depth: 'nonsense' })).toBe('normal')
    expect(readWaterDepth({ water_depth: 'deep' })).toBe('deep')
    expect(readWaterDepth('not-an-object')).toBe('normal')
  })

  it('labels every class', () => {
    expect(WATER_DEPTH_VALUES.map(waterDepthLabel)).toEqual(['Light', 'Normal', 'Deep'])
  })
})

describe('WaterDepthChips renders', () => {
  it('renders three pressable chips and reports the tapped value', () => {
    const onChange = vi.fn()
    render(<WaterDepthChips value="normal" onChange={onChange} />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByTestId('water-depth-light'))
    expect(onChange).toHaveBeenCalledWith('light')
    cleanup()
  })

  it('gives each chip an accessible name carrying its anchor, not just the bare word', () => {
    render(<WaterDepthChips value="normal" onChange={() => {}} />)
    expect(screen.getByLabelText('Light — a quick pass')).toBeTruthy()
    expect(screen.getByLabelText('Normal — what it needed')).toBeTruthy()
    expect(screen.getByLabelText('Deep — soaked to runoff')).toBeTruthy()
    cleanup()
  })

  it('keeps the 48px touch target in the compact variant — `small` is typography only', () => {
    render(<WaterDepthChips value="normal" onChange={() => {}} small idPrefix="row" />)
    for (const v of WATER_DEPTH_VALUES) {
      const chip = screen.getByTestId(`row-${v}`)
      expect(chip.style.minHeight).toBe('48px')
      expect(chip.style.minWidth).toBe('44px')
    }
    cleanup()
  })

  it('drops the anchor captions when asked, but never the accessible name', () => {
    render(<WaterDepthChips value="normal" onChange={() => {}} showAnchors={false} />)
    expect(screen.queryByText('soaked to runoff')).toBeNull()
    expect(screen.getByLabelText('Deep — soaked to runoff')).toBeTruthy()
    cleanup()
  })
})
