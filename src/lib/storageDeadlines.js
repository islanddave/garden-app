// V4-STORAGEDEADLINE-001 — seasonal LIFT deadlines for 'single'-habit storage crops.
//
// Data + provenance: `src/data/storageDeadlines.json`. Read that file's `note` before extending this
// one — the dataset is deliberately almost empty and the emptiness is the finding, not a TODO.
//
// WHY THIS EXISTS. `harvestReadiness.isReadyToPick` requires `harvest_habit IN ('repeat',
// 'cut_and_come_again')` (it returns false for 'single' before it ever reaches the DOY window) AND at
// least one prior harvest, which the server enforces in the candidate join. Both conditions are
// correct for what that band is — an evidence-only "you have picked this before and are due again"
// nudge. Their joint effect is that every once-per-season crop is structurally invisible to it: 23 of
// Dave's live edible plantings on 2026-08-12 (beet, cabbage, carrot, garlic, kohlrabi, leek, onion,
// potato, radicchio, shallot, sweet potato). That gap is real and is the true half of the ledger item.
//
// WHY IT IS ALMOST EMPTY — the other half of the item did not survive verification. The originally
// specified crop list was five crops; against live prod, two of them are not grown (winter squash has
// no live plantings; there is no dry-bean crop type and all three `bean` plantings are snap/filet
// types on a 'repeat' crop type), garlic's hard window had already closed on 2026-07-30, and the
// onion/shallot/cabbage triggers (leaf-fall, pod-rattle, rain-split, cure) are observed plant states
// that appear in NONE of the 38 event types in prod. Exactly one crop — sweet potato — has a seasonal
// deadline that is citable, still in the future, and attached to a live planting.
//
// DO NOT REACH FOR `crop_types.harvest_season_end_doy` TO STORE THESE. It is tempting and it is wrong
// twice over. First, it is a SUPPRESSOR inside `isReadyToPick`, and that function has already returned
// false for a 'single' crop by the time the window is consulted — so a value written there for a
// storage crop is unreachable code paved as data. Second, its own field contract
// (`harvest-attributes-v1.json`) restricts it to windows where harvesting OUTSIDE is actively harmful,
// precisely because a wrong window silently suppresses a true readiness signal. It is populated for 2
// of 136 crop types on purpose. This module keeps advisory deadlines in a separate key space so
// neither meaning can bleed into the other.
//
// PURE, like harvestReadiness: `todayISO` always arrives as an argument. No internal `new Date()` —
// a date-dependent module that reads its own clock cannot be tested across a boundary without flake,
// and the reporting zone is the Lambda's, not the browser's.
//
// COPY IS CHECK-FORM, NEVER ASSERTION-FORM. "Start checking sweet potatoes", never "sweet potatoes are
// ready". The one date in here is a measured site BACKSTOP standing in for VINE KILL — an observed plant
// state nobody is recording; copy that asserts readiness would overclaim it.
//
// THE ONE DATE HAS MOVED TWICE, AND ONLY THE SECOND MOVE WAS MEASURED. Read this before touching it.
//  • 1.0.0 shipped 10-15, read off UMass's "usually before mid-October" as a SOIL-temperature cutoff.
//  • 1.1.0 (BUG-SWEETPOTATODEADLINE-001, 2026-08-17) replaced the mechanism with VINE KILL — correct,
//    and it still stands — but derived the new date from FROST_ANCHORS.firstFallFrost, landing on
//    09-25 (anchor - 3d).
//  • 1.2.0 (same day, 8-seat crucible) reverted the DATE to 10-10 and kept the mechanism. The anchor is
//    a conservative SOWING-safety margin, not an observed frost date: 11 years of 2m minima at this
//    exact site put the first <=32F night between 10-10 and 11-08, median 10-29, with zero September
//    nights below 38.2F. 09-25 therefore fired 15-44 days before frost had ever occurred here, trading
//    a certain annual loss of the fastest bulking weeks against a hazard with no September tail.
// THE STANDING RULE: no deadline in this file may be derived from FROST_ANCHORS, in either direction.
// Two sessions did it, on opposite readings, and both were wrong. The dataset's `frost_anchor_warning`
// carries the argument and every dated record now carries a reproducible `measured_basis`;
// storageDeadlines.test.js pins the date to that measurement rather than to the anchor.
// BUG-FROSTANCHORWRONG-001 (2026-08-17) gave the measurement a NAME so the next consumer does not
// have to re-derive it: sowEngine.js exports OBSERVED_FIRST_FALL_FROST carrying the identical
// `measured_basis`, and sowEngine.test.js pins the two copies deep-equal. The standing rule above is
// unchanged — FROST_ANCHORS is still not a frost date — but "which value SHOULD I use" now has an
// answer that is a symbol rather than a warning.

import DATA from '../data/storageDeadlines.json'

export const DEADLINES_BY_CROP_TYPE = DATA.by_crop_type ?? {}
export const NO_CALENDAR_DEADLINE = DATA.no_calendar_deadline ?? {}

/** Phase vocabulary. `upcoming` deliberately carries NO copy — before the check window opens there is
 *  nothing honest to say, and a countdown would be the assertion form wearing a clock. */
export const PHASE_UPCOMING = 'upcoming'
export const PHASE_CHECK = 'check'
export const PHASE_PAST = 'past'

const DAY_MS = 86400000

/** UTC ms for a strict YYYY-MM-DD. Round-trips the components so 2026-02-30 is rejected rather than
 *  silently rolled into March — the Date constructor's overflow is the classic way a bad date in a
 *  data file becomes a plausible-looking wrong deadline. */
function utcMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''))
  if (!m) return NaN
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN
  return ms
}

function yearOf(iso) {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(String(iso ?? ''))
  return m ? Number(m[1]) : NaN
}

/** `MM-DD` + a year => `YYYY-MM-DD`, or null if either side is unusable. */
export function resolveMonthDay(monthDay, year) {
  if (!/^\d{2}-\d{2}$/.test(String(monthDay ?? '')) || !Number.isInteger(year)) return null
  const iso = `${String(year).padStart(4, '0')}-${monthDay}`
  return Number.isNaN(utcMs(iso)) ? null : iso
}

/**
 * Deadline record for a planting's variety_ref, or null.
 *
 * null is the CORRECT and overwhelmingly common outcome — every ornamental, every houseplant, every
 * repeat-harvest crop the ready band already covers, and every storage crop whose deadline could not
 * be sourced. The caller renders nothing rather than an empty labelled section.
 */
export function resolveStorageDeadline(varietyRef) {
  const slug = varietyRef?.crop_type_slug
  if (!slug) return null
  return DEADLINES_BY_CROP_TYPE[slug] ?? null
}

/** True when the crop was examined for this item and deliberately given no date. Distinct from "not
 *  looked at" — used to keep a future pass from re-litigating a settled disconfirmation. */
export function hasExaminedNoDeadline(slug) {
  return Boolean(slug) && slug !== '_note' && Object.hasOwn(NO_CALENDAR_DEADLINE, slug)
}

/**
 * Where a deadline record stands relative to `todayISO`.
 *
 * Returns null for an absent/malformed record or an unparseable date — UNKNOWN must not fire, same
 * contract as harvestReadiness. Never throws.
 */
export function storageDeadlineStatus(record, todayISO) {
  if (!record) return null
  const year = yearOf(todayISO)
  const todayMs = utcMs(todayISO)
  if (!Number.isInteger(year) || Number.isNaN(todayMs)) return null

  const deadlineISO = resolveMonthDay(record.deadline_month_day, year)
  const checkFromISO = resolveMonthDay(record.check_from_month_day, year)
  if (!deadlineISO || !checkFromISO) return null

  const deadlineMs = utcMs(deadlineISO)
  const checkFromMs = utcMs(checkFromISO)
  // A check window that opens on or after its own deadline is a data error, not a zero-length window
  // to render. Refusing is safer than showing a deadline with no lead time.
  if (checkFromMs >= deadlineMs) return null

  const phase = todayMs > deadlineMs ? PHASE_PAST : todayMs >= checkFromMs ? PHASE_CHECK : PHASE_UPCOMING

  return {
    phase,
    deadlineISO,
    checkFromISO,
    daysUntil: Math.round((deadlineMs - todayMs) / DAY_MS),
    copy: phase === PHASE_CHECK ? (record.check_copy ?? null)
      : phase === PHASE_PAST ? (record.past_copy ?? null)
        : null,
    trueTrigger: record.true_trigger ?? null,
    source: record.source ?? null,
    sourceUrl: record.source_url ?? null,
    confidence: record.confidence ?? null,
  }
}

/**
 * Convenience for a list of plantings: those whose crop has a sourced deadline currently in its check
 * or past phase, soonest deadline first. Plantings with no deadline are dropped, not annotated.
 */
export function plantingsWithOpenDeadline(plantings, todayISO) {
  if (!Array.isArray(plantings)) return []
  return plantings
    .map(p => ({ planting: p, status: storageDeadlineStatus(resolveStorageDeadline(p?.variety_ref), todayISO) }))
    .filter(r => r.status && r.status.phase !== PHASE_UPCOMING)
    .sort((a, b) =>
      a.status.daysUntil - b.status.daysUntil ||
      String(a.planting?.name || '').localeCompare(String(b.planting?.name || '')))
}
