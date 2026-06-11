// src/components/forms/Badge.jsx
// Lane D / Phase A — canonical Badge primitive. Operational/display-only label chip;
// NOT a reward-UX surface. Built on the formStyles token layer (T) and palette (P)
// so it stays visually consistent with the established status pills without duplicating
// their chrome. API shape mirrors Button/Card: style-merge, rest-prop passthrough, and
// custom props (tone) destructured before spread so they never reach the DOM. No role is
// assigned (it is a visual label); title/aria-label pass through for the AT affordance.
import React from 'react'
import { P } from '../../lib/constants.js'
import { T } from './formStyles.js'

const TONE_COLORS = {
  neutral: { bg: P.cream,     text: P.mid,         border: P.border },
  active:  { bg: P.greenPale, text: P.green,       border: P.greenLight },
  success: { bg: P.greenPale, text: P.green,       border: P.greenLight },
  warn:    { bg: P.warn,      text: P.gold,        border: P.warnBorder },
  info:    { bg: '#e8f0fa',   text: P.blue,        border: P.blue },
  danger:  { bg: P.alert,     text: P.alertBorder, border: P.alertBorder },
}

function badgeChrome(tone) {
  const c = TONE_COLORS[tone] ?? TONE_COLORS.neutral
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 9px',
    borderRadius: T.radiusButton,
    fontSize: '0.75rem',
    fontWeight: 600,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    backgroundColor: c.bg,
    color: c.text,
    border: `1px solid ${c.border}`,
    fontFamily: 'inherit',
  }
}

export default function Badge({ tone = 'neutral', children, style, className, ...rest }) {
  return (
    <span className={className} style={{ ...badgeChrome(tone), ...style }} {...rest}>
      {children}
    </span>
  )
}
