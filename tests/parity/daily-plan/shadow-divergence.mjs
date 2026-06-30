// DRG-BACKBONE-001 P0 / G-PARITY — shadow-divergence detector.
//
// §16 OQ1 refinement: "Add a shadow-divergence alert during the parity window (log every shadow-vs-live plan
// delta; a delta outside the allowlist BLOCKS cutover and pages, rather than silently passing)."
//
// This is the PURE detector + report formatter. During the parity window the nightly handler will call
// detectDivergence(live, shadow) and, on `blocking`, emit the report to the structured log / alert channel
// (that wiring lands with the cutover; the detector exists + is tested now so the gate is real and
// FALSIFIABLE — see parity.test.js fault-injection). `live` = the plan the rule engine actually drove;
// `shadow` = the shared-engine candidate. Order matters only for diff direction (golden=live, candidate=shadow).
import { compare, formatDiffs } from './compare.mjs';

export function detectDivergence(live, shadow, opts = {}) {
  const { blocking, benign, all } = compare(live, shadow, opts);
  return {
    blocking: blocking.length > 0,            // a non-allowlisted delta blocks the cutover and pages
    blockingDiffs: blocking,
    benignDiffs: benign,
    counts: { total: all.length, blocking: blocking.length, benign: benign.length },
    report: renderReport({ blocking, benign }),
  };
}

function renderReport({ blocking, benign }) {
  if (!blocking.length && !benign.length) return 'PARITY OK — live and shadow plans are equivalent.';
  const lines = [];
  if (blocking.length) {
    lines.push(`PARITY BLOCKED — ${blocking.length} non-allowlisted divergence(s):`);
    lines.push(formatDiffs(blocking));
  }
  if (benign.length) {
    lines.push(`(${benign.length} benign/allowlisted diff(s) ignored)`);
  }
  return lines.join('\n');
}
