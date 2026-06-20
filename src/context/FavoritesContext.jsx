import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAuth } from './AuthContext.jsx'
import { useApiFetch } from '../lib/api.js'

// V3-PERF-FAV-001 — single source of favorite state for the whole app.
// Replaces the per-FavoriteToggle GET /api/favorites?entity (an N+1 fan-out:
// one request per card -> 150+ requests on /garden, ~3s tail + connection-pool
// starvation). The provider fetches the user's full favorites list ONCE (the
// bulk GET /api/favorites the Favorites page already uses) and serves every
// toggle from an in-memory Set. Toggles mutate the Set optimistically.
const DEFAULT = { isFavorite: () => false, setFavorite: () => {}, favoritesLoaded: false }
const FavoritesContext = createContext(DEFAULT)

export function FavoritesProvider({ children }) {
  const { user } = useAuth()
  const { fetch } = useApiFetch()
  const [favSet, setFavSet] = useState(() => new Set())
  const [favoritesLoaded, setFavoritesLoaded] = useState(false)

  useEffect(() => {
    let on = true
    if (!user) { setFavSet(new Set()); setFavoritesLoaded(false); return }
    fetch('/api/favorites')
      .then(list => {
        if (!on) return
        setFavSet(new Set((list ?? []).map(f => `${f.entity_type}:${f.entity_id}`)))
        setFavoritesLoaded(true)
      })
      .catch(() => { if (on) setFavoritesLoaded(true) })
    return () => { on = false }
  }, [user, fetch])

  const isFavorite = useCallback((t, id) => favSet.has(`${t}:${id}`), [favSet])
  const setFavorite = useCallback((t, id, val) => {
    setFavSet(prev => {
      const next = new Set(prev)
      const k = `${t}:${id}`
      if (val) next.add(k); else next.delete(k)
      return next
    })
  }, [])

  return (
    <FavoritesContext.Provider value={{ isFavorite, setFavorite, favoritesLoaded }}>
      {children}
    </FavoritesContext.Provider>
  )
}

// Non-throwing: a toggle rendered without a provider (isolated component tests,
// public pages) gets the safe default -- no favorites, no-op toggle -- not a crash.
export function useFavorites() {
  return useContext(FavoritesContext)
}
