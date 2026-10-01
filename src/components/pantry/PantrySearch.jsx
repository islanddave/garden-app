// src/components/pantry/PantrySearch.jsx
// Put-Up B′ release 2 (V4 §2.5 "One search at page level", §6.1) — the page header's search field and
// the results that REPLACE the segment body while it holds text (× or Back clears it: the text lives in
// the page's `?find=` param, so Back pops it). Corpus: the Pantry list plus whatever the page hands in as
// `extraSearchItems` (the recipes lane's loaded recipes); NAME/LABEL match only. A tap opens the jar row
// or item (its row sheet) or the extra item (its own onOpen). No hit → "Put something up: <text> →".
// Batches are not in it (Going now is their list).
// `onOpenBatch` (the page's opener, Put-Up UX pass R1): a jar hit's row sheet offers What went in → for a
// batch this host can name, exactly as the Pantry's does. The names are read only when it is handed in.
import React, { useMemo, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { inputChrome } from '../forms/formStyles.js'
import PantryRowSheet from './PantryRowSheet.jsx'
import { useBatchNames, batchNameOf } from './PantryView.jsx'
import { searchHits, leftWords, extraLabel } from './pantryRows.js'

export const SEARCH_LABEL = 'Search the pantry'

export function PantrySearchBox({ value, onChange, onClear }) {
  return (
    <div role="search" style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
      <input type="search" aria-label={SEARCH_LABEL} data-testid="pantry-search" value={value} placeholder="Search"
        onChange={e => onChange(e.target.value)}
        style={{ ...inputChrome(false), flex: 1, minWidth: 0, minHeight: 48 }} />
      {value && (
        <button type="button" onClick={onClear} data-testid="pantry-search-clear" aria-label="Clear the search"
          style={{ minWidth: 48, minHeight: 48, background: 'none', border: 'none', color: P.mid, fontSize: '1.2rem', cursor: 'pointer' }}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  )
}

export default function PantrySearchResults({
  query, rows, loading, extraSearchItems = [], onOpenExtra = null, fetch, onPutUp, onUsed, onChanged, JarEditor = null, onHowItWasMade = null,
  canHowItWasMade = null, onOpenBatch = null, now,
}) {
  const [openRow, setOpenRow] = useState(null)
  const batches = useBatchNames({ fetch, rows, enabled: typeof onOpenBatch === 'function' })
  const hits = useMemo(() => searchHits(rows ?? [], extraSearchItems, query), [rows, extraSearchItems, query])
  const text = String(query ?? '').trim()
  return (
    <div data-testid="pantry-search-results">
      {rows == null && loading && <div style={{ padding: 16, color: P.light }}>Searching&hellip;</div>}
      {hits.length > 0 && (
        <ul aria-label={`Found for ${text}`} style={{ listStyle: 'none', margin: 0, padding: 0, background: P.white,
          border: `1px solid ${P.border}`, borderRadius: T.radiusBadge, overflow: 'hidden' }}>
          {hits.map(h => (
            <li key={h.key} style={{ borderTop: `1px solid ${P.cream}` }}>
              <button type="button" data-testid={`pantry-search-hit-${h.key}`}
                onClick={() => {
                  if (h.row) setOpenRow(h.row)
                  else if (typeof h.extra?.onOpen === 'function') h.extra.onOpen(h.extra)
                  else onOpenExtra?.(h.extra)
                }}
                style={{ display: 'block', width: '100%', minHeight: 48, textAlign: 'left', padding: '8px 14px', background: 'none',
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark }}>
                <span style={{ fontWeight: 600 }}>{h.name}</span>
                <span style={{ color: P.mid, fontSize: T.type.sm }}>
                  {h.row
                    ? [h.row.place?.label, leftWords(h.row)].filter(Boolean).map(x => ` · ${x}`).join('')
                    : (extraLabel(h.extra) ? ` · ${extraLabel(h.extra)}` : '')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows != null && hits.length === 0 && text && (
        <button type="button" data-testid="pantry-search-putup" onClick={() => onPutUp(text)}
          style={{ display: 'block', width: '100%', minHeight: 48, textAlign: 'left', padding: '8px 14px', background: P.white,
            border: `1px solid ${P.border}`, borderRadius: T.radiusButton, cursor: 'pointer', fontFamily: 'inherit',
            color: P.green, fontWeight: 700 }}>
          Put something up: {text} →
        </button>
      )}
      <PantryRowSheet row={openRow} fetch={fetch} onClose={() => setOpenRow(null)} now={now}
        JarEditor={JarEditor} onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade} onUsed={onUsed} onChanged={onChanged}
        onOpenBatch={onOpenBatch} canOpenBatch={(r) => batchNameOf(batches, r) != null} />
    </div>
  )
}
