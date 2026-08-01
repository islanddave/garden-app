// src/components/forms/AsyncRegion.jsx
// Lane D / Phase A — async-state content region that freezes the three states every page was
// hand-rolling: loading / error / empty. Precedence: error → loading → empty → children.
// NOT a titled section. Renamed from `Section` (HG-1, 2026-07): the old name wrongly implied a
// titled grouping — FROZEN.md documented it as one and TreatmentDetails misused it that way, so
// its `label` was silently dropped and the heading vanished. For a titled grouping, compose a
// local titled <section> with a heading; this primitive only owns the three async states.
//
// The error branch has TWO shapes, selected by whether the caller can offer a retry:
//   no `onRetry`   → inline <ErrorBanner> (the original contract, byte-identical)
//   with `onRetry` → the recoverable-error CARD (glyph + optional title + message + Button)
// Before this the primitive had no retry affordance at all, so four surfaces hand-rolled the card
// instead and drifted apart. The card below is the UNION of those four, not a copy of one: the
// tap-target floor comes from PhotosWall (the only site that had one), `aria-hidden` on the glyph
// comes from Harvests (the only site that had it — elsewhere a screen reader announced the warning
// emoji inside role="alert"), and the retry control routes through the frozen Button primitive.
import React from 'react'
import { P } from '../../lib/constants.js'
import { T } from './formStyles.js'
import Spinner from './Spinner.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import Button from './Button.jsx'

const errorCardChrome = {
  textAlign: 'center',
  padding: '40px 16px',
  background: P.alert,
  border: `1px solid ${P.alertBorder}`,
  borderRadius: T.radiusCard,
}

// Button's `secondary` chrome (transparent fill, P.border outline, P.mid ink) is tuned for the
// white/cream page ground; on the terra-tinted alert card it collapses to a near-invisible
// outline. Only those three colour properties are restored — padding, type ramp, weight, radius
// and the frozen 48px minHeight all stay the primitive's.
const retryOnAlertChrome = {
  backgroundColor: P.white,
  border: `1px solid ${P.alertBorder}`,
  color: P.dark,
}

function ErrorCard({ title, message, onRetry, retryLabel }) {
  const hasTitle = title != null && title !== false
  return (
    <div role="alert" style={errorCardChrome}>
      <div style={{ fontSize: '2.2rem', marginBottom: 10 }} aria-hidden="true">⚠️</div>
      {hasTitle && <p style={{ margin: 0, fontSize: '0.92rem', color: P.dark, fontWeight: 600 }}>{title}</p>}
      <p style={{ margin: hasTitle ? '6px 0 14px' : '0 0 14px', fontSize: T.type.sm, color: P.mid }}>{message}</p>
      <Button variant="secondary" onClick={onRetry} style={retryOnAlertChrome}>{retryLabel}</Button>
    </div>
  )
}

export default function AsyncRegion({
  loading = false,
  error = null,
  empty = false,
  emptyLabel = 'Nothing here yet.',
  loadingLabel = 'Loading…',
  onRetry,
  errorTitle,
  retryLabel = 'Retry',
  children,
  style,
  ...rest
}) {
  let body
  if (error) {
    body = onRetry
      ? <ErrorCard title={errorTitle} message={error} onRetry={onRetry} retryLabel={retryLabel} />
      : <ErrorBanner>{error}</ErrorBanner>
  }
  else if (loading) body = <div style={{ padding: '24px 0', display: 'flex', justifyContent: 'center' }}><Spinner label={loadingLabel} /></div>
  else if (empty) body = <div style={{ padding: '20px 0', textAlign: 'center', color: P.light, fontSize: '0.9rem' }}>{emptyLabel}</div>
  else body = children
  return <section style={style} {...rest}>{body}</section>
}
