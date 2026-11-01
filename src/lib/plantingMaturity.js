// Computed maturity / harvest window for a planting. Pure, null-tolerant.
//
// The DTM anchor is BASIS-AWARE. days_to_maturity is a catalogue figure quoted either from sow or from
// transplant depending on the crop. The basis is carried per crop type on crop_types.dtm_basis and
// reaches here as planting.variety_ref.dtm_basis ('from-sow' | 'from-transplant' | null).
//   from-transplant -> DTM anchors on transplanted_at ?? planted_out_at; with neither, the window
//                      is SUPPRESSED rather than guessed.
//   from-sow / null -> DTM anchors on sown_at ?? the display anchor. NULL means "uncurated" and
//                      reproduces the pre-basis behaviour EXACTLY.
// The AGE anchor (anchorField/anchorDate/anchorLabel, "Day N since transplanted") is UNCHANGED --
// only the DTM anchor is basis-sensitive.
//
// variety_ref.days_to_maturity_min/max come from the cultivar.
//
// from-transplant windows are SITE-CALIBRATED: no observed first harvest landed inside the catalogue
// window, so those windows are scaled by the measured site factor and presented as a widened range
// (+/-14d), which puts 31 of 35 observed first-harvests inside. from-sow and uncurated (null) bases
// are DELIBERATELY untouched. See maturityCalibration.js for why, and for the full derivation and its
// provenance; all calibration constants live there, not here.

// A DTM-derived window does not CLOSE on a continuous-harvest crop. maturityCalibration.js fitted the
// site factor against FIRST harvest only, so the lo..hi pair it returns is an uncertainty band around
// the FIRST pick; it was never a statement about when production ends. For a `single` crop the two
// readings coincide closely enough to be harmless: there is one terminal harvest, so "when it's ready"
// and "when it's done" are the same event. For a crop that keeps fruiting until frost or death they
// are not, and rendering the upper bound as a close told the grower a plant they were actively picking
// had finished (a pepper with weeks of season left reading "Harvest window open — through Aug 12"
// after that date). See the comment on the label branches below for what it says now and why the
// alternatives were rejected.

import { calibrateFromTransplant, SITE_FACTOR } from './maturityCalibration.js'
import { plantingIsHarvestTracked } from './harvestTracked.js'
import { parseDayOrInstant as parseDate } from './dateLocal.js'

export const DTM_BASIS_SOW = 'from-sow'
export const DTM_BASIS_TRANSPLANT = 'from-transplant'

// crop_types.harvest_habit values whose harvest is CONTINUOUS: the plant goes on yielding after the
// first pick, so no catalogue figure can say when it stops. `repeat` = discrete fruits picked over a
// season (pepper, tomato); `cut_and_come_again` = the plant regrows the harvested tissue (basil,
// lettuce). Deliberately the SAME two-member set as harvestReadiness.js REPEATING_HABITS — that
// module already encodes "keeps producing" as exactly these two, and a second, differently-drawn
// line between them would be a split-brain nobody could reason about.
//
// WHY cut_and_come_again IS IN. Its harvest does end — by bolting — but bolting is not a DTM
// function either, so a catalogue-derived close is exactly as fictional there as it is for a pepper.
// watch.js makes the same point from the other direction: "for a crop harvested continuously from
// the moment it has leaves, 'the catalogue says day 45' answers a question nobody asked". Where
// watch.js DOES separate them (DERIVED_ANCHOR_HABITS drops cut_and_come_again) the reason is anchor
// quality on a date the system invented — which cannot apply here, because this surface only speaks
// when Dave entered a real sow or transplant date.
//
// `single` and NULL/unknown habits are NOT in this set and take the untouched code path below.
//
// NULL harvest_habit means "nobody has said", which is a different statement from "this is not
// harvested", so ornamental-ness must not be read off it (some edible plants have a NULL habit). The
// positive list in lib/harvestTracked.js is the actual classifier.
export const CONTINUOUS_HARVEST_HABITS = new Set(['repeat', 'cut_and_come_again'])

// Only the two CHECK-constrained values resolve; anything else (null, undefined, a value from a
// newer server than this bundle) falls back to the legacy from-sow behaviour.
function resolveBasis(value) {
  return value === DTM_BASIS_SOW || value === DTM_BASIS_TRANSPLANT ? value : null
}

function fmt(d) {
  if (!d) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const DAY_MS = 86400000

// Days are counted on the CALENDAR, never as multiples of 24 hours: a local day is 23 or 25 hours
// long when the clocks change, so `anchor + n * DAY_MS` lands at 11 pm the evening before once a
// window crosses the fall change (sown Sep 1 + 70 printed Nov 9) and at 1 am across the spring one.
// Same counting as the server twin's addDays/daysBetween (lambda/harvests/watch.js), which works on
// Y-M-D text and so never had the defect.
function addCalendarDays(d, n) {
  const r = new Date(d.getTime())
  r.setDate(r.getDate() + n)
  return r
}

// Whole calendar days from the local day of `a` to the local day of `b`.
function calendarDaysBetween(a, b) {
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS,
  )
}

// computeMaturity(planting, today=new Date()) ->
//   { ageDays, anchorField, anchorDate, anchorLabel,
//     dtmMin, dtmMax, maturityMinDate, maturityMaxDate,
//     harvestWindowLabel, isMature, pctToMaturity,
//     dtmBasis, basisResolved, dtmAnchorField, dtmAnchorDate, dtmAnchorLabel, awaitingTransplant,
//     calibrated, calibrationFactor, harvestHabit, continuousHarvest }
// Returns nulls (not throws) for every field that can't be computed.
export function computeMaturity(planting, today = new Date()) {
  const out = {
    ageDays: null, anchorField: null, anchorDate: null, anchorLabel: null,
    dtmMin: null, dtmMax: null, maturityMinDate: null, maturityMaxDate: null,
    harvestWindowLabel: null, isMature: null, pctToMaturity: null,
    dtmBasis: null, basisResolved: false,
    dtmAnchorField: null, dtmAnchorDate: null, dtmAnchorLabel: null,
    awaitingTransplant: false,
    calibrated: false, calibrationFactor: null,
    harvestHabit: null, continuousHarvest: false,
    // True unless the crop type is positively listed as not-harvested. Defaults TRUE so an unknown
    // slug can only ever remove a claim somebody made, never withhold one from a food crop.
    harvestTracked: true,
  }
  if (!planting) return out

  // Rides in on variety_ref alongside dtm_basis/default_unit: it is a crop_types column, and
  // variety_ref is the only channel crop-type attributes have to the client (there is no crop-types
  // endpoint). An older bundle, or a cultivar with no crop_type_slug, sees undefined here and gets the
  // wording from before habits mattered.
  out.harvestHabit = planting?.variety_ref?.harvest_habit ?? null
  out.continuousHarvest = CONTINUOUS_HARVEST_HABITS.has(out.harvestHabit)

  // A plant grown to be LOOKED AT gets no harvest projection (a rescued ornamental once read "Est.
  // harvest Oct 4 – Oct 24"). harvestReadiness.js and the watch Lambda have the same gate.
  //
  // AGE IS NOT SUPPRESSED, only the harvest CLAIM. "Transplanted 34 days ago" is true and useful for an
  // ornamental. What goes is the projected window, its dates, isMature and the progress fraction:
  // statements about a pick that will never happen. Suppressed here rather than at each render site so
  // every consumer of computeMaturity is covered at once.
  out.harvestTracked = plantingIsHarvestTracked(planting)

  // Anchor for AGE display: the most advanced lifecycle date present.
  const transplanted = parseDate(planting.transplanted_at)
  const plantedOut = parseDate(planting.planted_out_at)
  const sown = parseDate(planting.sown_at)
  if (transplanted) { out.anchorField = 'transplanted_at'; out.anchorDate = transplanted; out.anchorLabel = 'transplanted' }
  else if (plantedOut) { out.anchorField = 'planted_out_at'; out.anchorDate = plantedOut; out.anchorLabel = 'planted out' }
  else if (sown) { out.anchorField = 'sown_at'; out.anchorDate = sown; out.anchorLabel = 'sown' }

  const now = parseDate(today) || new Date()
  if (out.anchorDate) {
    out.ageDays = Math.max(0, calendarDaysBetween(out.anchorDate, now))
  }

  // Maturity window: anchor per the crop's DTM basis (see header).
  const dtmMin = Number.isFinite(planting?.variety_ref?.days_to_maturity_min) ? planting.variety_ref.days_to_maturity_min : null
  const dtmMax = Number.isFinite(planting?.variety_ref?.days_to_maturity_max) ? planting.variety_ref.days_to_maturity_max : null
  out.dtmMin = dtmMin
  out.dtmMax = dtmMax

  const basis = resolveBasis(planting?.variety_ref?.dtm_basis)
  out.dtmBasis = basis
  out.basisResolved = basis != null

  let dtmAnchor = null
  if (basis === DTM_BASIS_TRANSPLANT) {
    if (transplanted) { dtmAnchor = transplanted; out.dtmAnchorField = 'transplanted_at'; out.dtmAnchorLabel = 'transplant' }
    else if (plantedOut) { dtmAnchor = plantedOut; out.dtmAnchorField = 'planted_out_at'; out.dtmAnchorLabel = 'planting out' }
  } else {
    dtmAnchor = sown || out.anchorDate
    if (sown) { out.dtmAnchorField = 'sown_at'; out.dtmAnchorLabel = 'sow' }
    else if (dtmAnchor) { out.dtmAnchorField = out.anchorField; out.dtmAnchorLabel = out.anchorLabel }
  }
  out.dtmAnchorDate = dtmAnchor

  // A from-transplant crop with no transplant/planted-out date has an UNKNOWABLE window. Say so instead
  // of projecting one: start_indoor_weeks is populated for well under half the affected plantings, so
  // a projection would fabricate a confident-looking wrong date.
  if (out.harvestTracked && !dtmAnchor && basis === DTM_BASIS_TRANSPLANT && (dtmMin != null || dtmMax != null)) {
    out.awaitingTransplant = true
    out.harvestWindowLabel = 'Est. harvest — set at transplant'
    return out
  }

  // The harvest projection is skipped entirely for a not-harvest-tracked crop. The awaiting-transplant
  // branch above is also a harvest claim, so it carries the same harvestTracked condition.
  if (out.harvestTracked && dtmAnchor && (dtmMin != null || dtmMax != null)) {
    // For from-transplant crops, scale the catalogue ends by the site factor and widen. Returns null
    // for every other basis, so from-sow/uncurated keep the raw catalogue window.
    const calib = calibrateFromTransplant(basis, dtmMin, dtmMax)
    out.calibrated = calib != null
    out.calibrationFactor = calib != null ? SITE_FACTOR : null

    const lo = calib ? calib.loDays : (dtmMin != null ? dtmMin : dtmMax)
    const hi = calib ? calib.hiDays : (dtmMax != null ? dtmMax : dtmMin)
    out.maturityMinDate = addCalendarDays(dtmAnchor, lo)
    out.maturityMaxDate = addCalendarDays(dtmAnchor, hi)
    out.isMature = now >= out.maturityMinDate
    // progress toward the EARLIEST maturity date (0..1), clamped. Uses the calibrated opening when
    // calibration applied, so the bar and the label agree.
    const span = out.maturityMinDate - dtmAnchor
    out.pctToMaturity = span > 0 ? Math.max(0, Math.min(1, (now - dtmAnchor) / span)) : (now >= out.maturityMinDate ? 1 : 0)

    const a = fmt(out.maturityMinDate)
    const b = fmt(out.maturityMaxDate)
    // No " · site-calibrated" suffix: the window is read as a rough guide, and the suffix advertised a
    // precision the reader was not asking for. The calibration itself is unchanged: SITE_FACTOR (0.75)
    // still scales the window and `out.calibrated` / `out.calibrationFactor` are still set, so every
    // consumer and every measurement of calibration accuracy is untouched. Do not restore the suffix
    // without a new product decision; re-tightening the window itself is separate work.
    const suffix = ''
    // On a continuous-harvest crop the pair is an estimate of the FIRST pick, so it is named as one.
    // Same two dates, no numeric change: the range already meant this; the old wording just implied
    // the harvest was over by `b`.
    const estLead = out.continuousHarvest ? 'Est. first harvest' : 'Est. harvest'
    if (out.isMature && out.continuousHarvest && calib && a) {
      // An OPEN-ENDED label: a continuous crop past its opening estimate gets the opening date (the end
      // with measured backing: 0.75 factor, 31/35 observed first-harvests in-window) and no close,
      // because none of the inputs here knows one.
      //
      // REJECTED, and why:
      //  * A frost-driven close ("through ~Sep 28"). Tempting, and the anchor already exists
      //    (sowEngine.js FROST_ANCHORS, restated in watch.js). Rejected: first frost is a
      //    climatological hazard date, not a harvest-window close — it applies to `single` habits
      //    identically, so scoping it to repeat would be arbitrary; it is flat wrong for the
      //    cold-hardy half of cut_and_come_again (kale and lettuce outlive 09-28, under cover or
      //    not); and a container pepper can be carried indoors. It also swaps a measured estimate
      //    for an unmeasured prediction on the one surface whose sibling module explicitly refuses
      //    prediction grammar (watch.js §GRAMMAR CONTRACT).
      //  * Suppressing the window entirely for continuous habits. Rejected: the opening estimate is
      //    the half of this that has evidence behind it, and dropping it would blank the maturity
      //    band on every continuous-harvest crop to fix a wording defect.
      //  * Projecting the next pick off crop_types.repeat_interval_days ("~7 days"). Rejected: that
      //    is harvestReadiness.isReadyToPick's job, it is evidence-only and requires >=1 logged
      //    pick, and restating it here in prediction grammar is the split-brain watch.js warns of.
      out.harvestWindowLabel = `Harvest window open — picking from ${a}${suffix}`
    } else if (out.isMature && calib && b) {
      // A calibrated window that has OPENED must keep its closing date visible. Collapsing it to a
      // bare "Maturity window reached" would throw away the +/-14d uncertainty that is the entire
      // point of calibrating — and would read as more confident than the raw catalogue label it
      // replaced. Uncalibrated windows keep the original wording untouched.
      //
      // This branch is for non-continuous habits ONLY. It keeps the close for `single` (and for an
      // unknown habit, which must behave as it did before), where a closing date is a real thing: a
      // storage onion, garlic or winter squash has one terminal harvest and a genuine deadline past
      // which the crop degrades in the ground.
      out.harvestWindowLabel = `Harvest window open — through ${b}${suffix}`
    } else if (out.isMature) {
      // Uncalibrated + open. Says nothing about a close in any habit, and is left alone rather than
      // widening this change's blast radius.
      out.harvestWindowLabel = 'Maturity window reached'
    } else if (a && b && a !== b) {
      out.harvestWindowLabel = `${estLead} ${a} – ${b}${suffix}`
    } else if (a) {
      out.harvestWindowLabel = `${estLead} ~${a}${suffix}`
    }
  }

  return out
}
