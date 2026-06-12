// V3-FEED-001 — client-side feed helpers for the /feed page.
// The /api/events/feed endpoint paginates RAW events (batch member rows included). The page
// accumulates pages and collapses the WHOLE accumulated array each render, so a Log-Many batch
// split across a page boundary still folds into ONE entry. Mirrors the server-side collapse in
// lambda/dashboard/handlers.js (dashboard card path) — kept in sync by intent.

// Collapse Log-Many batches: each batch -> ONE entry, anchored at its newest row (rows arrive
// created_at DESC). batch_count prefers event_batches.item_count (exact, window-proof) and falls
// back to occurrences seen. A critter earned by ANY member surfaces on the collapsed entry
// (the batch awards one critter total — V4 social-feed hook). Non-batch rows pass through as count 1.
export function collapseFeed(rows) {
  const out = [];
  const byBatch = new Map();
  for (const r of rows ?? []) {
    if (!r) continue;
    const bid = r.batch_id ?? null;
    if (!bid) { out.push({ ...r, batch_count: 1 }); continue; }
    const prev = byBatch.get(bid);
    if (prev) {
      if (!prev.exact) prev.entry.batch_count += 1;
      // carry a critter from any later member if the anchor lacked one
      if (!prev.entry.critter_species_id && r.critter_species_id) {
        prev.entry.critter_species_id = r.critter_species_id;
        prev.entry.critter_id = r.critter_id;
      }
      continue;
    }
    const n = Number(r.item_count);
    const exact = Number.isFinite(n) && n > 0;
    const entry = { ...r, batch_count: exact ? n : 1 };
    byBatch.set(bid, { entry, exact });
    out.push(entry);
  }
  return out;
}

// De-dupe by id while preserving order — guards against an overlapping page (offset races) adding
// a row twice before collapse.
export function dedupeById(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows ?? []) {
    if (!r || r.id == null || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// Compact relative time (mirrors Dashboard's local relativeTime; shared here for the feed).
export function relativeTime(isoStr) {
  if (!isoStr) return '';
  const then = new Date(isoStr).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const wks = Math.floor(days / 7);
  if (wks < 5) return `${wks}w ago`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${mos}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export const prettyEventType = (t) => (t ?? '').replace(/_/g, ' ');
