import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { P, LOCATION_TYPE_LABELS } from '../lib/constants.js'

const LEVEL_LABELS = ['Zone', 'Area', 'Section', 'Sub-Section']
const LEVEL_ACCENTS = [P.green, P.greenLight, P.gold, P.terra]

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function emptyCreateForm() {
  return { name: '', slug: '', type_label: '', parent_id: '', sort_order: '0', description: '' }
}

export default function Locations() {