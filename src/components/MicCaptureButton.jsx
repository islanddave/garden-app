import React from 'react'
import { P } from '../lib/constants.js'

/**
 * src/components/MicCaptureButton.jsx
 *
 * Bite 3 of Post-V2 UX overhaul Increment 2: Field capture surface MVP.
 *
 * SURFACE ONLY — no getUserMedia, no MediaRecorder, no audio capture yet.
 * Tapping fires `onCapture()`; Bite 4 wires this to real audio capture +
 * IndexedDB queue. This bite proves the affordance and de-risks the iOS
 * spike by getting the surface into Dave's hands first.
 *
 * Design (per decomposition doc §"Bite 3" + roadmap §4):
 *   - "Glove-and-glare mic UI": ≥2cm tap target, max contrast, color-independent
 *     state. Spec floor is 2cm (~76px @96dpi); we go 128px round so even a
 *     mis-tap with a gloved finger lands center.
 *   - Color-independent state per V100 §7: icon + always-visible label +
 *     focus ring. Never depend on color alone to communicate state.
 *   - Queued count badge: shows numeric + the word "queued" so the count
 *     is intelligible without color cues. Hidden when count === 0.
 *
 * Operational surface (not reward — Reward UX V100 falsifiability test fails
 * the "positive signal" check; this is a user-initiated capture affordance).
 *
 * Props:
 *   - onCapture: () => void — called when the button is pressed
 *   - queuedCount: number — count of items waiting in the local queue stub
 *   - disabled: boolean — render disabled (parent decides; Bite 3 leaves this
 *     up to FieldCapture; Bite 4 may disable while a recording is in flight)
 */
export default function MicCaptureButton({ onCapture, queuedCount = 0, disabled = false }) {
  const hasQueue = queuedCount > 0
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        data-testid="mic-capture-button"
        onClick={() => { if (!disabled) onCapture && onCapture() }}
        disabled={disabled}
        aria-label="Capture a voice note"
        style={{
          width: 128, height: 128, borderRadius: '50%',
          background: disabled ? P.light : P.terra,
          color: P.white,
          border: `4px solid ${P.white}`,
          boxShadow: disabled
            ? 'none'
            : `0 4px 16px rgba(0,0,0,0.25), 0 0 0 4px ${P.terra}`,
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '3.5rem', lineHeight: 1,
          padding: 0,
          fontFamily: 'inherit',
        }}
      >
        <span aria-hidden="true">🎤</span>
      </button>
      {/* Color-independent label — always visible, not state-conditional. */}
      <div style={{
        marginTop: 12, textAlign: 'center',
        fontSize: '1rem', fontWeight: 700, color: P.dark,
      }}>
        Tap to capture
      </div>
      {hasQueue && (
        <div
          data-testid="mic-queued-count"
          aria-label={`${queuedCount} ${queuedCount === 1 ? 'capture' : 'captures'} queued`}
          style={{
            position: 'absolute', top: -4, right: -4,
            minWidth: 32, height: 32, borderRadius: 16,
            background: P.gold, color: P.white,
            border: `3px solid ${P.cream}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.85rem', fontWeight: 700,
            padding: '0 8px',
          }}
        >
          {queuedCount}
        </div>
      )}
      {/* Subtext — the word "queued" so the count is meaningful without
          relying on the badge color/position alone. */}
      {hasQueue && (
        <div style={{
          marginTop: 6, textAlign: 'center',
          fontSize: '0.8rem', color: P.light,
        }}>
          {queuedCount} {queuedCount === 1 ? 'capture' : 'captures'} queued
        </div>
      )}
    </div>
  )
}
