import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useZone } from '../context/ZoneContext.jsx'
import { P } from '../lib/constants.js'

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
      const [zoneData, projData] = await Promise.all([
        fetch('/api/locations?level=0&active=true'),
        fetch('/api/projects'),
      ])

      const countMap = {}
      ;(projData ?? []).filter(p => p.status === 'active').forEach(p => {
        if (p.location_id) {
          countMap[p.location_id] = (countMap[p.location_id] || 0) + 1
        }
      })

      setZones(zoneData ?? [])
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
          Tap a zone to focus your tasks and suggestions there.
        </p>

        <ZoneCard
          icon="🗺️"
          name="Everywhere"
          subtitle="All zones — show everything"
          selected={activeZone === null}
          onSelect={() => select(null)}
        />

        {zones.map(zone => {
          const count = counts[zone.id] ?? 0
          return (
            <ZoneCard
              key={zone.id}
              icon={zoneIcon(zone)}
              name={zone.name}
              subtitle={count === 0
                ? 'No active projects'
                : `${count} active project${count === 1 ? '' : 's'}`
              }
              selected={activeZone?.id === zone.id}
              onSelect={() => select(zone)}
            />
          )
        })}

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

function ZoneCard({ icon, name, subtitle, selected, onSelect }) {
  const [pressed, setPressed] = useState(false)

  return (
    <button
      onClick={onSelect}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onTouchStart={() => setPressed(true)}
      onTouchEnd={() => setPressed(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        width: '100%',
        minHeight: '80px',
        padding: '16px 20px',
        marginBottom: '10px',
        backgroundColor: selected ? P.greenPale : P.white,
        border: `2px solid ${selected ? P.green : P.border}`,
        borderRadius: '12px',
        cursor: 'pointer',
        textAlign: 'left',
        outline: 'none',
        fontFamily: 'inherit',
        transition: 'border-color 150ms ease, background-color 150ms ease',
        transform: pressed ? 'scale(0.98)' : 'scale(1)',
        boxShadow: selected ? `0 0 0 1px ${P.green}20` : 'none',
      }}
    >
      <span style={{ fontSize: '2rem', lineHeight: 1, flexShrink: 0, userSelect: 'none' }}>
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: 700,
          fontSize: '1.05rem',
          color: selected ? P.green : P.dark,
          lineHeight: 1.25,
        }}>
          {name}
        </div>
        <div style={{
          fontSize: '0.85rem',
          color: P.mid,
          marginTop: '3px',
          lineHeight: 1.3,
        }}>
          {subtitle}
        </div>
      </div>
      {selected && (
        <span style={{ fontSize: '1.3rem', color: P.green, flexShrink: 0 }}>✓</span>
      )}
    </button>
  )
}
