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
//
// ⚠ THIS HEADER USED TO END "Nothing here says anything about pH, acidification, safety or shelf
// stability — that adjudication is running separately and is unlanded." The adjudication has since
// landed and reversed the first of those four, and only the first: V5-PHRECORD-001 adds a recorded
// pH, a prompt to measure and a link-out, in the block near the bottom of this file. Everything else
// in that sentence still holds — nothing here says anything about acidification, safety or shelf
// stability, and nothing scores, colours, compares or gates on a reading. Read that block before
// touching anything named ph*.
//
// Put-Up UX pass R1 ADDS the page shell's pure half at the foot of this file (its segments, the words and
// the direction of a mode's Back, recipes as page-search items) and changes no name above it: batch
// detail, Check on it, the pH field and the Log's edit sheet all import from here.
import { readFrom, backLabel } from './origin.js'

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
// cease while the pH is still above the acid line, so the visible completion proxy and the criterion
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
  // SILENT ON A PAUSED BATCH. A pause is the cook saying "I have set this down"; asking whether it is
  // still under the brine is the app questioning an answer it was just given, and the cadence it is
  // keyed on has no meaning across a suspension anyway — the clock ran while nobody was tending it.
  // Ruling 3 permits questions, not noise, and noise on this card is what the four retired signalling
  // surfaces died of. The same gate is on phPrompt below, for the same reason.
  if (isSuspended(batch)) return null
  const since = batch.current_stage_entered_at || batch.first_recorded_at
  if (!since) return null
  const then = new Date(since).getTime()
  if (Number.isNaN(then)) return null
  if (nowMs - then < SUBMERSION_CHECK_DAYS * DAY_MS) return null
  return SUBMERSION_PROMPT
}

// ── the recorded pH ──────────────────────────────────────────────────────────────────────────────
// V5-PHRECORD-001. The header above says "Nothing here says anything about pH" — that was true when
// it was written and is no longer, and the reversal is deliberate rather than a drift. The
// adjudication that produced the original silence was re-examined and found to have over-corrected:
// forbidding the app to mention pH also forbade it to ask the cook to MEASURE, which is the opposite
// of the thing it was protecting. BC CDC's fermented-vegetables guidance recommends "monitoring and
// recording pH and time", and this app is a record.
//
// ⚠ THE LINE, AND EVERY FUNCTION BELOW SITS ON ONE SIDE OF IT:
//   FORBIDDEN — derive, score, colour, gate, compare to a threshold, or infer from elapsed time.
//   PERMITTED — record a measured value verbatim, prompt someone to measure, link to how.
// So: no comparison of a reading to anything, no status, no colour, no ordering of "better" readings,
// nothing that reads a reading and returns a judgement. The number a cook types is carried to the
// server and back and rendered as typed, beside the date it was taken, and that is the whole feature.
// There is no threshold constant in this file and there must never be one; the guard that keeps it
// out is in src/__tests__/PutUpPhReading.test.jsx and it fails on the literal, not on the intent.
//
// ⚠ AND IT IS AN ORIGINAL DESIGN CHOICE, NOT A COMPLIANCE POSTURE. No published convention exists for
// what home-preservation software should say about any of this — a documented negative result, not a
// gap in the reading. Nothing here follows a standard and no comment may imply that it does.
// Adjudication: project-state/_build-inflight-20260904/FOODSAFETY-RULING-V101.md §2 (gardening-docs).

// The pH scale's definitional range, mirroring chk_ksl_ph_scale. NOT a safety band: it is symmetric,
// it prefers no reading to any other, and it excludes nothing either instrument in the link-out below
// can produce. Its only job is to catch a fat-finger before it is stored — a strip cannot read 46.
export const PH_SCALE_MIN = 0
export const PH_SCALE_MAX = 14

// A reading is recorded by APPENDING a stage row, because that is where an observation about a batch
// lives and the stage log is append-only: a wrong reading is corrected by recording the next one, and
// the record keeps both. Stage kinds are started/tended/moved/finished/failed and going to measure
// something is tending it.
export const PH_STAGE_KIND = 'tended'

// UMN Extension's published cadence: "continue to ferment and check the pH every 1 to 2 days." It is
// the ONLY cadence in the evidence base with a sourced number behind it.
//
// TWO DAYS, THE OUTER BOUND, chosen so the prompt can never fire before the published window has
// fully elapsed. The inner bound would be defensible too and this is a judgement rather than a
// finding: a question asked a day early is answered "yes, this morning", and a card that asks about
// something already done is how a reader learns that its questions can be ignored — which is the
// same reasoning ruling 4 uses to refuse urgency tone. Late costs a day; early costs the affordance.
//
// It coincides with SUBMERSION_CHECK_DAYS and the two must NOT be collapsed into one constant. They
// come from different sources (Penn State's "two to three times each week" vs UMN's "every 1 to 2
// days") about different acts, and either publisher can revise without the other.
export const PH_CHECK_DAYS = 2

// A QUESTION, and it stops. No verdict, no failure-sign checklist, no second clause — the same shape
// as SUBMERSION_PROMPT and for the same reason: a list of what going wrong looks like invites the
// reader to conclude that its absence means success. It asks whether you measured; it says nothing
// whatever about what the measurement was or should be.
export const PH_PROMPT = 'Measured the pH in the last day or two?'

// Quoted verbatim and attributed, rather than paraphrased into house voice. The caution travels WITH
// the recommendation because USU publishes them together and separating them would leave the cheaper
// instrument looking equivalent to the better one.
export const PH_INSTRUMENT_NOTE =
  'Utah State University Extension recommends "a digital pH meter or pH test strips that can measure '
  + 'to at least 1 decimal point", and notes that "Test strips are less accurate as the color of the '
  + 'food can alter the result."'

export const PH_LINK_URL =
  'https://extension.usu.edu/preserve-the-harvest/research/tips-to-safely-ferment-at-home'
// Describes what the destination is being cited FOR. The page's own title is not used as the label:
// it is a sentence about fermenting rather than about measuring, and the app is linking to the
// instrument note inside it.
export const PH_LINK_LABEL = 'Utah State University Extension — how to measure →'

// The only rejection this input performs, and it is about the SCALE, not about the value's meaning.
export const PH_SCALE_HINT = 'A pH reading is a number from 0 to 14 — check what the meter showed.'

// VERBATIM, and that is the requirement rather than a convenience. No rounding, no toFixed, no
// Number() round-trip, because a Number round-trip drops a trailing zero the meter displayed.
// Trimmed only, because leading whitespace is not part of what anyone measured.
export function phReadingText(v) {
  if (v == null) return null
  const t = String(v).trim()
  return t === '' ? null : t
}

// BOTH HALVES OR NEITHER. A reading with no instant beside it is not a dated line, and a dated line
// is the only shape a reading is allowed to take on a surface — the ruling forbids rendering the
// check history as a streak, a count, a badge, a run of ticks or any other aggregate, because a batch
// that never acidified produces an unbroken run of "checked" entries and an aggregate over them turns
// absent failure signs into apparent success. One reading, one date, no summary of the rest.
export function describeLastPhReading(batch) {
  const text = phReadingText(batch?.last_ph_reading)
  if (text == null) return null
  const at = batch?.last_ph_read_at
  if (!at) return null
  if (Number.isNaN(new Date(at).getTime())) return null
  return { text, at }
}

// WHAT THE CADENCE COUNTS FROM, in the order the fallbacks apply:
//   1. last_ph_read_at — when you last measured. This is the real anchor; the other two only exist
//      because a batch with no reading yet still has to be asked once.
//   2. started_at — the batch's own beginning, when the cook knows it.
//   3. first_recorded_at — the honest floor, NOT NULL by design, so a ferment whose start was never
//      asked (start_precision NULL) or is permanently 'unknown' still gets asked. Falling silent on
//      those two would suppress the prompt on exactly the batches nobody has looked at.
//
// NO PRECISION GATE HERE, unlike describeExpectedWindow above, and the difference is the point. That
// function pairs a start with an expected DURATION, which licenses "it's been long enough" — a
// readiness claim, and a guessed start makes it a fabricated one. This one asks a question that makes
// no claim about the batch at all, so a coarse start can only make the question slightly early or
// late, and after the first reading the anchor is exact anyway.
export function phPromptAnchor(batch) {
  return batch?.last_ph_read_at || batch?.started_at || batch?.first_recorded_at || null
}

// KNOWN ferments only, exactly as submersionPrompt is scoped, and `kind IS NULL` is SILENT. kind is
// nullable by design — the capture path never asks — so null means "nobody said", and asking for a
// pH on what might be a dehydrator run fails open into nonsense. 'other' is silent for the same
// reason. This is the opposite fail-direction from DURATION_KINDS and correctly so: suppressing a
// question costs a prompt, asking the wrong one costs the surface's credibility.
//
// SUBMERSION_KIND is reused rather than copied, unlike the cadence above. The two cadences come from
// two publishers who can revise independently; the kind scope is ONE fact — both affordances are
// about fermentation — and a second constant holding the same string is a place for them to diverge.
export function phPrompt(batch, nowMs) {
  if (!batch || batch.kind !== SUBMERSION_KIND) return null
  // Silent on a paused batch — see submersionPrompt. phRecorderVisible is deliberately NOT gated the
  // same way: the prompt is the app speaking and must not talk over a set-down batch, while the
  // recorder is a door the cook opens, and a reading taken on a paused ferment is still a fact.
  if (isSuspended(batch)) return null
  const since = phPromptAnchor(batch)
  if (!since) return null
  const then = new Date(since).getTime()
  if (Number.isNaN(then)) return null
  if (nowMs - then < PH_CHECK_DAYS * DAY_MS) return null
  return PH_PROMPT
}

// ⚠ phRecorderVisible WAS HERE, and was RETIRED by Put-Up 1a item 3 (V4 §2.3: "the pH button moves
// into Check on it"). It gated the card's inline recorder, deliberately wider than the prompt — it
// admitted a NULL kind because nothing could classify a batch, so a strict gate would have locked the
// one real ferment out of the feature. The card's one-tap kind question removes that reason, and the
// pH field now lives in Check on it on kind = 'ferment' only: see checkInFields.

// The POST body for one reading. `ph_reading` is the trimmed STRING the cook typed, never a Number —
// see phReadingText. Returns null for anything off the scale or unparseable, so the component can say
// so without a round trip; the server and chk_ksl_ph_scale both restate the same rule behind it.
export function phStagePatch(raw, atIso) {
  const text = phReadingText(raw)
  if (text == null) return null
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  if (n < PH_SCALE_MIN || n > PH_SCALE_MAX) return null
  if (!atIso || Number.isNaN(new Date(atIso).getTime())) return null
  return { stage_kind: PH_STAGE_KIND, ph_reading: text, ph_read_at: atIso }
}

// ── the one-week stall prompt ────────────────────────────────────────────────────────────────────
// FOODSAFETY-RULING-V101 §4. The corpus's ONE time-keyed rule that tells a cook to throw a batch
// away, and V100 banned it along with every other elapsed-time affordance — a restrictive ruling
// producing a permissive outcome, which is the failure §4 exists to correct.
//
// ⚠ WHY THIS IS NOT THE THING ELAPSED TIME IS BANNED FOR, and the distinction is the whole ruling:
// elapsed time is an invalid ACCEPTANCE input and a valid REJECTION input. A readiness claim made
// from a clock ("it's been long enough") is a fabrication; a question asked because a published
// deadline has passed is a prompt to go and measure. Every readiness affordance stays banned at every
// precision — nothing below adds a countdown, a progress figure, a completion or a verdict, and no
// function here reads a recorded value back.
//
// ⚠ NO ACID NUMBER, IN THE COPY OR IN THIS FILE. The ruling's own example sentence names one and it is
// deliberately not written here. This file is one of fifteen swept by src/__tests__/PutUpPhReading
// .test.jsx ("the acid line appears nowhere in this lane's source"), which forbids the literal in
// SOURCE and in the DOM on the stated reasoning that a number on this surface is a threshold whether
// or not any code compares to it. That census carries a green control and a proven-non-vacuous regex,
// so it is a decision rather than an oversight, and the ruling's illustrative copy loses to it. What
// §4 actually REQUIRES is a time-keyed failure prompt carrying its scope condition; both survive
// without the figure, and the figure keeps its source and its scope at the end of the link-out.
//
// ⚠ IT IS ANSWERED BY THE ACT OF MEASURING, NEVER BY THE VALUE — and that distinction is the whole
// reason this is allowed to go quiet at all. Silencing on a reading that "looked acceptable" would be
// the app comparing a number to a threshold, which is the one thing the pH affordance above exists not
// to do, and it would do it against the cook's own unvalidated typing. Silencing because a reading was
// TAKEN after the deadline reads nothing: it asks "have you been to look since this came due", the
// cook answers by going to look, and a question nobody can answer is a nag rather than a prompt. A
// reading taken BEFORE the deadline does not answer it — that measurement predates the question.
// Otherwise it stops only on a pause, and on a close (a closed batch is not on this surface).
export const FERMENT_STALL_DAYS = 7

// A QUESTION, and it stops — the same shape and the same ink as SUBMERSION_PROMPT and PH_PROMPT. It
// asks whether the reading has moved. It does not say where it should have got to, it does not claim
// anything about this batch, and it carries no urgency tone (ruling 4 refuses one).
export const FERMENT_STALL_PROMPT = "It's been a week — has the pH come down yet?"

// SAY WHICH, per §4, because the deadline is borrowed and the borrowing is load-bearing: the one-week
// figure is authored for businesses, and the tighter figures elsewhere in the same corpus would fire
// sooner on a jar sitting on a counter. Rendered as attribution beneath the question, never as a
// verdict, and spelled rather than digitised so no numeral on this line can read as a threshold.
export const FERMENT_STALL_NOTE =
  'Snyder et al., writing for small businesses and retail food establishments, treat a ferment that '
  + 'has not come down within a week as a failed one and say to throw it out. BC CDC uses tighter '
  + 'limits for kimchi — three days at room temperature, one week refrigerated.'

// ANCHORED ON THE START, AND GATED ON ITS PRECISION. This is the one affordance in this file where a
// coarse start silences a question for the OPPOSITE reason to describeExpectedWindow's gate: §4
// retracted V100's "a perfectly known start date tells you nothing a guessed one doesn't" in terms —
// a one-week deadline is not evaluable against a start known only to the month. Precision carries
// information HERE, for the rejection test, which is the test the evidence supports.
//
// first_recorded_at is deliberately NOT a fallback, unlike phPromptAnchor's chain next door. That
// column is when the row reached the database, not when the ferment began, and counting a deadline
// from it would invent one. A ferment whose start nobody knows gets no deadline rather than a
// fabricated one — and it still gets the cadence prompt, which makes no claim needing a start.
export function fermentStallPrompt(batch, nowMs) {
  if (!batch || batch.kind !== SUBMERSION_KIND) return null
  if (isSuspended(batch)) return null
  if (!startIsDayOrBetter(batch)) return null
  const since = batch.started_at
  if (!since) return null
  const then = new Date(since).getTime()
  if (Number.isNaN(then)) return null
  const deadline = then + FERMENT_STALL_DAYS * DAY_MS
  if (nowMs < deadline) return null
  // The ONLY thing read off a reading anywhere in this module: WHEN it was taken. Never `ph_reading`,
  // which this function does not touch and must never touch. An unparseable instant is treated as no
  // reading at all rather than as an answer — the fail direction that keeps asking.
  const read = batch.last_ph_read_at ? new Date(batch.last_ph_read_at).getTime() : NaN
  if (!Number.isNaN(read) && read >= deadline) return null
  return FERMENT_STALL_PROMPT
}

// THE CARD ASKS ONE pH QUESTION, NEVER TWO. Both predicates can be live at once — a fortnight-old
// ferment nobody has measured satisfies the cadence rule and the deadline rule simultaneously — and
// two questions about the same act, stacked, is the noise the four retired signalling surfaces died
// of. The stall prompt WINS because it is the cadence question plus the thing the cook does not
// already know; suppressing it in favour of the cadence line would drop information.
//
// The suppression lives HERE and not in the view, for the same seam reason as everything else in this
// module: the .jsx paints what it is handed and decides nothing. Returning both keys always — rather
// than one prompt string — keeps the two testids independent, so a future change cannot silently
// merge them into one line that no assertion distinguishes.
export function fermentPrompts(batch, nowMs) {
  const stall = fermentStallPrompt(batch, nowMs)
  return { stall, cadence: stall ? null : phPrompt(batch, nowMs) }
}

// ── the card's ONE inline question ───────────────────────────────────────────────────────────────
// Put-Up 1a (V4 §2.3 "Card"): at most three quiet actions plus AT MOST ONE inline question. The card
// used to be able to stack the submersion question over a pH question, and a NULL-kind card would now
// add "What kind of batch?" to that — three questions about one crock is the noise the four retired
// signalling surfaces died of, and the adhd seat's split-attention finding. So the questions share
// ONE slot and this function picks, in this order:
//   1. kind      — a NULL kind. Exclusive with the rest by construction: every ferment question is
//                  gated on kind = 'ferment', so an unclassified batch cannot be asked any of them.
//   2. stall     — FOODSAFETY-RULING-V101 §4, the one question that carries information the cook does
//                  not already have; it already beat the cadence question (fermentPrompts above).
//   3. submersion— the shipped brine question. It outranks the cadence question because the pH clock
//                  anchors no later than the stage clock, so whenever this one is due the cadence
//                  question is too: ranking it second would mean it could NEVER appear. This way all
//                  three shipped prompts still speak at their shipped timing, one at a time.
//   4. cadence   — the shipped pH question.
// Each prompt keeps its own predicate unchanged; this only chooses which one is on screen. Returning
// a SHAPE, not a string, keeps the testids of the three shipped prompts independent.
export function cardQuestion(batch, nowMs) {
  if (kindQuestionVisible(batch)) return { kind: 'kind' }
  const { stall, cadence } = fermentPrompts(batch, nowMs)
  if (stall) return { kind: 'stall', text: stall }
  const submersion = submersionPrompt(batch, nowMs)
  if (submersion) return { kind: 'submersion', text: submersion }
  if (cadence) return { kind: 'cadence', text: cadence }
  return null
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

// ── Check on it (Put-Up 1a, V4 §2.3) ─────────────────────────────────────────────────────────────
// The check-in sheet, on every kind. What it offers depends on the kind and on nothing else:
//   every kind   — Moved it (the household's places) and a note
//   ferment      — also the ruled brine question and the pH field
//   dehydrate    — also "In jars to condition" / "Condensation → back in the dryer" (Dry, NOT Candy)
// A NULL kind gets the every-kind set only — the pH field is a ferment observation, and the card's
// one-tap kind question is the door to it. (The old inline recorder also admitted a NULL kind, but
// only because nothing could classify a batch; something now can.)
export const CHECK_ON_IT_CTA = 'Check on it'

// Stored verbatim in kitchen_stage_log.cue_observed — free text the log reads back as written.
// The brine answers are the RULED pair, in both directions (V4 §2.3), and nothing else: no
// failure-sign checklist, for the reason SUBMERSION_PROMPT's header gives.
export const SUBMERSION_ANSWERS = Object.freeze([
  { value: 'all_under', label: 'All under' },
  { value: 'poking_out', label: 'Something poking out' },
])
export const CONDITIONING_ANSWERS = Object.freeze([
  { value: 'jars', label: 'In jars to condition' },
  { value: 'back_in_dryer', label: 'Condensation → back in the dryer' },
])

export function checkInFields(batch) {
  const kind = batch?.kind ?? null
  // `acts` (release F, Dave 16:30): what he did — Topped up brine · Pushed it back under · Skimmed the
  // top — Ferment only, like the submersion question beside it (06 §3.10).
  return { ph: kind === SUBMERSION_KIND, submersion: kind === SUBMERSION_KIND, conditioning: kind === 'dehydrate', acts: kind === SUBMERSION_KIND }
}

// Release F (Dave 16:30, binding): a check-in is a note plus THREE action chips. Film, mold, bubbling,
// taste, smell and temperature go in the note — there is no surface column, no burp act, and no chip
// for any of them. Stored as the words' keys in kitchen_stage_log.acts (chk_ksl_acts), tended rows only.
export const CHECK_IN_ACTS = Object.freeze([
  { value: 'topped_up', label: 'Topped up brine' },
  { value: 'pushed_under', label: 'Pushed it back under' },
  { value: 'skimmed', label: 'Skimmed the top' },
])
export const WHAT_YOU_DID = 'What you did'
// The top-up amount's units (all in KITCHEN_UNITS); ml first because brine is poured.
export const TOP_UP_UNITS = Object.freeze(['ml', 'g', 'cup'])

export const CHECK_IN_EMPTY = 'Note one thing first — an answer, a reading, a place or a note.'

// THE ONE ROW a check-in writes (V4 §2.3: "A check-in writes ONE tended row (Moved it writes moved)").
// One Save, one POST, one row — never a row per observation, and never two rows for one visit:
//   · a place was picked -> stage_kind 'moved', carrying storage_location_id (chk_ksl_moved_needs_location)
//     and a label naming where, so the card and the log say where it went;
//   · otherwise           -> stage_kind 'tended'.
// Whatever else was observed rides on that same row: the chosen answer as cue_observed, the pH as the
// typed STRING with its read instant (never through a Number — see phReadingText), the note.
// Returns { body } or { error }; the caller never sends a body this refused.
// Release F: acts ride ONLY on a tended row (chk_ksl_acts_on_tended), so a visit that did something AND
// moved the crock is two rows — the tended row with everything observed and done, then the moved row —
// returned as { body, move }. Every other visit is still ONE row, as before.
export const TOP_UP_HINT = 'The top-up needs a number more than 0 — or leave it empty.'
export function checkInBody({ batch, ph = '', submersion = null, conditioning = null, place = null, note = '', atIso,
  acts = [], topUp = '', topUpUnit = 'ml' }) {
  const fields = checkInFields(batch)
  const did = fields.acts ? CHECK_IN_ACTS.map(a => a.value).filter(v => (acts ?? []).includes(v)) : []
  const topUpText = did.includes('topped_up') ? String(topUp ?? '').trim().replace(',', '.') : ''
  if (topUpText && !(Number.isFinite(Number(topUpText)) && Number(topUpText) > 0)) return { error: TOP_UP_HINT }
  const split = !!place && did.length > 0
  const body = { stage_kind: place && !split ? 'moved' : 'tended' }
  let move = null
  if (place) {
    if (!place.id) return { error: CHECK_IN_EMPTY }
    const moved = { storage_location_id: place.id, label: `Moved to ${place.label}` }
    if (split) move = { stage_kind: 'moved', ...moved }
    else Object.assign(body, moved)
  }
  if (did.length) body.acts = did
  if (topUpText) { body.amount = topUpText; body.amount_unit = TOP_UP_UNITS.includes(topUpUnit) ? topUpUnit : 'ml' }
  const answer = fields.submersion
    ? SUBMERSION_ANSWERS.find(a => a.value === submersion)
    : fields.conditioning ? CONDITIONING_ANSWERS.find(a => a.value === conditioning) : null
  if (answer) body.cue_observed = answer.label
  const typed = fields.ph ? phReadingText(ph) : null
  if (typed != null) {
    const patch = phStagePatch(typed, atIso)
    if (!patch) return { error: PH_SCALE_HINT }
    body.ph_reading = patch.ph_reading
    body.ph_read_at = patch.ph_read_at
  }
  const text = String(note ?? '').trim()
  if (text) body.note = text
  const observed = !!place || !!answer || typed != null || !!text || did.length > 0
  if (!observed) return { error: CHECK_IN_EMPTY }
  // Every row this writes carries its date AND its word (review I-N1): the instant of the visit, 'exact'.
  // Without a precision the route takes the pre-1b path and stores it NULL — a legacy-shaped row, and the
  // shape "Saved · Undo" of a date edit tripped on. The route writes exactly what it is given here.
  if (atIso != null && !Number.isNaN(new Date(atIso).getTime())) {
    const stamp = { entered_at: atIso, entered_precision: 'exact' }
    Object.assign(body, stamp)
    if (move) Object.assign(move, stamp)
  }
  return move ? { body, move } : { body }
}

// ── the kind of batch ────────────────────────────────────────────────────────────────────────────
// Put-Up 1a (V4 §2.3). A NULL kind shows ONE inline question, answered by the kind chips in one tap
// through the shipped merge PUT, and NEVER ASKED AGAIN once any kind is stored — including `age`,
// which is still a valid stored value though no chip offers it, and `other`, which is an answer.
// NULL is the only unanswered state, the same distinction the start fields draw between "never
// asked" and "asked, doesn't know". A closed batch is not on the card, and is not asked either.
//
// Not gated on a pause: the ferment prompts go silent under suspension because they are the app
// asking about the batch's state, which a pause answers. This asks what the batch IS, which a pause
// does not answer, and it is the one door that wakes those prompts at all.
export const KIND_QUESTION = 'What kind of batch?'

export function kindQuestionVisible(batch) {
  return !!batch && batch.kind == null && !batch.closed_at
}

// ── suspended ────────────────────────────────────────────────────────────────────────────────────
// Ruling from the DDL: "A frozen candy parent resumes N times over months; showing it beside a day-2
// syrup pot as equally 'in flight' misreports the only thing the Going-now view exists to say."
// suspended_at is the discriminator, and it is NOT closed_at — chk_kitchen_batch_suspend_exclusive
// makes the two mutually exclusive, and `state=going` returns both suspended and active rows.
export function isSuspended(batch) { return !!batch?.suspended_at }

// ── pause / resume, and the two doors off the card ───────────────────────────────────────────────
// V5-BATCHCLOSE-001. `suspended_at` sits on KITCHEN_BATCH_EDITABLE_COLUMNS and the card above already
// draws the state it produces, and yet NOTHING in the client has ever written it: the app shipped the
// irreversible give-up and left the reversible one unreachable. That is backwards for an
// interrupt-sensitive user — the cheapest correct answer to "I am not dealing with this right now"
// should be the one you can take back.
//
// ONE key reaches the wire. The kitchen-batch PUT is a MERGE (see startChipPatch's note below), so an
// absent column is left alone; do not copy the preservation route's full-replace payload shape here.
// The instant is the caller's INJECTED clock and never a Date.now() in this file — everything here is
// a pure function of a row plus an explicit `now`, which is what lets a test pin the PUT body to a
// fixed literal instead of to whenever the run happened.
export function pausePatch(paused, nowMs) {
  if (paused) return { suspended_at: null }
  const at = new Date(nowMs)
  return Number.isNaN(at.getTime()) ? null : { suspended_at: at.toISOString() }
}

// The card's copy, as constants rather than as JSX literals, so a test binds the string it asserts
// rather than re-typing it — the same reason PH_PROMPT and SUBMERSION_PROMPT live here.
// The two `→` labels REVEAL a surface; the pause pair COMMITS a write on one tap and carries no
// arrow, because an arrow that writes is a promise the control does not keep.
export const OPEN_BATCH_CTA = 'Open this batch →'
export const CLOSED_DOOR_CTA = 'Closed batches →'
export const PAUSE_CTA = 'Pause this batch'
// Never "Resume": the word the user has for this is picking it back up, and the label has to read the
// same way on a card they last touched two months ago.
export const RESUME_CTA = 'Pick it back up'

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
  // 4, not 3, CORRECTED at integration 2026-09-04: the panel's rule is the MIDPOINT of the window each
  // chip names (3–5 d → 4, 14–21 d → 18). The Snap-card table this was reconciled against was retired
  // in Put-Up 1a item 5 (Snap opens the shared Start sheet); src/__tests__/startChipParity.test.js now
  // binds the labels this table shares with the Start sheet's (Today, Yesterday) and pins the two
  // midpoints here directly.
  { value: 'few_days',   label: 'A few days ago',    days: 4,    precision: 'day',     anchor: 'memory' },
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

// ── Put-Up UX pass R1 — the page shell: its segments, the way out of a mode, recipes in the search ──
// The page (PutUp.jsx) takes no new logic in R1: it holds ONE opener and the wiring, and asks here for
// everything a test can pin without a router. Pure, like the rest of this file: a router state and the
// router's history index come in as arguments, never off `window`.

// The door that starts a batch — the page header's filled button on Going now, and the empty card's
// secondary one. One string, so the two controls cannot drift. No arrow: it opens a sheet.
export const START_BATCH_CTA = 'Start a batch'
// Going now's load error offers the reload the page already owns.
export const TRY_AGAIN_CTA = 'Try again'

// The four segments, in the order the control shows them: going → logged → kept, then the recipes. ONE
// list for the segmented control AND for the Back's words, so a renamed segment cannot leave a Back that
// still names the old one.
export const PUT_UP_SEGMENTS = Object.freeze([
  Object.freeze({ value: 'going', label: 'Going now' }),
  Object.freeze({ value: 'log', label: 'Log a put-up' }),
  Object.freeze({ value: 'pantry', label: 'Pantry' }),
  Object.freeze({ value: 'recipes', label: 'Recipes' }),
])
export const RECIPES_SEGMENT = 'recipes'

// The segment a mode's Back lands on when it leaves by its own push (nothing to pop to): the one the
// page is holding, except that a recipe is left onto Recipes — a recipe opened from a search hit on
// another segment would otherwise land on a list that has no recipes in it.
export function leaveSegment(view, { recipe = false } = {}) {
  return recipe ? RECIPES_SEGMENT : view
}
// The segment's own label, or null for a value no segment carries.
export function segmentLabel(value) {
  return PUT_UP_SEGMENTS.find(s => s.value === value)?.label ?? null
}

// THE ORIGIN A SENDER DID NOT NAME: the segment on screen. A Going-now card, the door to the closed list, a
// Recipes row and a batch just started hand the page no origin, and the entry under their push IS that
// segment — so the page names it, `{ label: <the segment's own label> }`, and the mode's Back pops to it
// like any other sender's. Left unnamed, each of them was left by a PUSH, and the system's Back after
// "← Going now" walked back INTO the batch just left (two entries a visit, on the most-used doors).
// The Back's words do not change by a letter: a pop reads the origin's label, a push the segment's, and
// they are the same string.
// null when NO segment is on screen: over the page search's results (the entry under a hit is the results,
// not a segment) and inside a mode (the entry under it is that mode). Those doors push, as they always did.
export function segmentOrigin(view, { onScreen = true } = {}) {
  const label = onScreen ? segmentLabel(view) : null
  return label ? { label } : null
}
// The segment an entry's origin names, or null. The segment is the page's own state, not part of the URL:
// a page that MOUNTS on a mode entry (a reload, a PWA restored from a discard, a return from another
// route) has lost it, and the list entry under the mode would show whatever a fresh page defaults to —
// "← Recipes" landing on the Pantry. So the page starts out holding the segment its entry names.
// Only a segment's own label with NO kind: a recipe or a batch that happens to be called "Pantry" is a
// sender like any other.
export function originSegment(state) {
  const from = readFrom(state)
  if (!from || from.kind) return null
  return PUT_UP_SEGMENTS.find(s => s.label === from.label)?.value ?? null
}

// POP, OR PUSH. A mode's in-page Back pops ONLY when the entry names where it was opened from AND the
// router's own history index says an app entry sits under it. Either alone is not enough: an entry with
// no origin has nowhere it promised to return to, and an origin can outlive what was under it
// (history.state survives a reload and a deploy, and a restored session can open on the mode at index
// 0, where history.back() does nothing — a dead press on the only in-page exit an installed PWA has).
// `historyIndex` is the router's `history.state.idx`; anything that is not a whole number above 0 —
// a MemoryRouter, a first entry, a foreign state — is a push.
export function leavesByPop(state, historyIndex) {
  return readFrom(state) != null && Number.isInteger(historyIndex) && historyIndex > 0
}

// How long a started pop may take to land before a second press stops waiting for it. A same-document
// traversal lands in a frame or two; this only bounds one that never lands (OverlayContext bounds its own
// close walk the same way, at the same figure).
export const POP_LANDS_WITHIN_MS = 1500

// What ONE press of a mode's Back does: 'pop' | 'wait' | 'push'.
//   pop  — the entry names its sender and an app entry is under it (leavesByPop), and no pop is under way.
//   wait — a pop was already started FROM THIS ENTRY and has not landed. A pop is not idempotent the way
//          the push was: a second one would walk PAST the sender, off the page the press was meant to
//          return to. So a second press before the first lands does nothing.
//   push — everything else, including a pop that was started from this entry and never landed: the Back
//          is never a press that does nothing for good.
// `entryKey` is the router's key for the entry being left; `started` is `{ key, at }`, the entry the last
// pop was started from and when (the page clears it when a traversal lands — see popLanding — and whenever
// the location changes).
export function leavePlan({ state, historyIndex, entryKey, started = null, nowMs }) {
  if (!leavesByPop(state, historyIndex)) return 'push'
  if (!started || started.key !== entryKey) return 'pop'
  return nowMs - started.at < POP_LANDS_WITHIN_MS ? 'wait' : 'push'
}

// WHEN A TRAVERSAL LANDS (a popstate), with a pop of the page's own under way: 'hop' | 'clear' | 'keep'.
// The page's latch (`started`, see leavePlan) used to be dropped only when the router's location key
// changed. A sheet's Back marker is pushed as a COPY of the entry under it — the same router key and index
// (context/DismissRegistry.jsx `arm`). Reload with a sheet open and boot reconciliation strips the marker
// off that copy, leaving two identical entries: the Back's pop landed on the twin, nothing on screen moved,
// the key had not changed so the latch stood, every press for the next 1.5 s was swallowed, and a later
// one PUSHED while the label still named the origin. So the landing itself settles the latch:
//   clear — the pop landed on another entry (the sender: the press worked), or there was no pop of the
//           page's to settle, or the one hop below has been spent. The next press is a fresh one.
//   hop   — it landed on an entry with the key it STARTED from: the twin. Go one entry further, ONCE; the
//           page marks the latch `hopped`, so a third identical entry (two restores) costs a second press,
//           never a walk of unknown length.
//   keep  — it landed on its own key, but it was started while a sheet's marker WAS the current entry
//           (`started.overMarker`): that is the entry under the marker, where such a pop lands by design,
//           and the closing sheet's own disarm may have a second traversal queued behind it — a hop would
//           walk past the sender, and a cleared latch would let a second press do the same. The latch
//           stands, as it did before, until the location changes or it runs out.
// `started` is `{ key, at, hopped?, overMarker? }`; `landedKey` is history.state.key as the popstate
// finds it. The same key means the same URL, so the page is still in the mode it pressed Back in.
export function popLanding({ started, landedKey }) {
  if (!started) return 'clear'
  if (typeof landedKey !== 'string' || landedKey === '' || landedKey !== started.key) return 'clear'
  if (started.overMarker) return 'keep'
  return started.hopped ? 'clear' : 'hop'
}

// The words after the Back's arrow, in two parts so the name can shorten on one line while the kind
// stays whole: { name, suffix }. They always name where the press LANDS: the origin (origin.js
// backLabel: "Petri Dish" + " (recipe)") only when the press will pop to it, otherwise `fallback` — the
// label of the segment the push lands on. A Back that reads "Pantry" and lands on Going now would be
// the page lying about its only exit.
export function backWords(state, historyIndex, fallback) {
  if (!leavesByPop(state, historyIndex)) return { name: fallback, suffix: '' }
  const words = backLabel(state, fallback)
  const name = readFrom(state).label
  return words.startsWith(name) ? { name, suffix: words.slice(name.length) } : { name: words, suffix: '' }
}

// The recipes lane's list (GET /api/recipes answers `{ recipes }`; a bare array is read too, the same
// two shapes batchRows reads) as page-search items: `{ kind: 'recipe', id, name, type_label? }`, the
// shape pantryRows.searchHits and extraLabel read. A row with no id or no name is not a hit anyone
// could open, so it is not offered. Nothing else of the row rides along: the search matches on the name.
export function recipeSearchItems(payload) {
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.recipes) ? payload.recipes : [])
  const items = []
  for (const r of rows) {
    const name = typeof r?.name === 'string' ? r.name.trim() : ''
    if (r?.id == null || r.id === '' || !name) continue
    const item = { kind: 'recipe', id: String(r.id), name }
    if (typeof r.type_label === 'string' && r.type_label.trim()) item.type_label = r.type_label
    items.push(item)
  }
  return items
}
