import React, { useState, useEffect, useRef } from 'react'
import { getFlavor } from '../lib/critterFlavor.js'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'

const REDUCE_MOTION = typeof window !== 'undefined' && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// FIX-5: critter Facts / Alt Facts popover. Reward-UX compliant — ambient, opened only on an
// explicit user tap (no auto-interrupt, no sound, no haptic). Two tabs: Facts (sourced natural
// history) and Alt Facts (whimsical, always authored). The Facts tab shows a slow-pulsing "?"
// when the critter has no verified source (content == null OR has_source === false OR empty facts).
// content = { facts, alt_facts, has_source } | null. theme = { bg, strip, name } (Collection THEMES tone).
const GROUP_LABEL = { cryptid: 'Cryptid', legacy: 'No longer with us', wild: 'Garden visitor' }

export default function CritterFactsPopover({ critter, theme, content, onClose }) {
  const [tab, setTab] = useState('facts')
  const closeRef = useRef(null)

  // V4-BACKNAV-001 Slice 2 — join the shared registry. This popover is mounted-means-open, and its
  // keydown below was gated on NOTHING: over an open Sheet, one Escape fired both onCloses.
  const { registered, isTopmost } = useDismissable({ open: true, onDismiss: onClose, layer: LAYER.DIALOG })

  useEffect(() => {
    if (registered) return   // registry owns Escape
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    closeRef.current && closeRef.current.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, registered])

  const hasSource = !!(content && content.has_source && content.facts)
  const factsText = hasSource ? content.facts : ''
  const altText = (content && content.alt_facts) || ''
  const accent = theme.strip
  const para = { margin: 0, fontSize: '0.96rem', lineHeight: 1.62, color: '#2c2a24' }
  const flavor = getFlavor(critter)
  const firstSeen = critter && critter.firstSeenAt
    ? (() => { try { return new Date(critter.firstSeenAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) } catch { return '' } })()
    : ''

  return (
    <div role="dialog" aria-modal={isTopmost ? 'true' : undefined} aria-labelledby="cfp-title" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(28,24,18,0.46)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        animation: REDUCE_MOTION ? 'none' : 'cfp-fade 160ms ease' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 380, maxWidth: '100%', maxHeight: '86vh', overflow: 'hidden', background: '#fff',
          borderRadius: 18, boxShadow: '0 12px 40px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column',
          animation: REDUCE_MOTION ? 'none' : 'cfp-pop 200ms cubic-bezier(.2,.9,.3,1.1)' }}>

        <div style={{ position: 'relative', background: theme.bg, padding: '18px 16px 14px',
          display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 66, height: 66, flex: '0 0 auto', borderRadius: '50%', background: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)' }}>
            <img src={critter.image_url} alt="" draggable={false}
              style={{ width: '82%', height: '82%', objectFit: 'contain',
                transform: `scale(${critter.view_scale || 1})` }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div id="cfp-title" style={{ fontSize: '1.06rem', fontWeight: 700, color: theme.name, lineHeight: 1.2 }}>{critter.name}</div>
            <div style={{ marginTop: 3, fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: accent, opacity: 0.85 }}>
              {GROUP_LABEL[critter.group] || GROUP_LABEL.wild}
            </div>
            {flavor && flavor.fun_fact && (
              <div style={{ marginTop: 6, fontSize: '0.82rem', lineHeight: 1.4, fontStyle: 'italic',
                color: theme.name, opacity: 0.92 }}>{flavor.fun_fact}</div>
            )}
            {firstSeen && (
              <div style={{ marginTop: 5, fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.02em',
                color: accent, opacity: 0.8 }}>First seen in your garden on {firstSeen}</div>
            )}
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close"
            style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, border: 'none',
              borderRadius: '50%', background: 'rgba(255,255,255,0.72)', color: theme.name,
              fontSize: 17, lineHeight: '30px', cursor: 'pointer', padding: 0 }}>×</button>
        </div>

        <div role="tablist" style={{ display: 'flex', borderBottom: '1px solid rgba(0,0,0,0.08)', padding: '0 10px' }}>
          {[['facts', 'Facts'], ['alt', 'Alt facts']].map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
              style={{ appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
                padding: '11px 12px', fontSize: '0.85rem', fontWeight: tab === key ? 700 : 500,
                color: tab === key ? accent : '#8a8576',
                borderBottom: `2px solid ${tab === key ? accent : 'transparent'}` }}>{label}</button>
          ))}
        </div>

        <div style={{ padding: '18px 18px 22px', overflowY: 'auto' }}>
          {tab === 'facts'
            ? (<>
                {hasSource
                  ? <p style={para}>{factsText}</p>
                  : (flavor && flavor.fun_fact
                      ? <p style={para}>{flavor.fun_fact}</p>
                      : <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                          justifyContent: 'center', textAlign: 'center', padding: '18px 0 8px' }}>
                          <div className="cfp-q" style={{ fontSize: 52, fontWeight: 700, color: accent, lineHeight: 1 }}>?</div>
                          <div style={{ marginTop: 12, fontSize: '0.86rem', color: '#7a7567' }}>No verified facts yet — coming soon.</div>
                        </div>)}
                {flavor && flavor.call && (
                  <p style={{ ...para, marginTop: 14, fontSize: '0.9rem', fontStyle: 'italic', color: '#5b574c' }}>
                    <span style={{ fontStyle: 'normal', fontWeight: 700, color: accent }}>Listen for: </span>{flavor.call}
                  </p>
                )}
                {flavor && flavor.lore && (
                  <p style={{ ...para, marginTop: 14, fontSize: '0.9rem', color: '#4a463d' }}>
                    <span style={{ fontWeight: 700, color: accent }}>{critter.group === 'cryptid' ? 'Lore: ' : 'Once here: '}</span>{flavor.lore}
                  </p>
                )}
              </>)
            : <p style={para}>{altText || 'No alt facts yet.'}</p>}
        </div>
      </div>

      <style>{`
        @keyframes cfp-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes cfp-pop { from { opacity: 0; transform: translateY(8px) scale(0.98) } to { opacity: 1; transform: none } }
        @keyframes cfp-qpulse { 0%,100% { opacity: 0.32 } 50% { opacity: 1 } }
        .cfp-q { animation: cfp-qpulse 2.2s ease-in-out infinite }
        @media (prefers-reduced-motion: reduce) { .cfp-q { animation: none; opacity: 0.7 } }
      `}</style>
    </div>
  )
}
