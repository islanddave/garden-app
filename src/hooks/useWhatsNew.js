// useWhatsNew — V4-WHATSNEW-001. Fetches releases.json, derives whether the newest release is
// unseen vs the localStorage last-seen version, and stays in sync across instances (header dot +
// More-tab dot) via the SEEN_EVENT. First run writes the current version (no cold-start dot).
import { useEffect, useState, useCallback } from 'react'
import { readSeen, writeSeen, isUnseen, SEEN_EVENT } from '../lib/whatsNew.js'

export function useWhatsNew() {
  const [latest, setLatest] = useState(null)
  const [unseen, setUnseen] = useState(false)

  useEffect(() => {
    let on = true
    fetch('/releases.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!on) return
        const v = Array.isArray(d) && d[0] && d[0].version ? d[0].version : null
        setLatest(v)
        const seen = readSeen()
        if (seen == null || seen === '') { writeSeen(v); setUnseen(false) }
        else setUnseen(isUnseen(v, seen))
      })
      .catch(() => {})
    const onSeen = () => setUnseen(false)
    if (typeof window !== 'undefined') window.addEventListener(SEEN_EVENT, onSeen)
    return () => { on = false; if (typeof window !== 'undefined') window.removeEventListener(SEEN_EVENT, onSeen) }
  }, [])

  const markSeen = useCallback(() => { if (latest) { writeSeen(latest); setUnseen(false) } }, [latest])
  return { unseen, latest, markSeen }
}
