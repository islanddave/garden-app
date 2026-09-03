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
import FilterChipRow from '../components/forms/FilterChipRow.jsx'
import { useCropTypes } from '../hooks/useCropTypes.js'
import Icon from '../components/Icon.jsx'
import Spinner from '../components/forms/Spinner.jsx'
import { todayLocalISO } from '../lib/dateLocal.js'
import { T } from '../components/forms/formStyles.js'
import { SEED_STAGES } from '../components/seed/seedStages.js'
import SaveSeedSheet from '../components/planting/SaveSeedSheet.jsx'
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
  // V4-SEEDFRESHPROCESS-001 — Dave asked for this half explicitly: warn when the seed went in WET.
  // Two lots in `drying` are not in the same condition. Seed that arrived by the `fresh` route was
  // scraped out of a ripe fruit hours ago and is genuinely wet; seed that arrived by `dry` was
  // threshed from a pod that dried on the plant and is nearly there already. The wet one is the one
  // that moulds, and it needs airflow and days rather than hours. Keyed on the lot's own
  // seed_process so it appears only where it is true — a blanket warning on every drying lot would
  // be noise on the majority and would stop being read by the time it mattered.
  stored:     { label: 'Stored',     sub: 'Dry, packeted and put away' },
}
const nextStage = (s) => STAGES[STAGES.indexOf(s) + 1] ?? null

// ── BUG-SEEDZEROSOWABLE-001 — the count, asked at EVERY stage ─────────────────────────────────────
// Dave 2026-09-02, verbatim: "ensure I can enter/update the count along the entire process. I might
// save 10 seeds and know it from the first moment, or I might have saved dozens/hundreds and not
// know how many potentially viable ones I'll save in the end. Each step needs to be able to
// set/update that count."
//
// SUPERSEDES V4-SEEDSTOREDQTY-001's stored-only placement, and it is NOT a revert of it. That change
// removed a count field DEFAULTING TO 1 — a guess dressed as data — and concluded the only knowable
// moment was `stored`. The first half stands: every field below is blank-by-default and nothing is
// ever fabricated. The second half was too strong. A count is knowable whenever the gardener happens
// to know it, which is a fact about the gardener and not about the stage, so the field is offered at
// every step and the ANSWER stays optional — everywhere except the one place its absence is
// load-bearing.
//
// REQUIRED AT `stored`, and that arm is the whole fix for the silent half of the defect. Reaching
// `stored` with the count skipped left the lot at 0, which sowEngine.isDepleted() reads as "none
// left" — so a lot that completed the entire ferment→dry→store process was filed under "Sowed
// previously" on Sow Now. The seed was finished, packeted and on the shelf, and the app said there
// was none. Nothing on the row distinguished never-counted-0 from counted-and-gone-0, and no column
// could be added to tell them apart retroactively.
//
// Requiring the answer at the terminal stage resolves it at the SOURCE instead: from here on, a
// seeds lot at `stored` is one whose count was explicitly answered, so 0 there genuinely means zero
// and depletion is the right reading. That invariant holds from day one rather than needing a
// backfill — prod carries ZERO lots with any seed_stage today (the surface shipped this morning),
// so there is no legacy population that reached `stored` unanswered.
//
// Zero stays fully expressible: the input accepts 0 and the help text names it as a real answer.
// "Required" here means an answer is required, never that the answer must be non-zero.
const COUNT_ASK = {
  fermenting: {
    label: 'How many are in the jar?',
    help: 'Optional — a rough count is fine, and you can change it at every step.',
  },
  drying: {
    label: 'How many are drying?',
    help: 'Optional — update it as you thresh and clean, right up to putting them away.',
  },
  stored: {
    label: 'How much did you get?',
    // The consequence of 0, said out loud at the one place it is now deliberately chosen rather
    // than fallen into. Same sentence the sheet used to carry for a BLANK answer, moved onto the
    // answer that now actually causes it.
    help: 'Needed now that the seed is dry and countable. Enter 0 if none of it was viable — a lot on zero shows as empty on Sow now.',
  },
}

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
// V4-SEEDFRESHPROCESS-001 — 'fresh' added, and BOTH existing labels were wrong at the edges.
// Dave, 2026-09-03: "wet / dry don't give any option for peppers, which just goes from fresh plant
// to drying for a few days then saved. None of these two options works here."
//
// He is right, and the copy failed him in both directions at once:
//   * `wet` advertised "seed WASHED or fermented out of wet pulp" while routing to `fermenting`.
//     A user who read "washed" and picked it would get peppers filed in the ferment queue AND a
//     permanent seed_lot_stage_log row asserting a ferment that never happened. The word "washed"
//     is removed from this option for that reason — it belongs to 'fresh' now.
//   * `dry` said "threshed from a pod dried ON THE PLANT", which a fresh pepper also is not.
// So peppers fell into the gap between two labels, on this garden's LARGEST seed crop (36 Capsicum
// cultivars, ~175 plants).
//
// 'fresh' enters at the SAME `drying` stage 'dry' does — the distinction is PROVENANCE, not routing.
// It is worth a vocabulary widening rather than a copy tweak precisely because seed_process is a
// permanent record of how a lot was handled, and "threshed from a dried pod" would be false on every
// pepper lot Dave saves.
//
// The DB CHECK is the authority and it was widened FIRST (migrations/v4-seedfreshprocess-001), then
// the two Lambda SEED_PROCESSES arrays, then this. Shipping this file ahead of either is a 400.
const PROCESS_ENTRY = {
  wet: {
    stage: 'fermenting',
    label: 'Wet — ferment first',
    sub: 'Tomato, cucumber, melon: seed sits in its own pulp for a few days first',
  },
  fresh: {
    stage: 'drying',
    label: 'Fresh — rinse and dry',
    sub: 'Pepper, squash: seed scraped from a ripe fruit, no ferment — straight onto a plate or screen',
  },
  dry: {
    stage: 'drying',
    label: 'Dry — threshed from a dried pod',
    sub: 'Beans, peas, lettuce, brassicas: pod dried on the plant before you opened it',
  },
}

// V4-SEEDLINK-001. Byte-identical to PlantingSelect's own unscoped self-fetch path, deliberately:
// dataCache keys on the path, so the name lookup below and the picker inside the advance sheet
// share ONE warm entry instead of each paying a round trip.
const PICKER_PATH = '/api/plants?view=picker'

// ── V4-SEEDNOPLANTING-001 — the door for seed that came from no planting ──────────────────────────
// Dave, 2026-09-02, hours after the create-a-lot flow shipped: "i don't see where to go right now to
// add seeds into this flow when not from a planting - is that just adding a seed item to inventory?"
//
// It is. The path already worked end to end — add a seeds item, then track it here, then set "Or
// where did it come from?" on the lot for the non-garden origin. Nothing was broken. But NOTHING
// POINTED AT IT: "Track a saved-seed lot" only offers packets that already exist, and the empty
// state taught provenance rather than the first step. A working path nobody can find is not a
// working path, and he is the second person to walk into this after the session that built it.
//
// The params carry the two facts the general Add-item form would otherwise make him re-derive (a
// seed packet is a `consumable` in category `seeds`) plus a return leg, so saving lands him back
// HERE — where the tracking control is — instead of on the Inventory list.
const ADD_PACKET_HREF = '/inventory/add?type=consumable&category=seeds&return=%2Fseeds%2Fsaved'

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

// Last-resort chip label when the crop-type vocabulary has no row for a slug the packets DO carry.
// Reachable in two real ways, so it is not defensive padding: useCropTypes resolves to an empty list
// on any fetch failure (documented, non-fatal), and a variety can be typed to a crop_type that was
// later renamed or scoped out of the 'garden' vocabulary. A raw `winter_squash` on a chip is worse
// than an imperfect "Winter squash", and an unlabelled chip is worse than both.
const prettySlug = (s) => {
  const t = String(s ?? '').replace(/_/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

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
//
// `source_plant_id` / `source_kind` (pre-promote MINOR #1) are the delay-fuse pair — see the note on
// PUT_PRESENCE_GUARDED_KEYS in InventoryDetail.jsx. Neither is in the handler's PUT SET list today,
// so both ride through harmlessly; the day either is added, a stale round-trip from this page would
// null the parent plant off the very lot the count belongs to. The subset test below is what
// forced them in here rather than only there, which is the seam working as intended.
// `crop_slug` joins `variety_name` and `stage_entered_at` as the THIRD list-only projection — added
// with the crop facet (V5-SEEDSAVEDFILTER-001). It is a `pv.crop_type_slug` alias, not a column on
// inventory_items, so echoing it back would put a key in the wide PUT body that names no column.
// It rides harmlessly today only because the handler's SET list does not mention it — exactly the
// delay fuse described above for source_plant_id/source_kind, and the reason this list is a strip
// rather than a whitelist. Stripping it now costs nothing and removes the fuse.
const LIST_ROW_PUT_STRIP = [
  'variety_name', 'stage_entered_at', 'crop_slug', 'featured_photo_view_url', 'featured_is_explicit',
  'germination', 'featured_photo_id', 'variety_id', 'seed_process', 'seed_stage', 'source_plant_id',
  'source_kind',
]

/** A complete wide-PUT body from a list row, with the count applied. Pure, exported for test. */
export function countPayloadFrom(row, quantityOnHand) {
  const out = { ...(row ?? {}) }
  for (const k of LIST_ROW_PUT_STRIP) delete out[k]
  // `type` rides through untouched and is load-bearing: the handler nulls quantity_on_hand outright
  // unless body.type === 'consumable' (BUG-INVSEEDPUT400-001 is the same fact from the other side).
  return { ...out, quantity_on_hand: quantityOnHand }
}

/**
 * BUG-SEEDZEROSOWABLE-001 — read the count field for a move into `toStage`. Pure, exported for test.
 *
 * @returns {{value: number|null, error: null}|{value: null, error: string}}
 *   `value` is the number to PUT, or null meaning "write nothing and leave the lot's count alone".
 *   `error` is a refusal — the submit must not proceed.
 *
 * THE ONE ASYMMETRY IS DELIBERATE. Blank is a legitimate answer on `fermenting` and `drying` ("I
 * haven't counted") and is refused on `stored`, because that is the stage whose 0 is unreadable
 * afterwards: sowEngine.isDepleted() cannot tell a lot nobody counted from a lot that is genuinely
 * empty, and `stored` is terminal so there is no later step to correct it at.
 *
 * A blank on an in-flight stage writes NOTHING rather than 0 — the lot keeps whatever it holds. That
 * distinction is load-bearing: writing 0 for "don't know" would manufacture the exact ambiguous
 * value this whole change exists to eliminate, one stage earlier.
 *
 * Rejects negatives and non-numbers rather than coercing. Number('') is 0 and Number('abc') is NaN,
 * so a bare Number() here would turn a blank into a hard zero and a typo into a silent no-op.
 */
export function parseCountInput(raw, toStage) {
  const typed = String(raw ?? '').trim()
  if (typed === '') {
    return toStage === 'stored'
      ? { value: null, error: 'Enter how much you got — 0 is a real answer if none of it was viable.' }
      : { value: null, error: null }
  }
  const n = Number(typed)
  if (!Number.isFinite(n)) return { value: null, error: 'That is not a number.' }
  if (n < 0) return { value: null, error: 'A count cannot be negative.' }
  return { value: n, error: null }
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
  // V5-SEEDSAVEDFILTER-001 — the crop facet's selection. A Set, because FilterChipRow is multi-select
  // OR and pepper+tomato together are 51% of the collection; single-select would make the two most
  // common answers mutually exclusive. Component-local and cleared with the query on every close,
  // for the reason the line above gives about a stale query — and MORE so for a chip than for text,
  // because typed text is visibly sitting in the box while a selected chip is easy to scroll past.
  // FilterChipRow's own contract already declares its selection session-ephemeral (FROZEN.md).
  const [cropSel, setCropSel] = useState(() => new Set())
  // Whether the facet renders at all, decided ONCE when the sheet opens rather than derived per
  // render. Gating on the live match count would make the control appear and vanish as the user
  // types, re-anchoring the list under a moving thumb; gating on `untracked` alone would still
  // re-evaluate mid-session if a row changed underneath. Snapshot at open, hold for the sheet's life.
  const [cropFacetOn, setCropFacetOn] = useState(false)
  // The PAGE-level crop filter's selection (V5-SEEDSAVEDFILTER-001 second pass). Separate state from
  // `cropSel` above, deliberately: that one narrows the packets you might START tracking, this one
  // narrows the lots you ARE tracking. Sharing one Set would make choosing a crop in the sheet
  // silently reorder the page behind it — two different questions wearing the same control.
  const [trackedCropSel, setTrackedCropSel] = useState(() => new Set())
  const [busy, setBusy]       = useState(false)
  const [when, setWhen]       = useState(todayLocalISO())
  const [note, setNote]       = useState('')
  // BUG-SEEDZEROSOWABLE-001 — the count, now asked on EVERY move (see COUNT_ASK). '' still writes
  // nothing, which keeps "I don't know yet" a real answer on the two in-flight stages; at `stored`
  // an empty value is refused before the request goes out, so the ambiguous 0 can no longer be
  // reached by omission. Prefilled from the lot on open so the field reads as UPDATE rather than
  // re-enter — the count is a running number now, not a one-time capture.
  const [qtyInput, setQtyInput] = useState('')
  const [qtyErr, setQtyErr]     = useState(null)
  // V4-SEEDLINK-001 — the parent plant chosen inside the advance sheet, for a lot that has none.
  // '' is "not chosen"; the field is optional and a lot can always be linked later from
  // /inventory/:id, which is the canonical editor for this column.
  const [stagePlant, setStagePlant] = useState('')
  const [stagePlantFailed, setStagePlantFailed] = useState(false)

  const [intakeOpen, setIntakeOpen] = useState(false)
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
  // ── V5-SEEDSAVEDFILTER-001 — the crop facet ─────────────────────────────────────────────────────
  // Options come from the ROWS, not from the crop-type vocabulary: a chip that matches nothing is a
  // control that can only disappoint, and 62 of the app's crop types have no packet here at all.
  // Ordered by packet count DESCENDING, deliberately, not alphabetically. Measured on prod: pepper 95
  // and tomato 40 are 51% of 263 rows, and 30 slugs hold exactly one. Alphabetical would bury
  // `tomato` two-thirds down the tray behind beet, broccoli, carrot and columbine — frequency order
  // puts the reachable answers where the thumb already is. FilterChipRow's pinned-first re-sort is
  // stable, so this order survives into the tray (FilterChipRow.jsx:55-63).
  //
  // Labels come from useCropTypes, the app's controlled vocabulary, rather than a slug prettifier
  // written here: a second naming authority for crop names is how two surfaces start disagreeing
  // about what a crop is called. The hook is non-fatal by design and resolves to an empty list on
  // any failure, so the fallback below is its documented degrade path, not a guess.
  const { cropTypes } = useCropTypes()
  const cropLabelBySlug = useMemo(() => {
    const m = new Map()
    for (const t of cropTypes ?? []) if (t?.slug) m.set(t.slug, t.display_name || prettySlug(t.slug))
    return m
  }, [cropTypes])
  const cropOptions = useMemo(() => {
    const counts = new Map()
    for (const i of untracked) {
      if (!i.crop_slug) continue
      counts.set(i.crop_slug, (counts.get(i.crop_slug) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([slug]) => ({ value: slug, label: cropLabelBySlug.get(slug) || prettySlug(slug) }))
  }, [untracked, cropLabelBySlug])
  // DERIVED, not the literal ['pepper','tomato'] the measurement suggests. Those two are 51% of the
  // collection TODAY; hardcoding them would freeze a fact about one September into the source, and
  // this page exists to serve a collection that is actively growing — the whole point of the autumn
  // seed-save is that these counts move. Because cropOptions is already count-descending, the top
  // two ARE the two worth pinning, whatever they turn out to be next year.
  const cropPinned = useMemo(() => cropOptions.slice(0, 2).map((o) => o.value), [cropOptions])

  // matched -> visible -> hiddenCount, the VarietyPicker/PlantingSelect idiom. `matched` is the FULL
  // result set and `visible` is what renders, so the footer can say how much is being held back
  // instead of the list simply ending.
  //
  // The two predicates are ANDed and they match DIFFERENT OBJECTS, which is worth stating because it
  // will look like a bug the first time they disagree: the text box matches row TEXT — variety_name,
  // name, and the free-text `source`, which on prod holds whole intake sentences carrying order
  // numbers and receipt dates — while a chip matches the joined `crop_type_slug`. So typing "pepper"
  // and tapping Pepper are not the same query and will not return the same set. Measured on prod:
  // 232 of 263 rows contain their own crop word somewhere in that text, so the chip's real work is
  // the remaining ~31 — including 12 tomato packets whose names never say "tomato".
  const matchedCandidates = useMemo(() => {
    const q = candidateQuery.trim()
    const byCrop = cropSel.size
      ? untracked.filter((i) => cropSel.has(i.crop_slug))
      : untracked
    if (!q) return byCrop
    return byCrop.filter((i) =>
      looseIncludes(i.variety_name, q) || looseIncludes(i.name, q) || looseIncludes(i.source, q))
  }, [untracked, candidateQuery, cropSel])
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

  // ── V5-SEEDSAVEDFILTER-001 (second pass) — the crop filter on the PAGE, not behind a tap ────────
  // The first pass put this only inside the "Track a saved-seed lot" sheet, and Dave went looking for
  // it twice on the page itself and did not find it. His rule, verbatim: "there is no point in having
  // to click to get to a search/sort/filter." A control you have to open something to reach is not a
  // filter, it is a preference buried in a menu — so it renders inline, above the stage sections.
  //
  // I argued against this originally on the grounds that the list held three rows. That reasoning was
  // measured and still wrong in the way that matters: the same release added the door that makes the
  // list grow, and a filter that only appears once the list is already unmanageable is a filter that
  // arrives late. It renders whenever it can actually DO something (more than one crop among the
  // lots) and is otherwise absent — which is a statement about capability, not about a tap budget.
  const trackedCropOptions = useMemo(() => {
    const counts = new Map()
    for (const i of tracked) {
      if (!i.crop_slug) continue
      counts.set(i.crop_slug, (counts.get(i.crop_slug) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([slug]) => ({ value: slug, label: cropLabelBySlug.get(slug) || prettySlug(slug) }))
  }, [tracked, cropLabelBySlug])
  const trackedCropPinned = useMemo(
    () => trackedCropOptions.slice(0, 2).map((o) => o.value), [trackedCropOptions])

  // THE ONE ROW A FILTER MAY NEVER HIDE. `fermentUrgency` is the only overdue-ferment warning in the
  // app — past day 5 the seed sprouts in the jar and the lot is finished — and it is computed per
  // rendered row, so a row filtered out takes its own alarm with it. Silently. The filter would be
  // doing exactly what the user asked, and the cost would be a dead lot rather than a missed row.
  // So an alarming lot survives its own exclusion and is COUNTED, so the page can say why it is
  // there. This is the R-9 rule from the regression review, implemented rather than noted.
  const visibleTracked = useMemo(() => {
    if (!trackedCropSel.size) return tracked
    return tracked.filter((i) => trackedCropSel.has(i.crop_slug) || fermentUrgency(i))
  }, [tracked, trackedCropSel])
  const keptUrgent = useMemo(
    () => (trackedCropSel.size
      ? visibleTracked.filter((i) => !trackedCropSel.has(i.crop_slug) && fermentUrgency(i)).length
      : 0),
    [visibleTracked, trackedCropSel])

  const byStage = useMemo(() => {
    const m = Object.fromEntries(STAGES.map((s) => [s, []]))
    for (const i of visibleTracked) m[i.seed_stage].push(i)
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
  }, [visibleTracked])

  const openAdvance = (item, toStage, process = null) => {
    setAdvancing({ item, toStage, process })
    setWhen(todayLocalISO())
    setNote('')
    setStagePlant('')
    setStagePlantFailed(false)
    // BUG-SEEDZEROSOWABLE-001 — seed the field with what the lot already holds so the gardener is
    // amending a running count rather than being asked the same question from scratch at every step.
    // A 0 prefills as BLANK, not as "0": 0 is the create-time placeholder for "nobody has counted
    // this yet", and rendering it as an answer would let a `stored` move satisfy its own required
    // field with a number no human ever typed — the exact ambiguity this change exists to end.
    const held = Number(item?.quantity_on_hand)
    setQtyInput(Number.isFinite(held) && held > 0 ? String(held) : '')
    setQtyErr(null)
  }

  const readCount = () => parseCountInput(qtyInput, advancing?.toStage)

  async function submitStage() {
    if (!advancing) return
    // Refuse BEFORE any request. The stage POST is not undoable from this page — seed_lot_stage_log
    // has no DELETE and the InventoryDetail control is the only repair — so a submit that would
    // land the stage and then reject the count is the one ordering that cannot be backed out.
    const count = readCount()
    if (count.error) { setQtyErr(count.error); return }
    setQtyErr(null)
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
      let qtyWriteErr = null
      if (count.value != null) {
        try {
          await fetch(`/api/inventory-items/${advancing.item.id}`, {
            method: 'PUT',
            body: JSON.stringify(countPayloadFrom(advancing.item, count.value)),
          })
        } catch (e) {
          qtyWriteErr = e?.message ?? 'Stage saved, but the count did not.'
        }
      }
      // "Started in", not "Moved to", when this is the lot's first stage — `process` is set only on
      // the start path (BUG-SEEDPROCFORCED-001). A dry lot's first entry IS drying, and calling that
      // a move implies a fermenting step it never had.
      const verb = advancing.process ? 'Started in' : 'Moved to'
      show({ message: linkErr ?? qtyWriteErr ?? `✓ ${verb} ${STAGE_META[advancing.toStage].label.toLowerCase()}` })
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
      {/* BUG-SEEDTAPTARGET-001 — `center`, not `baseline`. The cross-link below is now a 44px box
          rather than a 16px line of text, and baseline alignment would hang that box off the
          heading's baseline instead of centring it against the heading. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700, flex: 1 }}>
          Saved seeds
        </h1>
        <Link
          to="/sow"
          data-testid="sow-now-link"
          style={{
            display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
            paddingLeft: 8, color: P.green, fontSize: '0.85rem', flexShrink: 0,
          }}
        >
          Sow now →
        </Link>
      </div>
      <p style={{ margin: '0 0 12px', color: P.mid, fontSize: '0.86rem', lineHeight: 1.5 }}>
        Seed you saved yourself, and where each lot has got to.
      </p>

      {/* V4-SEEDINTAKEAGNOSTIC-001 — the door this page never had.
          Dave, 2026-09-03: "I still cannot find an easy way to start a saved seed path anywhere."
          He was right, and the page was worse than he described: BOTH previous doors were
          CONDITIONAL. One lived in the empty state, so it vanished the moment a single lot existed;
          the other was buried inside the tracking picker's scroll. Neither started a seed lot — both
          linked to the generic /inventory/add form, which makes a packet with no parent.
          ALWAYS RENDERED, above the fold, before any conditional branch. A primary action that only
          appears when the page is empty is not a primary action. */}
      <button
        type="button"
        onClick={() => setIntakeOpen(true)}
        data-testid="save-seed-open"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          width: '100%', minHeight: T.tapMinHeight, marginBottom: 20,
          borderRadius: 10, border: 'none', background: P.green, color: '#fff',
          fontSize: '0.95rem', fontWeight: 700, cursor: 'pointer',
        }}
      >
        + Save seed
      </button>
      {/* Opened with NO planting, which is the whole point — the sheet asks where the seed came from
          and offers both answers, instead of requiring the caller to already know. */}
      {intakeOpen && <SaveSeedSheet onClose={() => { setIntakeOpen(false); load() }} />}

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
          {/* V4-SEEDNOPLANTING-001 rewrote this paragraph, for the reason the version before it
              records about its own predecessor: it answered a question the visitor is not asking
              yet. "Where does provenance live" matters once a lot exists; on an EMPTY page the only
              question is "I am holding seed — where do I start", and the previous copy sent the
              reader to Inventory to look for a control on a packet that may not exist.
              Both doors, named by where the seed came from, because that is the fork the user is
              actually standing at. The planting one is a Link to the plant list rather than to a
              sheet: the Save-seed sheet needs a planting as a parameter, so the honest route is
              "pick the plant, then Save seed on its page". */}
          <p style={{ margin: '0 0 4px', color: P.mid, fontSize: '0.8rem', lineHeight: 1.6 }}>
            Saved seed from one of your plants? Open that planting and tap{' '}
            <strong>Save seed</strong> — it remembers the parent for you.
          </p>
          <p style={{ margin: '0 0 8px', color: P.mid, fontSize: '0.8rem', lineHeight: 1.6 }}>
            From something else — a shop pepper, a gift, a u-pick?
          </p>
          {/* A BLOCK TARGET, not a link inside the sentence. The layout gate's tap census measured
              the inline version of this at FIFTEEN pixels, which is the same defect
              BUG-SEEDTAPTARGET-001 just fixed on the card anchors — reintroduced by me one paragraph
              later, and caught only because the census counts every link rather than a named list.
              WCAG 2.5.8's inline-link exemption does not cover it: this is the primary action of an
              empty state, on the first screen a new user sees, reached with wet hands. */}
          <Link
            to={ADD_PACKET_HREF}
            data-testid="empty-add-packet"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minHeight: T.tapMinHeight, borderRadius: 8,
              border: `1px dashed ${P.border}`, color: P.green,
              fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none',
            }}
          >
            Add the packet →
          </Link>
        </div>
      )}

      {/* THE FILTER, INLINE — no tap to reach it. Rendered above the stage sections rather than
          inside any sheet, and only when there is more than one crop among the lots, because a chip
          row that cannot change the answer is furniture. Selection defaults to EMPTY (show all),
          which is not a style choice: scripts/layout-gate/seeds-saved-clearance.mjs pins the
          rendered card and section counts EXACTLY, so a default-on filter would red the gate. */}
      {trackedCropOptions.length > 1 && (
        <div style={{ marginBottom: 16 }}>
          <FilterChipRow
            options={trackedCropOptions}
            selected={trackedCropSel}
            pinned={trackedCropPinned}
            trayMaxHeight={180}
            onToggle={(v) => setTrackedCropSel((prev) => {
              const next = new Set(prev)
              if (next.has(v)) next.delete(v); else next.add(v)
              return next
            })}
            onClear={() => setTrackedCropSel(new Set())}
            aria-label="Filter your saved lots by crop"
            data-testid="tracked-crop-filter"
          />
          {/* An overdue ferment is never hidden, so say so rather than letting the count look like a
              filter that does not work. Ambient text, not a toast or a badge — the Reward UX rule
              puts interrupts out of scope, and this is an operational note either way. */}
          {keptUrgent > 0 && (
            <p data-testid="tracked-urgent-kept"
               style={{ margin: '8px 0 0', color: P.statusInkGold, fontSize: '0.78rem', lineHeight: 1.5 }}>
              Still showing {keptUrgent} lot{keptUrgent === 1 ? '' : 's'} outside this filter —
              {keptUrgent === 1 ? ' its ferment needs checking.' : ' their ferments need checking.'}
            </p>
          )}
        </div>
      )}

      {/* Two emptinesses on this list too, and the teaching empty state above answers only the first.
          Without this branch, filtering to a crop you have no lots of would render the whole
          "here is how to save seed" panel at someone who has already saved seed. */}
      {tracked.length > 0 && visibleTracked.length === 0 && (
        <p data-testid="tracked-no-match" style={{ color: P.mid, fontSize: '0.85rem', marginBottom: 16 }}>
          No saved lots match this filter.
        </p>
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
                        P.mid rather than P.light: this line is the one the page exists to be
                        read for, so it takes the stronger ink. (The original reason — P.light was
                        #777 at 4.478:1, under the AA floor — was retired by V4-INKCONTRAST-001,
                        which repainted P.light to #707070 at 4.952:1 on white. P.light now passes;
                        P.mid is still right here on emphasis grounds, not contrast grounds.) */}
                    <div style={{ color: urgency ? urgency.ink : P.mid, fontSize: '0.78rem', marginTop: 3, fontWeight: urgency ? 600 : 400 }}>
                      {elapsed(item.stage_entered_at)
                        ? `${elapsed(item.stage_entered_at)} in ${STAGE_META[s].label.toLowerCase()}`
                        : `In ${STAGE_META[s].label.toLowerCase()}`}
                      {item.seed_process ? ` · ${item.seed_process} process` : ''}
                    </div>
                    {/* V4-SEEDFRESHPROCESS-001 — the wet-seed drying warning, per Dave's ask.
                        Shown ONLY for a `fresh` lot that is currently drying: that seed came out of
                        a ripe fruit and is genuinely wet, unlike a `dry` lot threshed from a pod
                        that dried on the plant. Same stage, materially different risk, and this one
                        is the one that moulds. Gated on both facts rather than on the stage alone,
                        because a warning that appears on every drying lot is noise on the majority
                        and stops being read before it matters. */}
                    {s === 'drying' && item.seed_process === 'fresh' && (
                      <div
                        data-testid="fresh-drying-note"
                        style={{ color: P.mid, fontSize: '0.75rem', marginTop: 3, lineHeight: 1.45 }}
                      >
                        Went in wet — give it airflow and a single layer, and expect days rather than
                        hours. Seed that feels dry outside can still be damp inside.
                      </div>
                    )}
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
                        // BUG-SEEDTAPTARGET-001 — 44px, measured not assumed. The layout gate's tap
                        // census reported this anchor at FIFTEEN pixels tall at 390x844, four of
                        // them on a populated list, and it REPORTED rather than ASSERTED because
                        // WCAG 2.5.8 exempts inline links. That exemption does not apply here: this
                        // is not a link inside a sentence, it is the card's second action, sitting
                        // beside a 48px advance button, on a page reached in a shed with wet hands.
                        // inline-flex + minHeight rather than padding alone so the box is the target
                        // and the text stays vertically centred in it.
                        <Link
                          to={`/inventory/${item.id}`}
                          data-testid="set-source-plant"
                          style={{
                            display: 'inline-flex', alignItems: 'center',
                            minHeight: T.tapMinHeight, marginTop: 2, paddingRight: 8,
                            color: P.green, fontSize: '0.78rem',
                          }}
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
      <button
        type="button" data-testid="track-a-lot"
        onClick={() => {
          // The facet earns its 56px only when the list is long enough to need narrowing. Same
          // threshold as the truncation cap, so the control appears exactly when the list starts
          // hiding rows from you — below it, every packet is already on screen and a filter would
          // be furniture over a list you can simply read.
          setCropFacetOn(untracked.length > MAX_CANDIDATES)
          setStarting(true)
        }}
        style={trackBtnStyle}
      >
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
          {/* BUG-SEEDZEROSOWABLE-001 — THE COUNT, AT EVERY STAGE. See COUNT_ASK at the top of this
              file for why this moved off `stored`-only and why `stored` alone refuses a blank. The
              wording, the optional/required chip and the help line all come from that one table, so
              the three can never disagree about which stages demand an answer. */}
          {(() => {
            // Pre-promote MIN-1 — the fallback is NOT reachable today and is here anyway. Every
            // producer of `toStage` is enumerable: nextStage() over SEED_STAGES, and
            // PROCESS_ENTRY[*].stage, all three of which have a COUNT_ASK entry. But the previous
            // shape of this block was gated on `=== 'stored'`, so an unknown stage rendered NOTHING;
            // this one dereferences `ask.label`, so the same unknown stage would throw and
            // white-screen the whole advance sheet — turning "a fourth stage was added upstream"
            // from a missing field into a dead page. The generic wording is deliberately answerable
            // at any stage, and `required` stays pinned to `stored` alone.
            const ask = COUNT_ASK[advancing.toStage] ?? {
              label: 'How many?',
              help: 'Optional — you can set or change the count at every step.',
            }
            const required = advancing.toStage === 'stored'
            return (
              <label style={fieldLabelStyle} data-testid="seed-count">
                {ask.label}{' '}
                {required
                  ? <span data-testid="seed-count-required" style={{ color: P.severityUrgent, fontWeight: 600 }}>(required)</span>
                  : <span style={{ color: P.light, fontWeight: 400 }}>(optional)</span>}
                <input
                  type="number" inputMode="decimal" min="0" step="1" value={qtyInput}
                  onChange={(e) => { setQtyInput(e.target.value); if (qtyErr) setQtyErr(null) }}
                  placeholder={advancing.item.unit ? `e.g. 2 ${advancing.item.unit}` : 'e.g. 2'}
                  aria-invalid={qtyErr ? 'true' : undefined}
                  aria-describedby="ss-count-help"
                  data-testid="seed-count-input"
                  style={qtyErr ? { ...inputStyle, borderColor: P.alertBorder } : inputStyle}
                />
                {/* The refusal replaces the help rather than stacking under it: two lines of small
                    print under a field the user is being blocked by is where the actionable one gets
                    lost. role=alert so it is announced, not just painted. */}
                {qtyErr
                  ? (
                    <span
                      id="ss-count-help" role="alert" data-testid="seed-count-error"
                      style={{ display: 'block', marginTop: 6, color: P.severityUrgent, fontSize: '0.78rem', fontWeight: 600, lineHeight: 1.5 }}
                    >
                      {qtyErr}
                    </span>
                  )
                  : (
                    <span
                      id="ss-count-help"
                      style={{ display: 'block', marginTop: 6, color: P.mid, fontSize: '0.78rem', fontWeight: 400, lineHeight: 1.5 }}
                    >
                      {ask.help}
                    </span>
                  )}
              </label>
            )
          })()}
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
          onClose={() => {
            setStarting(false); setStartItem(null); setCandidateQuery(''); setCropSel(new Set())
          }}
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
              {/* Search first, chips second, deliberately: the common case is that you are holding a
                  packet and know its cultivar, and the box answers that in one gesture. The chips are
                  the browse fallback — and sitting directly above the list, the row reads as a visible
                  qualifier on what is beneath it rather than as a separate mode. Pinning is by
                  measured share, not taste: pepper and tomato are 51% of the collection, so they stay
                  on the collapsed row and the other ~24 crops expand IN PLACE via `More ▾` (no nested
                  sheet — FilterChipRow's contract forbids a third modal layer, which is also why the
                  Harvests FilterPill+PickerSheet pattern was not reused here). */}
              {cropFacetOn && cropOptions.length > 1 && (
                <FilterChipRow
                  options={cropOptions}
                  selected={cropSel}
                  pinned={cropPinned}
                  trayMaxHeight={180}
                  onToggle={(v) => setCropSel((prev) => {
                    const next = new Set(prev)
                    if (next.has(v)) next.delete(v); else next.add(v)
                    return next
                  })}
                  onClear={() => setCropSel(new Set())}
                  aria-label="Filter packets by crop"
                  data-testid="candidate-crop-filter"
                  style={{ marginBottom: 10 }}
                />
              )}
              <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                {untracked.length === 0 && (
                  <p style={{ color: P.mid, fontSize: '0.85rem' }}>No untracked seed packets.</p>
                )}
                {/* Two different emptinesses, and conflating them is how a filter teaches the wrong
                    thing: "you have none" and "none match what you typed" send the user opposite ways.
                    The crop facet makes it THREE, and adding it naively is a real regression rather
                    than a missed nicety: before the chips, this branch was unreachable with an empty
                    box, because a blank query short-circuits to the full set. A chip can empty the
                    list with nothing typed, and the old copy would then have read the literal
                    `No packet matches ""` — a sentence naming neither the cause nor the way out. */}
                {untracked.length > 0 && matchedCandidates.length === 0 && (
                  <p data-testid="candidate-no-match" style={{ color: P.mid, fontSize: '0.85rem' }}>
                    {(() => {
                      const q = candidateQuery.trim()
                      const crops = [...cropSel]
                        .map((s) => cropLabelBySlug.get(s) || prettySlug(s))
                        .join(' or ')
                      if (q && crops) return `No ${crops} packet matches “${q}”.`
                      if (crops) return `No untracked ${crops} packets.`
                      return `No packet matches “${q}”.`
                    })()}
                  </p>
                )}
                {visibleCandidates.map((c) => (
                  <button
                    key={c.item.id} type="button" data-testid="track-candidate"
                    onClick={() => setStartItem(c.item)}
                    style={candidateRowStyle}
                  >
                    <span style={{ display: 'block', fontWeight: 600 }}>{c.title}</span>
                    {/* P.mid, not P.light, for the reason the elapsed line above gives: this line
                        is the one the choice turns on, so it takes the stronger ink. Contrast is no
                        longer the reason — see that comment, post-V4-INKCONTRAST-001. */}
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
              {/* V4-SEEDNOPLANTING-001 — the way out of this list when the packet is not in it.
                  BELOW the scrollport, not inside it: a row appended to a 25-item scrolling list is
                  a row nobody reaches, and this is the answer to "none of these are mine", which is
                  exactly the moment the list has failed to help. Always present rather than shown
                  only on an empty result — the seed in hand is new, so the packet is missing on the
                  FIRST visit too, before any search has been typed. */}
              <Link
                to={ADD_PACKET_HREF}
                data-testid="add-seed-packet"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  minHeight: T.tapMinHeight, marginTop: 10, borderRadius: 8,
                  border: `1px dashed ${P.border}`, color: P.green,
                  fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none',
                }}
              >
                Seed not in the list? Add the packet →
              </Link>
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
// dried lot and a dead one, so safety-critical copy takes the strongest ink available.
// (The original reason — P.light was #777, 4.478:1 on the white card, a WCAG 2.1 AA 1.4.3 failure —
// was retired by V4-INKCONTRAST-001, which repainted P.light to #707070 at 4.952:1. It passes now.
// P.mid stays here because of what this line says, not because P.light fails.)
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
