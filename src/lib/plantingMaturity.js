// V4-PLANTINGUI-001 — computed maturity / harvest window for a planting.
// Pure, null-tolerant.
//
// V4-MATURITYBASIS-001 (Slice A) — the DTM anchor is now BASIS-AWARE.
// days_to_maturity is a catalogue figure quoted either from sow or from transplant depending on
// the crop. The basis is carried per crop type on crop_types.dtm_basis and reaches here as
// planting.variety_ref.dtm_basis ('from-sow' | 'from-transplant' | null).
//   from-transplant -> DTM anchors on transplanted_at ?? planted_out_at; with neither, the window
//                      is SUPPRESSED rather than guessed (design D3).
//   from-sow / null -> DTM anchors on sown_at ?? the display anchor. NULL means "uncurated" and
//                      reproduces the pre-basis behaviour EXACTLY, which is what makes this change
//                      a provable no-op until the crop_types backfill lands.
// The AGE anchor (anchorField/anchorDate/anchorLabel, "Day N since transplanted") is UNCHANGED --
// only the DTM anchor is basis-sensitive.
//
// variety_ref.days_to_maturity_min/max come from the cultivar (PLANTTYPE substrate).
//
// V4-MATURITYBASIS-001 (Slice D) — from-transplant windows are now SITE-CALIBRATED.
// Slice A exposed that from-transplant crops land inside the catalogue window 0 times out of 21.
// Slice D scales those windows by the measured site factor (~0.70) and presents them as a widened
// range (+/-14d), which puts 16 of 18 observed first-harvests inside the window. from-sow and
// uncurated (null) bases are DELIBERATELY untouched — see maturityCalibration.js for why, and for
// the full derivation and its provenance. All calibration constants live there, not here.

// V4-MATURITYREPEAT-001 (BD-024) — a DTM-derived window no longer CLOSES on a continuous-harvest
// crop. The math was not wrong (BUG-MATURITYMODELMIX-001 verified it end to end and closed
// no-change); what the window MEANT was. maturityCalibration.js fitted the site factor against
// FIRST harvest only ("Observed time-to-first-harvest ~= FACTOR * catalogue DTM"), so the lo..hi
// pair it returns is an uncertainty band around the FIRST pick — it was never a statement about
// when production ends. For a `single` crop the two readings coincide closely enough to be
// harmless: there is one terminal harvest, so "when it's ready" and "when it's done" are the same
// event. For a crop that keeps fruiting until frost or death they are not the same event at all,
// and rendering the upper bound as a close told Dave a plant he was actively picking had finished.
//
// The motivating row, live prod 2026-08-16: Armageddon F1 pepper (status `fruiting`, one logged
// pick on 08-05, DTM 75-95 from-transplant, transplanted 2026-05-23). round(.70*95)+14 = day 81 =
// Aug 12, so the card read "Harvest window open — through Aug 12, 2026" four days AFTER that date,
// on a pepper with ~6 weeks of season left. See the comment on the label branches below for what
// it says now and why the alternatives were rejected.

import { calibrateFromTransplant, SITE_FACTOR } from './maturityCalibration.js'

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
// NULL is the load-bearing exclusion: on live prod it is 54 live plantings, every one an ornamental.
export const CONTINUOUS_HARVEST_HABITS = new Set(['repeat', 'cut_and_come_again'])

// Only the two CHECK-constrained values resolve; anything else (null, undefined, a value from a
// newer server than this bundle) falls back to the legacy from-sow behaviour.
function resolveBasis(value) {
  return value === DTM_BASIS_SOW || value === DTM_BASIS_TRANSPLANT ? value : null
}

function parseDate(value) {
  if (!value) return null
  const d = new Date(typeof value === 'string' && value.length === 10 ? value + 'T00:00:00' : value)
  return isNaN(d.getTime()) ? null : d
}

function fmt(d) {
  if (!d) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const DAY_MS = 86400000

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
  }
  if (!planting) return out

  // V4-MATURITYREPEAT-001. Rides in on variety_ref alongside dtm_basis/default_unit — it is a
  // crop_types column, and variety_ref is the only channel crop-type attributes have to the client
  // (there is no crop-types endpoint). An older bundle, or a cultivar with no crop_type_slug, sees
  // undefined here and gets the pre-V4-MATURITYREPEAT-001 wording unchanged.
  out.harvestHabit = planting?.variety_ref?.harvest_habit ?? null
  out.continuousHarvest = CONTINUOUS_HARVEST_HABITS.has(out.harvestHabit)

  // Anchor for AGE display: the most advanced lifecycle date present.
  const transplanted = parseDate(planting.transplanted_at)
  const plantedOut = parseDate(planting.planted_out_at)
  const sown = parseDate(planting.sown_at)
  if (transplanted) { out.anchorField = 'transplanted_at'; out.anchorDate = transplanted; out.anchorLabel = 'transplanted' }
  else if (plantedOut) { out.anchorField = 'planted_out_at'; out.anchorDate = plantedOut; out.anchorLabel = 'planted out' }
  else if (sown) { out.anchorField = 'sown_at'; out.anchorDate = sown; out.anchorLabel = 'sown' }

  const now = parseDate(today) || new Date()
  if (out.anchorDate) {
    out.ageDays = Math.max(0, Math.floor((now - out.anchorDate) / DAY_MS))
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

  // D3: a from-transplant crop with no transplant/planted-out date has an UNKNOWABLE window.
  // Say so instead of projecting one -- start_indoor_weeks is populated for well under half the
  // affected plantings, so a projection would fabricate a confident-looking wrong date.
  if (!dtmAnchor && basis === DTM_BASIS_TRANSPLANT && (dtmMin != null || dtmMax != null)) {
    out.awaitingTransplant = true
    out.harvestWindowLabel = 'Est. harvest — set at transplant'
    return out
  }

  if (dtmAnchor && (dtmMin != null || dtmMax != null)) {
    // Slice D: for from-transplant crops, scale the catalogue ends by the site factor and widen.
    // Returns null for every other basis, so from-sow/uncurated keep the raw catalogue window.
    const calib = calibrateFromTransplant(basis, dtmMin, dtmMax)
    out.calibrated = calib != null
    out.calibrationFactor = calib != null ? SITE_FACTOR : null

    const lo = calib ? calib.loDays : (dtmMin != null ? dtmMin : dtmMax)
    const hi = calib ? calib.hiDays : (dtmMax != null ? dtmMax : dtmMin)
    out.maturityMinDate = new Date(dtmAnchor.getTime() + lo * DAY_MS)
    out.maturityMaxDate = new Date(dtmAnchor.getTime() + hi * DAY_MS)
    out.isMature = now >= out.maturityMinDate
    // progress toward the EARLIEST maturity date (0..1), clamped. Uses the calibrated opening when
    // calibration applied, so the bar and the label agree.
    const span = out.maturityMinDate - dtmAnchor
    out.pctToMaturity = span > 0 ? Math.max(0, Math.min(1, (now - dtmAnchor) / span)) : (now >= out.maturityMinDate ? 1 : 0)

    const a = fmt(out.maturityMinDate)
    const b = fmt(out.maturityMaxDate)
    // A calibrated number must be visibly distinct from a catalogue one (design D3's labelling
    // rule). Plain text in the same ink and type scale as the rest of the label — deliberately not
    // a badge, tint, or confidence gradient (Reward UX V102 bars colour used to encode magnitude).
    const suffix = calib ? ' · site-calibrated' : ''
    // V4-MATURITYREPEAT-001: on a continuous-harvest crop the pair is an estimate of the FIRST pick,
    // so it is named as one. Same two dates, no numeric change — the range already meant this; the
    // old wording just implied the harvest was over by `b`.
    const estLead = out.continuousHarvest ? 'Est. first harvest' : 'Est. harvest'
    if (out.isMature && out.continuousHarvest && calib && a) {
      // THE FIX. A continuous crop past its opening estimate gets an OPEN-ENDED label: the opening
      // date (the end with measured backing — 0.70 factor, 16/18 observed first-harvests in-window)
      // and no close, because none of the inputs here knows one.
      //
      // REJECTED, and why — this is a judgement call, so the alternatives are recorded:
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
      //    band on 41 of Dave's live plantings to fix a wording defect.
      //  * Projecting the next pick off crop_types.repeat_interval_days ("~7 days"). Rejected: that
      //    is harvestReadiness.isReadyToPick's job, it is evidence-only and requires >=1 logged
      //    pick, and restating it here in prediction grammar is the split-brain watch.js warns of.
      out.harvestWindowLabel = `Harvest window open — picking from ${a}${suffix}`
    } else if (out.isMature && calib && b) {
      // A calibrated window that has OPENED must keep its closing date visible. Collapsing it to a
      // bare "Maturity window reached" would throw away the +/-14d uncertainty that is the entire
      // point of calibrating — and would read as more confident than the raw catalogue label it
      // replaced, which is the failure mode Slice D exists to fix. Uncalibrated windows keep the
      // original wording untouched.
      //
      // V4-MATURITYREPEAT-001 narrowed this branch to non-continuous habits ONLY. It keeps the
      // close for `single` (and for an unknown habit, which must behave as it did before), where a
      // closing date is a real thing: a storage onion, garlic or winter squash has one terminal
      // harvest and a genuine deadline past which the crop degrades in the ground.
      out.harvestWindowLabel = `Harvest window open — through ${b}${suffix}`
    } else if (out.isMature) {
      // Uncalibrated + open. Says nothing about a close in any habit, so V4-MATURITYREPEAT-001
      // leaves it alone rather than widening its own blast radius past the defect it fixes.
      out.harvestWindowLabel = 'Maturity window reached'
    } else if (a && b && a !== b) {
      out.harvestWindowLabel = `${estLead} ${a} – ${b}${suffix}`
    } else if (a) {
      out.harvestWindowLabel = `${estLead} ~${a}${suffix}`
    }
  }

  return out
}
