// src/components/putup/goingNow.js
// V5-INFLIGHTBATCH-001 — the pure half of the "Going now" view (a third segment on /put-up, NOT a
// new page and NOT a seventh bottom-nav tab: PutUp.jsx:44-46 already records the house pattern for
// "a thing you are in the middle of" as a mode/view flag on an existing page).
//
// Everything here is a pure function of a `v_kitchen_batch_current` row plus an explicit `now`.
// That is deliberate and is the only way this lane can be tested at all: the migration has not been
// applied to any database (API-CONTRACT §1), so there is nothing to integration-test against and
// every assertion has to bite on logic rather than on data.
//
// THE RULINGS THIS FILE ENFORCES (crucible DECISION-V100, API-CONTRACT §3) — each one is a thing
// this module deliberately does NOT compute, so read the absences as hard as the presences:
//   1. NO age-derived readiness. No "due", no remaining days, no progress ring, no duration bar, no
//      "day 12 of 21". A ferment that stalled at pH 4.8 looks normal, smells normal and has no
//      visible defect, so elapsed time is the one variable that cannot detect it. `describeAge`
//      returns a DESCRIPTION and nothing in this file turns a description into a verdict.
//      STRENGTHENED 2026-09-04 by the food-safety adjudication: for a ferment this holds at EVERY
//      start precision, including exact. See the two gates on `describeExpectedWindow` below.
//   3. The timer counts SINCE YOU LAST LOOKED (`current_stage_entered_at`), never toward a finish.
//   4. NO urgency tone at all, per stage or otherwise. Risk decays across a preservation process —
//      a 40-day pepper mash is not late, a six-week mash is a better mash — and a card that reddens
//      for a thing that is fine teaches the user that red means nothing. SavedSeeds' FERMENT_WARN /
//      FERMENT_ALARM mechanism is NOT copied here; seed ferments have a real day-5 cliff (the seed
//      sprouts in the jar) and kitchen batches do not.
//   6. An unknown start is a PERMANENT, ACCEPTABLE TERMINAL STATE. See `startPromptState`.
// Nothing here says anything about pH, acidification, safety or shelf stability — that adjudication
// is running separately and is unlanded (API-CONTRACT §3.2).

// ── start precision ──────────────────────────────────────────────────────────────────────────────
// chk_kitchen_batch_start_precision's six values, ordered coarsest-last. A row whose precision the
// client does not recognise ranks WORSE than every known grade rather than better: an unrecognised
// value is unknown reliability, and the only safe direction to round unknown reliability is down.
const PRECISION_RANK = { exact: 0, hour: 1, day: 2, week: 3, month: 4, unknown: 5 }
export const UNRANKED_PRECISION = 9

export function precisionRank(precision) {
  if (precision == null) return UNRANKED_PRECISION
  return PRECISION_RANK[precision] ?? UNRANKED_PRECISION
}

// "Day or better" is the gate for every affordance that pairs the start with an expected duration.
// Ruling 1 names the mechanism precisely: pairing a GUESSED start with an expected window licenses
// "it's been long enough", which is the exact sentence a stalled ferment needs nobody to say.
export function startIsDayOrBetter(batch) {
  return precisionRank(batch?.start_precision) <= PRECISION_RANK.day
}

// ── elapsed ──────────────────────────────────────────────────────────────────────────────────────
// SavedSeeds.elapsed() floors to days and renders 'today' under 24 h, which reads a dehydrator run
// started four hours ago as "today" — the one number that decides whether to go and check it. So
// this carries an hours branch, and the unit is selected by MAGNITUDE while the "about" qualifier is
// selected by PRECISION (see describeAge). The two are decoupled on purpose: they answer different
// questions and conflating them is how a coarse grade silently becomes a confident figure.
const HOUR_MS = 3600000
const DAY_MS = 86400000
const WEEK_UNIT_FROM_DAYS = 21   // 3 weeks reads better than "21 days"
const MONTH_UNIT_FROM_DAYS = 60
const DAYS_PER_MONTH = 30.44

function plural(n, unit) { return `${n} ${unit}${n === 1 ? '' : 's'}` }

// Returns null for an unparseable/absent instant — a caller must render nothing rather than a zero,
// because "0 days" is indistinguishable from missing data.
export function describeElapsed(iso, nowMs) {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const ms = Math.max(0, nowMs - then)
  if (ms < HOUR_MS) return 'less than an hour'
  if (ms < DAY_MS) return plural(Math.floor(ms / HOUR_MS), 'hour')
  const days = Math.floor(ms / DAY_MS)
  if (days < WEEK_UNIT_FROM_DAYS) return plural(days, 'day')
  if (days < MONTH_UNIT_FROM_DAYS) return plural(Math.round(days / 7), 'week')
  return plural(Math.round(days / DAYS_PER_MONTH), 'month')
}

// ── the card's lead line ─────────────────────────────────────────────────────────────────────────
// Shape, never a string, so the component owns the formatting and the test owns the decision:
//   { kind: 'elapsed', text, approx }        — a real start, with its grade carried as `approx`
//   { kind: 'first_recorded', at }           — no start; the HONEST FLOOR, per the 0a DDL comment:
//                                              "'First recorded Sep 3' is a fact even when the start
//                                              is not, and it is what the card leads with instead of
//                                              a blank."
//
// DIVERGENCE, recorded rather than smuggled: the brief's illustrative literal for a no-start card is
// `**Pepper mash** · about 3 weeks · Set a start date →`. "about 3 weeks" cannot be derived from a
// row whose only instant is first_recorded_at without presenting a FLOOR as an AGE, which is the
// readiness-computation ruling 1 forbids. The DDL is the schema authority and is explicit about what
// this card leads with, so the floor is rendered as provenance and the divergence is in the lane
// report. A `week`-precision batch that DOES carry a started_at renders exactly "about 3 weeks".
export function describeAge(batch, nowMs) {
  if (!batch) return null
  if (batch.started_at) {
    const text = describeElapsed(batch.started_at, nowMs)
    if (!text) return null
    return { kind: 'elapsed', text, approx: !startIsDayOrBetter(batch) }
  }
  if (!batch.first_recorded_at) return null
  return { kind: 'first_recorded', at: batch.first_recorded_at }
}

// ── expected duration ────────────────────────────────────────────────────────────────────────────
// TWO GATES, and they close for different reasons. Both must pass.
//
// GATE A — KIND. For a ferment, elapsed time supports NO readiness affordance at ANY start
// precision, including a start known to the second. This is stricter than the contract's original
// rule and supersedes it; the food-safety adjudication landed 2026-09-04
// (project-state/_build-inflight-20260904/foodsafety-research.md) and the reason is not uncertainty
// about the date. It is that elapsed time is not evidence about a ferment at all: BC CDC — "no
// standard set of time to a required pH drop is provided based on vegetable category"; Snyder et al.
// — pH is "the only critical control of significance"; and decisively UMN Extension — bubbling can
// cease while pH is still above 4.6, so the visible completion proxy and the actual safety criterion
// can and do disagree. A perfectly known start date tells you nothing a guessed one doesn't.
//
// FAIL-CLOSED ON AN UNCLASSIFIED BATCH. `kind` is nullable by design (the capture path never asks),
// and `other` names something the app cannot reason about — so neither may render a window either.
// The app cannot rule out that an unlabelled crock is a ferment, and an allowlist is the only shape
// where adding a kind later is a deliberate act rather than an accident. The five named non-ferment
// kinds keep the behaviour they had; whether any of them should is a separate, unadjudicated
// question (the research finds no home guidance for candied endpoints at all, and NCHFP's
// dehydrating endpoint is TEXTURE — "brittle or crisp" — not elapsed time).
export const DURATION_KINDS = new Set(['dehydrate', 'candy', 'cure', 'infuse', 'age'])

// GATE B — PRECISION. Day-or-better, the original ruling, retained for the kinds that pass gate A:
// a window is honest on its own but reads as a readiness claim the moment it sits beside a start the
// app only guessed at. En dash and both bounds, always — a half-rendered range is the assertion bug
// this repo already shipped once.
export function describeExpectedWindow(batch) {
  if (!batch) return null
  if (!DURATION_KINDS.has(batch.kind)) return null
  const { expected_days_min: min, expected_days_max: max } = batch
  if (min == null || max == null) return null
  if (!startIsDayOrBetter(batch)) return null
  return min === max ? `usually ${plural(min, 'day')}` : `usually ${min}–${max} days`
}

// ── the one affordance the evidence base actually supports ───────────────────────────────────────
// A recurring SUBMERSION PROMPT. The mechanism is documented at three levels of authority (NCHFP,
// USDA ARS, FDA): solids above the brine line → aerobic film organisms → those organisms CONSUME the
// lactic acid → pH rises → the botulism window reopens. Penn State issues it as a standing action —
// "check the sauerkraut two to three times each week and remove scum if it forms" — which is a
// SCHEDULE, and a schedule is the one thing a tool that knows only a date can do honestly.
//
// It is a prompt to go and look. It is never an assessment of the batch, and it is deliberately NOT
// accompanied by a list of failure signs: presenting failure signs invites the inference that their
// absence means success, and that inference is the specific error behind the documented olive
// botulism outbreak (measured pH 6.5, no sensory alarm recorded). One question, no verdict, no
// second clause. Nothing about pH, salt, acidification, safety or shelf stability.
//
// KNOWN ferments only — the opposite fail-direction from DURATION_KINDS above, and correctly so:
// suppressing an affordance for an unclassified batch fails closed, whereas ASKING about brine on
// what might be a dehydrator run fails open into nonsense.
export const SUBMERSION_KIND = 'ferment'
export const SUBMERSION_CHECK_DAYS = 2   // Penn State's "two to three times each week"
export const SUBMERSION_PROMPT = 'Everything still under the brine?'

// Keyed on when you LAST LOOKED, never on how far along anything is — the same instant the stage
// line reads. Silent inside the cadence because you have already looked, which is a statement about
// your attention and not about the jar.
export function submersionPrompt(batch, nowMs) {
  if (!batch || batch.kind !== SUBMERSION_KIND) return null
  const since = batch.current_stage_entered_at || batch.first_recorded_at
  if (!since) return null
  const then = new Date(since).getTime()
  if (Number.isNaN(then)) return null
  if (nowMs - then < SUBMERSION_CHECK_DAYS * DAY_MS) return null
  return SUBMERSION_PROMPT
}

// ── the missing-datum CTA ────────────────────────────────────────────────────────────────────────
// THE THREE STATES ARE NOT TWO. The 0a DDL is explicit that the two started_at-NULL states are
// different claims: "an un-asked batch may prompt, an `unknown` one must never prompt again."
//   start_precision NULL      → never asked          → 'prompt'
//   start_precision 'unknown' → asked, doesn't know  → 'silent', FOREVER (ruling 6: permanent,
//                               acceptable terminal state — never a badge, never a warning colour,
//                               never a "complete this" affordance)
//   started_at set            → nothing missing      → 'silent'
export function startPromptState(batch) {
  if (!batch) return 'silent'
  if (batch.started_at) return 'silent'
  return batch.start_precision == null ? 'prompt' : 'silent'
}

// ── suspended ────────────────────────────────────────────────────────────────────────────────────
// Ruling from the DDL: "A frozen candy parent resumes N times over months; showing it beside a day-2
// syrup pot as equally 'in flight' misreports the only thing the Going-now view exists to say."
// suspended_at is the discriminator, and it is NOT closed_at — chk_kitchen_batch_suspend_exclusive
// makes the two mutually exclusive, and `state=going` returns both suspended and active rows.
export function isSuspended(batch) { return !!batch?.suspended_at }

// ── ordering ─────────────────────────────────────────────────────────────────────────────────────
// `started_at DESC NULLS LAST, first_recorded_at DESC`, mirroring the server's ORDER BY. The client
// re-sorts rather than trusting transport order for two reasons: an unknown start outranking a
// measured one at the top of a "check this" list is the exact defect SavedSeeds.jsx:594-613 already
// ruled on, and with no database to integration-test against this is the ONLY layer at which that
// ruling can be gated by a test at all.
function descInstant(a, b) {
  const av = a == null ? null : new Date(a).getTime()
  const bv = b == null ? null : new Date(b).getTime()
  const aBad = av == null || Number.isNaN(av)
  const bBad = bv == null || Number.isNaN(bv)
  if (aBad && bBad) return 0
  if (aBad) return 1        // NULLS LAST
  if (bBad) return -1
  return bv - av
}

export function sortGoing(rows) {
  if (!Array.isArray(rows)) return []
  return [...rows].sort((a, b) => (
    descInstant(a?.started_at, b?.started_at) || descInstant(a?.first_recorded_at, b?.first_recorded_at)
  ))
}

// Active first, paused second, each sorted independently. Two lists rather than one sorted key,
// because "paused" is a different answer to "what needs me", not a lower-ranked one.
export function partitionGoing(rows) {
  const all = sortGoing(rows)
  return { active: all.filter(r => !isSuspended(r)), paused: all.filter(isSuspended) }
}

// ── stage line ───────────────────────────────────────────────────────────────────────────────────
// STAGE ORDER IS NOT MONOTONIC — a `tended` row legitimately follows a `finished` one (three of six
// documented candy recoveries re-enter the sequence). Nothing here derives a position in a sequence,
// a next stage, or a percentage; it names the newest row the view already picked and says when.
const STAGE_KIND_LABELS = {
  started: 'Started', tended: 'Tended', moved: 'Moved', finished: 'Finished', failed: 'Failed',
}

// The auto-written `started` row is SILENT in both halves. Every batch has one (POST writes it in
// the same transaction as the insert), so "Started" on every card carries zero information, and
// "last touched" is a claim about a LATER touch — on a batch nobody has touched yet it would just be
// the age again under a name that implies attention was paid.
export function describeStage(batch, nowMs) {
  if (!batch) return null
  const kind = batch.current_stage_kind
  const custom = batch.current_stage_label || null
  const untouched = kind === 'started' && !custom
  if (untouched) return { label: null, since: null }
  const label = custom || STAGE_KIND_LABELS[kind] || null
  const since = describeElapsed(batch.current_stage_entered_at, nowMs)
  if (!label && !since) return null
  // "last touched" — ruling 3. The question is when you last looked, not how long is left.
  return { label, since: since ? `last touched ${since} ago` : null }
}

// ── setting a start date after the fact ──────────────────────────────────────────────────────────
// Ruling 5: NEVER ask for a precision grade. `exact` vs `day` are not humanly distinguishable and
// asking someone to rate the reliability of their own memory is a second decision stacked on the one
// already avoided. The grade is DERIVED from which chip was tapped; uncertainty is expressed by
// choosing a wider chip, which is a natural act.
//
// `days` is the midpoint of the band the chip names, which minimises the worst-case error the stored
// instant can carry ("2–3 weeks" → 18, the rounded midpoint of 14 and 21). `anchor` records HOW the
// value was arrived at, so a later reader can tell a remembered date from a picked one.
export const START_CHIPS = [
  { value: 'today',      label: 'Today',             days: 0,    precision: 'exact',   anchor: 'memory' },
  { value: 'yesterday',  label: 'Yesterday',         days: 1,    precision: 'day',     anchor: 'memory' },
  { value: 'few_days',   label: 'A few days ago',    days: 3,    precision: 'day',     anchor: 'memory' },
  { value: 'about_week', label: 'About a week',      days: 7,    precision: 'week',    anchor: 'memory' },
  { value: 'few_weeks',  label: '2–3 weeks',         days: 18,   precision: 'week',    anchor: 'memory' },
  { value: 'unsure',     label: 'Longer / not sure', days: null, precision: 'unknown', anchor: 'memory' },
]

// A calendar date has no time-of-day, and midnight is the one instant a timezone can move across a
// day boundary. Local NOON is the standard defence and is why this is not `new Date(ymd)`, which
// parses a bare YYYY-MM-DD as UTC and lands the previous day for every negative offset.
export function ymdToInstant(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const d = new Date(`${ymd}T12:00:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// The PUT body for one chip. Keys are exactly three of the PUT allowlist (API-CONTRACT §2) and the
// route is a MERGE, so an absent key is left alone — this never touches label, kind or notes.
export function startChipPatch(chipValue, nowMs) {
  const chip = START_CHIPS.find(c => c.value === chipValue)
  if (!chip) return null
  if (chip.days == null) {
    // 'unknown' is the one grade that pairs with a NULL instant, and it is a TERMINAL answer: the
    // card stops prompting after this, permanently.
    return { started_at: null, start_precision: 'unknown', start_anchor_kind: chip.anchor }
  }
  return {
    started_at: new Date(nowMs - chip.days * DAY_MS).toISOString(),
    start_precision: chip.precision,
    start_anchor_kind: chip.anchor,
  }
}

export function pickedDatePatch(ymd) {
  const at = ymdToInstant(ymd)
  if (!at) return null
  return { started_at: at, start_precision: 'day', start_anchor_kind: 'manual' }
}

// chk_kitchen_batch_start_pairing, restated in the client so a patch that could never commit is
// caught before it is sent: "(started_at IS NOT NULL) = (start_precision IS NOT NULL AND
// start_precision <> 'unknown')". The biconditional is what makes the four start states the ONLY
// four, and a client that can build a fifth would surface as an opaque 400.
export function startPatchViolatesPairing(patch) {
  if (!patch) return true
  const hasDate = patch.started_at != null
  const hasGrade = patch.start_precision != null && patch.start_precision !== 'unknown'
  return hasDate !== hasGrade
}
