import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../lib/supabase.js'

export default function FavoriteToggle({ entityType, entityId, size = '1.2rem' }) {
  const { user } = useAuth()
  const [isFav,   setIsFav]   = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user || !entityId) { setLoading(false); return }
    supabase
      .from('favorites')
      .select('id')
      .eq('user_id',    user.id)
      .eq('entity_type', entityType)
      .eq('entity_id',   entityId)
      .maybeSingle()
      .then(({ data }) => { setIsFav(!!data); setLoading(false) })
  }, [user, entityType, entityId])

  async function toggle(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!user || loading) return
    setLoading(true)
    if (isFav) {
      await supabase.from('favorites').delete()
        .eq('user_id',    user.id)
        .eq('entity_type', entityType)
        .eq('entity_id',   entityId)
      setIsFav(false)
    } else {
      await supabase.from('favorites').insert({
        user_id:     user.id,
        entity_type: entityType,
        entity_id:   entityId,
      })
      setIsFav(true)
    }
    setLoading(false)
  }

  if (!user) return null

  return (
    <button
      onClick={toggle}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
      style={{
        background:  'none',
        border:      'none',
        cursor:      loading ? 'default' : 'pointer',
        padding:     '4px',
        fontSize:    size,
        opacity:     loading ? 0.4 : 1,
        lineHeight:  1,
        transition:  'transform 150ms, opacity 150ms',
        display:     'inline-flex',
        alignItems:  'center',
        color:       isFav ? '#c9a84c' : '#aaa',
      }}
    >
      {isFav ? '★' : '☆'}
    </button>
  )
}
