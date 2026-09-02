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
import { Sheet, PlantingSelect, Badge } from '../components/forms'
import Icon from '../components/Icon.jsx'
import Spinner from '../components/forms/Spinner.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'
import { SEED_STAGES } from '../components/seed/seedStages.js'
import { looseIncludes } from '../lib/comboboxInput.js'
import { formatQty, formatDate } from '../lib/format.js'

// Process order, and it is an ORDER not a set: "advance" means one step right, and `stored` is
// terminal. Kept in one place so the section list, the next-stage arrow and the advance button copy
// can never disagree about what follows what.
//
// IMPORTED, not redeclared, since V4-SEEDSTOREDQTY-001. This file used to spell the three values out
// again, which made it the fourth declaration of one DB CHECK and left
// src/__tests__/seedStageVocabulary.test.js scraping this page's source text to prove it still
// agreed. seedStages.js is a leaf module with no imports of its own, so taking the array from there
// costs nothing and removes the drift surface rather than guarding it.
const STAGES = SEED_STAGES
const STAGE_META = {
  fermenting: { label: 'Fermenting', sub: 'Wet-process seed sitting in its own juice' },
  // "keep below 95°F" is not decoration. Seed viability falls off above roughly that point, and a
  // dehydrator is the one drying surface here that can exceed it without looking like it is doing
  // anything wrong — see the note placeholder below.
  drying:     { label: 'Drying',     sub: 'Spread out to dry — screens, plates, a dehydrator; keep below 95°F' },
  stored:     { label: 'Stored',     sub: 'Dry, packeted and put away' },
}
const nextStage = (s) => STAGES[STAGES.indexOf(s) + 1] ?? null

// BUG-SEEDPROCFORCED-001. The PROCESS decides where a lot enters the pipeline, so it is asked once,
// at the only moment the answer is known, and the entry stage follows from it.
//
// Until now "Track a saved-seed lot" had exactly one action and it hard-coded `fermenting`, which
// meant the surface FABRICATED a process record: the /seed-stage POST writes a permanent row into
// seed_lot_stage_log, so a dry-cleaned lot could only be tracked by asserting a ferment that never
// happened. Beans, peas, lettuce and every brassica are that case: seed threshed out of a pod that
// dried on the plant, never wet, never fermented.
//
// MELON IS NOT ONE OF THEM, and this file said it was until 2026-09-02 (WAVE 2 S3c). Melon seed
// comes out of a ripe wet fruit surrounded by pulp; it is a WET extraction and belongs on the wet
// entry point. Calling it "cleaned dry" in the option copy taught the wrong process on the one
// screen where the process is chosen, and the choice writes a permanent stage-log row. The same
// error is in the migration comment that introduced seed_process — reported, not fixed here.
//
// The two keys are the WHOLE live vocabulary of inventory_items_seed_process_check, read from prod
// (`seed_process IS NULL OR seed_process = ANY (ARRAY['wet','dry'])`) — not a third value invented
// to fit the UI. `drying` is a legal entry point with no special-casing anywhere: nextStage('drying')
// is 'stored', so a dry lot advances through the same machinery one step shorter.
const PROCESS_ENTRY = {
  wet: {
    stage: 'fermenting',
    label: 'Wet — ferment first',
    sub: 'Tomato, cucumber, squash, melon: seed washed or fermented out of wet pulp',
  },
  dry: {
    stage: 'drying',
    label: 'Dry — no ferment',
    sub: 'Beans, peas, lettuce, brassicas: seed threshed from a pod dried on the plant',
  },
}

// V4-SEEDLINK-001. Byte-identical to PlantingSelect's own unscoped self-fetch path, deliberately:
// dataCache keys on the path, so the name lookup below and the picker inside the advance sheet
// share ONE warm entry instead of each paying a round trip.
const PICKER_PATH = '/api/plants?view=picker'

// ── BUG-SEEDCANDIDATEAMBIG-001 — the untracked-packet picker ──────────────────────────────────────
// Measured against prod: ~260 untracked seed rows, roughly 41 phone-screens of unbroken scroll, and
// 51 of them across 24 groups rendering a BYTE-IDENTICAL label — because the row printed
// `{i.variety_name || i.name}` and nothing else. Choosing the right packet was not hard, it was
// UNDECIDABLE, and the choice writes a permanent seed_lot_stage_log row against whichever one the
// thumb landed on.
//
// Three parts, and the third is the one that closes the defect:
//   1. a filter over name / variety / source, using the same looseIncludes both shipped pickers use
//      (VarietyPicker, PlantingSelect) rather than a third matching dialect;
//   2. a cap with VISIBLE truncation — the matched -> visible -> hiddenCount idiom those two share,
//      never a silent slice (VarietyPicker.jsx:49-52 records what a silent one cost);
//   3. a second line of facts per row, with a last-resort ordinal when even those collide.
//
// 25 rather than those pickers' 200, deliberately. Their list is an anchored dropdown over a page
// where 200 rows are a scrollport the user can abandon by looking away; this one IS the body of a
// 340px sheet, and 200 rows here is 32 screens of the exact scroll this change exists to end. The
// mechanism is identical, only the number is surface-specific.
const MAX_CANDIDATES = 25

// The row's first line: what the seed IS. Unchanged from the shipped behaviour.
const candidateTitle = (i) => i.variety_name || i.name || ''

// The second line, and the whole fix. Facts that actually separate two packets of one cultivar, in
// the order they separate them: how much is in the jar, where it came from, when it was bought.
// Absent facts are DROPPED rather than rendered as a dash — "Brandywine · — · —" is noise, and the
// ordinal below is what covers a row with nothing left to say.
function candidateFacts(i) {
  const parts = []
  const qty = formatQty(i.quantity_on_hand)
  if (qty !== '') parts.push(i.unit ? `${qty} ${i.unit}` : qty)
  if (i.source) parts.push(String(i.source))
  const bought = formatDate(i.purchase_date)
  if (bought) parts.push(bought)
  return parts.join(' · ')
}

/**
 * Decorate the rows about to be rendered so that NO TWO READ ALIKE. Exported for test.
 *
 * The facts line separates the real prod collisions, but nothing guarantees it separates ALL of
 * them: two packets of one cultivar with the same count, the same vendor and the same purchase date
 * are identical in everything a row records. The honest answer is to SAY so rather than print the
 * same string twice, so a group that still collides gets an ordinal naming its size — the user
 * learns the list is not repeating itself, which is the actual question a duplicated row raises.
 *
 * Computed over the RENDERED rows, not over the whole untracked set: the property being kept is
 * "nothing on this screen reads the same", and it re-derives as the filter narrows.
 *
 * Two passes. The second exists because the first is not TOTAL — a vendor string that happened to
 * read like the ordinal would re-collide — and a uniqueness rule with an exception is not one. The
 * row id is the only thing guaranteed distinct, so it is the backstop, and only ever the backstop.
 */
export function labelCandidates(rows) {
  const base = rows.map((i) => ({ item: i, title: candidateTitle(i), facts: candidateFacts(i) }))
  const size = new Map()
  for (const r of base) {
    const k = `${r.title}\n${r.facts}`
    size.set(k, (size.get(k) ?? 0) + 1)
  }

  const nth = new Map()
  const labelled = base.map(({ item, title, facts }) => {
    const k = `${title}\n${facts}`
    const total = size.get(k)
    if (total < 2) return { item, title, detail: facts }
    const n = (nth.get(k) ?? 0) + 1
    nth.set(k, n)
    const ord = `${n} of ${total} with identical details`
    return { item, title, detail: facts ? `${facts} · ${ord}` : ord }
  })

  const used = new Set()
  return labelled.map((r) => {
    const full = `${r.title}\n${r.detail}`
    if (!used.has(full)) { used.add(full); return r }
    const tail = `#${String(r.item.id ?? '')}`
    return { ...r, detail: r.detail ? `${r.detail} · ${tail}` : tail }
  })
}

// Elapsed whole days, floor. Null when there is no timestamp or it does not parse. Split out of
// elapsed() so the ferment thresholds below compare the SAME number the card renders — deriving it
// twice is two places for the badge and the text to disagree.
function elapsedDays(iso) {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  return Math.floor((Date.now() - then.getTime()) / 86400000)
}

// Same-day reads "today" rather than "0 days", because 0 of anything looks like missing data.
function elapsed(iso) {
  const days = elapsedDays(iso)
  if (days == null) return null
  if (days <= 0) return 'today'
  return days === 1 ? '1 day' : `${days} days`
}

// A ferment is DONE at two to four days. Past about five the seed germinates in the jar and the lot
// is finished — not degraded, finished. Until now an eight-day ruined ferment rendered in the same
// grey as a healthy two-day one, so the number was on screen and its meaning was not, on a page
// whose entire job is to say what needs checking.
//
// `fermenting` ONLY. Drying has no equivalent cliff — a lot that has sat on a screen for three
// weeks is dry, not spoiled — and firing this on every stage would make it background noise.
const FERMENT_WARN_DAYS  = 4
const FERMENT_ALARM_DAYS = 5
const FERMENT_URGENCY = {
  warn: {
    tone: 'warn', ink: P.statusInkGold, border: P.warnBorder,
    badge: 'Check the ferment', note: 'Most ferments are finished by day 4.',
  },
  alarm: {
    tone: 'danger', ink: P.severityUrgent, border: P.alertBorder,
    badge: 'Overdue', note: 'Past 5 days the seed can sprout in the jar.',
  },
}
function fermentUrgency(item) {
  if (item.seed_stage !== 'fermenting') return null
  const days = elapsedDays(item.stage_entered_at)
  if (days == null) return null
  if (days >= FERMENT_ALARM_DAYS) return 'alarm'
  if (days >= FERMENT_WARN_DAYS) return 'warn'
  return null
}

// ── V4-SEEDSTOREDQTY-001 — writing a COUNT from this page ─────────────────────────────────────────
// There is no narrow quantity route on the handler, so the count goes through PUT
// /api/inventory-items/:id — which is the wide PUT, where every column in the SET list is assigned
// unconditionally (`= ${body.x ?? null}`). A short body there is not a partial update, it is a wipe.
// The complete row is therefore round-tripped, which is the same contract InventoryDetail's
// putPayloadFrom() keeps for its stage write; the row available here is the LIST row, which is
// `i.*` plus two derived columns.
//
// MIRRORS PUT_DERIVED_KEYS + PUT_PRESENCE_GUARDED_KEYS in src/pages/InventoryDetail.jsx, where the
// per-key reasoning is spelled out. Duplicated rather than imported for the reason SaveSeedSheet.jsx
// gives about PROCESS_ENTRY: a page importing from another page drags that page's whole module —
// and PlantingSelect, PhotoUpload, useInventory behind it — into this chunk. The two lists are kept
// in step by src/__tests__/SavedSeeds.storedCount.test.jsx, which reads both files' source text.
//
// `seed_stage` is the one that would BITE rather than merely leak. The list row carries the lot's
// stage as it was BEFORE the advance, so echoing that key back would revert the stage the POST just
// wrote — a 200 that silently undoes the action the sheet is titled for. Omitted, the handler's
// presence guard leaves the freshly-written value alone.
//
// Two keys here that InventoryDetail's lists do not carry: `variety_name` and `stage_entered_at` are
// projections the LIST query adds (a cultivar join and a LATERAL), not columns. Inert in the SET
// list either way; stripped so the body is only ever columns.
const LIST_ROW_PUT_STRIP = [
  'variety_name', 'stage_entered_at', 'featured_photo_view_url', 'featured_is_explicit', 'germination',
  'featured_photo_id', 'variety_id', 'seed_process', 'seed_stage',
]

/** A complete wide-PUT body from a list row, with the count applied. Pure, exported for test. */
export function countPayloadFrom(row, quantityOnHand) {
  const out = { ...(row ?? {}) }
  for (const k of LIST_ROW_PUT_STRIP) delete out[k]
  // `type` rides through untouched and is load-bearing: the handler nulls quantity_on_hand outright
  // unless body.type === 'consumable' (BUG-INVSEEDPUT400-001 is the same fact from the other side).
  return { ...out, quantity_on_hand: quantityOnHand }
}

export default function SavedSeeds() {
  const { fetch } = useApiFetch()
  const { show } = useToast()

  const [items, setItems]     = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [advancing, setAdvancing] = useState(null)   // the lot whose advance sheet is open
  const [starting, setStarting]   = useState(false)  // the "track a lot" picker sheet
  // BUG-SEEDPROCFORCED-001 — the packet picked in step 1, waiting on its process in step 2. Held
  // rather than passed straight to openAdvance because the entry stage is not known until the
  // process is chosen, and the advance sheet is titled by that stage.
  const [startItem, setStartItem] = useState(null)
  // BUG-SEEDCANDIDATEAMBIG-001 — the picker's filter box. Cleared whenever the sheet closes or the
  // user steps back to it, so re-opening never lands on a stale query hiding the packet they came for.
  const [candidateQuery, setCandidateQuery] = useState('')
  const [busy, setBusy]       = useState(false)
  const [when, setWhen]       = useState(todayLocalISO())
  const [note, setNote]       = useState('')
  // V4-SEEDSTOREDQTY-001 — the count, asked only on the move INTO `stored`. '' is "still don't know"
  // and writes nothing; see the field for why that is a real answer rather than a skipped one.
  const [storedQty, setStoredQty] = useState('')
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
  // Candidates for tracking: no stage yet, AND still active. The status filter is new
  // (BUG-SEEDCANDIDATEAMBIG-001) and matches how the server already decides a packet is live —
  // v_sow_candidates' predicate is a strict `i.status = 'active'`, so a retired or used-up packet is
  // not offered here either. Strict equality for the same reason: `status` is NOT NULL on every real
  // row, and a `?? 'active'` fallback would quietly re-admit exactly the rows this excludes.
  const untracked = useMemo(
    () => (items ?? []).filter((i) => !STAGES.includes(i.seed_stage) && i.status === 'active'),
    [items],
  )
  // matched -> visible -> hiddenCount, the VarietyPicker/PlantingSelect idiom. `matched` is the FULL
  // result set and `visible` is what renders, so the footer can say how much is being held back
  // instead of the list simply ending.
  const matchedCandidates = useMemo(() => {
    const q = candidateQuery.trim()
    if (!q) return untracked
    return untracked.filter((i) =>
      looseIncludes(i.variety_name, q) || looseIncludes(i.name, q) || looseIncludes(i.source, q))
  }, [untracked, candidateQuery])
  const visibleCandidates = useMemo(
    () => labelCandidates(matchedCandidates.slice(0, MAX_CANDIDATES)),
    [matchedCandidates],
  )
  const hiddenCandidates = matchedCandidates.length - visibleCandidates.length
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
    // Oldest first inside a stage: the lot that has sat longest is the one to check. Keyed on
    // stage_entered_at for the same reason the card is (BUG-SEEDELAPSEDUPDATED-001) — sorting by
    // updated_at ordered the list by "last edited", so touching a lot moved it to the bottom of a
    // list whose entire job is to surface the one that has sat longest.
    // A lot with no stage entry sorts LAST rather than first: its duration is unknown, and unknown
    // must not outrank a measured one at the top of a "check this" list.
    for (const s of STAGES) {
      m[s].sort((a, b) => {
        const A = a.stage_entered_at, B = b.stage_entered_at
        if (!A && !B) return 0
        if (!A) return 1
        if (!B) return -1
        return String(A).localeCompare(String(B))
      })
    }
    return m
  }, [tracked])

  const openAdvance = (item, toStage, process = null) => {
    setAdvancing({ item, toStage, process })
    setWhen(todayLocalISO())
    setNote('')
    setStagePlant('')
    setStagePlantFailed(false)
    setStoredQty('')
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
          // BUG-SEEDPROCFORCED-001 — set ONLY when this is the lot's first stage, where the process
          // was just chosen. The key is omitted entirely on a plain advance, and the handler's
          // presence guard leaves an existing process alone rather than clearing it; sending
          // `null` here would wipe it on every subsequent move.
          ...(advancing.process ? { seed_process: advancing.process } : {}),
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
      // V4-SEEDSTOREDQTY-001 — the count, on the same terms as the link above: its OWN request with
      // its OWN failure, because a lot that reached `stored` reached it whether or not we also
      // learned how much came out. Blank is not a skipped field, it is the answer "still don't know"
      // — and the only honest thing to do with it is write nothing, leaving the lot at whatever it
      // already held. Last of the three so the write order reads in order of importance.
      let qtyErr = null
      const typedQty = storedQty.trim()
      if (advancing.toStage === 'stored' && typedQty !== '') {
        const n = Number(typedQty)
        if (Number.isFinite(n) && n >= 0) {
          try {
            await fetch(`/api/inventory-items/${advancing.item.id}`, {
              method: 'PUT',
              body: JSON.stringify(countPayloadFrom(advancing.item, n)),
            })
          } catch (e) {
            qtyErr = e?.message ?? 'Stage saved, but the count did not.'
          }
        }
      }
      // "Started in", not "Moved to", when this is the lot's first stage — `process` is set only on
      // the start path (BUG-SEEDPROCFORCED-001). A dry lot's first entry IS drying, and calling that
      // a move implies a fermenting step it never had.
      const verb = advancing.process ? 'Started in' : 'Moved to'
      show({ message: linkErr ?? qtyErr ?? `✓ ${verb} ${STAGE_META[advancing.toStage].label.toLowerCase()}` })
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
              const urgencyKey = fermentUrgency(item)
              const urgency = urgencyKey ? FERMENT_URGENCY[urgencyKey] : null
              return (
                <div
                  key={item.id} data-testid="seed-lot-card"
                  data-ferment={urgencyKey ?? undefined}
                  style={urgency ? { ...cardStyle, borderColor: urgency.border } : cardStyle}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link to={`/inventory/${item.id}`} style={{ color: P.green, fontWeight: 600, textDecoration: 'none' }}>
                      {item.variety_name || item.name}
                    </Link>
                    {/* BUG-SEEDELAPSEDUPDATED-001 — elapsed from stage_entered_at, NOT updated_at.
                        set_updated_at is a BEFORE UPDATE ROW trigger that fires on every write to
                        the row, so "4 days in drying" reset to "today" the moment anything else on
                        the lot was edited — attaching a parent plant did it — with no stage change.
                        The server derives stage_entered_at from the lot's latest seed_lot_stage_log
                        entry FOR ITS CURRENT STAGE, which is the fact this line claims to render.
                        No fallback to updated_at when it is absent, deliberately: a wrong duration
                        is worse than none, and falling back would silently reinstate the bug.
                        P.mid rather than P.light: #777 is 4.478:1 on this white card, under the
                        AA floor, and this line is the one the page exists to be read for. Scoped
                        to the seed path — repainting P.light app-wide is Dave's call. */}
                    <div style={{ color: urgency ? urgency.ink : P.mid, fontSize: '0.78rem', marginTop: 3, fontWeight: urgency ? 600 : 400 }}>
                      {elapsed(item.stage_entered_at)
                        ? `${elapsed(item.stage_entered_at)} in ${STAGE_META[s].label.toLowerCase()}`
                        : `In ${STAGE_META[s].label.toLowerCase()}`}
                      {item.seed_process ? ` · ${item.seed_process} process` : ''}
                    </div>
                    {/* The state, said out loud. Colour alone would carry this for a sighted user
                        with good contrast conditions and nobody else, so the badge names it in
                        words and the note says what the number MEANS — the whole defect was a
                        duration rendered without its consequence. Badge is the frozen house
                        primitive, warn/danger its existing tones; no new chrome is minted. */}
                    {urgency && (
                      <div style={{ marginTop: 5 }}>
                        <Badge tone={urgency.tone} data-testid="ferment-urgency" style={{ whiteSpace: 'normal' }}>
                          {urgency.badge}
                        </Badge>
                        <div style={{ color: urgency.ink, fontSize: '0.75rem', marginTop: 3 }}>
                          {urgency.note}
                        </div>
                      </div>
                    )}
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
        <Sheet
          open busy={busy} onClose={() => setAdvancing(null)}
          title={`${advancing.process ? 'Start in' : 'Move to'} ${STAGE_META[advancing.toStage].label.toLowerCase()}`}
        >
          <p style={{ margin: '0 0 14px', color: P.mid, fontSize: '0.86rem' }}>
            {advancing.item.variety_name || advancing.item.name}
          </p>
          <label style={fieldLabelStyle}>
            When
            {/* Backdating is first-class here (see the file header) but FORWARD-dating is never
                meaningful: a stage cannot have been entered on a day that has not happened. A lot
                dated 2027 reads "today" forever on a page whose only job is to say what has sat
                longest, so it does not merely look odd — it silently leaves the list. `max` is the
                native picker's own guard and costs nothing; the server-side half is separate. */}
            <input
              type="date" value={when} max={todayLocalISO()} onChange={(e) => setWhen(e.target.value)}
              data-testid="stage-date" style={inputStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            Note <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>
            {/* The placeholder is an EXAMPLE, and on a teaching surface an example is an
                instruction. It used to read "Dehydrator on low, 95°F" — but most dehydrators' low
                setting runs 105-125°F, so following the example literally cooks the lot. Seed
                viability falls off above roughly 95°F, so the example is now the safe surface and
                the temperature named is one a shed actually holds. */}
            <input
              type="text" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Screen in the shed, 75°F, out of sun" data-testid="stage-note" style={inputStyle}
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
          {/* V4-SEEDSTOREDQTY-001 — THE COUNT IS ASKED HERE AND NOWHERE EARLIER. At "save seed" the
              lot is still wet and unthreshed and the honest answer is that nobody knows; the first
              moment anyone does is when the lot is packeted and put away, which is this transition.
              So SaveSeedSheet creates at 0 and this field is where the number arrives.
              `stored` only: asking on the way into fermenting or drying re-poses the unanswerable
              question, and the terminal stage is the one that has an answer. */}
          {advancing.toStage === 'stored' && (
            <label style={fieldLabelStyle} data-testid="stored-count">
              How much did you get? <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>
              <input
                type="number" inputMode="decimal" min="0" step="1" value={storedQty}
                onChange={(e) => setStoredQty(e.target.value)}
                placeholder={advancing.item.unit ? `e.g. 2 ${advancing.item.unit}` : 'e.g. 2'}
                data-testid="stored-count-input" style={inputStyle}
              />
              {/* The consequence, said out loud, because leaving this blank is not free. A lot at 0
                  that is no longer in process reads as DEPLETED on Sow now (sowEngine's isDepleted
                  diverts `<= 0`) — arguably correct, since there is no countable seed, but it is a
                  visible outcome and the field that causes it is the place to say so. */}
              <span style={{ display: 'block', marginTop: 6, color: P.mid, fontSize: '0.78rem', fontWeight: 400, lineHeight: 1.5 }}>
                Leave it blank if you still haven&apos;t counted — the lot keeps the count it has, and
                a lot on zero shows as empty on Sow now until you fill it in.
              </span>
            </label>
          )}
          <button type="button" onClick={submitStage} disabled={busy} data-testid="stage-save" style={primaryBtnStyle}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </Sheet>
      )}

      {/* BUG-SEEDPROCFORCED-001 — two steps in one sheet: pick the packet, then say how it was
          processed. Two steps rather than a process control beside every row, because the question
          is asked once per lot and a per-row control would ask it 260 times on a list whose job is
          to be scanned. Closing the sheet clears both, so re-opening never lands mid-flow. */}
      {starting && (
        <Sheet
          open
          onClose={() => { setStarting(false); setStartItem(null); setCandidateQuery('') }}
          title={startItem ? 'How was it processed?' : 'Track a saved-seed lot'}
        >
          {startItem ? (
            <div data-testid="start-process-step">
              <p style={{ margin: '0 0 12px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
                {startItem.variety_name || startItem.name} — this decides where the lot starts.
              </p>
              {Object.entries(PROCESS_ENTRY).map(([key, meta]) => (
                <button
                  key={key} type="button" data-testid={`start-process-${key}`}
                  onClick={() => {
                    setStarting(false)
                    setStartItem(null)
                    openAdvance(startItem, meta.stage, key)
                  }}
                  style={processRowStyle}
                >
                  <span style={{ fontWeight: 600 }}>{meta.label}</span>
                  <span style={{ display: 'block', color: P.light, fontSize: '0.78rem', marginTop: 2 }}>
                    {meta.sub}
                  </span>
                  <span style={{ display: 'block', color: P.light, fontSize: '0.78rem', marginTop: 4 }}>
                    Starts in {STAGE_META[meta.stage].label.toLowerCase()}
                  </span>
                </button>
              ))}
              <button
                type="button" data-testid="start-process-back"
                onClick={() => setStartItem(null)}
                style={backBtnStyle}
              >
                ← Pick a different packet
              </button>
            </div>
          ) : (
            <>
              <p style={{ margin: '0 0 12px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
                Pick the seed packet to track, then say how it was processed.
              </p>
              {/* type="search", not "text": Chrome on Android renders the clear affordance and a
                  search-shaped keyboard for free, and this box is the whole answer to a 260-row list. */}
              <input
                type="search" value={candidateQuery}
                onChange={(e) => setCandidateQuery(e.target.value)}
                placeholder={`Search ${untracked.length} packet${untracked.length === 1 ? '' : 's'}…`}
                aria-label="Search your untracked seed packets"
                data-testid="candidate-filter" style={{ ...inputStyle, marginTop: 0, marginBottom: 10 }}
              />
              <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                {untracked.length === 0 && (
                  <p style={{ color: P.mid, fontSize: '0.85rem' }}>No untracked seed packets.</p>
                )}
                {/* Two different emptinesses, and conflating them is how a filter teaches the wrong
                    thing: "you have none" and "none match what you typed" send the user opposite ways. */}
                {untracked.length > 0 && matchedCandidates.length === 0 && (
                  <p data-testid="candidate-no-match" style={{ color: P.mid, fontSize: '0.85rem' }}>
                    No packet matches “{candidateQuery.trim()}”.
                  </p>
                )}
                {visibleCandidates.map((c) => (
                  <button
                    key={c.item.id} type="button" data-testid="track-candidate"
                    onClick={() => setStartItem(c.item)}
                    style={candidateRowStyle}
                  >
                    <span style={{ display: 'block', fontWeight: 600 }}>{c.title}</span>
                    {/* P.mid, not P.light, for the reason the elapsed line above gives: #777 is
                        4.478:1 on this white row, and this line is now the one the choice turns on. */}
                    {c.detail && (
                      <span data-testid="track-candidate-detail" style={{ display: 'block', color: P.mid, fontSize: '0.78rem', marginTop: 2 }}>
                        {c.detail}
                      </span>
                    )}
                  </button>
                ))}
                {/* Truncation is VISIBLE, never silent — the whole point of keeping `matched` beside
                    `visible`. A list that simply stopped at 25 would read as "that is all of them". */}
                {hiddenCandidates > 0 && (
                  <p data-testid="candidate-truncation" style={{ margin: '2px 0 0', padding: '8px 2px', color: P.mid, fontSize: '0.78rem' }}>
                    Showing {visibleCandidates.length} of {matchedCandidates.length} — keep typing to narrow.
                  </p>
                )}
              </div>
            </>
          )}
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
// P.mid, not P.light: this line now carries "keep below 95F", which is the difference between a
// dried lot and a dead one. P.light is #777 — 4.478:1 on the white card, a WCAG 2.1 AA 1.4.3 failure
// — and safety-critical copy is the wrong place to ship it. Seed-path-only, matching the elapsed
// line; the app-wide P.light repaint stays Dave's call.
const sectionSubStyle  = { margin: '0 0 10px', color: P.mid, fontSize: '0.78rem' }
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
const processRowStyle = {
  ...candidateRowStyle, minHeight: 64, padding: '12px', marginBottom: 10,
}
const backBtnStyle = {
  display: 'block', width: '100%', minHeight: 48, marginTop: 4, borderRadius: 8,
  border: 'none', backgroundColor: 'transparent', color: P.mid, fontSize: '0.84rem',
  cursor: 'pointer',
}
