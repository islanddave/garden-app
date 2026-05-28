// GardenHelper — /helper route. Bite 1 of Post-V2 UX overhaul Increment 2.
//
// Text-path Rung-1 advisory helper-prompt. The user types a note, taps "Send to
// Claude," and the assembled prompt is shared (mobile share-sheet → Claude) or
// copied to clipboard (desktop / share unavailable) so the user can paste it into
// Claude themselves.
//
// NON-RECORDING SCAFFOLD: no DB writes, no Lambda calls. Pure client-side prompt
// assembly + system clipboard/share APIs.
//
// Dave-call #5 (postv2-ux-overhaul-phase2-build-roadmap §5 #5): one-time "Rung-1
// needs the Claude app" explainer for new users. Dismissable; persisted in
// localStorage so the same device doesn't see it twice.

import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../lib/constants.js'
import { assembleHelperPrompt } from '../lib/helperPrompt.js'

const RUNG1_EXPLAINER_DISMISSED_KEY = 'gardenHelper.rung1ExplainerDismissed'

function readDismissed() {
  try {
    return typeof window !== 'undefined'
      && window.localStorage
      && window.localStorage.getItem(RUNG1_EXPLAINER_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(RUNG1_EXPLAINER_DISMISSED_KEY, '1')
    }
  } catch {
    // Swallow — non-fatal; explainer will reappear next visit.
  }
}

export default function GardenHelper() {
  const [note, setNote] = useState('')
  const [status, setStatus] = useState(null) // 'shared' | 'copied' | 'error' | null
  const [showExplainer, setShowExplainer] = useState(() => !readDismissed())

  const trimmed = note.trim()
  const canSend = trimmed.length > 0

  function dismissExplainer() {
    setShowExplainer(false)
    writeDismissed()
  }

  async function handleSend() {
    if (!canSend) return
    const prompt = assembleHelperPrompt(trimmed)

    // Prefer share-sheet on mobile (user picks Claude). Fallback to clipboard.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ text: prompt })
        setStatus('shared')
        return
      } catch (err) {
        // AbortError (user dismissed sheet) → silently fall through to clipboard.
        // Other errors → also fall through to clipboard as best-effort recovery.
      }
    }

    try {
      if (typeof navigator !== 'undefined'
          && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(prompt)
        setStatus('copied')
        return
      }
    } catch {
      // Will report error below.
    }

    setStatus('error')
  }

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 20px' }}>

        <Link to="/dashboard" style={{
          display: 'inline-block', color: P.green,
          fontSize: '0.82rem', fontWeight: 600, textDecoration: 'none',
          marginBottom: 16,
        }}>← Dashboard</Link>

        <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 4px' }}>
          Garden Helper
        </h1>
        <p style={{ color: P.light, fontSize: '0.875rem', margin: '0 0 20px' }}>
          Jot a note, send it to Claude for advice. Nothing is logged — Claude just helps you think it through.
        </p>

        {showExplainer && (
          <div role="note" aria-label="Rung-1 explainer" style={{
            backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`,
            borderRadius: 8, padding: '12px 14px', marginBottom: 16,
            fontSize: '0.85rem', color: P.dark, lineHeight: 1.45,
          }}>
            <p style={{ margin: '0 0 10px' }}>
              <strong>Send to Claude needs the Claude app.</strong> Tapping the button
              copies an assembled prompt to your clipboard (or opens your share sheet).
              Paste it into Claude — web, mobile, or desktop — to get a response. No
              Claude? You can still draft notes here and take them anywhere.
            </p>
            <button
              type="button"
              onClick={dismissExplainer}
              style={{
                background: 'transparent', border: 'none', color: P.green,
                fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', padding: 0,
                fontFamily: 'inherit',
              }}
            >
              Got it
            </button>
          </div>
        )}

        <label htmlFor="garden-helper-note" style={{
          display: 'block', fontSize: '0.85rem', fontWeight: 600,
          color: P.dark, marginBottom: 6,
        }}>
          What's on your mind?
        </label>
        <textarea
          id="garden-helper-note"
          value={note}
          onChange={e => { setNote(e.target.value); setStatus(null) }}
          rows={8}
          placeholder="e.g. Pink Banana squash leaves look pale and the lower ones are yellowing. Should I be feeding them, or is this normal mid-season?"
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '12px 14px', fontSize: '0.95rem', fontFamily: 'inherit',
            border: `1px solid ${P.border}`, borderRadius: 8, backgroundColor: P.white,
            color: P.dark, resize: 'vertical', minHeight: 160, lineHeight: 1.45,
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="Send to Claude"
            style={{
              minHeight: 48,
              padding: '12px 22px',
              border: 'none', borderRadius: 10,
              backgroundColor: canSend ? P.green : P.border,
              color: P.white,
              fontSize: '0.95rem', fontWeight: 700, fontFamily: 'inherit',
              cursor: canSend ? 'pointer' : 'not-allowed',
              boxShadow: canSend ? '0 2px 8px rgba(45,106,79,0.35)' : 'none',
            }}
          >
            Send to Claude
          </button>

          {status === 'shared' && (
            <span role="status" style={{ color: P.green, fontSize: '0.85rem', fontWeight: 600 }}>
              Shared — pick Claude to continue.
            </span>
          )}
          {status === 'copied' && (
            <span role="status" style={{ color: P.green, fontSize: '0.85rem', fontWeight: 600 }}>
              Copied to clipboard — paste into Claude.
            </span>
          )}
          {status === 'error' && (
            <span role="status" style={{ color: P.terra, fontSize: '0.85rem', fontWeight: 600 }}>
              Couldn't copy or share automatically. Select the text below and copy it manually.
            </span>
          )}
        </div>

        {status === 'error' && (
          <pre data-testid="manual-copy-fallback" style={{
            marginTop: 14, padding: '12px 14px',
            backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8,
            fontSize: '0.82rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            color: P.mid, maxHeight: 240, overflowY: 'auto', fontFamily: 'inherit',
          }}>
            {assembleHelperPrompt(trimmed)}
          </pre>
        )}

      </div>
    </div>
  )
}
