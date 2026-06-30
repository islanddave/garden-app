import React, { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { useFavorites } from '../context/FavoritesContext.jsx'

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
      onClick={toggle}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
      style={{
        background:  'none',
        border:      'none',
        cursor:      busy ? 'default' : 'pointer',
        padding:     '4px',
        fontSize:    size,
        opacity:     busy ? 0.4 : 1,
        lineHeight:  1,
        transition:  'transform 150ms, opacity 150ms',
        display:     'inline-flex',
        alignItems:  'center',
        color:       isFav ? '#c9a84c' : '#aaa',
      }}
    >
      {isFav ? '♥' : '♡'}
    </button>
  )
}
