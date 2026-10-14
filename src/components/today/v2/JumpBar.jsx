import React, { forwardRef, useCallback, useLayoutEffect, useRef, useState } from 'react'
import Icon from '../../Icon.jsx'
import { P, TOP_CHROME_HEIGHT_PX } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import { useKeyboardChromeSuppressed } from '../../../lib/keyboardChrome.js'
import { CHIPS, chipText } from '../../../lib/todayV2/chips.js'

// JumpBar — the redesigned Today's one sticky layer (V5-TODAYREDESIGN-001 S3; plan-v2 §2.7, §4 "Jump bar",
// §5.4, §6.1, §6.8, §6.9; §13 Simplify 5; Today finish plan §3.4–3.5, Dave's D16 + D17, 2026-10-14).
//
// ONE ELEMENT, in flow and pinned alike: a direct child of the page frame (so its sticky range is every
// section), `position: sticky` just under TopChrome, z-index 70 (above the page, below TopChrome 80, BottomNav
// 100, sheets and toasts). No shadow and no change of any kind when it pins. While a text field has focus (the
// on-screen keyboard is up) it drops to position: static — the same in-flow box, so nothing moves.
//
// D16 "cells, never scroll": the bar is a grid of EQUAL-WIDTH cells across the page column, count over label,
// and it never scrolls sideways. A cell is at least CELL_MIN_REM wide — the widest label ("Heads-up") plus the
// cell's own border and padding, in rem so it grows with the text. Every chip sits on one row while the column can
// give each that much (six at 426px); else the cells wrap into two rows of equal-width columns, the second row
// never longer than the first (seven at 426px: 4 + 3, measured — "Heads-up" needs 58px, a seventh of the row is
// 53). Past two rows (200% text) the columns auto-fit at the minimum, so a label never spills and nothing scrolls.
// One row is 52px (2 + 48 + 1 + the 1px rule); min-height never height, so a wrapped bar grows and the page
// reads its real height for the scroll offset (TodayV2). Counted cells show their number (Protect, Heads-up,
// Water, Feed, Check); Harvest and Put-Up carry their icon, never a number (Reward UX). A counted cell that
// empties stays where it is and shows a check in place of its number, label muted; nothing animates.
//
// D17 "one set, in the bar": Water / Feed / Check ARE Needs care's task filter. Each is a toggle button
// (aria-pressed) that shows selected — the filter chips' green fill and doubled border, label 700 — while its
// task is the filter; the page owns what a tap does (TodayV2 `jump`). The other cells are plain navigation
// buttons, with no aria-current and no pressed state (Simplify 5: no in-view highlight). Each cell's accessible
// name is its label with its count ("Water 168", "Water · done", "Harvest").
//
// data-testid / data-chip are gate:today-shape:v2's anchors (today-v2-contract.mjs).
export const JUMP_BAR_HEIGHT_PX = 52
// A jump lands a section header this far under the bar (plan §6.2's "+ 8px").
export const JUMP_LANDING_GAP_PX = 8
// The narrowest a cell may be before the bar wraps: "Heads-up" at T.type.xs2 / 600 (52.2px, measured in the layout
// harness at 426px, Roboto pin) plus the cell's 1px borders and 2px padding, and ~2px to spare — in rem, so it
// scales with the text.
export const CELL_MIN_REM = 3.75
const GAP_PX = 4

// The grid's columns for n cells: auto-fit at the minimum while one row holds them all; wrapped, ceil(n / 2) columns
// at most (the min track is also that share of the row), so two rows split evenly — and a minimum that outgrows the
// share (larger text) still auto-fits fewer.
export function barColumns(n, oneRow) {
  if (oneRow) return `repeat(auto-fit, minmax(${CELL_MIN_REM}rem, 1fr))`
  const k = Math.max(1, Math.ceil(n / 2))
  return `repeat(auto-fit, minmax(max(${CELL_MIN_REM}rem, calc((100% - ${(k - 1) * GAP_PX}px) / ${k})), 1fr))`
}

const JumpBar = forwardRef(function JumpBar({ chips, counts, task, onJump }, ref) {
  const keyboardUp = useKeyboardChromeSuppressed()
  const own = useRef(null)
  const setRef = useCallback((el) => {
    own.current = el
    if (typeof ref === 'function') ref(el); else if (ref) ref.current = el
  }, [ref])
  // Does one row hold every cell? The bar's width against n minimum cells, read as either changes (the root font
  // size scales the minimum; a wrap changes the bar's height, which re-reads it). Without ResizeObserver: one row.
  const n = chips.filter((k) => CHIPS[k]).length
  const [oneRow, setOneRow] = useState(true)
  useLayoutEffect(() => {
    const el = own.current
    if (!el || typeof ResizeObserver !== 'function') return undefined
    const read = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setOneRow(el.clientWidth >= n * CELL_MIN_REM * rem + (n - 1) * GAP_PX)
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [n])
  return (
    <nav ref={setRef} aria-label="Today sections" data-testid="today-jumpbar" style={{ ...barStyle, gridTemplateColumns: barColumns(n, oneRow), position: keyboardUp ? 'static' : 'sticky' }}>
      {chips.map((key) => {
        const c = CHIPS[key]
        if (!c) return null
        const n = counts?.[key] || 0
        const done = c.counted && n === 0
        // A task cell is the filter's toggle while its task has rows; emptied, it only jumps.
        const toggle = !!c.task && !done
        const on = toggle && task === c.task
        return (
          <button
            key={key} type="button" data-chip={key} aria-label={chipText(key, n)} aria-pressed={toggle ? String(on) : undefined}
            onClick={() => onJump(key)} style={on ? cellOn : cellStyle}
          >
            <span style={slotStyle}>
              {c.counted && !done
                ? <span style={countStyle}>{n}</span>
                : <Icon name={done ? 'action.check' : c.icon} size={18} variant={done ? undefined : 'filled'} decorative style={done ? { color: P.green } : undefined} />}
            </span>
            <span style={done ? labelDone : on ? labelOn : labelStyle}>{c.label}</span>
          </button>
        )
      })}
    </nav>
  )
})

export default JumpBar

const barStyle = {
  top: `calc(${TOP_CHROME_HEIGHT_PX}px + env(safe-area-inset-top))`, zIndex: 70,
  display: 'grid', gap: GAP_PX,
  minHeight: JUMP_BAR_HEIGHT_PX, boxSizing: 'border-box', padding: '2px 0 1px',
  background: P.cream, borderBottom: `1px solid ${P.border}`,
}
// The row card's material (white, 1px P.border, radius 10), 48 tall; selected = the filter chips' green fill with a
// doubled border, drawn inset so the cell keeps its size.
const cellStyle = {
  minWidth: 0, minHeight: T.buttonMinHeight, boxSizing: 'border-box', margin: 0, padding: '2px',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
  borderRadius: T.radiusCard, border: `1px solid ${P.border}`, background: P.white,
  font: 'inherit', cursor: 'pointer',
}
const cellOn = { ...cellStyle, background: P.greenPale, borderColor: P.green, boxShadow: `inset 0 0 0 1px ${P.green}` }
// The count's line box holds the icon too, so labels sit level across the bar.
const slotStyle = { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '1.25rem' }
const countStyle = { fontSize: T.type.lg, fontWeight: 700, lineHeight: 1.1, color: P.dark, fontVariantNumeric: 'tabular-nums' }
const labelStyle = { fontSize: T.type.xs2, fontWeight: 600, lineHeight: 1.2, color: P.mid, whiteSpace: 'nowrap' }
const labelOn = { ...labelStyle, fontWeight: 700, color: P.greenDeep }
const labelDone = { ...labelStyle, color: P.light }
