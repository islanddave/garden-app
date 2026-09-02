// src/pages/SowNow.jsx — DRG-SOWNOW-001 /sow surface.
// Fetches GET /api/inventory-items/sow-candidates (v_sow_candidates rows), runs them
// through the pure sowEngine bucketizer for today, and renders action-bucket sections
// in fixed order. Actionable cards open a Sheet mini-form that POSTs /api/plants with
// the exact seed-provenance wire shape (source_type 'seed_packet' — dropdownRegistry
// PLANT_SOURCE_OPTIONS seed value). NO quantity decrement (decision: quantity_on_hand
// = packets owned; sowing doesn't consume a packet) — so a packet only reaches zero when
// Dave edits it down, which is what makes zero a trustworthy "used up" signal for the
// V4-SEEDZEROVIEW-001 `sowed_previously` section rather than an artefact of sowing.
import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { bucketize, isInProcess } from '../lib/sowEngine.js'
import { P } from '../lib/tokens.js'
import { formatDate } from '../lib/format.js'
import { useToast } from '../context/ToastContext.jsx'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { setReloadBlocked } from '../lib/reloadGate.js'
import { Sheet, Badge } from '../components/forms'
import PlantingEditor from '../components/PlantingEditor.jsx'

// V4-RELOADGATEWIRE-001 — this page's draft-stash route key.
const DRAFT_KEY = 'sow-now'

// Section order is FIXED per the panel deltas spec. Third element = optional subtitle.
// `sow_next_year` sits below every this-season section but above the non-actionable ones. It is
// DEMOTED (muted heading) but never collapsed: it is actionable and deadline-bearing, and hiding it
// behind a disclosure is exactly how a window closes unseen.
//
// The sow_next_year subtitle read 'Sow these this summer; they flower next spring.' until
// 2026-08-17. It was written when the bucket held four ornamentals (hollyhock, blackberry lily, two
// money plants) and it framed a HORIZON partition as a flower section: the bucket takes anything
// sowGoal() calls establishment, which already includes biennial vegetables and will include hardy
// greens sown for a spring cut. The copy now names both payoffs instead of only the floral one, and
// says plainly what the section is for — that nothing in it feeds you this season.
const BUCKET_META = [
  ['window_closing',     'Window closing'],
  ['start_indoors_now',  'Start indoors now'],
  ['direct_sow_now',     'Direct sow now'],
  ['sow_inside_anytime', 'Sow inside anytime'],
  ['sow_next_year',      'For next year — sow now', 'Sow now, bloom or harvest next spring — nothing here pays off this season.'],
  ['hold',               'Hold for later'],
  // V4-SEEDSAVEFLOW-001. Seed you are still making. Open and mid-page rather than collapsed at the
  // bottom with the other two divert targets, and the difference is what the section MEANS: those
  // are review surfaces for packets that are done with (empty, or put away for the year), this one
  // is forward-looking. Dave wants to keep seeing that the seed exists and is coming while being
  // unable to mis-sow it, and a lot behind a ▸ toggle is not something you can see coming.
  ['in_process',         'Still in process', 'Seed you are saving that is not finished yet. It stays on the list so you can see it coming — but it cannot be sown until it is dry and stored.'],
  ['needs_profile',      'Needs a sow profile'],
  ['too_late',           'Too late this year'],
  // V4-SEEDZEROVIEW-001. The packets there is none of left. Dave: "I want to keep zero counts in our
  // records, viewable as 'sowed previously' so i can review … zero counts can be filtered out of sow
  // now and other used surfaces, but a view/filter of them would be useful." Collapsed and near the
  // bottom because it is a review surface, not a working list — but present, complete, and never a
  // delete or a retire. There is deliberately NO reorder cue here: he said he will not use one.
  ['sowed_previously',   'Sowed previously', 'None of these left. Kept in full so you can see what you have grown and everything about the packet — they just stay off the working list.'],
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
const COLLAPSED = new Set(['too_late', 'sowed_previously', 'archived'])

// Buckets whose cards carry a Sow action.
const ACTIONABLE = new Set(['window_closing', 'start_indoors_now', 'direct_sow_now', 'sow_inside_anytime', 'sow_next_year'])

// V4-SEEDSAVEFLOW-001. Marker copy for a lot that is still being processed, keyed by the DB's own
// seed_stage vocabulary and worded exactly as SavedSeeds' STAGE_META labels the same jar, so the two
// surfaces cannot end up calling it two different things. `stored` has no entry on purpose — a
// stored lot is a packet and gets no marker at all. Exported so the suite can pin that every stage
// sowEngine diverts on has words here: a stage with no label would render a colour-only chip, which
// is exactly the marker nobody who cannot see colour can read.
export const SEED_STAGE_LABEL = { fermenting: 'Fermenting', drying: 'Drying' }

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
  // Which COLLAPSED sections are expanded, keyed by bucket. One Set rather than a boolean per
  // section: V4-SEEDZEROVIEW-001 made this a third disclosure, and a per-key ternary in
  // renderSection is exactly the drift vector the shared COLLAPSED set exists to close.
  const [openSections, setOpenSections] = useState(() => new Set())
  // In-flight archive PATCHes, by inventory_item_id — disables the button so a double-tap on a
  // slow phone connection cannot fire two writes.
  const [archiveBusy, setArchiveBusy] = useState(() => new Set())
  const [projects, setProjects] = useState([])

  // Sheet target — null when closed, else the bucket entry being sown. The sheet hosts the
  // canonical PlantingEditor (add-from-packet), so a sown planting gets a real place + full
  // details and can never land orphaned (BUG-ORPHANNAV-001, the old mini-form's project_id:null).
  const [sowTarget, setSowTarget] = useState(null)
  // V4-BACKNAV-001 Slice P (extended) — the sow sheet closes in place (setSowTarget(null)).
  // V4-PLANTEDITORWIRE-001: mirror of the embedded editor's own clean/dirty state, reported through
  // its `onDirty` prop. This is the ONLY thing this page can know about content typed INSIDE the
  // sheet — `sowTarget` says which packet is being sown, never whether anything has been entered.
  const [editorDirty, setEditorDirty] = useState(false)
  // BUG-DIRTYDISMISSGAP-001 — the editor's in-flight-write signal, which this page alone of the
  // three PlantingEditor hosts never subscribed to (Garden.jsx and PlantingDetail.jsx both did).
  // Without it decideBack's BLOCKED branch could never fire here, so the sow sheet was dismissable
  // mid-POST as well as mid-typing: closing unmounts the editor, so a create that FAILED had nothing
  // left to render its error into and looked exactly like one that succeeded.
  const [editorBusy, setEditorBusy] = useState(false)

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

  // V4-RELOADGATEWIRE-001 — the ONLY local state in this file that represents content the user
  // explicitly typed or picked/overrode is `sowTarget`: which packet's Sow sheet is open, set from
  // either an ordinary Sow tap or the "Sow anyway" engine-override tap on a gated hold. Everything
  // else here is fetched data (candidates/projects), UI view state (disclosure open/closed, archive
  // busy), or a post-save confirmation cache (sownIds) — none of it is unsaved input, and the
  // per-candidate windowLabel/daysLeft annotations are computed by sowEngine and always regenerable
  // from fresh candidates, never something a reload could "lose". PlantingEditor owns its own field
  // state (place/quantity/notes) internally, so this predicate — like the stash and the
  // checked-for-landmine restore below — recovers WHICH packet was mid-sow, not what was typed into
  // the sheet itself.
  //
  // Hoisted to a named value (not inlined per-consumer) for the same reason EventNew's
  // hasUnsavedInput is: it feeds three channels below (draft persist, the overlay-dirty report, the
  // reload gate) and letting them drift to slightly different predicates is how one ends up defended
  // and the others not.
  //
  // V4-PLANTEDITORWIRE-001 — `editorDirty` is deliberately NOT a term here, and the reason is
  // arithmetic rather than taste: PlantingEditor is rendered ONLY inside `{sowTarget && …}` and its
  // unmount releases, so editorDirty ⟹ sowTarget and `dirty || editorDirty` is exactly `dirty`. A
  // term that cannot change the value of the expression it is in cannot be tested, and an untestable
  // OR is how a predicate ends up looking guarded while proving nothing. Nor is the editor's signal
  // used to NARROW this to `sowTarget && editorDirty`: the stash restores the open sheet on a packet
  // the user chose, and that choice is worth holding a deploy for whether or not a field is filled.
  // The place the editor's signal is genuinely load-bearing is the Sheet's backdrop guard below,
  // which is the one discard path on this page that `dirty` never covered.
  const dirty = !!sowTarget

  // Restore a dismissed/reloaded Sow sheet, once candidates have loaded. Gated on `buckets` rather
  // than a bare mount: there is nothing to validate a stashed id against before the fetch resolves.
  // The ref makes this fire exactly once — `buckets` gets a new identity after every archive/
  // un-archive PATCH rewrites `candidates`, and without the guard a later PATCH would re-run this and
  // reopen a sheet the user has since closed.
  //
  // LANDMINE CHECK (V4-RELOADGATEWIRE-001, cf. EventNew's draftRestoredTypeRef): EventNew's restore
  // set form.event_type, which a SEPARATE effect ([form.event_type]) watched and treated as a fresh
  // type change, wiping the very state the restore had just filled — fixed with a one-shot skip ref.
  // No such landmine here — but NOT because there is a single writer: `sowTarget` is also set by
  // openSowSheet (both the Sow and the "Sow anyway" taps), cleared by closeSowSheet, and cleared
  // again on a successful create. What makes the restore safe is that nothing treats a sowTarget
  // CHANGE as a fresh selection to reset from: the only readers are the render below and the two
  // effects immediately following, which key on `dirty`/`sowTarget` to mirror the value outward
  // (stash, overlay-dirty, reload gate) and reset no state of their own.
  const restoredDraftRef = useRef(false)
  useEffect(() => {
    if (restoredDraftRef.current || !buckets) return
    restoredDraftRef.current = true
    const draft = readDraft(DRAFT_KEY)
    if (!draft?.inventoryItemId) return
    // Validated against LIVE data — the same rule LogMany applies to a restored scope. The stashed
    // candidate may no longer resolve (sown/archived/removed elsewhere) or may now sit in a
    // different bucket than when it was stashed; either way the fresh buckets are the source of
    // truth, never the stashed snapshot.
    const entry = Object.values(buckets).flat().find((e) => e.candidate.inventory_item_id === draft.inventoryItemId)
    if (entry) setSowTarget(entry)
  }, [buckets])

  // Persist while the sheet holds a target — for ABNORMAL exits only (see closeSowSheet: an
  // explicit dismissal clears it, unlike EventNew/LogMany).
  //
  // WHAT THIS RECOVERS, PRECISELY: the inventory_item_id, i.e. WHICH packet was mid-sow, and
  // nothing else. It does NOT preserve anything typed or picked inside the sheet — place/project,
  // location, quantity, planting notes, dates — because PlantingEditor owns that state internally.
  // So a mid-sheet SW reload that beats the gate re-opens the right packet on an EMPTY form.
  //
  // V4-PLANTEDITORWIRE-001 did NOT change that, and it is worth being precise about why: `onDirty`
  // reports a BOOLEAN — that unsaved work exists — not the values, so it lets this page DEFEND the
  // fields (backdrop guard below) but still gives it nothing to write down. A stash that claimed to
  // restore a form it cannot read would be worse than one that honestly restores only the target.
  // Widening the payload needs a values-level channel on PlantingEditor, which does not exist.
  useEffect(() => {
    if (!dirty) return
    writeDraft(DRAFT_KEY, { inventoryItemId: sowTarget.candidate.inventory_item_id })
  }, [dirty, sowTarget])

  // Tells the hosting overlay Sheet (if any) not to let a stray backdrop tap silently discard this
  // page while a sow is mid-flight.
  //
  // INERT IN PRODUCTION TODAY — say so plainly rather than let the call site imply a guard that is
  // running. App.jsx registers `/sow` as a plain full-page route with NO `overlayable` flag (unlike
  // /log, /log/many and /put-up), so no OverlayDirtyProvider is ever mounted above this page and
  // this hook reports into nothing. It is kept as forward-compat: it costs nothing, it keeps the
  // page in the standard three-guard shape, and adding `overlayable` later then needs no follow-up
  // here. The guard that actually runs on this surface is the reload gate below. The suite's
  // dirty-channel assertions manufacture their own provider and are labelled forward-compat to
  // match — they pin the contract, they do not evidence a live guard.
  useReportOverlayDirty(dirty)

  // V4-RELOADGATEWIRE-001 — hold the service-worker reload while the Sow sheet is open. This is the
  // guard that actually matters on this full-page-only surface (see the no-op note above). Cleanup
  // releases the key so a closed or unmounted sheet can never wedge updates (BUG-STALECLIENT-001).
  const reloadGateKey = `sow-now:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, dirty)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, dirty])

  const openSowSheet = useCallback((entry) => {
    setSowTarget(entry)
  }, [])

  // V4-RELOADGATEWIRE-001 — the single close path for the Sow sheet: the Sheet's Close control,
  // Escape, an un-dirty backdrop tap, the back gesture, and the editor's own Cancel all land here.
  //
  // CLEARS THE STASH, which is the opposite of what EventNew and LogMany do on a dismiss — and the
  // difference is not an inconsistency, it is the difference between what is being restored. Their
  // drafts refill FIELDS in a form the user is already looking at; this one restores a MODAL'S OPEN
  // STATE. Keeping it through a deliberate Close means the sheet re-opens itself on the next visit
  // to /sow in the same tab, and the next, with no way to stop it short of actually sowing the
  // packet — a dismissal the app refuses to accept. An exit the guards could NOT defer (SW reload,
  // hard refresh, navigating away mid-sheet) never runs this, so the recovery case still works: the
  // stash survives precisely the exits the user did not choose.
  const closeSowSheet = useCallback(() => {
    clearDraft(DRAFT_KEY)
    setSowTarget(null)
    // Cleared here as well as by PlantingEditor's unmount release, which lands a commit later: a
    // stale `true` would leave the NEXT sow sheet undismissable from its first frame — the stuck-busy
    // trap the bounded Back guard exists to survive, reached with no write in flight at all. Same
    // reasoning PlantingDetail.jsx records on its own closeEditor.
    setEditorBusy(false)
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
    // Where the engine had actually put this packet before it was diverted. All three divert targets
    // carry it, under their own key — an archived packet that is ALSO empty reads "From: Sowed
    // previously", which is the honest answer to "why was this on my list?" for that card. On an
    // in-process lot it answers something better: WHEN it would be sowable once it is dry.
    const divertedFrom = bucketKey === 'archived' ? entry.archivedFrom
      : bucketKey === 'sowed_previously' ? entry.depletedFrom
        : bucketKey === 'in_process' ? entry.inProcessFrom
          : null
    // V4-SEEDSAVEFLOW-001. Read off the CANDIDATE, not off bucketKey, so the marker travels with the
    // lot into the archived section too — an archived jar of wet seed is still a jar of wet seed.
    // Falls back rather than rendering an empty chip if a stage ever arrives with no label (pinned
    // by test, but a blank marker on a real surface is worse than a vague one).
    const stageLabel = isInProcess(c)
      ? (SEED_STAGE_LABEL[String(c.seed_stage).trim().toLowerCase()] ?? 'Still in process')
      : null
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
            {/* V4-SEEDSAVEFLOW-001. WORDS carry this, not colour: the chip names the stage the lot
                is actually in and says plainly that it cannot be sown, so it reads the same to
                anyone who cannot see the warn tone at all. The house Badge primitive rather than a
                local span — no new export from components/forms, which the FROZEN-primitives test
                fails on. whiteSpace overridden because Badge is nowrap by default and this string is
                long enough to overflow the title column on a 360px phone. */}
            {stageLabel && (
              <Badge tone="warn" style={{ whiteSpace: 'normal' }}>
                {stageLabel} — not ready to sow
              </Badge>
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
          {/* Where it sat before it was diverted. Answers "why was this on my list?" without making
              Dave put it back to find out. */}
          {divertedFrom && BUCKET_LABEL[divertedFrom] && (
            <div style={gateReasonLine}>From: {BUCKET_LABEL[divertedFrom]}</div>
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
            knows is right. Gated holds keep a secondary path to the same sow sheet.
            V4-SEEDSAVEFLOW-001 EXCEPTION, and it is the one place this page withholds the override
            on purpose: every other divert is a JUDGEMENT the engine made about timing, which Dave
            may know better than. `in_process` is not a judgement, it is a physical fact about the
            seed — it is wet, in a jar, in pulp — and there is no override that makes it sowable
            today. A "Sow anyway" here would offer the exact mis-sow this whole guard exists to
            prevent. The lot is still fully on the page and still one tap from Inventory. */}
        {!ACTIONABLE.has(bucketKey) && bucketKey !== 'in_process' && entry.gated && (
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
        {/* V4-SEEDZEROVIEW-001. The point of this section is review — "so i can review … all the
            details even if zero" — and the card alone carries only what the sow engine needed. Same
            navigation the needs_profile card already uses, so the packet's full record is one tap
            from here rather than a search through Inventory. */}
        {bucketKey === 'sowed_previously' && (
          <button
            type="button"
            onClick={() => navigate(`/inventory/${c.inventory_item_id}`)}
            aria-label={`View details for ${title}`}
            style={profileBtn}
          >
            Details
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

    // too_late, sowed_previously and archived share one disclosure: all three are "off the working
    // list but still on the page". Generalised rather than copied so they cannot drift apart
    // visually.
    if (COLLAPSED.has(key)) {
      const open = openSections.has(key)
      const toggle = () => setOpenSections((prev) => {
        const next = new Set(prev)
        if (!next.delete(key)) next.add(key)
        return next
      })
      return (
        <section key={key} style={{ marginBottom: 20 }}>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            style={disclosureBtn}
          >
            <span style={{ fontSize: '0.8rem' }}>{open ? '▾' : '▸'}</span>
            {label}
            <span style={countBadge}>{entries.length}</span>
          </button>
          {/* Subtitle rides inside the disclosure, not above it: a collapsed section is one line by
              design, and an explanation nobody has opened the section to read is just noise on it. */}
          {open && subtitle && <p style={sectionSubtitle}>{subtitle}</p>}
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
        armsBack
        open={!!sowTarget}
        onClose={closeSowSheet}
        // V4-PLANTEDITORWIRE-001 — the guard the reload gate above could not give this page. A
        // backdrop tap is the one exit that is neither deliberate nor deferrable: Sheet no-ops it
        // while dirty (Sheet.jsx §5.2) and leaves Escape and the labelled Close live, which is
        // exactly right here — a stray tap beside a half-filled sow form must not discard it, but a
        // user who means to leave still has two ways out and needs no confirm dialog to use them.
        // Gated on the EDITOR's signal, not on `dirty` (= sheet-open): passing sheet-open would make
        // the backdrop inert for every sow, including the far more common one where the sheet was
        // opened by mistake and holds nothing.
        dirty={editorDirty}
        // BUG-DIRTYDISMISSGAP-001 — this was the app's genuinely UNGUARDED editor surface, and the
        // worst-exposed of the three hosts. closeSowSheet clears the stash as its FIRST act, so an
        // unconfirmed dismiss destroyed both the typed fields and the {inventoryItemId} crumb that
        // would have said which packet was mid-sow (see the stash note at the top of this file).
        // Net recovery was zero. Escape and Android Back now raise the registry's ConfirmSheet.
        confirmOnDirty
        confirmTitle="Discard this sowing?"
        confirmBody="This packet has not been sown yet. What you typed will be lost, and the sheet will not reopen on this packet."
        // The in-flight-write half of the same gap — see the editorBusy declaration above.
        busy={editorBusy}
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
                closeSowSheet()
              }}
              onClose={closeSowSheet}
              // V4-PLANTEDITORWIRE-001. The setter itself, not an inline arrow — PlantingEditor
              // keeps `onDirty` behind a ref so an unstable prop cannot fire a spurious release,
              // and a stable identity means this page never has to rely on that.
              onDirty={setEditorDirty}
              // Same contract, same reasoning — feeds <Sheet busy> above.
              onBusy={setEditorBusy}
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
