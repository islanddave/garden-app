// Supabase removed from stack — migrated to Neon + Lambda.
// Tasks Lambda: DB-MIGRATE-TASKS | Inventory Lambda: DB-MIGRATE-INVENTORY

export function getGCalUrl({ title, date, notes }) {
  const start = date?.replace(/-/g, '') ?? '';
  const end   = start;
  const text  = encodeURIComponent(title ?? '');
  const details = encodeURIComponent(notes ?? '');
  return `https://calendar.google.com/calendar/r/eventedit?text=${text}&dates=${start}/${end}&details=${details}`;
}
