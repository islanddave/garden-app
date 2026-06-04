// src/components/forms/Section.jsx
// Lane D / Phase A — content region that freezes the three async states every
// page was hand-rolling: loading / error / empty. Precedence: error → loading →
// empty → children. This is the Phase A "shell primitives" deliverable (plan §5):
// without it pages keep re-inventing these three states and Phase A under-delivers.
import React from 'react'
import { P } from '../../lib/constants.js'
import Spinner from './Spinner.jsx'
import ErrorBanner from './ErrorBanner.jsx'

export default function Section({
  loading = false,
  error = null,
  empty = false,
  emptyLabel = 'Nothing here yet.',
  loadingLabel = 'Loading…',
  children,
  style,
  ...rest
}) {
  let body
  if (error) body = <ErrorBanner>{error}</ErrorBanner>
  else if (loading) body = <div style={{ padding: '24px 0', display: 'flex', justifyContent: 'center' }}><Spinner label={loadingLabel} /></div>
  else if (empty) body = <div style={{ padding: '20px 0', textAlign: 'center', color: P.light, fontSize: '0.9rem' }}>{emptyLabel}</div>
  else body = children
  return <section style={style} {...rest}>{body}</section>
}
