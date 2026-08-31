// src/pages/VoiceHarvest.jsx — V5-HARVESTVOICEFLOW-001 (BD-068), the first USER-FACING slice.
//
// Dave, 2026-08-30: "I want to get to production the voice harvest flow. It can run as a parallel tab
// short term so that I don't lose the harvest ability should this fail somehow, but I need to start
// using it to see if it is going to work."
//
// PARALLEL, NOT INTEGRATED — and that is the entire risk design. Build plan V101's S3 put voice
// INSIDE the live weigh-in session on /log, which meant every defect in this flow was a defect in the
// form Dave depends on daily. This is a separate route with its own state, mounted from its own row
// in the + sheet. /log is not imported, not modified, and not reachable from here; if this surface
// misbehaves the recovery is to close it. That is why this ships without the
// HARVEST_VOICE_FLOW_ENABLED flag V101 specified: the flag existed to make a root mic provider
// escapable, and a route you can navigate away from is already escapable. There is no root provider
// here — the recogniser lives and dies with this component.
//
// WHAT IT REUSES rather than rebuilds:
//   lib/voiceHarvestGrammar.js  — classify(): command vs quantity vs weight vs search vs unparsed
//   lib/voiceCommitDebounce.js  — settle window, supersede, write cooldown, staleness bound
//   lib/comboboxInput.js        — looseKey/looseIncludes, the voice-forgiving matcher the picker uses
//   POST /api/events            — the same endpoint and the same harvest payload /log posts
// The grammar and the debouncer had run only inside the /admin probe until now. This is their first
// execution against real data.
//
// WHY THE RECOGNISER IS OPEN-CODED HERE and not shared with ContinuousVoiceProbe: the probe's value
// is that it is deliberately un-abstracted — it reports what Chrome dispatches, not what a wrapper
// says Chrome dispatched, and wrapping it would destroy the instrument. It cannot go through
// lib/transcribe.js either, for the reason V101 records: transcribe.js ends a session on `onend` with
// no restart, and its BUG-VOICEDUPE-003 fix pins onResult to never deliver a revised final — which is
// exactly the revision the debouncer's supersede rule needs, so behind that wrapper "231 grams" would
// commit as "231". The mic arbiter (S1) is the thing that should eventually own all five start-paths
// including this one; it is not built, so this component owns its own and releases it on unmount.
//
// THE SAFETY PROPERTIES, because "a silent wrong save is worse than a slow form" (Dave, BD-068):
//   * A save NEVER happens without a planting AND a quantity. A "next" that cannot save says so and
//     keeps the record intact — it does not advance over it. This is the failure V101 found in
//     /log's handleSubmit, which returned undefined on all 9 paths so save_and_advance could not
//     tell a refusal from a success.
//   * Every outcome is announced on THREE channels — a large banner, a distinct haptic, and a
//     permanent ledger row. BUG-VOICEFAILSILENT-001 (Dave, verbatim): "a silent fail is a lost log."
//   * Every committed row carries an Undo for the whole session, not just the last one.
//   * A save that FAILS releases the write cooldown, so saying "next" again actually retries rather
//     than being swallowed for 1500 ms as a transport duplicate.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { useApiFetch } from '../lib/api.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { looseKey, looseIncludes } from '../lib/comboboxInput.js'
import { fuzzyMatch } from '../lib/voiceFuzzyMatch.js'
import { fetchAliases, indexAliases, resolveAlias, teachAlias } from '../lib/voiceAliases.js'
import { classify, foldNumberWords, normalise } from '../lib/voiceHarvestGrammar.js'
import { createCommitDebouncer } from '../lib/voiceCommitDebounce.js'
import {
  hapticSaveCommitted, hapticSaveFailed, hapticDigitAccepted, hapticDigitRejected, hapticUndoApplied,
} from '../lib/haptics.js'

// A HARD STOP, not a nag. An unbounded live mic is a recorder someone forgets, and this surface is
// reachable from the ordinary + menu rather than from /admin. Thirty minutes covers a real weigh-in
// (the outdoor fixture gate B6 asks for ≥20 utterances; the device re-arms ~5 sessions per 4
// utterances, so the re-arm cap is sized well above that) and restarting is one tap.
export const RUN_BUDGET = { restarts: 600, runMs: 30 * 60 * 1000, label: '30 minutes' }

function ctor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

// What a planting can be called out loud. Crop type is included for the reason V4-SEARCHCROPTYPE-001
// shipped for, in Dave's words: "I don't always remember spelling — is it charentais? charantais? —
// but I know it is a cantaloupe." Speaking makes that worse, not better: a recogniser has no chance
// on a cultivar name it has never heard, and every chance on "cucumber".
export function plantingAliases(p) {
  return [p?.name, p?.variety_ref?.name, p?.variety_ref?.crop_type_slug].filter(Boolean).map(String)
}

// EXPORTED AND PURE so the matcher is testable without a recogniser, a network or a DOM. Returns
// every planting any of whose aliases contains the spoken text, with exact alias matches promoted —
// "cucumber" must select a planting actually NAMED cucumber ahead of "Cucumber Beetle Trap Crop".
export function matchPlantings(plantings, spoken) {
  const needle = looseKey(spoken)
  if (!needle) return []
  const hits = plantings.filter((p) => plantingAliases(p).some((a) => looseIncludes(a, spoken)))
  const exact = hits.filter((p) => plantingAliases(p).some((a) => looseKey(a) === needle))
  return exact.length ? exact : hits
}

// BUG-VOICENUMWORD-001 — the same STRICT matcher, re-run with spoken number words folded to the
// digits a planting is actually named with ("eighteen eighty four" → "1884"). Returns [] when there
// was nothing to fold, so the caller can tell "no numbers in this phrase" from "folded and missed".
//
// WHY NOT IN looseKey, which is where it would be tidiest. `looseKey` is shared by three surfaces —
// this matcher, PlantingSelect (the /log picker) and VarietyPicker — so folding inside it would reach
// all three INCLUDING TYPED queries, and typing "1884" would start returning eighteen-eighty-four
// rows on the form Dave uses every day. This is a defect of the RECOGNISER, not of matching: nobody
// types "eighteen eighty four". Keeping the fold on the voice path is the same principle that put
// this whole flow on a parallel route — a voice defect must not become a defect in the form the
// harvest depends on.
function matchFolded(plantings, spoken) {
  const folded = foldNumberWords(spoken)
  if (folded === normalise(String(spoken ?? ''))) return []
  return matchPlantings(plantings, folded)
}

// V5-VOICEFUZZYMATCH-001 — the rescue, and WHERE it sits is the whole safety argument.
//
// It runs ONLY when matchPlantings returns empty. Every utterance that resolves today resolves
// identically after this change — the strict matcher is untouched and still answers first, so this
// can only turn a "nothing matched" into something. That is the same shape as the voice rescue
// VarietyPicker already ships (V4-PICKERVOICE-001 QA-G3: voice-only, empty-result-only, one shot),
// and it is deliberate reuse of a pattern Dave has already used in production rather than a new one.
//
// It cannot reach a command or a number: classify() decides those before the search branch is ever
// entered, and this is called from inside that branch. The grammar's own note says the search branch
// is the permissive one because "a wrong search shows the wrong list, which Dave sees and corrects".
//
// Returns the SAME shape the caller already handles plus a `rescued` marker, so a fuzzy hit is
// announced as a correction instead of passing itself off as a clean match.
// FOUR LAYERS, IN THIS ORDER, and the order is the whole safety argument:
//   1. strict   — exact/substring. Unchanged and still first, so every utterance that resolves today
//                 resolves identically.
//   2. learned  — a mishearing Dave has already corrected by hand (V5-VOICEALIAS-001).
//   3. folded   — spoken number words read as the digits in a name (BUG-VOICENUMWORD-001).
//   4. fuzzy    — closed-set scoring, for a mishearing nobody has taught yet.
// LEARNED BEATS FUZZY DELIBERATELY. Fuzzy is a guess that is right 77% of the time on adversarial
// input; an alias is a fact a human asserted. No score outranks that. Placing learned SECOND rather
// than first is equally deliberate: a strict match needs no rescue, and letting an alias shadow an
// exact name match would let one bad teach make a real planting unreachable.
//
// FOLDED SITS BETWEEN THEM, and both boundaries are deliberate:
//   * ABOVE FUZZY, because a fold is DERIVABLE — "eighteen eighty four" is 1884 by rule, not by
//     resemblance. Edit distance cannot reach it at all (measured: it scores 0.353 against
//     *helichrysum*), so letting a guess answer first would be strictly worse.
//   * BELOW LEARNED, because the layer-order principle above is about CONFIDENCE, not mechanism: a
//     correction a human actually made outranks one a rule derived. A fold is still an inference
//     about what was meant, and if Dave or Jen has explicitly taught this phrase, their word wins.
//     Aliases are user-scoped precisely because two people's recognisers mishear differently, and a
//     universal rule must not silently overrule one person's correction of their own device.
export function matchPlantingsWithRescue(plantings, spoken, aliasIndex = null) {
  const strict = matchPlantings(plantings, spoken)
  if (strict.length) return { hits: strict, rescued: null }

  const learned = resolveAlias(aliasIndex, spoken, plantings)
  if (learned.length) return { hits: learned, rescued: 'learned' }

  // Announced via a truthy `rescued` like any other non-strict outcome: Dave said words and got
  // digits back, so the caller quotes the heard text alongside the match. A fold that stayed silent
  // would look exactly like a clean match and hide the one step worth seeing.
  const folded = matchFolded(plantings, spoken)
  if (folded.length === 1) return { hits: folded, rescued: 'folded' }
  if (folded.length > 1) return { hits: folded, rescued: null }

  const res = fuzzyMatch(plantings, spoken, plantingAliases, looseKey)
  if (res.kind === 'one') return { hits: [res.planting], rescued: res.alias }
  if (res.kind === 'many') return { hits: res.hits.map((h) => h.planting), rescued: null }
  return { hits: [], rescued: null }
}

// THE GUARD THE GRAMMAR ASKS FOR AT THE CALL SITE, in its own words: "do not treat a whole-utterance
// command match as a command while the chooser's live result set contains an exact name match for
// that same text." A planting name is free text with no vocabulary file, so the grammar cannot check
// disjointness itself — a planting Dave named "Next" would otherwise be unselectable and would fire a
// save every time he said it. Only an EXACT alias match demotes a command; a partial one must not,
// or "save" would stop working the moment he grew something called Savoy.
export function resolveCommandCollision(result, plantings) {
  if (!result || result.kind !== 'command') return result
  const spoken = String(result.transcript ?? '')
  const key = looseKey(spoken)
  if (!key) return result
  const collides = plantings.some((p) => plantingAliases(p).some((a) => looseKey(a) === key))
  return collides ? { kind: 'search', text: spoken, transcript: spoken } : result
}

const TONE = {
  ok:   { bg: P.greenPale, border: P.green,       fg: P.dark },
  warn: { bg: P.warn,      border: P.warnBorder,  fg: P.dark },
  fail: { bg: P.alert,     border: P.alertBorder, fg: P.dark },
  idle: { bg: P.white,     border: P.border,      fg: P.light },
}

export default function VoiceHarvest() {
  const { fetch: apiFetch } = useApiFetch()

  const [plantings, setPlantings] = useState([])
  const [loadError, setLoadError] = useState(null)
  const [running, setRunning]     = useState(false)
  const [supported]               = useState(() => !!ctor())

  const [selected, setSelected]     = useState(null)
  const [candidates, setCandidates] = useState([])
  // The phrase that matched NOTHING, kept on screen so it stays teachable. Distinct from `candidates`
  // because the two render different affordances: a short list to confirm, versus a search box to
  // resolve from scratch.
  const [unmatched, setUnmatched]   = useState(null)
  const [qty, setQty]               = useState(null)     // { value, unit }
  const [weight, setWeight]         = useState(null)     // { value, unit }
  const [rows, setRows]             = useState([])       // committed harvests, newest last
  const [heard, setHeard]           = useState(null)     // the pending, not-yet-settled utterance
  const [status, setStatus]         = useState({ tone: 'idle', text: 'Tap Start, then say a crop.' })
  const [endsAt, setEndsAt]         = useState(null)

  // The recogniser and the run's own bookkeeping. Refs, not state: the recogniser callbacks fire
  // outside React's render cycle and must read CURRENT values, never the ones closed over at arm().
  const recRef      = useRef(null)
  const debRef      = useRef(null)
  const tickRef     = useRef(null)
  const wallRef     = useRef(null)
  const restartsRef = useRef(0)
  const stopRef     = useRef(false)

  // THE RECORD UNDER CONSTRUCTION, mirrored into refs. `setState` updaters are not a synchronous
  // read — a ref is the only synchronous truth — and the save path has to know, at the instant the
  // "next" commits, exactly what is on screen. Reading state here would save the previous record.
  const selectedRef = useRef(null)
  const qtyRef      = useRef(null)
  const weightRef   = useRef(null)
  const plantingsRef = useRef([])
  // V5-VOICEALIAS-001. `aliasRef` is the learned-mishearing index, consulted between strict and fuzzy.
  // `unmatchedRef` is the phrase that produced whatever the user is currently looking at — the thing
  // a tap would TEACH. It has to be a ref for the same reason the record slots are: the tap handler
  // must read what was actually heard, not what the last render closed over.
  const aliasRef    = useRef(null)
  const unmatchedRef = useRef(null)
  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { qtyRef.current = qty }, [qty])
  useEffect(() => { weightRef.current = weight }, [weight])
  useEffect(() => { plantingsRef.current = plantings }, [plantings])

  const say = useCallback((tone, text) => setStatus({ tone, text }), [])

  useEffect(() => {
    let live = true
    // ?view=picker — the narrow projection (V4-PICKERPAYLOAD-001). This page is now its THIRD
    // consumer and the census in lambda/plants/grid-view.test.js is extended to say so. Fields read
    // here: id, name, archived_at, variety_ref.{name,crop_type_slug,default_unit}. All present.
    apiFetch('/api/plants?view=picker')
      .then((r) => { if (live) setPlantings((r?.plants ?? r ?? []).filter((p) => !p.archived_at)) })
      .catch((e) => { if (live) setLoadError(e?.message || 'Could not load your plantings') })

    // V5-VOICEALIAS-001 — learned mishearings, fetched ALONGSIDE the plantings rather than gating
    // them. fetchAliases never rejects (it fails soft to []), and this deliberately sets no
    // loadError: a chooser that refuses to start because a cache of corrections could not load is
    // worse than one that has forgotten a few. Losing this degrades the page to its v4.78.0
    // behaviour — strict, then fuzzy — which is a working page.
    fetchAliases(apiFetch).then((rows) => { if (live) aliasRef.current = indexAliases(rows) })

    return () => { live = false }
  }, [apiFetch])

  const clearRecord = useCallback(() => {
    setSelected(null); setCandidates([]); setUnmatched(null); setQty(null); setWeight(null)
    selectedRef.current = null; qtyRef.current = null; weightRef.current = null
    unmatchedRef.current = null
  }, [])

  // V5-VOICEALIAS-001 — THE TEACH. One handler for every manual pick, so a correction is learned
  // from the candidate list and from the search box identically; two paths would mean one of them
  // silently never taught.
  //
  // SELECTION HAPPENS FIRST AND UNCONDITIONALLY. The user's actual job is logging a harvest, and the
  // teach is a side benefit — so a failed teach must never cost them the pick they just made. The
  // record is set before the network call and is not rolled back if it fails.
  //
  // A FAILED TEACH IS SAID OUT LOUD, unlike the failed alias READ, which is swallowed. The asymmetry
  // is the point: someone correcting the app has already been let down once, and a teach that
  // silently did nothing would let them believe it was fixed and meet the same failure tomorrow.
  const pickPlanting = useCallback(async (p) => {
    const phrase = unmatchedRef.current
    setSelected(p); selectedRef.current = p
    setCandidates([]); setUnmatched(null)
    const label = p.name || p.variety_ref?.name
    say('ok', `${label} — now say the count or the weight.`)

    const varietyId = p?.variety_ref?.id
    // Nothing to learn when the phrase already resolved strictly, and nothing to learn it AGAINST
    // when the picker payload carried no variety (a planting with no cultivar reference).
    if (!phrase || !varietyId) { unmatchedRef.current = null; return }
    unmatchedRef.current = null
    try {
      await teachAlias(apiFetch, { heardText: phrase, varietyId })
      // Update the live index immediately rather than waiting for a refetch, so saying it again in
      // THIS session already resolves — the correction has to be visibly true at once or the user
      // has no way to tell it worked.
      const next = new Map(aliasRef.current ?? [])
      next.set(looseKey(phrase), varietyId)
      aliasRef.current = next
      say('ok', `${label} — learned “${phrase}”. Now say the count or the weight.`)
    } catch (err) {
      say('warn', `${label} selected, but I could not remember “${phrase}” — ${err?.message || 'the save failed'}.`)
    }
  }, [apiFetch, say])

  // ── the save ────────────────────────────────────────────────────────────────────────────────────
  // Returns nothing and throws nothing: every outcome is a banner, a haptic and (on success) a row.
  // `token` is the debouncer's commit timestamp, which is how a failed write releases the cooldown
  // that a successful one armed — without it, Dave's natural retry is swallowed for 1500 ms.
  const saveRecord = useCallback(async (token) => {
    const plant = selectedRef.current
    const q = qtyRef.current
    const w = weightRef.current

    // REFUSE LOUDLY AND KEEP THE RECORD. Advancing over an unsaveable record is how a picking gets
    // silently lost, which is the one failure mode this flow is least allowed to have.
    if (!plant || !q) {
      const missing = !plant && !q ? 'a crop and a quantity' : !plant ? 'a crop' : 'a quantity'
      hapticSaveFailed()
      say('fail', `Not saved — still need ${missing}. Say it, then "next".`)
      debRef.current?.invalidateLastWrite(token)
      return
    }

    const label = plant.name || plant.variety_ref?.name || 'planting'
    try {
      const res = await apiFetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          // NULL BY DESIGN. The container is derived server-side (deriveEventProjectId), the same
          // rule dev 1f567ae applied to plantings — "no client should be expected to supply one".
          project_id: null,
          event_type: 'harvest',
          event_date: todayLocalISO(),
          notes: null,
          private_notes: null,
          quantity: null,           // harvests use the structured panel; the freetext field is nulled
          plant_id: plant.id,
          is_public: false,
          has_photo: false,
          metadata: { harvest_input_source: 'voice' },   // C8 — see the note below
          harvest: {
            quantity: Number(q.value),
            unit: q.unit,
            quality_rating: null,
            ...(w ? { weight: Number(w.value), weight_unit: w.unit } : {}),
          },
        }),
      })
      const eventId = res?.eventId ?? res?.event?.id ?? null
      hapticSaveCommitted()
      const said = `${q.value} ${q.unit}${w ? ` · ${w.value} ${w.unit}` : ''}`
      say('ok', `Saved ${label} — ${said}`)
      setRows((r) => [...r, { eventId, label, said, at: Date.now() }])
      clearRecord()
    } catch (err) {
      // The row did not land. Say so on every channel, keep the record so nothing is retyped, and
      // release the cooldown so "next" is a real retry.
      hapticSaveFailed()
      say('fail', `NOT SAVED — ${err?.message || 'the save failed'}. Say "next" to try again.`)
      debRef.current?.invalidateLastWrite(token)
    }
  }, [apiFetch, clearRecord, say])

  const undoRow = useCallback(async (idx) => {
    const row = rows[idx]
    if (!row?.eventId) return
    try {
      await apiFetch(`/api/events/${row.eventId}`, { method: 'DELETE' })
      hapticUndoApplied()
      setRows((r) => r.map((x, i) => (i === idx ? { ...x, undone: true } : x)))
      say('warn', `Removed ${row.label} — ${row.said}`)
    } catch (err) {
      hapticSaveFailed()
      say('fail', `Could not remove that row — ${err?.message || 'the delete failed'}`)
    }
  }, [apiFetch, rows, say])

  // ── one settled utterance ───────────────────────────────────────────────────────────────────────
  const applyCommitted = useCallback((raw, meta) => {
    const result = resolveCommandCollision(raw, plantingsRef.current)

    if (result.kind === 'search') {
      // `rescued` is the alias a FUZZY match landed on, or null when the strict matcher answered.
      // It exists to be said out loud: a rescue that stays silent is a guess wearing the costume of a
      // clean match, and this flow's rule is that every outcome is announced. Dave hears which words
      // were swapped, so a wrong rescue is caught before "next" rather than after the save.
      const { hits, rescued } = matchPlantingsWithRescue(
        plantingsRef.current, result.text, aliasRef.current,
      )
      // What a tap would teach. Recorded for EVERY non-strict outcome — a total miss, an ambiguous
      // list, and a fuzzy rescue alike — because all three are cases where the user is about to tell
      // us what they actually meant. Cleared on a strict match: there is nothing to learn from a
      // phrase that already resolved exactly.
      unmatchedRef.current = rescued === null && hits.length === 1 ? null : result.text
      if (hits.length === 0) {
        hapticDigitRejected()
        // The phrase survives into the candidate-less state so the manual picker below can still
        // teach it. Without this, a total miss — the case most worth learning from — is the one case
        // that cannot be taught.
        setCandidates([])
        setUnmatched(result.text)
        say('fail', `Nothing matched “${result.text}”. Say it again, or pick it below to teach me.`)
        return
      }
      setUnmatched(null)
      if (hits.length === 1) {
        hapticDigitAccepted()
        setSelected(hits[0]); selectedRef.current = hits[0]
        setCandidates([])
        // NO DEFAULT QUANTITY IS SEEDED HERE, and that is a correction rather than an omission.
        // This branch briefly pre-filled `{ value: 1, unit: variety_ref.default_unit }` so a weighed
        // crop would be "complete" from the weight alone. Caught in the browser harness, not in a
        // test: it made the record LOOK complete, so saying "Suyo Long" then "next" — with no count
        // ever spoken — saved a harvest of 1 count that Dave never said, and announced it as a
        // success. That is exactly the silent wrong save this whole flow exists to make impossible.
        //
        // It also bought nothing. The grammar only parses a quantity from a number carrying a
        // trailing unit ("three count"), so a bare "three" returns `unparsed` either way — the
        // default unit had no utterance it could rescue. A quantity now exists only if it was said.
        const chosen = hits[0].name || hits[0].variety_ref?.name
        say('ok', rescued
          // The heard text is quoted back verbatim so the swap is legible at a glance. Without the
          // "heard X" half, a rescue of the WRONG planting reads exactly like a correct match.
          ? `Heard “${result.text}” — matched ${chosen}. Say the count, or say it again to change it.`
          : `${chosen} — now say the count or the weight.`)
        return
      }
      hapticDigitRejected()
      setCandidates(hits.slice(0, 8))
      say('warn', `${hits.length} match “${result.text}” — say more of the name, or tap one.`)
      return
    }

    if (result.kind === 'quantity') {
      hapticDigitAccepted()
      const next = { value: result.value, unit: result.unit }
      setQty(next); qtyRef.current = next
      say(result.implausible ? 'warn' : 'ok',
        result.implausible ? `${result.value} ${result.unit} — that looks high. Say it again to correct it.`
          : `${result.value} ${result.unit}`)
      return
    }

    if (result.kind === 'weight') {
      hapticDigitAccepted()
      const next = { value: result.value, unit: result.unit }
      setWeight(next); weightRef.current = next
      say(result.implausible ? 'warn' : 'ok',
        result.implausible ? `${result.value} ${result.unit} — that looks high. Say it again to correct it.`
          : `${result.value} ${result.unit}`)
      return
    }

    if (result.kind === 'command') {
      if (result.command === 'save_and_advance' || result.command === 'save') {
        saveRecord(meta?.atMs)
        return
      }
      if (result.command === 'clear_field') {
        hapticDigitAccepted()
        clearRecord()
        say('warn', 'Cleared. Say a crop to start the next one.')
        return
      }
      if (result.command === 'finish') {
        stopRef.current = true
        try { recRef.current?.stop() } catch { /* already stopping */ }
        say('warn', 'Stopped listening.')
        return
      }
    }

    // unparsed — INCLUDING a near-miss of a command word. The grammar routes "text" (a measured 1-in-9
    // mishear of "next") here rather than to search, precisely so it cannot perform a different
    // action that looks like it worked. Costs one repeated word; says so out loud.
    //
    // `ambiguous-number` (BUG-VOICENUMSUM-001) needs its OWN sentence, not the generic one. It fires
    // when the utterance carried more than one number — the shape you get saying a planting NAMED
    // after a number together with the amount ("1884 two count"). A bare "Didn't catch that" is a
    // dead end there: the recogniser heard him perfectly, so he repeats it more clearly, gets the
    // same refusal, and has no way to discover that the name is being read as part of the count.
    hapticDigitRejected()
    const hint = result.reason === 'near-command' ? ' — say "next" again'
      : result.reason === 'ambiguous-number' ? ' — say the planting, then the amount separately'
      : ''
    say('warn', `Didn't catch that${hint}.`)
  }, [clearRecord, saveRecord, say])

  // ── the recogniser ──────────────────────────────────────────────────────────────────────────────
  const scheduleTickRef = useRef(null)
  const scheduleTick = useCallback(() => {
    if (tickRef.current) { clearTimeout(tickRef.current); tickRef.current = null }
    const deb = debRef.current
    if (!deb) return
    const due = deb.dueAt()
    if (due == null) return
    tickRef.current = setTimeout(() => {
      tickRef.current = null
      debRef.current?.tick(Date.now())
      scheduleTickRef.current?.()
    }, Math.max(0, due - Date.now()))
  }, [])
  useEffect(() => { scheduleTickRef.current = scheduleTick }, [scheduleTick])

  const arm = useCallback(() => {
    const C = ctor()
    if (!C) { say('fail', 'This browser has no speech recognition.'); setRunning(false); return }
    const rec = new C()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.lang = 'en-US'
    recRef.current = rec

    rec.onresult = (ev) => {
      const results = ev.results || []
      for (let i = ev.resultIndex || 0; i < results.length; i++) {
        const r = results[i]
        if (!r || !r[0] || !r.isFinal) continue
        debRef.current?.final(r[0].transcript || '', Date.now())
        scheduleTick()
      }
    }
    rec.onerror = (ev) => {
      const e = ev?.error
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        stopRef.current = true
        say('fail', 'Microphone permission was refused. Allow the mic, then tap Start.')
      } else if (e === 'audio-capture') {
        stopRef.current = true
        say('fail', 'No microphone available.')
      }
      // 'no-speech' and 'aborted' are ordinary in a continuous session — onend re-arms.
    }
    rec.onend = () => {
      // A DATA utterance flushes at the session boundary; a WRITE deliberately does not, and waits
      // out the settle window on a tick. That asymmetry is the whole reason a bare "next" can be
      // superseded by "next to the fence" instead of having already saved.
      debRef.current?.sessionEnd(Date.now())
      scheduleTick()
      if (stopRef.current) { setRunning(false); return }
      if (restartsRef.current >= RUN_BUDGET.restarts) {
        setRunning(false)
        say('warn', 'Stopped — session limit reached. Tap Start to carry on.')
        return
      }
      restartsRef.current += 1
      // Gesture-free re-arm. Measured on Dave's Android 2026-08-27: 16–133 ms, no permission
      // re-prompt. If it ever throws, hands-free is off the table and the message says so plainly
      // rather than leaving a dead mic that looks live.
      try { rec.start() } catch {
        setRunning(false)
        say('fail', 'The mic could not restart on its own. Tap Start to keep going.')
      }
    }
    try { rec.start() } catch { setRunning(false); say('fail', 'The mic would not start. Tap Start again.') }
  }, [say, scheduleTick])

  const start = useCallback(() => {
    stopRef.current = false
    restartsRef.current = 0
    setRunning(true)
    setRows((r) => r)   // the ledger persists across a stop/start within the visit
    say('ok', 'Listening — say a crop.')

    // A FRESH DEBOUNCER PER RUN. resetSession() would clear duplicate-suppression memory while a
    // pending utterance from the previous run might still be held, which its own docstring warns
    // hosts against. A new instance has no history to mis-clear.
    debRef.current = createCommitDebouncer({
      onCommit: applyCommitted,
      onPending: (r) => setHeard(r),
      onSuppressed: (r, reason) => {
        // A swallowed command with no signal is indistinguishable from a dead mic. Say which.
        if (reason === 'cooldown') say('warn', 'Heard "next" twice in a moment — saved once.')
        else if (reason === 'stale') say('warn', 'That "next" went stale and was not saved. Say it again.')
      },
    })

    arm()
    const until = Date.now() + RUN_BUDGET.runMs
    setEndsAt(until)
    wallRef.current = setTimeout(() => {
      stopRef.current = true
      try { recRef.current?.stop() } catch { /* ignore */ }
      say('warn', `Stopped after ${RUN_BUDGET.label}. Tap Start to carry on.`)
    }, RUN_BUDGET.runMs)
  }, [applyCommitted, arm, say])

  const stop = useCallback(() => {
    stopRef.current = true
    if (wallRef.current) { clearTimeout(wallRef.current); wallRef.current = null }
    setEndsAt(null)
    try { recRef.current?.stop() } catch { /* ignore */ }
    say('idle', 'Stopped.')
  }, [say])

  // RELEASE THE MIC ON UNMOUNT, however the page is left. abort() rather than stop(): stop() is the
  // graceful shutdown that asks the engine to FINALISE, and a final dispatched into an unmounted
  // component would commit against nothing.
  useEffect(() => () => {
    stopRef.current = true
    if (wallRef.current) clearTimeout(wallRef.current)
    if (tickRef.current) clearTimeout(tickRef.current)
    const rec = recRef.current
    if (rec) { rec.onresult = null; rec.onend = null; rec.onerror = null; try { rec.abort() } catch { /* gone */ } }
    recRef.current = null
    debRef.current = null
  }, [])

  const tone = TONE[status.tone] ?? TONE.idle
  const liveRows = rows.filter((r) => !r.undone)
  const totalLabel = useMemo(() => {
    if (!liveRows.length) return null
    return `${liveRows.length} harvest${liveRows.length === 1 ? '' : 's'} saved this session`
  }, [liveRows.length])

  const card = { background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }

  return (
    <div style={{ padding: 16, maxWidth: 680, margin: '0 auto' }} data-testid="voice-harvest">
      <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: P.dark, margin: '0 0 4px' }}>
        Harvest by voice
      </h1>
      <p style={{ fontSize: '0.82rem', color: P.light, lineHeight: 1.5, margin: '0 0 14px' }}>
        Say the crop, then the count, then the weight, then <strong>“next”</strong> to save and start
        the following one. The normal harvest form is untouched under Log an event.
      </p>

      {!supported && (
        <div style={{ ...card, background: P.alert, borderColor: P.alertBorder }} role="alert">
          This browser has no speech recognition. Use Log an event instead.
        </div>
      )}
      {loadError && (
        <div style={{ ...card, background: P.alert, borderColor: P.alertBorder }} role="alert">
          {loadError}
        </div>
      )}

      {/* THE LOUD CHANNEL. aria-live so it is announced, role=status so it never steals focus, and
          large enough to read at arm's length with wet hands — this is the surface that has to make
          a failed capture impossible to miss (BUG-VOICEFAILSILENT-001). */}
      <div
        data-testid="voice-harvest-status"
        role="status"
        aria-live="assertive"
        style={{
          ...card, background: tone.bg, borderColor: tone.border, color: tone.fg,
          fontSize: '1.05rem', fontWeight: 600, lineHeight: 1.4, minHeight: 62,
          display: 'flex', alignItems: 'center',
        }}
      >
        {status.text}
      </div>

      {/* The record under construction. Rendered as three named slots rather than a sentence, so a
          missing one is visible as a gap instead of having to be inferred from prose. */}
      <div style={card} data-testid="voice-harvest-record">
        <Slot label="Crop"     value={selected ? (selected.name || selected.variety_ref?.name) : null} />
        {/* Every value in these three slots was SPOKEN. Nothing is pre-filled and nothing carries a
            default, so a slot reading "—" means the words have not been said yet — which is the only
            reading that lets a glance at this card be trusted. */}
        <Slot label="Quantity" value={qty ? `${qty.value} ${qty.unit}` : null} />
        <Slot label="Weight"   value={weight ? `${weight.value} ${weight.unit}` : null} />
        <div style={{ marginTop: 6, fontSize: '0.78rem', color: P.light, fontStyle: 'italic' }} data-testid="voice-harvest-heard">
          hearing: {heard ? (heard.transcript || '—') : '—'}
        </div>
      </div>

      {candidates.length > 0 && (
        <div style={card} data-testid="voice-harvest-candidates">
          <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 6, color: P.dark }}>
            Which one?
          </div>
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickPlanting(c)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '10px 12px',
                marginBottom: 6, borderRadius: 8, border: `1px solid ${P.border}`, background: P.cream,
                fontSize: '0.95rem', fontFamily: 'inherit', color: P.dark, cursor: 'pointer',
              }}
            >
              {c.name || c.variety_ref?.name}
              {c.variety_ref?.crop_type_slug ? <span style={{ color: P.light }}> · {c.variety_ref.crop_type_slug}</span> : null}
            </button>
          ))}
        </div>
      )}

      {/* THE TEACH SURFACE, and the reason the whole learning layer can work at all. Before this,
          a phrase that matched NOTHING left no way to say what it meant — which made the case most
          worth learning from the one case that could not be taught. Typing here is the escape hatch
          from a name the recogniser will never get right, AND the moment the correction is captured. */}
      {unmatched && (
        <TeachPicker
          phrase={unmatched}
          plantings={plantings}
          onPick={pickPlanting}
          onDismiss={() => { setUnmatched(null); unmatchedRef.current = null }}
        />
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={!supported}
          data-testid="voice-harvest-toggle"
          style={{
            flex: 1, minHeight: 56, borderRadius: 10, border: 'none',
            background: running ? P.terra : P.green, color: P.white,
            fontSize: '1.05rem', fontWeight: 700, fontFamily: 'inherit',
            cursor: supported ? 'pointer' : 'not-allowed', opacity: supported ? 1 : 0.5,
          }}
        >
          {running ? 'Stop listening' : 'Start listening'}
        </button>
      </div>
      {running && endsAt && (
        <p style={{ fontSize: '0.75rem', color: P.light, margin: '0 0 12px' }}>
          The mic stops on its own after {RUN_BUDGET.label}.
        </p>
      )}

      <div style={card} data-testid="voice-harvest-ledger">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: P.dark, marginBottom: 6 }}>
          {totalLabel ?? 'Nothing saved yet'}
        </div>
        {rows.map((r, i) => (
          <div
            key={`${r.at}-${i}`}
            data-testid="voice-harvest-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${P.border}`,
              opacity: r.undone ? 0.45 : 1,
              textDecoration: r.undone ? 'line-through' : 'none',
            }}
          >
            <span style={{ flex: 1, fontSize: '0.9rem', color: P.dark }}>
              {r.label} <span style={{ color: P.light }}>· {r.said}</span>
            </span>
            {!r.undone && r.eventId && (
              <button
                type="button"
                onClick={() => undoRow(i)}
                aria-label={`Undo ${r.label} ${r.said}`}
                style={{
                  minHeight: 44, padding: '0 14px', borderRadius: 8,
                  border: `1px solid ${P.border}`, background: P.white,
                  fontSize: '0.85rem', fontFamily: 'inherit', color: P.terra, cursor: 'pointer',
                }}
              >
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// V5-VOICEALIAS-001 — resolve a phrase the recogniser mangled beyond matching, and teach it.
//
// A PLAIN TEXT INPUT, NOT the PlantingSelect combobox, and that is a deliberate refusal to reuse.
// PlantingSelect owns its own microphone (comboboxInput's SPEAK mode), and mounting it here would
// put a second recogniser on a page that already has one running continuously — the exact collision
// the unbuilt S1 mic arbiter exists to prevent. This is a filter over the plantings already in
// memory: no fetch, no mic, no combobox machinery.
//
// TYPING IS THE POINT. The user reaches this because speech failed, so the input opens with the
// keyboard available rather than suppressed — the opposite default from the voice-first pickers.
function TeachPicker({ phrase, plantings, onPick, onDismiss }) {
  const [q, setQ] = useState('')
  const matches = useMemo(() => {
    const query = q.trim()
    if (!query) return []
    return plantings
      .filter((p) => plantingAliases(p).some((a) => looseIncludes(a, query)))
      .slice(0, 8)
  }, [q, plantings])

  return (
    <div
      data-testid="voice-harvest-teach"
      style={{
        background: P.white, border: `1px solid ${P.border}`, borderRadius: 10,
        padding: 12, marginBottom: 12,
      }}
    >
      <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: 2, color: P.dark }}>
        What did you mean by “{phrase}”?
      </div>
      <div style={{ fontSize: '0.78rem', color: P.light, marginBottom: 8, lineHeight: 1.4 }}>
        Type it and pick one — I’ll remember that “{phrase}” means that from now on.
      </div>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Start typing a crop or variety"
        aria-label={`What did you mean by ${phrase}`}
        style={{
          width: '100%', minHeight: 44, padding: '8px 10px', boxSizing: 'border-box',
          borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '1rem',
          fontFamily: 'inherit', color: P.dark, background: P.cream, marginBottom: 8,
        }}
      />
      {matches.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onPick(m)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', minHeight: 44, padding: '10px 12px',
            marginBottom: 6, borderRadius: 8, border: `1px solid ${P.border}`, background: P.cream,
            fontSize: '0.95rem', fontFamily: 'inherit', color: P.dark, cursor: 'pointer',
          }}
        >
          {m.name || m.variety_ref?.name}
          {m.variety_ref?.crop_type_slug
            ? <span style={{ color: P.light }}> · {m.variety_ref.crop_type_slug}</span> : null}
        </button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        style={{
          minHeight: 44, padding: '0 14px', borderRadius: 8, border: `1px solid ${P.border}`,
          background: P.white, fontSize: '0.85rem', fontFamily: 'inherit', color: P.light,
          cursor: 'pointer',
        }}
      >
        Skip — just say it again
      </button>
    </div>
  )
}

function Slot({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '4px 0', fontSize: '0.95rem' }}>
      <span style={{ width: 76, flex: '0 0 auto', color: P.light }}>{label}</span>
      <span style={{ color: value ? P.dark : P.light, fontWeight: value ? 600 : 400 }}>
        {value ?? '—'}
      </span>
    </div>
  )
}
