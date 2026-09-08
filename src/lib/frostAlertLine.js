// src/lib/frostAlertLine.js — BUG-FROSTALERTNOAPP-001.
//
// Words the frost ADVISORY that the daily-plan engine already sent by SNS, for rendering on Today.
// Pure: no fetch, no clock, no DOM. Mirrors the vocabulary of the SNS text (frostEval
// advisoryMessage) so the message Dave gets on his phone and the line he sees in the app cannot
// drift into describing the same night two ways.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// IT RENDERS THE ADVISORY TIER ONLY, AND THE EXCLUSIONS ARE MEASURED, NOT TASTE.
//
// Today already has a frost surface: WeatherCueLine renders computeCallout's `freeze` cue at
// `tonightLow < 40` and `cold` at `< 45`. So the naive reading of this bug — "frost alerts are
// invisible in the app" — is FALSE for tonight, and shipping a second tonight-line would be pure
// duplication in a slot whose own header warns that a third warn-family item turns the other two
// into wallpaper.
//
// What has NO surface is the LEAD TIME. frostEval's evalAdvisory scans the D1..D3 forecast window
// and picks the coldest night in it; the cue keys on tonight alone. They are different nights, and
// `dayOffset` is `i + 1` there so an advisory can never even refer to tonight. Measured on the night
// it actually happened: the stored 2026-09-07 plan had tonightLow 55 and callout NULL — Today said
// nothing — while an advisory fired, because a night inside the window was <= 40F.
//
//   - imminent  -> skipped. Fires at <= 38F, and 38 < 40, so the freeze cue ALWAYS covers it.
//   - heat      -> skipped. computeCallout renders `high >= 88` already.
//   - advisory  -> rendered. Nothing else on Today speaks about a night that is not tonight.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AN ENTRY WITHOUT A TEMPERATURE RENDERS NOTHING, DELIBERATELY.
//
// Entries written before the handler persisted the weather facts carry key/tier/level/at only — 66
// such rows existed in prod when this was written. A line built from those could say no more than
// "an advisory was sent at 11:27pm", which raises the question it cannot answer and is worse than
// silence on a screen whose whole discipline is that silence means something. So: no lowF, no line.
// Those rows age out on their own; nothing needs backfilling.

const SEVERITY = { advisory: 1 };

// "tomorrow night" / "in 3 days" — the exact split frostEval's advisoryMessage uses.
export function whenPhrase(dayOffset) {
  const n = Number(dayOffset);
  if (!Number.isFinite(n) || n < 1) return null;
  return n === 1 ? 'tomorrow night' : `in ${Math.trunc(n)} days`;
}

// Picks the alert to render, or null. Most severe wins; among equals the most recently SENT wins,
// because a re-send inside one night is an escalation, not a repeat (handler carries prior sends
// forward rather than replacing them, so the array is append-ordered but `at` is authoritative).
export function pickAdvisory(alertsSent) {
  if (!Array.isArray(alertsSent)) return null
  let best = null
  for (const a of alertsSent) {
    if (!a || SEVERITY[a.tier] == null) continue
    if (a.lowF == null || !Number.isFinite(Number(a.lowF))) continue
    if (whenPhrase(a.dayOffset) == null) continue
    if (best == null) { best = a; continue }
    const s = SEVERITY[a.tier] - SEVERITY[best.tier]
    if (s > 0) { best = a; continue }
    if (s === 0 && String(a.at || '') > String(best.at || '')) best = a
  }
  return best
}

// -> { text, tier, dayOffset, lowF } or null.
export function buildFrostAlertLine(alertsSent) {
  const a = pickAdvisory(alertsSent)
  if (!a) return null
  const when = whenPhrase(a.dayOffset)
  const low = Math.round(Number(a.lowF))
  return {
    text: `Frost possible ${when} — low ${low}°F. Plan cover for tender plants.`,
    tier: a.tier,
    dayOffset: Math.trunc(Number(a.dayOffset)),
    lowF: low,
  }
}
