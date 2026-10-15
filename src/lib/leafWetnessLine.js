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

// THE SENTENCES (Today finish plan §3.2, 2026-10-14: the forecast half read "1 day ahead look like…"). Each
// agrees with its count, and each keeps "modelled" (constraint 2). `planDate` (optional, the plan's YYYY-MM-DD)
// lets the forecast half say "Tomorrow" when the only wet day ahead is the day after the plan's — the engine's
// window reaches three days out, so without the date, or for any other day, the line counts the days instead.
function dayAfter(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T12:00:00Z`);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildLeafWetnessLine(plan, { planDate = null } = {}) {
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

  const tomorrow = a === 1 && Array.isArray(w.ahead_dates) && w.ahead_dates.length === 1
    && dayAfter(planDate) != null && w.ahead_dates[0] === dayAfter(planDate);

  let text;
  if (r && a) {
    text = `${r} of the last few days had ${hourPhrase} of wet leaves, and ${a} more ${plural(a, 'day ahead looks', 'days ahead look')} the same — scout the lower leaves on ${SCOUT_TARGETS}; water the soil, not the leaves.`;
  } else if (r) {
    text = `${r} ${plural(r, 'day', 'days')} recently had ${hourPhrase} of wet leaves — worth scouting the lower leaves on ${SCOUT_TARGETS}.`;
  } else if (tomorrow) {
    text = `Tomorrow: ${hourPhrase} of wet leaves likely — water the soil, not the leaves; cut basil today.`;
  } else {
    text = `${a} ${plural(a, 'day ahead looks', 'days ahead look')} likely to bring ${hourPhrase} of wet leaves — water the soil, not the leaves; cut basil before then.`;
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
