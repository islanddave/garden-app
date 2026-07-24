// src/components/forms/AsyncRegion.jsx
// Lane D / Phase A — async-state content region that freezes the three states every page was
// hand-rolling: loading / error / empty. Precedence: error → loading → empty → children.
// NOT a titled section. Renamed from `Section` (HG-1, 2026-07): the old name wrongly implied a
// titled grouping — FROZEN.md documented it as one and TreatmentDetails misused it that way, so
// its `label` was silently dropped and the heading vanished. For a titled grouping, compose a
// local titled <section> with a heading; this primitive only owns the three async states.
import React from 'react'
import { P } from '../../lib/constants.js'
import Spinner from './Spinner.jsx'
import ErrorBanner from './ErrorBanner.jsx'

export default function AsyncRegion({
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
