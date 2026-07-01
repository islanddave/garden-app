// Deterministic render (spec §2 Render + confidence_basis). TEMPLATED ONLY — no serve-time
// LLM-introduced claims (C4). Same inputs → same strings → byte-stable.
import { FINDING_TYPE_TEMPLATES, RESOLVED_STATEMENT } from './config.js';

const supporting = (ev) => ev.polarity !== 'contradicting';

function fmtDate(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function latestLocalSupportingDate(evidence) {
  let max = null;
  for (const ev of evidence) {
    if (!supporting(ev) || ev.axis !== 'local') continue;
    const t = ev.observed_at ? Date.parse(ev.observed_at) : NaN;
    if (Number.isNaN(t)) continue;
    if (max === null || t > max) max = t;
  }
  return max === null ? null : new Date(max).toISOString().slice(0, 10);
}

// confidence_basis [DERIVED]: renders the REASON the finding asserts or asks, so `ask` reads as
// principled ("no first-party log yet") rather than empty. Pure function of the structured evidence.
export function renderConfidenceBasis({ evidence, tier, corroborator_count }) {
  const localCount = evidence.filter((e) => supporting(e) && e.axis === 'local').length;
  if (tier === 'dave_confirmed') {
    const confirmed = evidence.find((e) => supporting(e) && e.tier === 'dave_confirmed');
    const d = fmtDate(confirmed?.observed_at);
    return d ? `Confirmed by you on ${d}.` : 'Confirmed by you.';
  }
  if (localCount > 0) {
    const d = latestLocalSupportingDate(evidence);
    const noun = localCount === 1 ? 'observation' : 'observations';
    return d ? `Based on ${localCount} logged ${noun} (most recent ${d}).`
             : `Based on ${localCount} logged ${noun}.`;
  }
  if (corroborator_count === 0) {
    return 'No first-party log yet — drawn from general care knowledge for this plant.';
  }
  return 'Based on general care knowledge corroborated by a cited source.';
}

// statement [DERIVED]: templated from finding_type + assertion_mode. Unknown types use GENERIC.
// A resolved finding (decay_state==='resolved') ALWAYS renders the resolved statement — never a
// finding_type template — so the headline can never say "has an open issue" for a resolved finding.
export function renderStatement({ finding_type, subject_label, assertion_mode, decay_state }) {
  const subject = subject_label ?? 'This planting';
  if (decay_state === 'resolved') return RESOLVED_STATEMENT.replace('{subject}', subject);
  const tpl = FINDING_TYPE_TEMPLATES[finding_type] ?? FINDING_TYPE_TEMPLATES.GENERIC;
  const text = (assertion_mode === 'ask' ? tpl.ask : tpl.assert);
  return text.replace('{subject}', subject);
}
