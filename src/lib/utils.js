// Utility functions — small helpers with no home-specific dependency

// Build a Google Calendar "add event" URL from event fields.
// Used by event logging flow (Phase 3+).
export function getGCalUrl({ title, date, notes }) {
  const start = date?.replace(/-/g, '') ?? '';
  const end   = start;
  const text    = encodeURIComponent(title ?? '');
  const details = encodeURIComponent(notes ?? '');
  return `https://calendar.google.com/calendar/r/eventedit?text=${text}&dates=${start}/${end}&details=${details}`;
}
