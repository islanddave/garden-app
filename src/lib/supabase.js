import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Supabase client retained for inventory_items and tasks (no Lambdas deployed yet).
// TODO DB-MIGRATE-INVENTORY: remove when /api/inventory Lambda is deployed.
// TODO DB-MIGRATE-TASKS: remove when /api/tasks Lambda is deployed.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// getPhotoUrl removed — photos now include view_url from the photos Lambda (signed S3 URL).
// Remove any remaining imports of getPhotoUrl from callers.

export function getGCalUrl({ title, date, notes }) {
  const start = date?.replace(/-/g, '') ?? '';
  const end   = start;
  const text  = encodeURIComponent(title ?? '');
  const details = encodeURIComponent(notes ?? '');
  return `https://calendar.google.com/calendar/r/eventedit?text=${text}&dates=${start}/${end}&details=${details}`;
}
