// src/components/WhatsNewDot.jsx — V4-WHATSNEW-001 ambient unread indicator.
// Renders a small pulsing dot ONLY when a newer release is unseen; otherwise null.
// Reward-UX V101 compliant: ambient PRESENCE (single dot, no number/count, no toast/modal/sound/
// haptic, never auto-opens). variant="satellite" is a Link (standalone, e.g. beside the Favorites
// heart); variant="inline" is a bare span (the host row is already a Link to /releases — no nested a).
import React from 'react'
import { Link } from 'react-router-dom'
import { useWhatsNew } from '../hooks/useWhatsNew.js'
import { P } from '../lib/constants.js'

function Dot() {
  return (
    <>
      <style>{`@keyframes whatsnew-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.6}}
@media (prefers-reduced-motion: reduce){[data-whatsnew-dot]{animation:none!important}}`}</style>
      <span
        data-whatsnew-dot
        aria-hidden="true"
        style={{
          display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
          background: P.terra, boxShadow: '0 0 0 2px rgba(255,255,255,0.92)',
          animation: 'whatsnew-pulse 1.8s ease-in-out infinite',
        }}
      />
    </>
  )
}

export default function WhatsNewDot({ variant = 'satellite', style }) {
  const { unseen } = useWhatsNew()
  if (!unseen) return null
  if (variant === 'inline') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 8, ...style }}>
        <Dot />
      </span>
    )
  }
  return (
    <Link
      to="/releases"
      aria-label="New in the garden app — see what's new"
      style={{ position: 'absolute', top: -2, right: -2, zIndex: 3, lineHeight: 0, ...style }}
    >
      <Dot />
    </Link>
  )
}
