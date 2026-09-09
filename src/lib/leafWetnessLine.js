// src/lib/leafWetnessLine.js — V5-LEAFWETNESS-001.
//
// Reads the foliar infection-window cue off the stored daily_plan payload. Pure: no fetch, no clock,
// no DOM.
//
// WORDED HERE, unlike droughtLine.js which passes a server-worded sentence through. That module's
// reason for single-sourcing is specific and does not apply: the drought sentence is worded once by
// droughtSignal.gardenDroughtNote for THREE surfaces (per-plant note, garden line, CloudWatch), and
// Dave has a standing ruling on its exact phrasing. This cue has one surface and no server-side
// wording function, so a second wording site does not exist to drift against. Follows
// frostAlertLine.js's precedent instead.
//
// THE WORDING CARRIES TWO HONESTY CONSTRAINTS, both load-bearing rather than stylistic:
//
// 1. IT IS A SCOUTING PROMPT, NEVER A PREDICTION. `loss_cause` is populated on exactly ONE plant in
//    the whole database, so there is no disease-observation record to score this cue against — it
//    ships unfalsifiable. Language that asserts infection ("blight risk high", "your tomatoes will")
//    would be claiming an accuracy nobody has measured. Every sentence below tells him to go and
//    LOOK, which is true regardless of whether the cue is well-tuned.
// 2. IT IS MODELLED, AND IT UNDER-WARNS. precipitation_hours is Open-Meteo's grid cell, not the
//    on-site gauge, and it misses DEW entirely — dew dominates September leaf wetness at this site,
//    so a clear cool night that is peak Septoria weather scores bone dry. The count is a FLOOR. The
//    word "modelled" stays in the sentence for that reason; it is not hedging for its own sake.
//
// NEVER RENDER A COUNT BESIDE RAINFALL. precip_hours and precip_in are separate instruments that
// contradict on real days (2026-09-02: gauge 1.12 in over 0 modelled hours). This line therefore
// states hours-wet alone and never pairs it with a depth.

// Plain-language crop families, not a database read. These are the susceptible families the cue is
// about; the line names them so the prompt is actionable rather than abstract. Kept short on purpose —
// a line that lists nine crops is a line nobody finishes reading.
const SCOUT_TARGETS = 'tomatoes, peppers and basil';

function plural(n, one, many) { return n === 1 ? one : many; }

export function buildLeafWetnessLine(plan) {
  const w = plan && typeof plan === 'object' ? plan.leaf_wetness : null;
  if (!w || typeof w !== 'object') return null;

  const recent = Number(w.recent_wet_days);
  const ahead = Number(w.ahead_wet_days);
  const r = Number.isFinite(recent) && recent > 0 ? recent : 0;
  const a = Number.isFinite(ahead) && ahead > 0 ? ahead : 0;
  // Both zero means the engine emitted a shape with nothing in it. Render nothing rather than a
  // sentence about zero days — same rule as every other ambient line: silent on a quiet day.
  if (!r && !a) return null;

  const hrs = Number.isFinite(Number(w.wet_hours_min)) ? Number(w.wet_hours_min) : null;
  const hourPhrase = hrs ? `${hrs}+ modelled hours` : 'a long modelled stretch';

  let text;
  if (r && a) {
    text = `${r} of the last few days had ${hourPhrase} of leaf wetness, and ${a} more ${plural(a, 'day', 'days')} ahead look the same — scout the lower leaves on ${SCOUT_TARGETS}, and keep water off the foliage.`;
  } else if (r) {
    text = `${r} ${plural(r, 'day', 'days')} recently had ${hourPhrase} of leaf wetness — worth scouting the lower leaves on ${SCOUT_TARGETS}.`;
  } else {
    text = `${a} ${plural(a, 'day', 'days')} ahead look like ${hourPhrase} of leaf wetness — keep water off the foliage, and cut basil before it lands.`;
  }

  return {
    text,
    recentWetDays: r,
    aheadWetDays: a,
    wetHoursMin: hrs,
    // Surfaced so a caller can label provenance without re-deriving it. The component puts it on a
    // data attribute so a test can prove the modelled basis reached the DOM.
    basis: typeof w.basis === 'string' ? w.basis : null,
  };
}

export default { buildLeafWetnessLine };
