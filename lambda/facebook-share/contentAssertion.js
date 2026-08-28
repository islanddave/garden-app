// Pre-publish content assertion — the control the 2026-08-28 crucible named and the plan dropped.
//
// WHY. Two prior public-output defects on this project were not "compose produced wrong numbers";
// they were public surfaces disclosing WHERE. v4.61.0 scrubbed a home coordinate published to 4dp
// (about 11 m) and v4.62.0 stopped public garden pages disclosing where in the property a planting
// lives. This handler is a third public surface, and nothing inspects what it is about to say.
//
// The image bytes already have a fail-closed control (the EXIF strip refuses to publish a photo it
// could not fully walk). The TEXT has none. What reaches a public Page is:
//   - `caption`     — free text, whatever was typed
//   - `alt_text_custom` — derived from planting / variety / crop display names, which are
//                     user-authored and can say anything
//
// WHY THE TERM LIST IS NOT IN THIS FILE. islanddave/garden-app is a PUBLIC repo. A hardcoded list of
// the town, the road, or family names — the very strings worth blocking — would publish them to
// exactly the audience the control exists to protect against. That is the same defect, relocated
// into the guard. So terms are supplied by the caller from the environment (see SHARE_FORBIDDEN_TERMS
// in index.js), the same posture AWN_STATIONS_JSON took after the coordinate scrub.
//
// WHY `checksRun` IS RETURNED. An optional term list means "configured with no terms" and "found
// nothing" are the same output unless the result says which checks actually ran. A caller that logs
// `safe: true` without that distinction is reporting a control that may never have executed —
// the same failure the share alarms refuse to arm into.

// A decimal-degree PAIR, which is what a leaked location actually looks like when it appears in
// text. Requires >= 4 decimal places on both halves: that is ~11 m precision, the threshold the
// v4.61.0 incident turned on, and it is what keeps ordinary garden prose ("3.5, 4.2 lbs") out of the
// match. Ranges are constrained to real latitude/longitude so a pair of large measurements cannot
// trip it. Deliberately a PATTERN and not a VALUE — it needs no secret, so unlike the term list it
// is always available and therefore always runs.
// The lookarounds are load-bearing, not decoration. Without a leading (?<![\d.]) the engine happily
// matches a SUFFIX of a longer number — "191.4712, -72.6009" matched as "1.4712, -72.6009", reading
// a fragment of a measurement as a latitude. A guard that fires on the wrong substring is a guard
// whose output cannot be trusted either way, so it is anchored to whole numbers at both ends.
const COORD_PAIR = /(?<![\d.])(-?(?:90|[0-8]?\d)\.\d{4,})\s*[,;/]\s*(-?(?:180|1[0-7]\d|\d{1,2})\.\d{4,})(?![\d])/;

function normalize(s) {
  return typeof s === 'string' ? s : '';
}

// Word-boundary, case-insensitive, and escaped — a term is data, not a pattern. Without escaping, a
// term containing regex metacharacters would either throw or silently match the wrong thing.
function termHit(haystack, term) {
  const t = String(term ?? '').trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${esc}(\\W|$)`, 'i').test(haystack);
}

// Returns { safe, violations, checksRun }.
//   violations: [{ kind, field, detail }] — `detail` NEVER echoes the matched secret term, only
//   which term index matched, so a log line about a leak does not itself become the leak.
export function assertPublishSafe({ caption, altTexts = [], forbiddenTerms = [] } = {}) {
  const fields = [
    { field: 'caption', text: normalize(caption) },
    ...(Array.isArray(altTexts) ? altTexts : []).map((t, i) => ({ field: `alt[${i}]`, text: normalize(t) })),
  ].filter((f) => f.text);

  const violations = [];
  const checksRun = ['coordinates'];

  for (const { field, text } of fields) {
    const m = COORD_PAIR.exec(text);
    if (m) violations.push({ kind: 'coordinates', field, detail: `looks like a coordinate pair at offset ${m.index}` });
  }

  const terms = (Array.isArray(forbiddenTerms) ? forbiddenTerms : []).filter((t) => String(t ?? '').trim());
  if (terms.length) {
    checksRun.push('terms');
    for (const { field, text } of fields) {
      terms.forEach((term, i) => {
        if (termHit(text, term)) {
          violations.push({ kind: 'forbidden_term', field, detail: `matched configured term #${i}` });
        }
      });
    }
  }

  return { safe: violations.length === 0, violations, checksRun };
}

// Parse the env-supplied term list. Tolerant by design: a malformed value must not take the publish
// path down, but it must also not silently masquerade as "no terms configured" — it returns null,
// which the caller distinguishes from an empty list.
export function parseForbiddenTerms(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((t) => String(t)).filter((t) => t.trim());
    return null;
  } catch { return null; }
}
