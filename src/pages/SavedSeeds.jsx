// src/pages/SavedSeeds.jsx — V4-SEEDSAVEFLOW-001 (BD-071) /seeds/saved surface.
//
// WHY THIS PAGE EXISTS. There was no seed-saving flow. `seed_saved` is a valid event type with a
// label and an icon, but it is not in PRIMARY_EVENT_TYPES, so its only route was the collapsed
// "More event types" disclosure filed under the category "Harvest". Dave went looking for it and
// could not find it; prod has ZERO seed_saved events ever logged, for any crop. This page is the
// door, and the stage list is what makes it worth walking through.
//
// THE QUESTION IT ANSWERS is not "what seed do I have" — Inventory already answers that. It is
// "what is in flight right now, and when did I last touch it": a jar fermenting on the counter and
// a screen of seed drying in the shed are both time-sensitive and both invisible everywhere else in
// the app. So the list is grouped BY STAGE in process order, and every card leads with elapsed time
// rather than a date, because "4 days" is the number that decides whether to go and check it.
//
// BACKDATING IS FIRST-CLASS, NOT A CONVENIENCE. The founding case is retroactive: the 1884 tomato
// lot fermented and went out to dry before any of this shipped. A stage history that could only be
// written in the present tense could not record what actually happened, so the advance form carries
// a date field seeded to today and the Lambda accepts entered_at.
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { P } from '../lib/tokens.js'
import { useToast } from '../context/ToastContext.jsx'
import { Sheet, PlantingSelect } from '../components/forms'
import Icon from '../components/Icon.jsx'
import Spinner from '../components/forms/Spinner.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'

// Process order, and it is an ORDER not a set: "advance" means one step right, and `stored` is
// terminal. Kept in one place so the section list, the next-stage arrow and the advance button copy
// can never disagree about what follows what.
const STAGES = ['fermenting', 'drying', 'stored']
const STAGE_META = {
  fermenting: { label: 'Fermenting', sub: 'Wet-process seed sitting in its own juice' },
  drying:     { label: 'Drying',     sub: 'Spread out to dry — screens, plates, a dehydrator' },
  stored:     { label: 'Stored',     sub: 'Dry, packeted and put away' },
}
const nextStage = (s) => STAGES[STAGES.indexOf(s) + 1] ?? null

// V4-SEEDLINK-001. Byte-identical to PlantingSelect's own unscoped self-fetch path, deliberately:
// dataCache keys on the path, so the name lookup below and the picker inside the advance sheet
// share ONE warm entry instead of each paying a round trip.
const PICKER_PATH = '/api/plants?view=picker'

// Elapsed whole days, floor. Same-day reads "today" rather than "0 days", because 0 of anything
// looks like missing data.
function elapsed(iso) {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  const days = Math.floor((Date.now() - then.getTime()) / 86400000)
  if (days <= 0) return 'today'
  return days === 1 ? '1 day' : `${days} days`
}

export default function SavedSeeds() {
  const { fetch } = useApiFetch()
  const { show } = useToast()

  const [items, setItems]     = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [advancing, setAdvancing] = useState(null)   // the lot whose advance sheet is open
  const [starting, setStarting]   = useState(false)  // the "track a lot" picker sheet
  const [busy, setBusy]       = useState(false)
  const [when, setWhen]       = useState(todayLocalISO())
  const [note, setNote]       = useState('')
  // V4-SEEDLINK-001 — the parent plant chosen inside the advance sheet, for a lot that has none.
  // '' is "not chosen"; the field is optional and a lot can always be linked later from
  // /inventory/:id, which is the canonical editor for this column.
  const [stagePlant, setStagePlant] = useState('')
  const [stagePlantFailed, setStagePlantFailed] = useState(false)

  const load = useCallback(() => {
    setLoadErr(null)
    // ?category=seeds is a server-side filter (V4-TREATLOG-001), so the 260-row seed set arrives
    // without the rest of inventory. seed_stage / seed_process ride along on `i.*`.
    fetch('/api/inventory-items?category=seeds')
      .then((rows) => setItems(Array.isArray(rows) ? rows : []))
      .catch((e) => setLoadErr(e?.message ?? 'Could not load your seed inventory.'))
  }, [fetch])

  useEffect(() => { load() }, [load])

  // Tracked = has a stage. Everything else is ordinary bought seed and belongs on Inventory, not
  // here: showing all 260 packets would bury the four things actually in flight.
  const tracked = useMemo(
    () => (items ?? []).filter((i) => STAGES.includes(i.seed_stage)),
    [items],
  )
  const untracked = useMemo(
    () => (items ?? []).filter((i) => !STAGES.includes(i.seed_stage)),
    [items],
  )
  // V4-SEEDLINK-001 — parent-plant NAMES for the cards. The list endpoint returns source_plant_id
  // (a uuid) and nothing else about the parent, so the name is resolved from the picker projection.
  // GATED on a lot actually carrying a link: with none — which is every lot today — the hook sits
  // in its IDLE mode and no request goes out at all. When one does exist the entry is the same one
  // the sheet's picker uses, so the second reader is free.
  const anyLinked = useMemo(() => (items ?? []).some((i) => i.source_plant_id), [items])
  const plantCache = useCachedFetch(anyLinked ? PICKER_PATH : null)
  const plantNameById = useMemo(() => {
    const rows = Array.isArray(plantCache.data) ? plantCache.data : []
    return new Map(rows.map((p) => [String(p.id), p.name || p.variety_ref?.name || '']))
  }, [plantCache.data])

  const byStage = useMemo(() => {
    const m = Object.fromEntries(STAGES.map((s) => [s, []]))
    for (const i of tracked) m[i.seed_stage].push(i)
    // Oldest first inside a stage: the lot that has sat longest is the one to check.
    for (const s of STAGES) m[s].sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
    return m
  }, [tracked])

  const openAdvance = (item, toStage) => {
    setAdvancing({ item, toStage })
    setWhen(todayLocalISO())
    setNote('')
    setStagePlant('')
    setStagePlantFailed(false)
  }

  async function submitStage() {
    if (!advancing) return
    setBusy(true)
    try {
      await fetch(`/api/inventory-items/${advancing.item.id}/seed-stage`, {
        method: 'POST',
        body: JSON.stringify({
          stage: advancing.toStage,
          // Date-only in, timestamptz out. Sent as a local-noon instant so a date typed on a phone
          // in Eastern does not land on the previous day in UTC — the same off-by-one that backdated
          // events elsewhere in this app.
          entered_at: `${when}T12:00:00`,
          note: note.trim() || undefined,
        }),
      })
      // V4-SEEDLINK-001 — provenance rides along, but as its OWN request with its OWN failure.
      // These are independent facts: a lot that moved to drying moved whether or not we also
      // learned which plant it came from. Folding the link failure into the stage failure would
      // report a write that succeeded as failed, and both halves are re-doable from /inventory/:id.
      // Second, not first: the stage move is the action this sheet is titled for.
      let linkErr = null
      if (stagePlant) {
        try {
          await fetch(`/api/inventory-items/${advancing.item.id}/source-plant`, {
            method: 'PATCH',
            body: JSON.stringify({ source_plant_id: stagePlant }),
          })
        } catch (e) {
          linkErr = e?.message ?? 'Stage saved, but the parent plant did not.'
        }
      }
      show({ message: linkErr ?? `✓ Moved to ${STAGE_META[advancing.toStage].label.toLowerCase()}` })
      setAdvancing(null)
      load()
    } catch (e) {
      show({ message: e?.message ?? 'Could not save that.' })
    } finally {
      setBusy(false)
    }
  }

  if (items === null && !loadErr) return <Shell><Spinner block /></Shell>
  if (loadErr) return <Shell><p style={{ color: P.mid }}>{loadErr}</p></Shell>

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700, flex: 1 }}>
          Saved seeds
        </h1>
        <Link to="/sow" style={{ color: P.green, fontSize: '0.85rem' }}>Sow now →</Link>
      </div>
      <p style={{ margin: '0 0 20px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
        Seed you saved yourself, and where each lot has got to.
      </p>

      {tracked.length === 0 && (
        // The empty state does the teaching, because on the day this ships EVERY visit is empty —
        // there are no tracked lots and no seed_saved events anywhere in the app. An empty page with
        // a bare "nothing here" would send Dave straight back out again.
        <div data-testid="saved-seeds-empty" style={emptyStyle}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, color: P.green }}>Nothing in flight yet.</p>
          <p style={{ margin: '0 0 14px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.55 }}>
            When you save seed from a plant, track it here and this page will tell you what is
            fermenting, what is drying, and how long it has been that way.
          </p>
          {/* V4-SEEDLINK-001 rewrote this paragraph. It used to send the user to log a
              "Seed saved" EVENT on the planting — a dead end: that event type has never been
              logged once in the app's history, has no side effect of any kind, and could not point
              at a seed lot even if it had (event_log's only FK to inventory_items means "the
              product I sprayed"). Provenance now has a real column and a real control, so the copy
              points at it. Leaving the old sentence standing would be worse than never having
              written it. */}
          <p style={{ margin: 0, color: P.light, fontSize: '0.8rem', lineHeight: 1.5 }}>
            Provenance — which plant a lot came from — is recorded on the packet itself: open it
            from <Link to="/inventory" style={{ color: P.green }}>Inventory</Link> and use{' '}
            <strong>Saved from</strong>. This page tracks the lot itself.
          </p>
        </div>
      )}

      {STAGES.map((s) => {
        const list = byStage[s]
        if (!list.length) return null
        return (
          <section key={s} data-testid={`stage-section-${s}`} style={{ marginBottom: 22 }}>
            <h2 style={sectionHeadStyle}>{STAGE_META[s].label}</h2>
            <p style={sectionSubStyle}>{STAGE_META[s].sub}</p>
            {list.map((item) => {
              const to = nextStage(item.seed_stage)
              return (
                <div key={item.id} data-testid="seed-lot-card" style={cardStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link to={`/inventory/${item.id}`} style={{ color: P.green, fontWeight: 600, textDecoration: 'none' }}>
                      {item.variety_name || item.name}
                    </Link>
                    <div style={{ color: P.light, fontSize: '0.78rem', marginTop: 3 }}>
                      {elapsed(item.updated_at)} in {STAGE_META[s].label.toLowerCase()}
                      {item.seed_process ? ` · ${item.seed_process} process` : ''}
                    </div>
                    {/* V4-SEEDLINK-001 — the parent, retroactively. Two states and no third: the
                        name when it is known, and a way in when it is not. Rendered only once the
                        name RESOLVES rather than falling back to "a plant" — a row that names
                        nothing is worse than no row, and the lookup is a cache read that lands in
                        the same paint on a warm entry. Setting it happens on /inventory/:id rather
                        than in a fourth sheet here: that page owns this column, is one tap away,
                        and is the only surface that reaches an UNTRACKED lot (which is every lot
                        that never gets a stage). */}
                    {item.source_plant_id
                      ? (plantNameById.get(String(item.source_plant_id)) && (
                          <div data-testid="lot-source-plant" style={{ color: P.light, fontSize: '0.78rem', marginTop: 2 }}>
                            Saved from {plantNameById.get(String(item.source_plant_id))}
                          </div>
                        ))
                      : (
                        <Link
                          to={`/inventory/${item.id}`}
                          data-testid="set-source-plant"
                          style={{ display: 'inline-block', marginTop: 4, color: P.green, fontSize: '0.78rem' }}
                        >
                          Set parent plant →
                        </Link>
                      )}
                  </div>
                  {to && (
                    <button
                      type="button"
                      data-testid="advance-stage"
                      onClick={() => openAdvance(item, to)}
                      style={advanceBtnStyle}
                    >
                      {STAGE_META[to].label} →
                    </button>
                  )}
                </div>
              )
            })}
          </section>
        )
      })}

      {/* Start tracking. Deliberately at the BOTTOM and deliberately not a floating button: it is
          the once-per-lot action, while advancing is the repeated one, and the page's job on a
          normal visit is to answer "what needs checking" rather than to invite data entry. */}
      <button type="button" data-testid="track-a-lot" onClick={() => setStarting(true)} style={trackBtnStyle}>
        <Icon name="event.seed_saved" size={20} decorative /> Track a saved-seed lot
      </button>

      {/* `busy` below is Sheet's OWN prop, not a hand-rolled guard on onClose. DismissRegistry owns
          outside-click, Escape and Android Back for every layer in this app; re-implementing a
          piece of that here would be a second, disagreeing answer to the same question. */}
      {advancing && (
        <Sheet open busy={busy} onClose={() => setAdvancing(null)} title={`Move to ${STAGE_META[advancing.toStage].label.toLowerCase()}`}>
          <p style={{ margin: '0 0 14px', color: P.mid, fontSize: '0.86rem' }}>
            {advancing.item.variety_name || advancing.item.name}
          </p>
          <label style={fieldLabelStyle}>
            When
            <input
              type="date" value={when} onChange={(e) => setWhen(e.target.value)}
              data-testid="stage-date" style={inputStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            Note <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>
            <input
              type="text" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Dehydrator on low, 95°F" data-testid="stage-note" style={inputStyle}
            />
          </label>
          {/* V4-SEEDLINK-001 — capture the parent at the moment Dave is actually holding the seed.
              Shown ONLY while the lot has none: once it is recorded this sheet has nothing to ask,
              and re-offering the field here would make the advance form the place provenance gets
              edited, which it is not — /inventory/:id is. Optional throughout; a lot with no
              remembered parent moves stages exactly as before. */}
          {advancing.item.source_plant_id == null && (
            <div data-testid="stage-source-plant" style={{ marginBottom: 14 }}>
              <div style={fieldLabelStyle}>
                Saved from <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>
              </div>
              <PlantingSelect
                id="ss-source-plant"
                value={stagePlant}
                onChange={(pid) => setStagePlant(pid || '')}
                varietyId={advancing.item.variety_id}
                labelFormat="wave"
                emptyMeaning="none"
                retainOutOfScopeValue
                required={false}
                onLoadError={() => setStagePlantFailed(true)}
                aria-label="Saved from which plant"
                data-testid="stage-source-plant-select"
              />
              {stagePlantFailed && (
                <p style={{ margin: '6px 0 0', color: P.light, fontSize: '0.78rem' }}>
                  Couldn&apos;t load your plantings — you can still save the stage without one.
                </p>
              )}
            </div>
          )}
          <button type="button" onClick={submitStage} disabled={busy} data-testid="stage-save" style={primaryBtnStyle}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </Sheet>
      )}

      {starting && (
        <Sheet open onClose={() => setStarting(false)} title="Track a saved-seed lot">
          <p style={{ margin: '0 0 12px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
            Pick the seed packet to track. It will start in <strong>fermenting</strong>; move it on
            from the list.
          </p>
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {untracked.length === 0 && (
              <p style={{ color: P.light, fontSize: '0.85rem' }}>No untracked seed packets.</p>
            )}
            {untracked.map((i) => (
              <button
                key={i.id} type="button" data-testid="track-candidate"
                onClick={() => { setStarting(false); openAdvance(i, 'fermenting') }}
                style={candidateRowStyle}
              >
                {i.variety_name || i.name}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 90px' }}>{children}</div>
    </div>
  )
}

// 48px floors throughout, matching the V4-LOGMANYUXREFRESH-001 S2 pass — this is a shed-and-counter
// surface reached with wet or dirty hands, which is the same argument that raised the Log Many
// selection controls.
const sectionHeadStyle = { margin: '0 0 2px', color: P.green, fontSize: '0.95rem', fontWeight: 700 }
const sectionSubStyle  = { margin: '0 0 10px', color: P.light, fontSize: '0.78rem' }
const cardStyle = {
  display: 'flex', alignItems: 'center', gap: 12, minHeight: 56,
  backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
  padding: '10px 12px', marginBottom: 8,
}
const advanceBtnStyle = {
  minHeight: 48, padding: '0 14px', borderRadius: 8, border: `1px solid ${P.green}`,
  backgroundColor: P.white, color: P.green, fontWeight: 600, fontSize: '0.84rem', cursor: 'pointer',
  flexShrink: 0,
}
const trackBtnStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  width: '100%', minHeight: 48, marginTop: 6, borderRadius: 10,
  border: `1px dashed ${P.border}`, backgroundColor: 'transparent', color: P.green,
  fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer',
}
const emptyStyle = {
  backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
  padding: '18px 16px', marginBottom: 18,
}
const fieldLabelStyle = {
  display: 'block', marginBottom: 14, fontSize: '0.82rem', fontWeight: 600, color: P.mid,
}
const inputStyle = {
  display: 'block', width: '100%', minHeight: 48, marginTop: 6, padding: '0 12px',
  borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '1rem', backgroundColor: P.white,
}
const primaryBtnStyle = {
  width: '100%', minHeight: 48, borderRadius: 10, border: 'none',
  backgroundColor: P.green, color: P.white, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer',
}
const candidateRowStyle = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: 48, padding: '10px 12px',
  marginBottom: 6, borderRadius: 8, border: `1px solid ${P.border}`,
  backgroundColor: P.white, color: P.green, fontSize: '0.9rem', cursor: 'pointer',
}
