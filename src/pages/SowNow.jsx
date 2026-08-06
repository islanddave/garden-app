// src/pages/SowNow.jsx — DRG-SOWNOW-001 /sow surface.
// Fetches GET /api/inventory-items/sow-candidates (v_sow_candidates rows), runs them
// through the pure sowEngine bucketizer for today, and renders action-bucket sections
// in fixed order. Actionable cards open a Sheet mini-form that POSTs /api/plants with
// the exact seed-provenance wire shape (source_type 'seed_packet' — dropdownRegistry
// PLANT_SOURCE_OPTIONS seed value). NO quantity decrement (decision: quantity_on_hand
// = packets owned; sowing doesn't consume a packet).
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { bucketize } from '../lib/sowEngine.js'
import { P } from '../lib/tokens.js'
import { formatDate } from '../lib/format.js'
import { useToast } from '../context/ToastContext.jsx'
import { Sheet } from '../components/forms'
import PlantingEditor from '../components/PlantingEditor.jsx'
import { useBackDismiss } from '../hooks/useBackDismiss.js'

// Section order is FIXED per the panel deltas spec. Third element = optional subtitle.
// `sow_next_year` sits below every this-season section but above the non-actionable ones. It is
// DEMOTED (muted heading) but never collapsed: it is actionable and deadline-bearing, and hiding it
// behind a disclosure is exactly how a window closes unseen.
const BUCKET_META = [
  ['window_closing',     'Window closing'],
  ['start_indoors_now',  'Start indoors now'],
  ['direct_sow_now',     'Direct sow now'],
  ['sow_inside_anytime', 'Sow inside anytime'],
  ['sow_next_year',      'For next year — sow now', 'Sow these this summer; they flower next spring.'],
  ['hold',               'Hold for later'],
  ['needs_profile',      'Needs a sow profile'],
  ['too_late',           'Too late this year'],
  // V4-SOWARCHIVE-001. Dead last and collapsed, like too_late: the whole point is to get these off
  // the working list. They are still ON the page and one tap from returning — archiving is a view
  // preference, not a delete, so it must never look like the packet is gone.
  ['archived',           'Archived for this season'],
]

// Heading text by bucket key, for the archived card's "From: …" provenance line.
const BUCKET_LABEL = Object.fromEntries(BUCKET_META.map(([k, label]) => [k, label]))

// Sections rendered with the demoted (muted) heading treatment.
const DEMOTED = new Set(['sow_next_year'])

// Sections rendered as a collapsed disclosure at the bottom rather than an open list.
const COLLAPSED = new Set(['too_late', 'archived'])

// Buckets whose cards carry a Sow action.
const ACTIONABLE = new Set(['window_closing', 'start_indoors_now', 'direct_sow_now', 'sow_inside_anytime', 'sow_next_year'])

// Unicode vulgar fractions for the common seed depths (text, not emoji).
const FRACTIONS = { 0.125: '⅛', 0.25: '¼', 0.5: '½', 0.75: '¾' }

function formatInches(n) {
  const whole = Math.floor(n)
  const frac = Math.round((n - whole) * 1000) / 1000
  const glyph = FRACTIONS[frac]
  if (glyph) return `${whole > 0 ? whole : ''}${glyph}`
  return String(n)
}

// Depth/spacing line, e.g. 'Sow ¼ in deep · 6 in apart'. Numeric view columns may
// arrive as strings (neon driver) — Number()-coerce before formatting.
function depthSpacingLine(candidate) {
  const depth = Number(candidate.sow_depth_in)
  const spacing = Number(candidate.seed_spacing_in)
  const hasDepth = candidate.sow_depth_in != null && candidate.sow_depth_in !== '' && Number.isFinite(depth)
  const hasSpacing = candidate.seed_spacing_in != null && candidate.seed_spacing_in !== '' && Number.isFinite(spacing)
  const parts = []
  if (hasDepth) parts.push(`Sow ${formatInches(depth)} in deep`)
  if (hasSpacing) parts.push(`${formatInches(spacing)} in apart`)
  return parts.length ? parts.join(' · ') : null
}

function localTodayISO() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function SowNow({ todayISO = localTodayISO() }) {
  const navigate = useNavigate()
  const { fetch } = useApiFetch()
  const { show } = useToast()

  const [candidates, setCandidates] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sownIds, setSownIds] = useState(() => new Set())
  const [tooLateOpen, setTooLateOpen] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  // In-flight archive PATCHes, by inventory_item_id — disables the button so a double-tap on a
  // slow phone connection cannot fire two writes.
  const [archiveBusy, setArchiveBusy] = useState(() => new Set())
  const [projects, setProjects] = useState([])

  // Sheet target — null when closed, else the bucket entry being sown. The sheet hosts the
  // canonical PlantingEditor (add-from-packet), so a sown planting gets a real place + full
  // details and can never land orphaned (BUG-ORPHANNAV-001, the old mini-form's project_id:null).
  const [sowTarget, setSowTarget] = useState(null)
  // V4-BACKNAV-001 Slice P (extended) — the sow sheet closes in place (setSowTarget(null)).
  useBackDismiss({ open: !!sowTarget, onDismiss: () => setSowTarget(null), id: 'sownow-sow' })

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fetch('/api/inventory-items/sow-candidates')
      .then((data) => {
        if (!alive) return
        setCandidates(Array.isArray(data?.items) ? data.items : [])
      })
      .catch((err) => {
        if (!alive) return
        setError(err?.message ?? 'Failed to load sow candidates')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fetch])

  // Projects for the embedded PlantingEditor's place picker.
  useEffect(() => {
    let alive = true
    fetch('/api/projects')
      .then((data) => { if (alive) setProjects(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) setProjects([]) })
    return () => { alive = false }
  }, [fetch])

  const buckets = useMemo(
    () => (candidates ? bucketize(candidates, todayISO) : null),
    [candidates, todayISO]
  )

  const openSowSheet = useCallback((entry) => {
    setSowTarget(entry)
  }, [])

  // V4-SOWARCHIVE-001. Archive/un-archive a packet for THIS season.
  //
  // The season is taken from todayISO rather than from a fresh Date, so the stamp we write is the
  // exact year the engine is bucketing against (bucketize derives its year the same way). A packet
  // archived at 11:59pm on 31 Dec is stamped with the year Dave was actually looking at.
  //
  // Written OPTIMISTICALLY into `candidates` — not into a side Set — so the single useMemo
  // re-bucketizes from one source of truth and the archived section cannot disagree with the active
  // ones. On failure the previous value is restored, because a card that silently stays put after a
  // tap reads as an unresponsive button rather than as a failed write.
  const setArchived = useCallback(async (candidate, archived) => {
    const id = candidate.inventory_item_id
    const season = Number(todayISO.slice(0, 4))
    const prevSeason = candidate.sow_archived_season ?? null
    const nextSeason = archived ? season : null

    setArchiveBusy((b) => new Set(b).add(id))
    setCandidates((prev) => prev?.map((c) => (
      c.inventory_item_id === id ? { ...c, sow_archived_season: nextSeason } : c
    )) ?? prev)

    try {
      await fetch(`/api/inventory-items/${id}/sow-archive`, {
        method: 'PATCH',
        body: JSON.stringify(archived ? { archived: true, season } : { archived: false }),
      })
      // Deliberately NOT the section heading's own words: the toast says where the card WENT,
      // which is the thing that isn't obvious the first time a card disappears from under your
      // thumb. (It also kept colliding with the heading in the DOM.)
      show({ message: archived ? 'Archived — moved to the bottom' : 'Back on the list' })
    } catch (err) {
      setCandidates((prev) => prev?.map((c) => (
        c.inventory_item_id === id ? { ...c, sow_archived_season: prevSeason } : c
      )) ?? prev)
      show({ message: archived ? "Couldn't archive that" : "Couldn't un-archive that" })
    } finally {
      setArchiveBusy((b) => { const n = new Set(b); n.delete(id); return n })
    }
  }, [fetch, show, todayISO])

  function renderCard(entry, bucketKey) {
    const c = entry.candidate
    const title = c.variety_name || c.item_name
    const line = depthSpacingLine(c)
    const sown = sownIds.has(c.inventory_item_id)
    const busy = archiveBusy.has(c.inventory_item_id)
    return (
      <div key={c.inventory_item_id} style={cardStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, color: P.dark, fontSize: '0.95rem' }}>{title}</span>
            {entry.daysLeft != null && (
              <span style={daysLeftBadge}>{entry.daysLeft} days left</span>
            )}
            {entry.reopensOn && (
              <span style={reopensBadge}>opens ~{formatDate(entry.reopensOn)}</span>
            )}
          </div>
          {c.variety_name && c.item_name && c.item_name !== c.variety_name && (
            <div style={{ fontSize: '0.74rem', color: P.light, marginTop: 2 }}>{c.item_name}</div>
          )}
          {entry.windowLabel && (
            <div style={{ fontSize: '0.82rem', color: P.mid, marginTop: 4 }}>{entry.windowLabel}</div>
          )}
          {line && (
            <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 3 }}>{line}</div>
          )}
          {/* Why this one is being held. Gated alliums land in `hold` alongside ordinary holds, so
              the section heading cannot explain them — the reason has to ride on the card. */}
          {entry.gateReason && (
            <div style={gateReasonLine}>{entry.gateReason}</div>
          )}
          {/* Where it sat before it was archived. Answers "why was this on my list?" without making
              Dave un-archive it to find out. */}
          {bucketKey === 'archived' && entry.archivedFrom && BUCKET_LABEL[entry.archivedFrom] && (
            <div style={gateReasonLine}>From: {BUCKET_LABEL[entry.archivedFrom]}</div>
          )}
        </div>
        <div style={cardActions}>
        {ACTIONABLE.has(bucketKey) && (
          sown ? (
            <span style={sownChip} role="status">Sown &#10003;</span>
          ) : (
            <button
              type="button"
              onClick={() => openSowSheet(entry)}
              aria-label={`Sow ${title}`}
              style={sowBtn}
            >
              Sow
            </button>
          )
        )}
        {/* Override: an engine misclassification must never hard-block an action the gardener
            knows is right. Gated holds keep a secondary path to the same sow sheet. */}
        {!ACTIONABLE.has(bucketKey) && entry.gated && (
          sown ? (
            <span style={sownChip} role="status">Sown &#10003;</span>
          ) : (
            <button
              type="button"
              onClick={() => openSowSheet(entry)}
              aria-label={`Sow ${title} anyway`}
              style={profileBtn}
            >
              Sow anyway
            </button>
          )
        )}
        {bucketKey === 'needs_profile' && (
          <button
            type="button"
            onClick={() => navigate(`/inventory/${c.inventory_item_id}`)}
            aria-label={`Add sow details for ${title}`}
            style={profileBtn}
          >
            Add sow details
          </button>
        )}
        {/* V4-SOWARCHIVE-001. Offered on EVERY bucket rather than a curated subset: the reason a
            packet is not wanted on the list ("already sown all I'm going to") is Dave's, not the
            engine's, so any card can be the one he wants gone. The archived section offers the
            inverse. aria-label carries the packet name — 'Archive' alone is ambiguous in a list. */}
        <button
          type="button"
          onClick={() => setArchived(c, bucketKey !== 'archived')}
          disabled={busy}
          aria-label={bucketKey === 'archived' ? `Un-archive ${title}` : `Archive ${title} for this season`}
          style={busy ? { ...archiveBtn, opacity: 0.5 } : archiveBtn}
        >
          {bucketKey === 'archived' ? 'Un-archive' : 'Archive'}
        </button>
        </div>
      </div>
    )
  }

  function renderSection(key, label, subtitle) {
    const entries = buckets[key]
    if (!entries || entries.length === 0) return null // collapsed when empty

    // too_late and archived share one disclosure: both are "off the working list but still on the
    // page". Generalised rather than copied so the two cannot drift apart visually.
    if (COLLAPSED.has(key)) {
      const open = key === 'archived' ? archivedOpen : tooLateOpen
      const toggle = key === 'archived' ? setArchivedOpen : setTooLateOpen
      return (
        <section key={key} style={{ marginBottom: 20 }}>
          <button
            type="button"
            onClick={() => toggle((o) => !o)}
            aria-expanded={open}
            style={disclosureBtn}
          >
            <span style={{ fontSize: '0.8rem' }}>{open ? '▾' : '▸'}</span>
            {label}
            <span style={countBadge}>{entries.length}</span>
          </button>
          {open && (
            <div style={sectionList}>{entries.map((e) => renderCard(e, key))}</div>
          )}
        </section>
      )
    }

    return (
      <section key={key} style={{ marginBottom: 20 }}>
        <h2 style={DEMOTED.has(key) ? demotedSectionHeading : sectionHeading}>
          {label}
          <span style={countBadge}>{entries.length}</span>
        </h2>
        {subtitle && <p style={sectionSubtitle}>{subtitle}</p>}
        <div style={sectionList}>{entries.map((e) => renderCard(e, key))}</div>
      </section>
    )
  }

  const totalCount = candidates?.length ?? 0

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px 80px' }}>

        {/* Breadcrumb */}
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          <Link to="/inventory" style={{ color: P.green, textDecoration: 'none' }}>Inventory</Link>
          {' › Sow now'}
        </div>

        <h1 style={{ margin: '0 0 20px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          What can I sow now?
        </h1>

        {loading && (
          <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading&hellip;</div>
        )}

        {!loading && error && (
          <div role="alert" style={errorBanner}>{error}</div>
        )}

        {!loading && !error && totalCount === 0 && (
          <div style={emptyState}>
            <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
              No seed packets yet
            </p>
            <p style={{ margin: '0 0 20px', color: P.light, fontSize: '0.875rem' }}>
              Add seed packets to your inventory and this page will tell you what to sow when.
            </p>
            <Link to="/inventory/add-seeds" style={ctaLink}>Add seeds</Link>
          </div>
        )}

        {!loading && !error && buckets && totalCount > 0 && (
          BUCKET_META.map(([key, label, subtitle]) => renderSection(key, label, subtitle))
        )}
      </div>

      {/* Sow sheet — hosts the canonical PlantingEditor (add-from-packet): required place
          picker + location + full details, pre-seeded seed/today/seed_packet. Orphan-safe. */}
      <Sheet
        open={!!sowTarget}
        onClose={() => setSowTarget(null)}
        title={sowTarget ? `Sow ${sowTarget.candidate.variety_name || sowTarget.candidate.item_name}` : undefined}
      >
        {sowTarget && (
          <div style={{ padding: '0 16px 4px' }}>
            <PlantingEditor
              mode="add"
              fetch={fetch}
              projects={projects.filter((p) => !p.archived_at)}
              sourceInventoryItemId={sowTarget.candidate.inventory_item_id}
              varietyId={sowTarget.candidate.variety_id}
              addDefaults={{ status: 'seed', sown_at: todayISO, source_type: 'seed_packet' }}
              onCreated={() => {
                setSownIds((prev) => new Set(prev).add(sowTarget.candidate.inventory_item_id))
                show({ message: 'Planted!' })
                setSowTarget(null)
              }}
              onClose={() => setSowTarget(null)}
            />
          </div>
        )}
      </Sheet>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const sectionHeading = {
  margin: '0 0 10px',
  fontSize: '0.85rem',
  fontWeight: 700,
  color: P.greenLight,
  letterSpacing: '0.6px',
  textTransform: 'uppercase',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

// Demoted heading for next-year work: visually subordinate to this-season sections, still a real
// heading (P.mid on P.cream clears 4.5:1 — same pairing the too_late disclosure already ships).
const demotedSectionHeading = { ...sectionHeading, color: P.mid }

const sectionSubtitle = {
  margin: '-4px 0 10px',
  fontSize: '0.78rem',
  color: P.light,
}

const gateReasonLine = {
  fontSize: '0.78rem',
  color: P.mid,
  marginTop: 5,
  lineHeight: 1.4,
}

const countBadge = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 22,
  padding: '1px 7px',
  borderRadius: 999,
  backgroundColor: P.greenPale,
  color: P.green,
  fontSize: '0.72rem',
  fontWeight: 700,
}

const disclosureBtn = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.85rem',
  fontWeight: 700,
  color: P.mid,
  letterSpacing: '0.6px',
  textTransform: 'uppercase',
  minHeight: 44,
}

const sectionList = { display: 'flex', flexDirection: 'column', gap: 8 }

const cardStyle = {
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: 10,
  padding: '14px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

// Action column. Wraps rather than overflows: a card can carry two buttons (Sow + Archive, or
// Add sow details + Archive) and the narrowest phone Dave uses is 360px, where three side-by-side
// controls plus the title would squeeze the name to nothing.
const cardActions = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  flexWrap: 'wrap',
  flexShrink: 0,
}

// Deliberately the quietest control on the card — archiving is housekeeping, not the primary
// action, and it must never compete with Sow. Text-only, but still a 44px touch target.
const archiveBtn = {
  backgroundColor: 'transparent',
  color: P.mid,
  border: 'none',
  borderRadius: 8,
  padding: '9px 10px',
  fontSize: '0.8rem',
  fontWeight: 600,
  cursor: 'pointer',
  minHeight: 44,
  flexShrink: 0,
  textDecoration: 'underline',
}

const daysLeftBadge = {
  fontSize: '0.72rem',
  fontWeight: 700,
  color: P.terra,
  backgroundColor: P.alert,
  border: `1px solid ${P.alertBorder}`,
  borderRadius: 10,
  padding: '2px 8px',
  flexShrink: 0,
}

const reopensBadge = {
  fontSize: '0.72rem',
  fontWeight: 600,
  color: P.mid,
  backgroundColor: P.cream,
  border: `1px solid ${P.border}`,
  borderRadius: 10,
  padding: '2px 8px',
  flexShrink: 0,
}

const sowBtn = {
  backgroundColor: P.green,
  color: P.white,
  border: 'none',
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: '0.88rem',
  fontWeight: 700,
  cursor: 'pointer',
  minHeight: 44,
  flexShrink: 0,
}

const profileBtn = {
  backgroundColor: 'transparent',
  color: P.green,
  border: `1px solid ${P.green}`,
  borderRadius: 8,
  padding: '9px 14px',
  fontSize: '0.82rem',
  fontWeight: 600,
  cursor: 'pointer',
  minHeight: 44,
  flexShrink: 0,
}

const sownChip = {
  fontSize: '0.82rem',
  fontWeight: 700,
  color: P.green,
  backgroundColor: P.greenPale,
  borderRadius: 999,
  padding: '6px 14px',
  flexShrink: 0,
}

const errorBanner = {
  backgroundColor: P.alert,
  border: `1px solid ${P.alertBorder}`,
  borderRadius: 8,
  padding: '12px 16px',
  fontSize: '0.875rem',
  color: P.terra,
}

const emptyState = {
  textAlign: 'center',
  padding: '52px 20px',
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: 8,
}

const ctaLink = {
  display: 'inline-flex',
  alignItems: 'center',
  backgroundColor: P.terra,
  color: P.white,
  textDecoration: 'none',
  borderRadius: 8,
  padding: '10px 20px',
  fontSize: '0.9rem',
  fontWeight: 700,
  minHeight: 44,
}
