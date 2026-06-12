// Findings assembly (slice 6) — PURE, DB-free. Maps DB rows (flagged-issue events joined to their
// planting + canonical entity) into raw findings the engine composes. Kept separate from index.js so
// it is unit-testable without resolving @neondatabase/serverless (same pattern as events/validators.js).
//
// V1 read-model scope (honest cold-start): the ONLY structured first-party care signal in the V1 Neon
// DB is event_log.flagged_as_issue (crop care-knowledge lives in plant-knowledge.json, not the DB until
// V1.1 DRG-GUIDE-001). So V1 surfaces Knowledge-room findings derived from flagged issues. Garden room
// emits 0 (C2); Critters room deferred. Each issue becomes ONE finding, run through the full engine.

const SEVERITY_MAP = { low: 'low', medium: 'moderate', moderate: 'moderate', high: 'high' };
function normalizeSeverity(s) {
  return SEVERITY_MAP[String(s ?? '').toLowerCase()] ?? 'moderate';
}

// Coarse event_type → finding_type mapping (templates in engine/config.js). Unknown → open_issue.
function mapFindingType(eventType) {
  const t = String(eventType ?? '').toLowerCase();
  if (t.includes('pest') || t.includes('aphid') || t.includes('beetle')) return 'pest_pressure';
  if (t.includes('water') || t.includes('wilt') || t.includes('dry')) return 'water_need';
  if (t.includes('light') || t.includes('leggy') || t.includes('etiol')) return 'light_deficit';
  if (t.includes('feed') || t.includes('nutrient') || t.includes('deficien')) return 'nutrient_need';
  return 'open_issue';
}

function subjectLabel(row) {
  const name = (row.plant_name ?? '').trim() || 'This planting';
  return row.project_name ? `${name} (${row.project_name})` : name;
}

// rows: [{ event_id, entity_id, plant_name, project_name, event_type, severity, event_date, resolved_at }]
// Only rows with a resolved canonical entity_id are emitted (a finding MUST carry a valid entity_id, C3).
export function assembleIssueFindings(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!row || !row.entity_id) continue; // no canonical entity → cannot emit a contract-valid finding.
    const severity = normalizeSeverity(row.severity);
    const evidence = [
      // The logged issue itself = first-party local observation supporting the finding.
      { tier: 'first_party_log', axis: 'local', observed_at: row.event_date, polarity: 'supporting' },
    ];
    if (row.resolved_at) {
      // An explicit household resolution is an authoritative contradiction (dave_confirmed tier),
      // so even a high-severity finding resolves (the no-single-signal guard is for inferred
      // contradictions, not an explicit user resolve).
      evidence.push({ tier: 'dave_confirmed', axis: 'local', observed_at: row.resolved_at, polarity: 'contradicting' });
    }
    out.push({
      finding_id: `issue:${row.event_id}`,
      entity_id: row.entity_id,
      source_room: 'Knowledge',
      finding_type: mapFindingType(row.event_type),
      subject_label: subjectLabel(row),
      severity,
      evidence,
      // Flagged issues are ambient by policy: an issue is NOT auto-operational. Frost/heat survival
      // alerts are a SEPARATE operational-alert channel (V3-FROST-001), never inferred here.
      harm: { horizon_hours: null, external: false, irreversible: false, is_cadence_miss: false },
    });
  }
  return out;
}

export { normalizeSeverity, mapFindingType };
