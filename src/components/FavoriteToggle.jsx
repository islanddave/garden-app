import React, { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { useFavorites } from '../context/FavoritesContext.jsx'
import { P } from '../lib/constants.js'
import { T } from './forms/formStyles.js'

// BUG-SEEDPAGETAPFLOORS-001 — a T.tapMinHeight HIT AREA around a glyph drawn at `size`, without moving
// one pixel of layout on any of the six hosts (the inventory and project detail titles, the planting
// hero's float button, the planting tile's 36px scrim, the Garden project row, the project list card).
// It measured 26x27 at the default size. The BOX grows by padding and a margin of 4px MINUS that padding
// hands the growth back, per side, so the MARGIN box — the thing every host lays out — is exactly the
// old `padding: 4px` box and the glyph sits where it sat. Padding + margin is the ONLY shape that is
// exact: Chrome lays out in 1/64 px, and a min-height of 44 with a margin derived from `size` came out
// 1/64 px taller than the old box (measured on ProjectDetail's header row), while a pair that sums to
// 4px rounds to 4px whichever way each half rounds.
//   block axis:  hitPadY — the glyph's box is exactly `size` tall (lineHeight 1), so this makes the box
//                44 plus a half-pixel either side, which keeps it at or over the floor after rounding.
//   inline axis: hitPadX — the glyph's advance is not something CSS can read; this makes the box 44 wide
//                for any glyph at least 0.75em wide (♡ measures 0.94em in the gate's Chrome).
// What does change: the focus ring and Android's tap flash now outline the target rather than the glyph.
const hitPadY = (size) => `calc((${T.tapMinHeight}px - ${size}) / 2 + 0.5px)`
const hitPadX = (size) => `calc((${T.tapMinHeight}px - 0.75 * ${size}) / 2)`

// V3-PERF-FAV-001 — favorite state now comes from FavoritesContext (one bulk
// fetch app-wide) instead of a per-toggle GET on mount. Removes the /garden
// N+1 (150+ /api/favorites requests -> 1). Click still POST/DELETEs and updates
// the shared Set optimistically (rolled back on failure).
export default function FavoriteToggle({ entityType, entityId, size = '1.2rem' }) {
  const { user } = useAuth()
  const { fetch } = useApiFetch()
  const { isFavorite, setFavorite } = useFavorites()
  const [busy, setBusy] = useState(false)
  const isFav = isFavorite(entityType, entityId)

  async function toggle(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!user || busy || !entityId) return
    setBusy(true)
    const next = !isFav
    setFavorite(entityType, entityId, next)
    try {
      if (next) {
        await fetch('/api/favorites', { method: 'POST', body: JSON.stringify({ entity_type: entityType, entity_id: entityId }) })
      } else {
        await fetch(`/api/favorites?entity_type=${entityType}&entity_id=${entityId}`, { method: 'DELETE' })
      }
    } catch {
      setFavorite(entityType, entityId, !next)
    } finally {
      setBusy(false)
    }
  }

  if (!user) return null

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Favorite"
      aria-pressed={isFav}
      style={{
        background:  'none',
        border:      'none',
        cursor:      busy ? 'default' : 'pointer',
        padding:     `${hitPadY(size)} ${hitPadX(size)}`,
        margin:      `calc(4px - ${hitPadY(size)}) calc(4px - ${hitPadX(size)})`,
        fontSize:    size,
        opacity:     busy ? 0.4 : 1,
        lineHeight:  1,
        transition:  'transform 150ms, opacity 150ms',
        display:     'inline-flex',
        alignItems:  'center',
        color:       isFav ? P.gold : P.light,  // V4-A11Y-001: AA-legible on light surfaces (was #c9a84c/#aaa)
      }}
    >
      {isFav ? '♥' : '♡'}
    </button>
  )
}
