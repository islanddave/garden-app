import React, { forwardRef } from 'react'
import Icon from '../../Icon.jsx'
import { P, TOP_CHROME_HEIGHT_PX } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import { useKeyboardChromeSuppressed } from '../../../lib/keyboardChrome.js'
import { CHIPS } from '../../../lib/todayV2/chips.js'

// JumpBar — the redesigned Today's one sticky layer (V5-TODAYREDESIGN-001 S3; plan-v2 §2.7, §4 "Jump bar",
// §5.4, §6.1, §6.8, §6.9; §13 Simplify 5).
//
// ONE ELEMENT, in flow and pinned alike: a direct child of the page frame (so its sticky range is every
// section), `position: sticky` just under TopChrome, z-index 70 (above the page, below TopChrome 80, BottomNav
// 100, sheets and toasts). The SAME box is the chip strip: one non-wrapping row that scrolls sideways
// (overflow-x auto), inset to the page column — never full-bleed, so Android's edge swipe is never the only way
// to a chip. 57px in both states (4 + 48 + 4 + the 1px rule), min-height never height, no vertical clip; no
// shadow and no change of any kind when it pins. While a text field has focus (the on-screen keyboard is up) it
// drops to position: static — the same in-flow box, so nothing moves.
//
// Chips are plain buttons in a <nav>: no aria-current, no aria-pressed — there is no in-view highlight
// (Simplify 5), and filter chips (S4) are the only ones that carry a pressed state. The visible text is the
// accessible name ("Water 168", "Water · done"). The page owns what a tap does (TodayV2 `jump`).
//
// data-testid / data-chip are gate:today-shape:v2's anchors (today-v2-contract.mjs).
export const JUMP_BAR_HEIGHT_PX = 57
// A jump lands a section header this far under the bar (plan §6.2's "+ 8px").
export const JUMP_LANDING_GAP_PX = 8

const JumpBar = forwardRef(function JumpBar({ chips, counts, onJump }, ref) {
  const keyboardUp = useKeyboardChromeSuppressed()
  return (
    <nav ref={ref} aria-label="Today sections" data-testid="today-jumpbar" style={{ ...barStyle, position: keyboardUp ? 'static' : 'sticky' }}>
      {chips.map((key) => {
        const c = CHIPS[key]
        if (!c) return null
        const n = counts?.[key] || 0
        return (
          <button key={key} type="button" data-chip={key} onClick={(e) => onJump(key, e.currentTarget)} style={chipStyle}>
            <Icon name={c.icon} size={18} variant="filled" decorative style={{ flexShrink: 0 }} />
            <span style={labelStyle}>{c.label}</span>
            {c.counted && ' '}
            {c.counted && (n > 0
              ? <span style={countStyle}>{n}</span>
              : <span style={labelStyle}>· done</span>)}
          </button>
        )
      })}
    </nav>
  )
})

export default JumpBar

const barStyle = {
  top: `calc(${TOP_CHROME_HEIGHT_PX}px + env(safe-area-inset-top))`, zIndex: 70,
  display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 8,
  overflowX: 'auto', minHeight: JUMP_BAR_HEIGHT_PX, boxSizing: 'border-box', padding: '4px 0',
  background: P.cream, borderBottom: `1px solid ${P.border}`,
}
// FilterChipRow's geometry (one chip grammar for navigation and filtering): 48 tall, pill, 6px 14px.
const chipStyle = {
  flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 6,
  minHeight: T.buttonMinHeight, boxSizing: 'border-box', padding: '6px 14px', margin: 0,
  borderRadius: T.radiusPill, border: `1px solid ${P.border}`, background: P.white,
  font: 'inherit', whiteSpace: 'nowrap', cursor: 'pointer',
}
const labelStyle = { fontSize: T.type.sm, fontWeight: 600, color: P.mid }
const countStyle = { fontSize: T.type.sm, fontWeight: 700, color: P.dark, fontVariantNumeric: 'tabular-nums' }
