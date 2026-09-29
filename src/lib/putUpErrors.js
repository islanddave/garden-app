// putUpErrors.js — Put-Up release 1a (design V4 §6.5 "409 handling", §5.4, §11). A refused write
// says WHY, by the server's `code`, instead of "Couldn't update — try again."
//
// WHY 1a CARRIES WORDS FOR CODES ITS OWN SERVER NEVER SENDS. client_stale arrives from the release
// 1b/2 legacy PUT, only_n_left from the release-2 uses route, batch_closed from 1b's Put it up. The
// bundle that meets them is by definition the OLD one — the phone that has not updated yet — and an
// old bundle can only explain a refusal it already knows how to read. So the reading ships first.
// Before this, RecordRow.put discarded the body and every retry got the same generic line (V4 §11).
//
// THE WIRE. api.js throws Error(body.error) carrying `.status` and `.body` (the parsed JSON), so the
// code is `err.body.code` — the house shape `{ error, code }` (lambda/locations `location_slug_conflict`,
// lambda/photos `photo_duplicate`). `err.code` is NOT read: Clerk's offline errors and the storage
// field's retry classifier both put their own values there.
//
// WHO OWNS THE WORDS. A code this module knows gets this module's sentence, because the sentence has
// to match what the surface offers (client_stale's is the only one with a button) and has to stay
// true on a bundle nobody can update. A code it does NOT know gets the server's own text — the
// server that invented the code is the only party that can explain it. A coded refusal with no text
// at all returns null, and so does every uncoded failure: the caller keeps its own copy for those
// (offline, a timeout, an uncoded 400), so nothing that renders today changes.

export const REFUSAL_CODES = Object.freeze({
  CLIENT_STALE: 'client_stale',
  ONLY_N_LEFT: 'only_n_left',
  BATCH_CLOSED: 'batch_closed',
  // The release-1a server lane's refusal for a package count lowered below what is already used
  // (V4 §5.4 "From 1a": the delta would take remaining_count below 0). Its name is the server lane's
  // to confirm; a different name still renders, through the unknown-code arm, as the server's text.
  COUNT_BELOW_USED: 'count_below_used',
  // The storage Lambda, from 1a: a place with that kind and name is already there (1b's UNIQUE on
  // storage_location). Its words are the SERVER's — the server lane writes a message meant to be shown
  // as-is — so it has no sentence here and describeRefusal renders it through the unknown-code arm.
  // On a create it is not a failure at all: see existingPlaceId.
  PLACE_EXISTS: 'place_exists',
})

export const REFRESH_NOW_LABEL = 'Refresh now'
export const CLIENT_STALE_TEXT =
  'The app on this phone is out of date — nothing was changed. Tap Refresh now, then make the change again.'
export const BATCH_CLOSED_TEXT = 'This batch has been closed — nothing was changed.'
export const COUNT_BELOW_USED_TEXT =
  'Some of these have already been used, so the count can’t go that low — nothing was changed.'
export const ONLY_SOME_LEFT_TEXT = 'Not that many are left — nothing was changed.'

export function onlyNLeftText(n) {
  return n === 0 ? 'None are left — nothing was changed.' : `Only ${n} left — nothing was changed.`
}

// only_n_left's number, from the server — never computed from the row on screen, which is exactly the
// copy that went stale when the other person used a jar. `n` is the name this client asks a server to
// send (the code reads "only N left"); the other three are read too, because once this bundle is the
// stale one it cannot be taught a new spelling, and the server that sends this code is not built yet.
const LEFT_COUNT_KEYS = ['n', 'left', 'remaining', 'remaining_count']

function leftCount(body) {
  for (const k of LEFT_COUNT_KEYS) {
    const raw = body[k]
    if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') continue
    const v = Number(raw)
    if (Number.isInteger(v) && v >= 0) return v
  }
  return null
}

// `message` first, then `error`: a body carrying both means the author put the human sentence in
// `message` on purpose, while `error` is the house field every route fills.
function serverText(body) {
  for (const k of ['message', 'error']) {
    const v = body[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

// place_exists names the place the person meant, so a create that meets it selects that place instead
// of reporting a failure. err -> the existing place's id (a string) | null. The key is read in every
// spelling a server might pick — the lane sending it is being built alongside this one, and once this
// bundle is the stale one it cannot learn a new spelling.
const PLACE_ID_KEYS = ['existing_id', 'id', 'place_id']

export function existingPlaceId(err) {
  const body = err && typeof err === 'object' ? err.body : null
  if (!body || typeof body !== 'object' || body.code !== REFUSAL_CODES.PLACE_EXISTS) return null
  const candidates = [...PLACE_ID_KEYS.map(k => body[k]), body.existing?.id, body.place?.id]
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

// err -> { code, text, refresh } | null. `refresh` is true only for client_stale: the one refusal the
// person can fix from here, and only by a tap (V4 §6.5 — never an automatic reload).
export function describeRefusal(err) {
  const body = err && typeof err === 'object' ? err.body : null
  if (!body || typeof body !== 'object') return null
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code) return null
  switch (code) {
    case REFUSAL_CODES.CLIENT_STALE:
      return { code, text: CLIENT_STALE_TEXT, refresh: true }
    case REFUSAL_CODES.ONLY_N_LEFT: {
      const n = leftCount(body)
      return { code, text: n != null ? onlyNLeftText(n) : (serverText(body) ?? ONLY_SOME_LEFT_TEXT), refresh: false }
    }
    case REFUSAL_CODES.BATCH_CLOSED:
      return { code, text: BATCH_CLOSED_TEXT, refresh: false }
    case REFUSAL_CODES.COUNT_BELOW_USED:
      return { code, text: COUNT_BELOW_USED_TEXT, refresh: false }
    default: {
      const said = serverText(body)
      return said ? { code, text: said, refresh: false } : null
    }
  }
}
