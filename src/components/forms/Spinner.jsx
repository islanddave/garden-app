// src/components/forms/Spinner.jsx
// Lane D / Phase A — accessible loading indicator. role="status" + aria-live
// polite + an SR-only label so AT announces loading; the visual is a CSS ring.
// `label` customizes the announcement ("Loading…" default).
import React from 'react'
import { P } from '../../lib/constants.js'

export default function Spinner({ size = 22, label = 'Loading…', style, block = false }) {
  const ring = (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: '50%',
        border: `2px solid ${P.border}`, borderTopColor: P.green,
        display: 'inline-block', animation: 'forms-spin 0.7s linear infinite',
      }}
    />
  )
  const keyframes = <style>{'@keyframes forms-spin{to{transform:rotate(360deg)}}'}</style>
  if (block) {
    // HG-4.1 centered block variant — drop-in for the legacy static
    // `<div style={{padding:48,textAlign:'center'}}>Loading…</div>` spinners so the
    // swap to the animated ring doesn't layout-shift list/detail pages. The visible
    // label doubles as the role=status accessible name.
    return (
      <div role="status" aria-live="polite" style={{ padding: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: P.light, ...style }}>
        {ring}
        <span>{label}</span>
        {keyframes}
      </div>
    )
  }
  return (
    <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: P.light, ...style }}>
      {ring}
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{label}</span>
      {keyframes}
    </span>
  )
}
