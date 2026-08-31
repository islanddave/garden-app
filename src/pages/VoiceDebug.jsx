// src/pages/VoiceDebug.jsx — BUG-VOICEDUPE-002 device-truth surface.
//
// Dave taps the toggle, dictates ONE known phrase on his Android phone, comes back here, and copies
// the raw SpeechRecognition event sequence. That sequence is ground truth about what Chrome actually
// dispatches — the thing BUG-VOICEDUPE-001 shipped without and consequently got wrong.
//
// GATING follows the GardenActivity convention (src/pages/GardenActivity.jsx): an UNLINKED
// /admin/* route behind <Protected>, Jen-invisible — no nav link, not in settings, not in help,
// not in onboarding. GardenActivity additionally renders a placard on a server 403 because it
// fetches OTHER users' aggregate metrics; this page has no server call at all. Everything it shows
// is Dave's own browser's localStorage, written by his own dictation on his own device, so there is
// no cross-user surface for a server allowlist to protect. Deliberately no toast, no modal, no
// celebration — this is a diagnostic (Reward UX V100 §8), not a reward surface.
//
// Mobile-first: single column, 16px controls, the log in its own scroll container so the page body
// never scrolls sideways at ~390px.

import React, { useCallback, useEffect, useState } from 'react'
import { P } from '../lib/constants.js'
import ContinuousVoiceProbe from '../components/ContinuousVoiceProbe.jsx'
import {
  isVoiceDebugEnabled,
  setVoiceDebugEnabled,
  readVoiceDebugLog,
  clearVoiceDebugLog,
  formatVoiceDebugLog,
  VOICE_DEBUG_MAX_ENTRIES,
} from '../lib/voiceDebug.js'

export default function VoiceDebug() {
  const [enabled, setEnabled] = useState(() => isVoiceDebugEnabled())
  const [log, setLog]         = useState(() => readVoiceDebugLog())
  const [copied, setCopied]   = useState(false)

  // Re-read on focus: the capture happens on ANOTHER route (Log an event / Field capture), so the
  // log this page holds is stale the moment Dave navigates away and dictates.
  useEffect(() => {
    const refresh = () => { setLog(readVoiceDebugLog()); setEnabled(isVoiceDebugEnabled()) }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const text = formatVoiceDebugLog(log)
  const resultCount = log.filter((e) => e.kind === 'result').length

  const toggle = useCallback(() => {
    setEnabled((cur) => { setVoiceDebugEnabled(!cur); return !cur })
    setCopied(false)
  }, [])

  const refresh = useCallback(() => { setLog(readVoiceDebugLog()); setCopied(false) }, [])

  const clear = useCallback(() => { clearVoiceDebugLog(); setLog([]); setCopied(false) }, [])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard API blocked (insecure context / permission). The textarea below is selectable —
      // long-press → Select all → Copy still works, which is why the text is never hidden.
      setCopied(false)
    }
  }, [text])

  return (
    <div style={{ padding: 16, maxWidth: 720, margin: '0 auto', color: P.dark }}>
      <h1 style={{ marginTop: 0, fontSize: '1.3rem' }}>Voice debug</h1>
      <p style={{ marginTop: 0, color: P.light, fontSize: '0.85rem', lineHeight: 1.45 }}>
        Records the raw Web Speech events this browser dispatches while you dictate
        (BUG-VOICEDUPE-002). Off by default, stored only on this device, never uploaded.
      </p>

      <button
        type="button"
        data-testid="voice-debug-toggle"
        aria-pressed={enabled}
        onClick={toggle}
        style={{
          width: '100%', minHeight: 48, marginTop: 8,
          borderRadius: 8, cursor: 'pointer',
          fontSize: '1rem', fontWeight: 700, fontFamily: 'inherit',
          background: enabled ? P.terra : P.white,
          color:      enabled ? P.white : P.dark,
          border: `1px solid ${enabled ? P.terra : P.border}`,
        }}
      >
        {enabled ? 'Capture ON — tap to stop' : 'Capture OFF — tap to start'}
      </button>

      <ol
        data-testid="voice-debug-steps"
        style={{ marginTop: 16, paddingLeft: 20, color: P.mid, fontSize: '0.88rem', lineHeight: 1.6 }}
      >
        <li>Turn capture ON, then tap <strong>Clear</strong> so the log holds one run only.</li>
        {/* TWO SURFACES, because the recorder now covers both and they answer different questions.
            The Notes path is BUG-VOICEDUPE — one phrase, one field, does the transcript double.
            Harvest by voice is BUG-VOICECOUNTSPLIT — a whole run, where the question is WHERE the
            session boundaries fell, which is only visible across several utterances. Sending Dave
            to Notes for a count problem would capture the wrong screen entirely. */}
        <li>For a <strong>dictation</strong> problem: go to <strong>Log an event</strong> and
            dictate one known phrase into Notes — say it once, normally, then stop the mic.</li>
        <li>For a <strong>Harvest by voice</strong> problem: run a normal harvest — crop, count,
            weight, “next” — for two or three plants, then stop. Say them the way you normally
            would; a run that is spoken carefully is a run that does not reproduce the fault.</li>
        <li>Come back here, tap <strong>Copy</strong>, and paste the block to Claude along with the
            exact words you said and what actually landed on screen.</li>
        <li>Turn capture back OFF when you are done.</li>
      </ol>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <DebugButton testid="voice-debug-copy" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</DebugButton>
        <DebugButton testid="voice-debug-refresh" onClick={refresh}>Refresh</DebugButton>
        <DebugButton testid="voice-debug-clear" onClick={clear}>Clear</DebugButton>
      </div>

      <p data-testid="voice-debug-count" style={{ marginTop: 12, marginBottom: 4, color: P.light, fontSize: '0.8rem' }}>
        {log.length} entr{log.length === 1 ? 'y' : 'ies'} · {resultCount} result event
        {resultCount === 1 ? '' : 's'} · keeps the newest {VOICE_DEBUG_MAX_ENTRIES}
      </p>

      <textarea
        data-testid="voice-debug-text"
        readOnly
        value={text}
        aria-label="Captured raw speech-recognition events"
        onFocus={(e) => e.target.select()}
        style={{
          width: '100%', height: 340, boxSizing: 'border-box',
          padding: 10, borderRadius: 8,
          border: `1px solid ${P.border}`, background: P.white, color: P.dark,
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          fontSize: '0.72rem', lineHeight: 1.4,
          whiteSpace: 'pre', overflow: 'auto',
        }}
      />

      {/* V5-HARVESTVOICEFLOW-001 (BD-068) — the continuous-mode probe. Same purpose as the log
          above and the same reason for living on THIS route: a question about what Chrome actually
          does on Dave's Android can only be settled by his Android. The section above answers "what
          did the recogniser emit for one dictated phrase"; this one answers "does the recogniser
          stay alive across several, and how much speech is lost when it does not" — which is the
          question a hands-free harvest flow stands or falls on. Investigation instrument, not a
          feature: nothing outside this unlinked admin route renders it. */}
      <ContinuousVoiceProbe />
    </div>
  )
}

function DebugButton({ testid, onClick, children }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      style={{
        flex: '1 1 auto', minWidth: 96, minHeight: 44,
        borderRadius: 8, cursor: 'pointer',
        background: P.white, color: P.dark, border: `1px solid ${P.border}`,
        fontSize: '0.95rem', fontWeight: 600, fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}
