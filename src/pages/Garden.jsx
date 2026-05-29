import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { getStatusColors } from '../lib/status.js'
import FavoriteToggle from '../components/FavoriteToggle.jsx'
import CritterSprite from '../components/CritterSprite.jsx'
import LoveMehPopover from '../components/LoveMehPopover.jsx'
import BaselineResidents from '../components/BaselineResidents.jsx'
import { fetchActiveCritters, markCrittersViewed, patchSpeciesPrefs } from '../lib/critterClient.js'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'
import { buildGardenTree, nodeHasChildren, loadExpanded, saveExpanded } from '../lib/projectTree.js'
import { formatQty } from '../lib/format.js'

// Garden — Increment 1 of the post-V2 UX overhaul. Unifies the old Projects + Plants
// tabs into ONE nested accordion: projects form a parent/child tree; each project's
// plantings hang under it as leaf rows. Collapsed-first (ADHD-overwhelm mitigation).
//
// Variant A interaction (ratified Dave+Jen 2026-05-23, garden-tab-mockup-V002):
//   • leading PHOTO thumbnail → OPENS the node's detail page (picture = go in)
//   • row BODY + chevron      → PEEK (expand/collapse children)  (row = look inside)
//   • leaf rows (no children) → whole row OPENS
// Frontend-only: composes /api/projects + /api/plants (no backend/schema change).

export default function Garden() {
  const { fetch, getToken } = useApiFetch()
  const [projects, setProjects] = useState([])
  const [plants,   setPlants]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [expanded, setExpanded] = useState(() => loadExpanded())
  // MVP-Critter Session 3: active critters for this household, grouped by plant_id.
  const [critters, setCritters] = useState([])
  // D-INV-1 long-press popover state. anchorEl is the long-pressed sprite DOM node.
  const [popover, setPopover] = useState({ open: false, critter: null, anchorEl: null })

  // Session 3.5 (§3.26): per-sprite actually-seen accumulator.
  // CritterSprite fires onIntersect ONCE per id when IO-gate trips (sprite enters viewport).
  // Drained on Garden unmount (route change) AND on visibilitychange → hidden (tab background).
  const seenIdsRef = useRef(new Set())
  const onSpriteIntersect = useCallback((critter) => {
    if (critter && critter.id) seenIdsRef.current.add(critter.id)
  }, [])

  useEffect(() => {
    let on = true
    Promise.all([fetch('/api/projects'), fetch('/api/plants')])
      .then(([proj, pl]) => {
        if (!on) return
        setProjects(proj ?? [])
        setPlants(pl ?? [])
        setLoading(false)
      })
      .catch(err => { if (!on) return; setError(err.message); setLoading(false) })
    return () => { on = false }
  }, [fetch])

  // MVP-Critter Session 3: fetch active critters on mount + visibilitychange.
  // critterClient is fire-and-forget — silent no-op when VITE_API_CRITTERS unset.
  useEffect(() => {
    let on = true
    function refresh() {
      fetchActiveCritters({ getToken }).then(list => { if (on) setCritters(list) })
    }
    refresh()
    function onVis() { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => { on = false; document.removeEventListener('visibilitychange', onVis) }
  }, [getToken])

  // MVP-Critter Session 3 + 3.5: mark unviewed critters as viewed.
  // Session 3 path = bulk PATCH /api/critters/viewed (legacy, still supported when no sprites IO'd).
  // Session 3.5 path = drain seenIdsRef and pass actuallySeenCritterIds → Lambda marks ONLY those.
  // Race-window header (x-garden-view-opened-at) preserved in both paths.
  //
  // Flush boundaries:
  //   • Garden unmount (route change out)
  //   • document visibilitychange → hidden (tab background; iOS PWA app switch)
  // Both flushes drain + clear the ref so re-mount/re-foreground starts fresh.
  const gardenOpenedAtRef = useRef(new Date().toISOString())
  const flushSeen = useCallback(() => {
    const ids = Array.from(seenIdsRef.current)
    seenIdsRef.current.clear()
    // Pass null when no sprites IO'd → Lambda falls back to bulk-mark (preserves Stage 3 dot clear).
    markCrittersViewed({
      getToken,
      openedAt: gardenOpenedAtRef.current,
      actuallySeenCritterIds: ids.length > 0 ? ids : null,
    })
  }, [getToken])

  useEffect(() => {
    function onVis() {
      if (document.visibilityState === 'hidden') flushSeen()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      // Unmount flush — route change out of Garden.
      flushSeen()
    }
  }, [flushSeen])

  // Long-press handler — opens popover anchored to the long-pressed sprite element.
  const onSpriteLongPress = useCallback((critter, e) => {
    const anchorEl = e?.currentTarget ?? null
    setPopover({ open: true, critter, anchorEl })
  }, [])

  // Popover pick handler — translate action → weight via D-INV-1 mapping (§3.29).
  const onPrefsPick = useCallback((action) => {
    if (!popover.critter) return
    const weight = action === 'love' ? 2.0 : action === 'meh' ? 0.5 : action === 'reset' ? 1.0 : null
    if (weight != null) {
      patchSpeciesPrefs({ getToken, speciesId: popover.critter.species_id, weight })
      // Fire-and-forget; no toast per §3.29. Pulse confirmation is already inside popover.
    }
  }, [getToken, popover.critter])

  const closePopover = useCallback(() => {
    setPopover({ open: false, critter: null, anchorEl: null })
  }, [])

  const toggle = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveExpanded(next)
      return next
    })
  }, [])

  // Group critters by plant_id (target_id falls back to plant_id) for O(1) lookup in PlantingRow.
  const crittersByPlantId = useMemo(() => {
    const m = new Map()
    for (const c of critters) {
      const key = c.plant_id ?? c.target_id
      if (!key) continue
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(c)
    }
    return m
  }, [critters])

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  const tree = buildGardenTree(projects, plants)

  return (
    <Shell>
      {/* MVP-Critter Session 3: Day-1 always-present residents (robin + honeybee).
          Decorative, aria-hidden, never persisted to critter_state. Per revision §3.14. */}
      <BaselineResidents />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>Garden</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/log/many" style={btnGhost}>⚡ Log many</Link>
          <Link to="/plants" style={btnGhost}>+ Planting</Link>
          <Link to="/projects/new" style={btnLink}>+ Project</Link>
        </div>
      </div>

      {tree.length === 0 ? (
        <EmptyState />
      ) : (
        <div role="tree" aria-label="Garden" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tree.map(node => (
            <TreeNode key={node.project.id} node={node} expanded={expanded} onToggle={toggle} level={1}
              crittersByPlantId={crittersByPlantId}
              onSpriteLongPress={onSpriteLongPress}
              onSpriteIntersect={onSpriteIntersect} />
          ))}
        </div>
      )}

      {/* MVP-Critter Session 3 D-INV-1: long-press species-prefs popover.
          Anchored to long-pressed sprite. Single instance at a time. */}
      <LoveMehPopover
        open={popover.open}
        anchorRef={{ current: popover.anchorEl }}
        species={popover.critter ? SPECIES_BY_ID[popover.critter.species_id] : null}
        onPick={onPrefsPick}
        onClose={closePopover}
      />
    </Shell>
  )
}

function TreeNode({ node, expanded, onToggle, level, crittersByPlantId, onSpriteLongPress, onSpriteIntersect }) {
  const { project: p, depth, children, plantings } = node
  const hasKids = nodeHasChildren(node)
  const isOpen  = hasKids && expanded.has(p.id)
  const sc = getStatusColors(p.status)
  const indent = depth * 20

  const summary = hasKids
    ? `${children.length ? children.length + (children.length === 1 ? ' project' : ' projects') : ''}${children.length && plantings.length ? ' · ' : ''}${plantings.length ? plantings.length + (plantings.length === 1 ? ' planting' : ' plantings') : ''}`
    : ''

  const nameMeta = (
    <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: P.green, fontSize: '0.95rem' }}>{p.name}</span>
        {!p.is_public && (
          <span style={{ fontSize: '0.7rem', color: P.light, backgroundColor: '#eee', borderRadius: 10, padding: '1px 7px' }}>private</span>
        )}
      </div>
      {summary && <div style={{ fontSize: '0.75rem', color: P.light, marginTop: 2 }}>{summary}</div>}
      {p.location_path && <div style={{ fontSize: '0.78rem', color: P.mid, marginTop: 2 }}>📍 {p.location_path}</div>}
    </div>
  )

  return (
    <div role="treeitem" aria-level={level} aria-expanded={hasKids ? isOpen : undefined} style={{ paddingLeft: indent }}>
      <div style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`,
        borderLeft: depth > 0 ? `3px solid ${P.greenLight}` : `1px solid ${P.border}`,
        borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        {/* PHOTO / icon — OPENS detail (Variant A: picture = go in) */}
        <Link to={`/projects/${p.id}`} aria-label={`Open ${p.name}`} style={thumbWrap}>
          {p.featured_photo_view_url
            ? <img src={p.featured_photo_view_url} alt="" style={thumbImg} />
            : <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>🌿</span>}
        </Link>

        {/* BODY — PEEK (toggle) when it has children; OPEN when it's a leaf */}
        {hasKids ? (
          <button type="button" onClick={() => onToggle(p.id)} aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${p.name}`} style={bodyBtn}>
            {nameMeta}
          </button>
        ) : (
          <Link to={`/projects/${p.id}`} style={{ ...bodyBtn, textDecoration: 'none' }}>
            {nameMeta}
          </Link>
        )}

        <FavoriteToggle entityType="project" entityId={p.id} />

        <span style={{ backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
          fontSize: '0.72rem', padding: '3px 9px', borderRadius: 12, fontWeight: 600, flexShrink: 0 }}>
          {p.status}
        </span>

        {hasKids ? (
          <button type="button" onClick={() => onToggle(p.id)} aria-hidden="true" tabIndex={-1}
            style={chevronBtn}>
            <span style={{ display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', color: P.mid }}>›</span>
          </button>
        ) : (
          <span style={{ color: P.border, fontSize: '1rem', flexShrink: 0, width: 28, textAlign: 'center' }}>›</span>
        )}
      </div>

      {isOpen && (
        <div role="group" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {plantings.map(pl => <PlantingRow key={pl.id} planting={pl} depth={depth + 1} level={level + 1}
            critters={crittersByPlantId?.get(pl.id) ?? []}
            onSpriteLongPress={onSpriteLongPress}
            onSpriteIntersect={onSpriteIntersect} />)}
          {children.map(c => <TreeNode key={c.project.id} node={c} expanded={expanded} onToggle={onToggle} level={level + 1}
            crittersByPlantId={crittersByPlantId}
            onSpriteLongPress={onSpriteLongPress}
            onSpriteIntersect={onSpriteIntersect} />)}
        </div>
      )}
    </div>
  )
}

// Planting leaf — whole row OPENS (navigates to its owning project, where plantings live).
function PlantingRow({ planting: pl, depth, level, critters = [], onSpriteLongPress = null, onSpriteIntersect = null }) {
  const sc = getStatusColors(pl.status)
  const variety = pl.variety_ref?.name
  return (
    <div role="treeitem" aria-level={level} style={{ paddingLeft: depth * 20, position: 'relative' }}>
      {/* MVP-Critter Session 3: in-tile Stage 2 sprites (per §3.26 IO-gated reveal).
          Rendered as siblings of the Link so they get their own pointer-event surface
          (long-press without triggering nav). Absolute-positioned top-right of the row. */}
      {critters.length > 0 && (
        <div style={{ position: 'absolute', top: 4, right: 6, display: 'flex', gap: 4, zIndex: 5 }}>
          {critters.map(c => (
            <CritterSprite key={c.id} critter={c} onLongPress={onSpriteLongPress} onIntersect={onSpriteIntersect} spriteSize={28} />
          ))}
        </div>
      )}
      <Link to={`/projects/${pl.project_id}`} aria-label={`Open ${pl.name}`} style={{ textDecoration: 'none', display: 'block' }}>
        <div style={{
          backgroundColor: P.cream, border: `1px solid ${P.border}`, borderLeft: `3px solid ${P.greenLight}`,
          borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, minHeight: 44,
        }}>
          {pl.featured_photo_view_url
            ? <img src={pl.featured_photo_view_url} alt="" style={{ ...thumbImg, width: 32, height: 32 }} />
            : <span aria-hidden="true" style={{ fontSize: '1rem', width: 32, textAlign: 'center' }}>🌱</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: P.dark, fontSize: '0.9rem' }}>{pl.name}</span>
              {pl.quantity > 1 && <span style={{ fontSize: '0.76rem', color: P.green, fontWeight: 600 }}>×{formatQty(pl.quantity)}</span>}
              {variety && <span style={{ fontSize: '0.76rem', color: P.mid }}>{variety}</span>}
            </div>
          </div>
          {pl.status && (
            <span style={{ backgroundColor: sc.bg, color: sc.text, border: `1px solid ${sc.border}`,
              fontSize: '0.7rem', padding: '2px 8px', borderRadius: 12, fontWeight: 600, flexShrink: 0 }}>
              {pl.status}
            </span>
          )}
        </div>
      </Link>
    </div>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', backgroundColor: P.cream, position: 'relative' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px', position: 'relative' }}>{children}</div>
    </div>
  )
}
function Spinner() { return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div> }
function ErrMsg({ msg }) { return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div> }

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: '3rem', marginBottom: 12 }}>🌿</div>
      <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>Your garden is empty</p>
      <p style={{ margin: '0 0 24px', color: P.light, fontSize: '0.875rem' }}>
        Start a project, then add plantings to it. Everything you grow lives here.
      </p>
      <Link to="/projects/new" style={btnLink}>Create your first project</Link>
    </div>
  )
}

const thumbWrap = {
  flexShrink: 0, width: 40, height: 40, borderRadius: 8, overflow: 'hidden',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  backgroundColor: P.greenPale, textDecoration: 'none',
}
const thumbImg = { width: 40, height: 40, objectFit: 'cover', display: 'block' }
const bodyBtn = {
  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', minHeight: 44,
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
}
const chevronBtn = {
  flexShrink: 0, width: 36, minHeight: 44, background: 'none', border: 'none',
  cursor: 'pointer', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const btnLink = { backgroundColor: P.green, color: P.white, textDecoration: 'none', borderRadius: 6, padding: '9px 14px', fontSize: '0.85rem', fontWeight: 600 }
const btnGhost = { backgroundColor: P.white, color: P.green, border: `1px solid ${P.greenLight}`, textDecoration: 'none', borderRadius: 6, padding: '8px 13px', fontSize: '0.85rem', fontWeight: 600 }
