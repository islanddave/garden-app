import React, { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useMode, MODE } from '../lib/mode.js'
import { P } from '../lib/constants.js'
import MicCaptureButton from '../components/MicCaptureButton.jsx'
import TapCaptureFallback from '../components/TapCaptureFallback.jsx'

/**
 * src/pages/FieldCapture.jsx
 *
 * Bite 3 of Post-V2 UX overhaul Increment 2: Field capture surface MVP.
 *
 * The Field-mode home. Renders the mic affordance + tap-to-type fallback +
 * queued-count indicator. SURFACE ONLY — Bite 3 wires NO real capture:
 *   - Mic button calls a stub handler that appends a placeholder entry
 *     ("Voice capture (mic wiring in Bite 4)") to a local React-state
 *     queue. Bite 4 replaces the stub with getUserMedia + MediaRecorder.
 *   - Tap fallback appends typed text to the same React-state queue.
 *
 * Mode gate: if the user is in Desk mode, redirect to /dashboard. The
 * BottomNav center button in Field mode is the only entry point into this
 * page; visiting /field directly while in Desk mode is treated as a
 * mode-mismatch and bounces to the canonical home.
 *
 * Operational surface (not reward). No celebrations on queue-add — the
 * MicCaptureButton + TapCaptureFallback handle their own functional ACKs.
 *
 * Bite 4 will:
 *   - Move the queue out of React state into IndexedDB via captureQueue.js
 *   - Replace the mic stub with synchronous getUserMedia in the tap handler
 *   - Add navigator.storage.persist() prompt on first mount
 */
export default function FieldCapture() {
  const { mode } = useMode()
  // In-memory stub queue. Bite 4: replace with captureQueue.js (IndexedDB).
  const [queue, setQueue] = useState([])

  if (mode !== MODE.FIELD) {
    return <Navigate to="/dashboard" replace />
  }

  function appendEntry(text) {
    setQueue((prev) => [
      ...prev,
      {
        id: `stub-${prev.length + 1}-${Date.now()}`,
        text,
        capturedAt: new Date().toISOString(),
        mode,
        status: 'queued',
      },
    ])
  }

  function handleMicTap() {
    // Bite 3 stub — Bite 4 replaces with real getUserMedia in the same
    // call frame as this handler (iOS user-activation rule).
    appendEntry('Voice capture (mic wiring in Bite 4)')
  }

  function handleTapSubmit(text) {
    appendEntry(text)
  }

  return (
    <main
      data-testid="field-capture-page"
      style={{
        padding: '24px 16px 32px',
        maxWidth: 640, margin: '0 auto',
        display: 'flex', flexDirection: 'column', gap: 24,
        alignItems: 'center',
      }}
    >
      <header style={{ textAlign: 'center', width: '100%' }}>
        <h1 style={{
          margin: 0, fontSize: '1.5rem', fontWeight: 700, color: P.dark,
        }}>
          Field capture
        </h1>
        <p style={{
          margin: '8px 0 0', fontSize: '0.92rem', color: P.light,
          maxWidth: 420, marginLeft: 'auto', marginRight: 'auto',
        }}>
          Tap the mic to capture a quick note. Voice transcription arrives
          in the next bite; for now your captures queue locally.
        </p>
      </header>

      <section
        aria-label="Capture"
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 16, width: '100%',
        }}
      >
        <MicCaptureButton
          onCapture={handleMicTap}
          queuedCount={queue.length}
        />
      </section>

      <section
        aria-label="Type instead"
        style={{
          width: '100%',
          paddingTop: 16,
          borderTop: `1px solid ${P.border}`,
        }}
      >
        <TapCaptureFallback onSubmit={handleTapSubmit} />
      </section>

      {/* Queue preview. Operational, not reward — flat list, no badges or
          progress framing. Bite 4 replaces this with the durable queue
          view. Hidden when empty so the surface stays calm. */}
      {queue.length > 0 && (
        <section
          aria-label="Queued captures"
          data-testid="field-queue-preview"
          style={{
            width: '100%',
            paddingTop: 16,
            borderTop: `1px solid ${P.border}`,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <div style={{ fontSize: '0.92rem', fontWeight: 600, color: P.dark }}>
            Queued ({queue.length})
          </div>
          <ul style={{
            margin: 0, padding: 0, listStyle: 'none',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            {queue.map((q) => (
              <li
                key={q.id}
                data-testid="field-queue-item"
                style={{
                  padding: '8px 12px',
                  background: P.cream,
                  border: `1px solid ${P.border}`,
                  borderRadius: 6,
                  fontSize: '0.88rem', color: P.dark,
                  wordBreak: 'break-word',
                }}
              >
                {q.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
