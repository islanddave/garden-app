// useSources / useSourceKinds — V4-SOURCEREG-001 + V5-SOURCEKIND-001 controlled provenance
// vocabulary (GET/POST /api/varieties/sources and /api/varieties/source-kinds).
//
// Shaped on useCropTypes.js, which is the house pattern for a controlled vocabulary the app can
// both read and MINT. Same three properties, and each is load-bearing here for the same reason it
// is there:
//   - NON-FATAL. Any failure — a rejected fetch, or a test mock returning a non-Promise — resolves
//     to an empty list. A source is optional provenance on a plant; a picker that cannot load its
//     vocabulary must degrade to "no suggestions" and still let the form save, never block it.
//     Promise.resolve() wraps the call so a synchronous/undefined mock return can't throw.
//   - `enabled` DEFERS the fetch. Sources are the picker's own list, so it loads them on mount;
//     KINDS are needed only inside the mint panel, so SourcePicker latches that hook on first
//     mint-open. `loading` still resolves when disabled, or a consumer gating render on it hangs
//     forever on a page that was never going to fetch.
//   - LOCAL INSERT IN SORT ORDER after a mint, so the picker reflects the new row with no refetch.
//     The comparator mirrors the server's ORDER BY exactly (name ASC for sources; sort_order ASC
//     then display_name ASC for kinds) — a local order that disagreed with the server's would make
//     the row jump position on the next load.
//
// TWO FACTS, NOT ONE (schema contract, restated because callers get it wrong): `source_id` is the
// ORIGINATOR — who grew, bred, packed or gave it. `acquired_from_source_id` is the SHOP or venue
// where it changed hands, and is set ONLY when it differs. NULL is "not recorded / not distinct",
// never "same as source_id". Both columns are FKs to the same table, which is why ONE picker
// serves both and the axis lives in the call site's `label`.
//
// Contract:
//   useSources({ enabled }) -> { sources, loading, createSource(payload) }
//     sources: [{ id, name, kind, locality, address, website_url, notes }]
//     createSource({ name, kind?, locality?, address?, website_url?, notes? })
//       -> { source } | { error, existing, reason }
//   useSourceKinds({ enabled }) -> { sourceKinds, loading, createSourceKind(payload) }
//     sourceKinds: [{ slug, display_name, sort_order }]
//     createSourceKind({ display_name })  — `slug` is SERVER-DERIVED and must never be sent
//       -> { sourceKind } | { error, existing, reason }
//
// A steer is not a failure. The server answers 409 with `{ reason, existing }` when the requested
// name folds onto a row that already exists ('exists' — a live row; 'plural' — the singular/plural
// of an existing slug; 'label' — a display_name whose fold collides with a live kind). Adopting
// `existing` is the CORRECT outcome, so both creators surface it as data rather than swallowing it
// into an error string. A soft-deleted collision is RESTORED by the server instead and comes back
// as a 200, i.e. through the success branch carrying `restored: true` — the caller needs no branch
// for it, because a restored row is simply the row.

import { useState, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'

const SOURCES_PATH = '/api/varieties/sources'
const SOURCE_KINDS_PATH = '/api/varieties/source-kinds'

// Server: WHERE deleted_at IS NULL ORDER BY name ASC.
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))
// Server: ORDER BY sort_order ASC, display_name ASC. A minted kind gets max+10, so it lands at the
// TAIL — the head of this list is the twelve seeded common cases, which is what makes the Kind
// select scannable without a filter.
const byKindOrder = (a, b) =>
  ((a.sort_order ?? 0) - (b.sort_order ?? 0)) ||
  String(a.display_name ?? '').localeCompare(String(b.display_name ?? ''))

// The steer/failure projection both creators share. `existing` and `reason` ride on the error
// body; a transport failure simply has neither, so the caller's `existing &&` guard is the one
// branch that distinguishes "adopt this instead" from "that did not work".
function failure(err, fallbackMessage) {
  return {
    error: err?.message ?? fallbackMessage,
    existing: err?.body?.existing ?? null,
    reason: err?.body?.reason ?? null,
  }
}

// ONE request per path however many instances mount. Every provenance form carries TWO pickers
// (origin + acquired-from), so an edit form for a row that already has an origin issued two
// identical GETs of the same 54-row list. InventoryAdd.sourcePicker.test.jsx reported this and
// named useSources.js as the only place it could be fixed.
//
// Coalesced at the REQUEST rather than behind a store. useCachedFetch is the obvious candidate and
// is the wrong tool here on two counts: it caches ONLY when IMAGE_LIST_CACHE_ENABLED is on AND a
// Clerk sub exists, so it is a plain per-instance fetch in any provider-less unit test — the fix
// could not be proven by the suite that would have to guard it — and adopting it moves `sources`
// out of local state, taking the post-mint local insert (and its ORDER BY mirror) with it.
//
// A DEDUPE WINDOW, never a cache: the entry is dropped the moment the promise settles, so the next
// mount always re-fetches and no caller can be served a list that outlived its request. Both arms
// are pinned in useSources.test.js — the join, and the re-fetch that proves the window closes.
// Rejection propagates to every joiner, which is exactly what each instance's own .catch expects.
const inFlight = new Map()

function sharedGet(fetch, path) {
  const pending = inFlight.get(path)
  if (pending) return pending
  // Promise.resolve keeps the NON-FATAL contract for a mock that returns a non-Promise.
  const p = Promise.resolve(fetch(path)).finally(() => {
    if (inFlight.get(path) === p) inFlight.delete(path)
  })
  inFlight.set(path, p)
  return p
}

export function useSources({ enabled = true } = {}) {
  const { fetch } = useApiFetch()
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined }
    let alive = true
    setLoading(true)
    sharedGet(fetch, SOURCES_PATH)
      .then(data => { if (alive) setSources(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) setSources([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fetch, enabled])

  const createSource = useCallback(async (payload) => {
    try {
      const created = await fetch(SOURCES_PATH, { method: 'POST', body: JSON.stringify(payload) })
      // Filtered by id before the append: the restore path returns a row that may ALREADY be in
      // the list under a different name spelling, and a plain append would double it.
      setSources(prev => [...prev.filter(s => String(s.id) !== String(created.id)), created].sort(byName))
      return { source: created }
    } catch (err) {
      return failure(err, 'Failed to create source')
    }
  }, [fetch])

  return { sources, loading, createSource }
}

export function useSourceKinds({ enabled = true } = {}) {
  const { fetch } = useApiFetch()
  const [sourceKinds, setSourceKinds] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined }
    let alive = true
    setLoading(true)
    sharedGet(fetch, SOURCE_KINDS_PATH)
      .then(data => { if (alive) setSourceKinds(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) setSourceKinds([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fetch, enabled])

  // `slug` is a PRIMARY KEY and an FK target: it is derived server-side from display_name and is
  // never accepted from the caller. Passing one would be silently ignored at best; this hook does
  // not offer it as a parameter so no call site can come to depend on sending it.
  const createSourceKind = useCallback(async (payload) => {
    try {
      const created = await fetch(SOURCE_KINDS_PATH, { method: 'POST', body: JSON.stringify(payload) })
      setSourceKinds(prev =>
        [...prev.filter(k => k.slug !== created.slug), created].sort(byKindOrder))
      return { sourceKind: created }
    } catch (err) {
      return failure(err, 'Failed to create source kind')
    }
  }, [fetch])

  return { sourceKinds, loading, createSourceKind }
}
