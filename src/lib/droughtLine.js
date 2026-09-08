// src/lib/droughtLine.js — V5-DROUGHTSPACE-001.
//
// Reads the GARDEN-WIDE drought line off the stored daily_plan payload. Pure: no fetch, no clock, no DOM.
//
// THE WORDING IS NOT BUILT HERE, DELIBERATELY, and that is a departure from frostAlertLine.js's
// precedent. The drought sentence is already worded once, server-side, by droughtSignal.gardenDroughtNote
// — the same function that words the per-plant note and the CloudWatch line — and Dave's ruling is
// specifically about wording ("no deep soak in N days", never "no rain in N days"). A second wording
// site is a second place for that category slip to come back, and it would drift silently: the two
// halves ship on different pipelines (Lambda vs S3/CloudFront) and are never deployed together.
// So this module VALIDATES and PASSES THROUGH. The structured fields ride along for a caller that
// wants them; the sentence stays single-sourced.
//
// The key is spread CONDITIONALLY by the handler, so `plan.drought` is absent on every day the signal
// does not fire — which is most days. Absent, malformed, or noteless all mean the same thing here:
// render nothing. Never a blank strip, never a heading over silence.

// A note that reads as "no rain in N days" is the category slip Dave's ruling exists to prevent, and a
// payload written by an older Lambda could still carry one. Refuse it rather than render it: silence is
// recoverable, a sentence that says the wrong thing about his garden is not.
const CATEGORY_SLIP = /no (?:measurable )?rain in/i;

export function buildDroughtLine(plan) {
  const d = plan && typeof plan === 'object' ? plan.drought : null;
  if (!d || typeof d !== 'object') return null;
  const note = typeof d.note === 'string' ? d.note.trim() : '';
  if (!note) return null;
  if (CATEGORY_SLIP.test(note)) return null;
  const dryDays = Number(d.dry_days);
  // The sentence's whole content is the day count. A payload that lost it is not worth rendering.
  if (!Number.isFinite(dryDays) || dryDays <= 0) return null;
  return {
    text: note,
    dryDays,
    truncated: d.truncated === true,
    lastDeepSoak: typeof d.last_deep_soak === 'string' ? d.last_deep_soak : null,
    lastDeepWater: typeof d.last_deep_water === 'string' ? d.last_deep_water : null,
  };
}

export default { buildDroughtLine };
