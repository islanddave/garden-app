import React, { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

const TYPE_META = {
  // V3-FAV-001: plantings lead (plantings-first as projects deprecate to buckets). The plant list
  // (/api/plants) carries project_id, so the row deep-links to the planting's own detail page
  // (/projects/:id/plantings/:plantingId) instead of the generic /garden. Falls back to /garden
  // if a record somehow lacks project_id.
  plant:          { label: 'Plantings', icon: '🌿', link: i => i.project_id ? `/projects/${i.project_id}/plantings/${i.id}` : `/garden` },
  project:        { label: 'Projects',  icon: '🌱', link: i => `/projects/${i.id}` },
  location:       { label: 'Locations', icon: '📍', link: () => `/locations` },
  inventory_item: { label: 'Inventory', icon: '📦', link: i => `/inventory/${i.id}` },
}

export default function Favorites() {
  const { fetch } = useApiFetch()
  const [sections, setSections] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  const load = useCallback(async () => {
    try {
      // Parallel: favorites list + entity data for Lambda-backed types.
      // Each entity type is resolved by fetching the full list and filtering by
      // favorited id client-side — no batch-by-ids endpoint is needed (or used)
      // for any type, plants included.
      const [favs, allProjects, allLocations, allInventory, allPlants] = await Promise.all([
        fetch('/api/favorites'),
        fetch('/api/projects'),
        fetch('/api/locations'),
        fetch('/api/inventory-items').catch(() => []),
        fetch('/api/plants').catch(() => []),
      ])

      if (!favs?.length) { setSections([]); setLoading(false); return }

      // Group favorites by entity_type
      const byType = {}
      ;(favs ?? []).forEach(f => {
        if (!byType[f.entity_type]) byType[f.entity_type] = []
        byType[f.entity_type].push(f.entity_id)
      })

      const resolvedSections = []

      // Plantings — V3-FAV-001: surfaced FIRST (plantings-first as projects deprecate to buckets).
      // Cross-reference favorited plant ids with the /api/plants list (carries project_id for the
      // deep-link). The branch itself is the I3-persistence fix; it now leads the page.
      if (byType.plant) {
        const items = (allPlants ?? []).filter(pl => byType.plant.includes(pl.id))
        if (items.length) resolvedSections.push({ type: 'plant', items })
      }

      // Projects — cross-reference with Lambda result
      if (byType.project) {
        const items = (allProjects ?? []).filter(p => byType.project.includes(p.id))
        if (items.length) resolvedSections.push({ type: 'project', items })
      }

      // Locations — cross-reference with Lambda result.
      // /api/locations returns an ENVELOPE { locations, locations_with_path } — NOT a bare array.
      // Normalize defensively: prefer the .locations key; fall back to array-shape; else [].
      // (Fix for V1.2a-3 surface #3 crash: `(envelope ?? []).filter` blew up because ?? doesn't
      //  unwrap a non-null object; the LHS object passes through and .filter is undefined on it.)
      if (byType.location) {
        const locsArr = Array.isArray(allLocations)
          ? allLocations
          : (allLocations?.locations ?? [])
        const items = locsArr.filter(l => byType.location.includes(l.id))
        if (items.length) resolvedSections.push({ type: 'location', items })
      }

      // Inventory items — cross-reference with Lambda result
      if (byType.inventory_item) {
        const items = (allInventory ?? []).filter(it => byType.inventory_item.includes(it.id))
        if (items.length) resolvedSections.push({ type: 'inventory_item', items })
      }

      setSections(resolvedSections)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [fetch])

  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ padding: '48px 20px', textAlign: 'center', color: P.mid }}>Loading…</div>
  if (error)   return <div style={{ padding: '48px 20px', textAlign: 'center', color: P.terra }}>Error: {error}</div>

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 20px' }}>
        <h1 style={{ color: P.green, fontSize: '1.4rem', fontWeight: 700, margin: '0 0 24px' }}>
          ♥ Favorites
        </h1>
        {sections.length === 0 ? (
          <div style={{
            backgroundColor: P.white, border: `1px solid ${P.border}`,
            borderRadius: '10px', padding: '40px 20px',
            textAlign: 'center', color: P.light, fontSize: '0.95rem',
          }}>
            No favorites yet. Tap ♡ on any planting, project, location, or inventory item to save it here.
          </div>
        ) : sections.map(({ type, items }) => {
          const meta = TYPE_META[type]
          return (
            <section key={type} style={{ marginBottom: '28px' }}>
              <h2 style={{ fontSize: '0.8rem', fontWeight: 700, color: P.mid, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>
                {meta.icon} {meta.label}
              </h2>
              {items.map(item => (
                <Link key={item.id} to={meta.link(item)} style={{ textDecoration: 'none' }}>
                  <div style={{
                    backgroundColor: P.white, border: `1px solid ${P.border}`,
                    borderRadius: '8px', padding: '14px 16px', marginBottom: '8px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
                  }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = P.greenLight}
                    onMouseLeave={e => e.currentTarget.style.borderColor = P.border}
                  >
                    <div>
                      <span style={{ fontWeight: 600, color: P.green }}>{item.name}</span>
                      {item.variety && <span style={{ fontSize: '0.8rem', color: P.light, marginLeft: 6 }}>{item.variety}</span>}
                    </div>
                    {item.status && <span style={{ fontSize: '0.75rem', color: P.light }}>{item.status}</span>}
                  </div>
                </Link>
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
