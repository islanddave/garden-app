import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useZone } from '../context/ZoneContext.jsx'
import { P } from '../lib/constants.js'
import ChoiceGrid from '../components/forms/ChoiceGrid.jsx'

function zoneIcon(zone) {
  if (zone.icon) return zone.icon
  const n = (zone.name || '').toLowerCase()
  if (n.includes('stable'))     return '🏚️'
  if (n.includes('pasture'))    return '🌾'
  if (n.includes('deck'))       return '🪴'
  if (n.includes('porch'))      return '🪴'
  if (n.includes('perennial'))  return '🌸'
  if (n.includes('steps'))      return '🪜'
  if (n.includes('house'))      return '🏠'
  if (n.includes('greenhouse')) return '🏡'
  return '🌱'
}

export default function ZonePicker() {
  const { activeZone, setActiveZone } = useZone()
  const navigate   = useNavigate()
  const location   = useLocation()
  const { fetch }  = useApiFetch()
  const [zones,    setZones]    = useState([])
  const [counts,   setCounts]   = useState({})
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  const from = new URLSearchParams(location.search).get('from') || '/dashboard'

  useEffect(() => { loadZones() }, [fetch])

  async function loadZones() {
    try {
      const [locsResp, projData] = await Promise.all([
        fetch('/api/locations'),
        fetch('/api/projects'),
      ])

      const countMap = {}
      ;(projData ?? []).filter(p => p.status === 'active').forEach(p => {
        if (p.location_id) {
          countMap[p.location_id] = (countMap[p.location_id] || 0) + 1
        }
      })

      // Locations Lambda returns { locations: [...], locations_with_path: [...] }
      // Filter to level-0 active zones only for the zone picker
      const allLocs = locsResp?.locations ?? []
      setZones(allLocs.filter(l => l.level === 0 && l.is_active !== false)
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')))
      setCounts(countMap)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function select(zone) {
    setActiveZone(zone)
    navigate(from)
  }

  if (loading) return (
    <div style={{ padding: '64px 20px', textAlign: 'center', color: P.mid }}>
      Loading zones…
    </div>
  )

  if (error) return (
    <div style={{ padding: '48px 20px', textAlign: 'center', color: P.terra }}>
      Error loading zones: {error}
    </div>
  )

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: '480px', margin: '0 auto', padding: '32px 20px 48px' }}>

        <h1 style={{
          color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 6px',
        }}>
          Where are you? 🌱
        </h1>
        <p style={{ color: P.mid, fontSize: '0.875rem', margin: '0 0 28px', lineHeight: 1.5 }}>
          Zone focus is coming soon — picking one won't filter your views yet.
        </p>

        <ChoiceGrid
          layout="list"
          ariaLabel="Zone"
          value={activeZone?.id ?? '__all__'}
          onChange={(id) => select(id === '__all__' ? null : zones.find(z => z.id === id))}
          options={[
            { value: '__all__', label: 'Everywhere', description: 'All zones — show everything', icon: '🗺️' },
            ...zones.map(zone => {
              const count = counts[zone.id] ?? 0
              return {
                value: zone.id,
                label: zone.name,
                description: count === 0 ? 'No active projects' : `${count} active project${count === 1 ? '' : 's'}`,
                icon: zoneIcon(zone),
              }
            }),
          ]}
        />

        {zones.length === 0 && (
          <div style={{
            border: `1px dashed ${P.border}`,
            borderRadius: '12px',
            padding: '32px 20px',
            textAlign: 'center',
            color: P.mid,
            fontSize: '0.9rem',
            marginTop: '8px',
            lineHeight: 1.6,
          }}>
            No zones set up yet.{' '}
            <a href="/locations" style={{ color: P.green, textDecoration: 'none', fontWeight: 600 }}>
              Add zones in Locations →
            </a>
          </div>
        )}

        <button
          onClick={() => navigate(from)}
          style={{
            marginTop: '24px',
            background: 'none',
            border: 'none',
            color: P.mid,
            fontSize: '0.875rem',
            cursor: 'pointer',
            padding: '8px 0',
            textDecoration: 'underline',
            display: 'block',
          }}
        >
          ← Cancel, go back
        </button>

      </div>
    </div>
  )
}

