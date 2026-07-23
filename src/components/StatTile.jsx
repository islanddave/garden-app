import React from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'

// StatTile — V4-HARVESTVIEW-001 S2b (design §8). Ambient snapshot tile: a small label + a primary
// line + optional secondary. Tappable when `to` is given (renders a Link), else a plain div. Static
// by construction — no count-ups, no animation (Reward-UX: this surface never celebrates or scores).
export default function StatTile({ label, primary, secondary, to, onClick }) {
  const inner = (
    <>
      <div style={{ fontSize: '0.66rem', fontWeight: 700, color: P.light, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.dark, marginTop: 3, lineHeight: 1.25 }}>{primary}</div>
      {secondary && <div style={{ fontSize: '0.72rem', color: P.light, marginTop: 2, lineHeight: 1.3 }}>{secondary}</div>}
    </>
  )
  const style = {
    display: 'block', flex: 1, minWidth: 0, background: P.white, border: `1px solid ${P.border}`,
    borderRadius: 10, padding: '10px 12px', textDecoration: 'none', color: 'inherit', textAlign: 'left',
  }
  if (to) return <Link to={to} style={style}>{inner}</Link>
  if (onClick) return <button type="button" onClick={onClick} style={{ ...style, cursor: 'pointer', fontFamily: 'inherit' }}>{inner}</button>
  return <div style={style}>{inner}</div>
}
