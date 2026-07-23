// harvestGrouping.js — V4-HARVESTVIEW-001 S2a. Pure helpers for the Log feed: group entries into
// day sections and render a day label. No API/tz coupling — day_key is the server-computed
// YYYY-MM-DD in HARVEST_TZ, so the client groups on the string with zero timezone math (design §3b).

// Entries arrive reverse-chron (keyset (event_date,id) DESC); preserve that order both across and
// within day sections. Returns [{ day_key, entries: [...] }] in feed order.
export function groupByDay(entries = []) {
  const sections = [];
  const index = new Map();
  for (const e of entries) {
    const k = e?.day_key || (e?.event_date ? String(e.event_date).slice(0, 10) : 'unknown');
    let sec = index.get(k);
    if (!sec) { sec = { day_key: k, entries: [] }; index.set(k, sec); sections.push(sec); }
    sec.entries.push(e);
  }
  return sections;
}

// Human day label from a YYYY-MM-DD key. The year is shown only OUTSIDE the current grow display
// year (design §3b) — pass the caller's current year (kept pure: no Date.now() here). UTC construction
// + timeZone:'UTC' so the label reflects the key's own date, never the viewer's local shift.
export function dayLabel(dayKey, currentYear) {
  const k = String(dayKey ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return k;
  const [y, m, d] = k.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (currentYear != null && y !== currentYear) opts.year = 'numeric';
  return dt.toLocaleDateString(undefined, opts);
}

// Relative label for the "Last harvest" tile (design §3a): today / yesterday / N days ago within a
// week, absolute date beyond. Pure string-key math (both keys are YYYY-MM-DD in the garden zone).
function keyToUTC(k) { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); }
export function relativeDay(dayKey, todayKey) {
  const a = String(dayKey ?? ''); const t = String(todayKey ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return a;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return dayLabel(a);
  const diff = Math.round((keyToUTC(t) - keyToUTC(a)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff <= 7) return `${diff} days ago`;
  return dayLabel(a, Number(t.slice(0, 4)));
}
