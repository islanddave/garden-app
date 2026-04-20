import { createClient } from '@supabase/supabase-js'
import { PHOTO_BUCKET } from './constants.js'

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing Supabase environment variables.')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
})

export function getPhotoUrl(storagePath) {
  if (!storagePath) return null
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

export function getGCalUrl(task) {
  const base  = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
  const title = encodeURIComponent(task.title)
  const date  = task.due_date?.replace(/-/g, '')
  return `${base}&text=${title}&dates=${date}/${date}`
}
