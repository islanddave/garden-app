import React, { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useMode, MODE } from '../lib/mode.js'
import { P } from '../lib/constants.js'
import MicCaptureButton from '../components/MicCaptureButton.jsx'
import TapCaptureFallback from '../components/TapCaptureFallback.jsx'
import TranscriptReview from '../components/TranscriptReview.jsx'
import {
  enqueueRecording,
  enqueueText,
  list as listQueue,
  getUnprocessedDepth,
  getOldestUnprocessedAgeMs,
} from '../lib/captureQueue.js'
import { requestPersistence } from '../lib/durableStorage.js'
import { onReconnect } from '../lib/reconnect.js'
import { sendCaptureToClaude } from '../lib/sendCapture.js'

/**
 * src/pages/FieldCapture.jsx
 *
 * Bite 4: durable IndexedDB queue + real audio capture.
 * Bite 5: per-entry TranscriptReview inline expansion (tap a queued capture to
 *         open transcript review surface).
 *
 * Lifecycle on first mount:
 *   1. Install-early storage prompt: requestPersistence() (per Concept B spec).
 *   2. Load the captureQueue list into local state.
 *   3. Subscribe to window.online -> re-poll the queue (Bite 6 will retry items).
 *
 * Mode gate: Desk mode visits redirect to /dashboard (carry-over from Bite 3).
 *
 * No deletion path in this bite (Dave-call from Bite 4: "brain dump and lose it"
 * = adoption killer for Jen).
 *
 * Operational surface -- not a reward. Functional ACKs only.
 */
export default function FieldCapture() {
  const { mode } = useMode()
  const [queue,       setQueue]       = useState([])
  const [depth,       setDepth]       = useState(0)
  const [oldestAgeMs, setOldestAgeMs] = useState(null)
  const [errorBanner, setErrorBanner] = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [expandedId,  setExpandedId]  = useState(null)
  const [tileSend,    setTileSend]    = useState(null)  // { id, status, msg }

  const refresh = useCallback(async () => {
    try {
      const [list, d, age] = await Promise.all([
        listQueue(),
        getUnprocessedDepth(),
        getOldestUnprocessedAgeMs(),
      ])
      setQueue(list)
      setDepth(d)
      setOldestAgeMs(age)
    } catch (e) {
      const code = typeof e === 'string' ? e : 'failed'
      setErrorBanner(code === 'unavailable'
        ? 'Storage unavailable on this device. Captures cannot be saved.'
        : code === 'quota'
        ? 'Storage is full. Free space and try again.'
        : 'Could not load the capture queue.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (mode !== MODE.FIELD) return
    let cancelled = false
    requestPersistence().catch(() => {})
    refresh().then(() => { if (cancelled) setQueue((q) => q) })
    return () => { cancelled = true }
  }, [mode, refresh])

  useEffect(() => {
    if (mode !== MODE.FIELD) return
    return onReconnect(() => { refresh() })
  }, [mode, refresh])

  if (mode !== MODE.FIELD) {
    return <Navigate to="/dashboard" replace />
  }

  async function handleRecorded({ blob, mime, durationMs, transcript, transcriptSource }) {
    setErrorBanner(null)
    try {
      // Bite 7: transcript captured one-pass alongside the recording (may be
      // empty if Web Speech was unsupported / silently failed — recording still
      // queues, and TranscriptReview's "Speak it now" is the redo path).
      await enqueueRecording({ blob, mime, durationMs, transcript, transcriptSource, mode })
      await refresh()
    } catch (e) {
      const code = typeof e === 'string' ? e : 'failed'
      setErrorBanner(code === 'quota'
        ? 'Storage is full. Your recording was not saved.'
        : 'Could not save your recording.')
    }
  }

  async function handleMicError(code) {
    setErrorBanner(
      code === 'denied'      ? 'Microphone permission denied. Use the text fallback below.'
    : code === 'no-device'   ? 'No microphone found. Use the text fallback below.'
    : code === 'unavailable' ? 'Voice capture not supported on this device. Use the text fallback below.'
                             : 'Voice capture failed. Try again, or use the text fallback below.'
    )
  }

  async function handleTapSubmit(text) {
    setErrorBanner(null)
    try {
      await enqueueText({ text, mode })
      await refresh()
    } catch (e) {
      const code = typeof e === 'string' ? e : 'failed'
      setErrorBanner(code === 'quota'
        ? 'Storage is full. Your note was not saved.'
        : 'Could not save your note.')
    }
  }

  function toggleExpand(id) {
    setExpandedId((cur) => (cur === id ? null : id))
  }

  function handleTranscriptSaved() {
    refresh()
  }

  function handleTranscriptError(code) {
    setErrorBanner(
      code === 'quota'       ? 'Storage is full. Transcript not saved.'
    : code === 'unavailable' ? 'Storage unavailable on this device. Transcript not saved.'
                             : 'Could not save the transcript.'
    )
  }

  // Bite 7: one-tap Send to Claude directly from a queued tile when a transcript
  // is already present (the one-pass-capture happy path). Reuses the shared
  // share -> clipboard -> manual chain via sendCaptureToClaude.
  async function handleTileSend(entry) {
    setErrorBanner(null)
    setTileSend({ id: entry.id, status: 'sending', msg: null })
    const result = await sendCaptureToClaude(entry, {
      onError: () => {},
    })
    if (result.status === 'error') {
      setTileSend({ id: entry.id, status: 'error', msg: 'Nothing to send.' })
    } else if (result.status === 'manual') {
      setTileSend({ id: entry.id, status: 'manual', msg: 'Could not share or copy automatically. Tap the entry to open it and copy manually.' })
    } else {
      setTileSend({
        id: entry.id, status: 'sent',
        msg: result.status === 'shared' ? 'Shared — pick Claude to continue.' : 'Copied — paste into Claude.',
      })
      await refresh()
    }
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
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700, color: P.dark }}>
          Field capture
        </h1>
        <p style={{
          margin: '8px 0 0', fontSize: '0.92rem', color: P.light,
          maxWidth: 420, marginLeft: 'auto', marginRight: 'auto',
        }}>
          Tap the mic to record a quick voice note. Tap a queued entry below to
          add a transcript.
        </p>
      </header>

      {errorBanner && (
        <div
          data-testid="field-error-banner"
          role="alert"
          style={{
            width: '100%',
            padding: '10px 14px',
            background: P.alert,
            border: `1px solid ${P.alertBorder}`,
            borderRadius: 8,
            color: P.dark, fontSize: '0.92rem',
          }}
        >
          {errorBanner}
        </div>
      )}

      <section
        aria-label="Capture"
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 16, width: '100%',
        }}
      >
        <MicCaptureButton
          onRecorded={handleRecorded}
          onError={handleMicError}
          queuedCount={depth}
          oldestAgeMs={oldestAgeMs}
          disabled={loading}
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
            {queue.map((q) => {
              const expanded = expandedId === q.id
              return (
                <li
                  key={q.id}
                  data-testid="field-queue-item"
                  data-kind={q.kind}
                  data-status={q.status}
                  style={{
                    padding: 0,
                    background: P.cream,
                    border: `1px solid ${P.border}`,
                    borderRadius: 6,
                    fontSize: '0.88rem', color: P.dark,
                    wordBreak: 'break-word',
                    display: 'flex', flexDirection: 'column',
                  }}
                >
                  <button
                    type="button"
                    data-testid="field-queue-item-toggle"
                    aria-expanded={expanded}
                    aria-controls={expanded ? `transcript-${q.id}` : undefined}
                    onClick={() => toggleExpand(q.id)}
                    style={{
                      all: 'unset',
                      padding: '10px 12px',
                      cursor: 'pointer',
                      display: 'flex', flexDirection: 'column', gap: 2,
                      minHeight: 44,
                    }}
                  >
                    <div data-testid="field-queue-item-label">
                      <span aria-hidden="true" style={{ marginRight: 6 }}>
                        {q.kind === 'audio' ? '🎤' : '📝'}
                      </span>
                      {/* Bite 7: when a one-pass transcript is present, show it
                          inline as the primary label instead of "Voice (Xs)". */}
                      {q.kind === 'audio'
                        ? (q.transcript || `Voice (${q.durationMs ? Math.round(q.durationMs / 100) / 10 : '?'}s)`)
                        : (q.transcript || q.text || '')}
                    </div>
                    <div style={{ fontSize: '0.74rem', color: P.light }}>
                      {q.status}
                      {q.transcript ? ' · transcribed' : ''}
                      {' · '}{expanded ? 'tap to collapse' : (q.transcript ? 'tap to edit' : 'tap to transcribe')}
                    </div>
                  </button>

                  {/* Bite 7: direct Send-to-Claude on the tile when a transcript
                      is present and the entry hasn't been handed off yet. No
                      expand required for the common one-pass-capture path. */}
                  {q.transcript && q.status !== 'handed_off' && (
                    <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <button
                        type="button"
                        data-testid="field-queue-item-send"
                        onClick={() => handleTileSend(q)}
                        disabled={tileSend && tileSend.id === q.id && tileSend.status === 'sending'}
                        aria-label="Send to Claude"
                        style={{
                          alignSelf: 'flex-start',
                          padding: '8px 14px',
                          fontSize: '0.85rem', fontWeight: 700,
                          color: '#fff', background: '#2d6a4f',
                          border: '1px solid #2d6a4f', borderRadius: 6,
                          cursor: 'pointer', minHeight: 44,
                        }}
                      >
                        {tileSend && tileSend.id === q.id && tileSend.status === 'sending'
                          ? 'Sending…' : 'Send to Claude'}
                      </button>
                      {tileSend && tileSend.id === q.id && tileSend.msg && (
                        <div
                          data-testid="field-queue-item-send-status"
                          role={tileSend.status === 'manual' || tileSend.status === 'error' ? 'alert' : 'status'}
                          style={{
                            fontSize: '0.78rem', fontWeight: 600,
                            color: tileSend.status === 'manual' || tileSend.status === 'error' ? P.terra : '#2d6a4f',
                          }}
                        >
                          {tileSend.msg}
                        </div>
                      )}
                    </div>
                  )}
                  {q.status === 'handed_off' && (
                    <div
                      data-testid="field-queue-item-handed-off"
                      style={{ padding: '0 12px 10px', fontSize: '0.78rem', color: P.light }}
                    >
                      Sent to Claude.
                    </div>
                  )}
                  {expanded && (
                    <div id={`transcript-${q.id}`} style={{ padding: '0 12px 12px' }}>
                      <TranscriptReview
                        entry={q}
                        onTranscriptSaved={handleTranscriptSaved}
                        onError={handleTranscriptError}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </main>
  )
}
