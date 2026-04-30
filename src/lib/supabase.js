// Supabase removed from stack — migrated to Neon + Lambda.
// Tasks and Inventory Lambdas pending (DB-MIGRATE-TASKS, DB-MIGRATE-INVENTORY).
// All callers guard on `supabase &&` / `if (!supabase)` — null is handled gracefully.
export const supabase = null;

export function getGCalUrl({ title, date, notes }) {
  const start = date?.replace(/-/g, '') ?? '';
  const end   = start;
  const text  = encodeURIComponent(title ?? '');
  const details = encodeURIComponent(notes ?? '');
  return `https://calendar.google.com/calendar/r/eventedit?text=${text}&dates=${start}/${end}&details=${details}`;
}
