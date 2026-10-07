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
  // Release F (contract-F §2.7). Each carries the server's own sentence too; the ones below get this
  // module's words so a bundle that outlives a server wording change still reads right.
  ONLY_G_LEFT: 'only_g_left',
  JAR_USED_UP: 'jar_used_up',
  JAR_REMOVED: 'jar_removed',
  HAS_SALT_LINE: 'has_salt_line',
  ALREADY_IN: 'already_in',
  HAS_JARS: 'has_jars',
  PUT_UP_IN_USE: 'put_up_in_use',
  KEY_CONFLICT: 'key_conflict',
  SHU_CANNOT_COMPUTE: 'shu_cannot_compute',
  // B′ release 2 (the pantry-server lane's Pantry routes). Remove on a put-up that was used or drawn
  // into a batch; a use's Undo refused; a bought item removed under the person.
  JAR_WAS_USED: 'jar_was_used',
  JAR_IN_BATCH: 'jar_in_batch',
  ALREADY_UNDONE: 'already_undone',
  USE_IS_BATCH_LINE: 'use_is_batch_line',
  USE_IS_REVERSAL: 'use_is_reversal',
  COUNT_CHANGED: 'count_changed',
  ITEM_REMOVED: 'item_removed',
  // B′ release 3: Undo that put-up on How it was made →'s sitting, which wrote no jars of its own.
  NOTHING_PUT_UP_HERE: 'nothing_put_up_here',
  // Put-Up R2a, the storage Lambda's two place refusals: a re-kind while the place holds put-ups whose dates
  // were worked out for its kind, and a delete while something is stored there. Each 409 carries `n` and the
  // server's own sentence; neither has words here, so describeRefusal answers them through the unknown-code
  // arm (the server's sentence), and the Places sheet builds its own lines from the code and `n`.
  PLACE_HAS_DATED_JARS: 'place_has_dated_jars',
  PLACE_IN_USE: 'place_in_use',
})

export const REFRESH_NOW_LABEL = 'Refresh now'
export const CLIENT_STALE_TEXT =
  'The app on this phone is out of date — nothing was changed. Tap Refresh now, then make the change again.'
export const BATCH_CLOSED_TEXT = 'This batch has been closed — nothing was changed.'
export const COUNT_BELOW_USED_TEXT =
  'Some of these have already been used, so the count can’t go that low — nothing was changed.'
export const ONLY_SOME_LEFT_TEXT = 'Not that many are left — nothing was changed.'

// Release F's words (06 §1.4, §3.11, §3.12; contract-F §2.7). Plain, one line, no alarm.
export const JAR_USED_UP_TEXT = 'That one is marked used up — nothing was changed.'
export const JAR_REMOVED_TEXT = 'That jar was removed — nothing was changed.'
export const HAS_SALT_LINE_TEXT = 'Take the salt line out first.'
export const ALREADY_IN_TEXT = 'That pick is already in this batch.'
export const HAS_JARS_TEXT = 'This batch still has jars. Undo its put-ups first — nothing was changed.'
// has_jars does not say WHICH jars, and the two kinds have different doors (BUG-BATCHREMOVEDEADEND-001): a
// sitting's own jars go by "Undo that put-up"; a put-up picked on the close sheet was in the Pantry before
// the batch, has no put-up to undo, and goes by "Take it off this batch" in What came out. The surface that
// holds the batch counts each kind and asks here for the sentence. Told nothing, it gets the shipped one.
export const HAS_PICKED_TEXT =
  'This batch still has put-ups picked for it. Take them off under What came out first — nothing was changed.'
export const HAS_JARS_AND_PICKED_TEXT =
  'This batch still has jars. Undo its put-ups, and take the picked ones off under What came out, first — nothing was changed.'
export function hasJarsText({ sitting = 0, picked = 0 } = {}) {
  if (picked > 0) return sitting > 0 ? HAS_JARS_AND_PICKED_TEXT : HAS_PICKED_TEXT
  return HAS_JARS_TEXT
}
export const PUT_UP_IN_USE_TEXT = 'Some jars from this put-up were already used, so it can’t be undone — nothing was changed.'
export const NOTHING_PUT_UP_HERE_TEXT =
  'This batch was pieced together from jars you’d already logged — there’s nothing to undo here. Remove the batch instead.'
export const KEY_CONFLICT_TEXT = 'That didn’t go through — nothing was changed. Try again.'
export const SHU_CANNOT_COMPUTE_TEXT = 'Can’t work out the heat yet — nothing was saved.'
export const ONLY_SOME_G_LEFT_TEXT = 'Not that much is left in that one — nothing was changed.'

// B′ release 2's words (V4 §2.5: Remove is "logged by mistake"; refused on a jar with uses or live lines,
// with the reason and a path). Plain, one line.
export const JAR_WAS_USED_SOME_TEXT = 'Some were used — mark the rest Went bad, or undo that use.'
export function jarWasUsedText(n) {
  return `${n} was used — mark the rest Went bad, or undo that use.`
}
export const JAR_IN_BATCH_TEXT = 'Some of it went into a batch — take that line out first.'
export const ALREADY_UNDONE_TEXT = 'That was already undone — nothing was changed.'
export const USE_IS_BATCH_LINE_TEXT = 'That went into a batch — take the line out there to put it back.'
export const USE_IS_REVERSAL_TEXT = 'That was already an undo — nothing was changed.'
export const COUNT_CHANGED_TEXT = 'The count on that jar changed since — nothing was changed.'
export const ITEM_REMOVED_TEXT = 'That was removed from the Pantry — nothing was changed.'

// "Only about {g} g left in that one." — the number from the server, never from the row on screen.
export function onlyGLeftText(g) {
  return `Only about ${g} g left in that one — nothing was changed.`
}

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
    case REFUSAL_CODES.ONLY_G_LEFT: {
      const raw = body.g
      const g = raw == null || raw === '' || typeof raw === 'boolean' ? NaN : Number(raw)
      return { code, text: Number.isFinite(g) && g >= 0 ? onlyGLeftText(Math.round(g)) : (serverText(body) ?? ONLY_SOME_G_LEFT_TEXT), refresh: false }
    }
    case REFUSAL_CODES.JAR_USED_UP:
      return { code, text: JAR_USED_UP_TEXT, refresh: false }
    case REFUSAL_CODES.JAR_REMOVED:
      return { code, text: JAR_REMOVED_TEXT, refresh: false }
    case REFUSAL_CODES.HAS_SALT_LINE:
      return { code, text: HAS_SALT_LINE_TEXT, refresh: false }
    case REFUSAL_CODES.ALREADY_IN:
      return { code, text: ALREADY_IN_TEXT, refresh: false }
    case REFUSAL_CODES.HAS_JARS:
      return { code, text: HAS_JARS_TEXT, refresh: false }
    // put_up_in_use keeps the SERVER's words (the unknown-code arm): they count the jars ("1 jar from
    // this put-up was already used — …"), which a fixed sentence here would lose. PUT_UP_IN_USE_TEXT is
    // the fallback when the server sent none.
    case REFUSAL_CODES.PUT_UP_IN_USE:
      return { code, text: serverText(body) ?? PUT_UP_IN_USE_TEXT, refresh: false }
    case REFUSAL_CODES.NOTHING_PUT_UP_HERE:
      return { code, text: NOTHING_PUT_UP_HERE_TEXT, refresh: false }
    case REFUSAL_CODES.KEY_CONFLICT:
      return { code, text: KEY_CONFLICT_TEXT, refresh: false }
    case REFUSAL_CODES.SHU_CANNOT_COMPUTE:
      return { code, text: SHU_CANNOT_COMPUTE_TEXT, refresh: false }
    // B′ release 2. jar_was_used counts from the server's `n`; jar_in_batch keeps the server's words (they
    // name the batch), with this module's sentence when it sent none.
    case REFUSAL_CODES.JAR_WAS_USED: {
      const n = leftCount(body)
      return { code, text: n != null && n > 0 ? jarWasUsedText(n) : JAR_WAS_USED_SOME_TEXT, refresh: false }
    }
    case REFUSAL_CODES.JAR_IN_BATCH:
      return { code, text: serverText(body) ?? JAR_IN_BATCH_TEXT, refresh: false }
    case REFUSAL_CODES.ALREADY_UNDONE:
      return { code, text: ALREADY_UNDONE_TEXT, refresh: false }
    case REFUSAL_CODES.USE_IS_BATCH_LINE:
      return { code, text: USE_IS_BATCH_LINE_TEXT, refresh: false }
    case REFUSAL_CODES.USE_IS_REVERSAL:
      return { code, text: USE_IS_REVERSAL_TEXT, refresh: false }
    case REFUSAL_CODES.COUNT_CHANGED:
      return { code, text: COUNT_CHANGED_TEXT, refresh: false }
    case REFUSAL_CODES.ITEM_REMOVED:
      return { code, text: ITEM_REMOVED_TEXT, refresh: false }
    default: {
      const said = serverText(body)
      return said ? { code, text: said, refresh: false } : null
    }
  }
}
