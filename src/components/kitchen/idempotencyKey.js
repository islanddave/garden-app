// src/components/kitchen/idempotencyKey.js
// Put-Up release 1b (V4 §5.2, §6.5) — the one client key minter for every keyed Put-Up write (the Start
// sheet's create, a Put it up sitting, each line it adds). A v4 uuid: the server refuses a malformed
// key with a 400, so a timestamp fallback would be worse than none. getRandomValues exists wherever
// randomUUID does not (older Android WebViews).
export function mintKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ── A REPLAYED CREATE (BUG-PUTUPREPLAYDROPSEDIT-001) ────────────────────────────────────────────────
// The server keeps a create's key and nothing of its body: a second POST under a held key is answered 200
// `replayed: true` with the row the FIRST one made. The key does not change with the body — a second row is
// worse than a lost change (plan R2 V2 "Retry key", RIA I-3 / QA-I2; PutUpR2Df.door.test.jsx pins it) — so a
// body changed after a lost answer came back as a success that did not hold the change. The sheet that sent
// it now READS `replayed`, and puts what it holds on that row through the entity's own update route.
//
// WHAT TELLS A REPLAY THAT NEEDS IT is what has GONE OUT under the key, never the row: `sent` is the print of
// every different body sent under it (a list of short strings, so a stored draft can carry it). One body
// only → the row is that body, or that body and whatever was done to it since, and nothing is written (an
// untouched retry from a day-old draft must not undo an edit made on the row itself). More than one → any of
// them may be the one that landed, so the body in hand is put on the row — IF THE ROW IS THIS SITTING'S (below).
// A sheet keeps `sent` next to its key, notes the print BEFORE the request goes, and drops both together.
// A key this client has no `sent` for (a draft stored by a bundle from before this rule) is read as one body.
//
// A PRINT IS TAKEN OF WHAT WAS CHOSEN, not of what the clock or a read turned it into: a sheet prints the
// chip ("Today"), not the date it resolved to, and leaves out a value a search or a list read filled in. An
// untouched retry is then one body whatever the hour (whenChoice below; each sheet says what it leaves out).
//
// THE ROW MUST BE THIS SITTING'S. The update routes send every field and take no "unchanged since" guard, so
// the body in hand is written onto the replayed row only when all three hold:
//   · `mine` — every body under the key went out from the sheet that is open now. A draft restored from
//     storage with `sent` already in it is somebody's EARLIER sitting: what is typed over it may be another
//     thing altogether, and it is never written onto the row.
//   · the row was made within REPLAY_FRESH_MS (its created_at, read against this device's clock);
//   · nothing has touched it since: updated_at is created_at (each create is one statement, so the two are
//     one now(); every later write to the row goes through its set_updated_at trigger) — EXCEPT this sheet's
//     own update (`updatedHere`): a moved updated_at on a row that still holds what this sheet last sent it
//     is its own, landed with its answer lost, and Save again must still be able to finish it (below).
//     THE JAR TABLE IS THE ONE EXCEPTION TO "the two are one now()" (QA B-1). preservation_log.updated_at is
//     nullable with no default and the create's INSERT does not name it, so a jar nobody has written to since
//     its create carries updated_at NULL; its BEFORE UPDATE trigger stamps the first write after. The jar's two
//     doors say so (`nullIsUntouched`), and for them a NULL updated_at beside a real created_at reads as
//     untouched. pantry_item, recipe and kitchen_batch declare both stamps NOT NULL DEFAULT now() and their
//     INSERTs name neither: for them a NULL is not a row this rule knows, and stays "not this sitting's".
// Anything else answers 'stale': nothing is written, and the sheet says so. WHAT IT MAY SAY: `sent` tells
// that other bodies went out, never which one landed. So a stale sentence says what is certain (saved
// earlier; this Save changed nothing) and never "your change is not on it". A row that carries neither stamp
// is not this sitting's.
//
// A REFUSAL NEVER LETS GO OF THE KEY. After 'stale' or 'fixed' the sheet keeps its key and `sent`: Save again
// replays and is refused again — it can never be a second row. Only the draft's own end retires a key.
//
// 'stale' IS THE STORED DRAFT'S END (pre-promote I-1). It is only ever said to a replay, so the first Save
// landed and the draft has done its job: a sheet that keeps its key in a stored draft (Put something up, the
// recipe sheet, the Start sheet, Put it up) takes that draft out of storage at the refusal and does not write
// it back. (The Start sheet and Put it up say ONE refusal for 'stale' and 'fixed' alike: neither has a way
// through in the sheet that is open, so either ends its stored draft.) The sheet that is
// open is as above; the one opened next — after a close, or a reload with no close — is clean, has no key, and
// mints one for what is typed there as for any new thing. A draft whose answer was lost and has not been
// refused is not touched: it restores with its key, which is what stops a second row. The sheets that hold
// the key in memory only (the Walk, Save as recipe, How it was made) end it when they are left, as before.
//
// THE SHEET'S OWN UPDATE IS KNOWN BY WHAT IT SENT, NOT BY HAVING SENT (QA I-2). "This sheet sent an update to
// this row" does not make a moved updated_at its own: an update whose answer was lost may never have reached
// the server, and the stamp was then moved by somebody else — whose change the next Save would write over. So a
// sheet keeps the BODY of each update it sent that may have landed (`updateSent`), and `updatedHere` is true
// only while the replayed row is that row AND still holds every field one of those updates sent, read field by
// field (`holdsOwnUpdate`; each sheet says how a sent field is read off its row). A row that holds anything
// else in one of those fields was written by someone else since — or never got this sheet's update — and is
// 'stale': nothing is written. Every sheet that puts a body onto a replayed row uses this one reading.
//
// EVERY ONE THAT MAY HAVE LANDED, NOT ONLY THE LAST (re-review I-B). Whichever of them arrived last is what the
// row holds: the last one sent may never have reached the server while the one before it did, and the row —
// holding that earlier body, its stamp moved — is as much this sheet's own as one holding the last. So the
// kept updates are a list, and the row is this sheet's while it holds ANY ONE of them IN FULL (never a field
// of one and a field of another: that is somebody's write in between). A sheet's updates all send the same
// fields (the item's adds a typed name's crop only when that is not the item's already), so whichever is held
// vouches for the fields the next one writes. The list is short
// (UPDATES_KEPT, the oldest dropped first): a row that holds only a body no longer kept reads as not this
// sheet's, which is a refusal and never a write. It lives in memory with the open sheet and is NOT in the
// stored draft: a draft that comes back out of storage with `sent` in it is not `mine`, and nothing is ever
// written onto its row, so there is nothing for a stored list to vouch for.
//
// AN ANSWERED 4xx DID NOT LAND (BUG-PUTUPREPLAYREST-001). `sent` is what MAY have landed, so a sheet that
// reads its fixed part off the prints (the Start sheet, Put it up) takes back the print of a body the server
// answered with a 4xx — to what `sent` was before that body went — and so does the Walk, whose one key serves
// two routes (re-review I-A). And the updates a sheet keeps are taken back to what they were before the one
// the server answered with a 4xx (`answeredNo`): the row may still hold an earlier one, and that is still
// this sheet's.
//
// THE ROW ALREADY HOLDS IT (`holds`). Before any of that, the sheet reads the row the replay answered with:
// when it holds exactly what is on screen (the fields he chose — each sheet says what it compares) there is
// nothing to put on it and nothing to refuse. That is a save: no write, and the sheet completes as one.

// How long after it was made a row is still "the one this Save just made". One Save gives up after
// API_TIMEOUT_MS (15 s; ~30 s with a token refresh in front), so a lost answer, a correction and a second
// Save is a minute or two — and several when the phone has to be walked back into signal. Ten minutes covers
// that with room, and is far short of "came back to it after lunch". The clock is this device's against the
// server's stamp: a phone running fast only makes rows look older (more refusals, never a wrong write); one
// running slow stretches the window by as much as it is slow — `mine` and the untouched check do not read it.
export const REPLAY_FRESH_MS = 10 * 60 * 1000
// A row stamped later than this device's clock by more than this was not judged by a clock worth trusting.
export const REPLAY_CLOCK_SLACK_MS = 60 * 1000

const stampMs = (v) => (v == null || v === '' ? NaN : new Date(v).getTime())
export function rowIsThisSittings(row, nowMs = Date.now(), updatedHere = false, { nullIsUntouched = false } = {}) {
  const made = stampMs(row?.created_at)
  // The jar table only: the row SAYS updated_at is NULL (the key is there, and null) — never written since its create.
  const never = nullIsUntouched === true && Number.isFinite(made) && row.updated_at === null
  const touched = never ? made : stampMs(row?.updated_at)
  if (!Number.isFinite(made) || !Number.isFinite(touched)) return false
  if (touched !== made && updatedHere !== true) return false
  const age = nowMs - made
  return age >= -REPLAY_CLOCK_SLACK_MS && age <= REPLAY_FRESH_MS
}
// A failure with no status is an answer that never came: the write may have landed all the same.
export function answerLost(err) {
  return !(typeof err?.status === 'number' && err.status >= 400)
}
// A write the server ANSWERED with a 4xx: it did not land.
export function answeredNo(err) {
  return typeof err?.status === 'number' && err.status >= 400 && err.status < 500
}

// ── The sheet's own updates (QA I-2, re-review I-B) ─────────────────────────────────────────────────
// How many of its own updates a sheet keeps. Each one is a Save whose create was answered and whose update was
// not, with a change before it — eight of those in one sitting is past any connection worth retrying on.
export const UPDATES_KEPT = 8
// The kept list as a list: a single { id, body } (what a sheet kept before the list) reads as a list of one.
const ownUpdates = (kept) => (Array.isArray(kept) ? kept : kept ? [kept] : []).filter(u => u && u.id != null && u.body && typeof u.body === 'object')
// What a sheet keeps of the updates it sent to a row: `before` (what it kept until now) with this one — the
// row's id and the body exactly as it went — at its end. A new list every time, so the one before is still
// there to go back to when the server answers this one with a 4xx. The same body sent again is one entry.
export function updateSent(id, body, before = null) {
  const list = ownUpdates(before)
  if (id == null) return list.length ? list : null
  const next = { id: String(id), body: body ?? {} }
  const text = canonText(next.body)
  return [...list.filter(u => !(String(u.id) === next.id && canonText(u.body) === text)), next].slice(-UPDATES_KEPT)
}
// Whether a row holds every field of `body`, field by field. `reads` names the fields that are not "the same
// key holding the same value" on the row: field → (sent value, row, body) => boolean. Any other field is one
// fact under one name (sameFact). A body with no field at all is held by nothing.
export function rowHoldsFields(row, body, reads = null) {
  if (!row || !body || typeof body !== 'object') return false
  const fields = Object.keys(body)
  return fields.length > 0 && fields.every(k => (typeof reads?.[k] === 'function' ? reads[k](body[k], row, body) === true : sameFact(body[k], row[k])))
}
// Whether `row` is the row one of this sheet's kept updates (`kept`, from updateSent) went to AND still holds
// every field that one sent — the only thing that makes a moved updated_at this sheet's own. `reads` as above;
// a sheet whose update is the whole of what it shows passes ONE function (body, row) => boolean instead. A
// removed row holds nothing.
export function holdsOwnUpdate(row, kept, reads = null) {
  if (!row || row.id == null || row.deleted_at) return false
  return ownUpdates(kept).some(u => String(u.id) === String(row.id)
    && (typeof reads === 'function' ? reads(u.body, row) === true : rowHoldsFields(row, u.body, reads)))
}

// A date question's ANSWER as it goes into a print: the chip, and under "Earlier…" the window or the day
// picked — never the date it came to, which moves with the clock (Today at 11:58 pm and at 12:02 am).
export function whenChoice(chip, earlier = null, pickedDate = '') {
  if (chip !== 'earlier') return [chip ?? null]
  return earlier === 'pickdate' ? ['pickdate', pickedDate ?? ''] : ['earlier', earlier ?? null]
}

// A body as one text, the same for the same content whatever order its keys were written in.
function canonText(body) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o }, {})
    : v)
  return JSON.stringify(canon(body))
}

// The print of a body: the same for the same content whatever order its keys were written in, and without
// the body's OWN key (a line's key is content, and stays). 64 bits of cyrb53 and the length; never sent.
export function payloadPrint(body) {
  const own = { ...(body ?? {}) }
  delete own.idempotency_key
  const s = canonText(own)
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${s.length.toString(36)}.${(h2 >>> 0).toString(36)}.${(h1 >>> 0).toString(36)}`
}

// One send's print, in two halves: what the update route can carry / what it cannot. `fixed` names the body
// keys the update route has no way to change (an absent one prints as null).
export function sendPrint(body, fixed = []) {
  const rest = { ...(body ?? {}) }
  const held = {}
  for (const k of fixed) { held[k] = rest[k] ?? null; delete rest[k] }
  return `${payloadPrint(rest)}/${payloadPrint(held)}`
}

// `sent` with this print in it. A stored list that is not a list of strings is read as nothing sent.
export function noteSent(sent, print) {
  const list = Array.isArray(sent) ? sent.filter(s => typeof s === 'string') : []
  return list.includes(print) ? list : [...list, print]
}

// What a create's answer asks of the sheet that sent it:
//   null      it is saved as sent (not a replay, or no other body ever went out under this key, or the row
//             already holds what is on screen — `holds`, the caller's own reading of the row);
//   'stale'   a replay, another body went out before, and the row is not this sitting's: write nothing,
//             and say it was saved earlier and this Save changed nothing;
//   'update'  … and the row is this sitting's: put this body on the row the answer names;
//   'fixed'   … but they differ in a part the update route cannot carry: write nothing, and say so.
// `row` is the row the answer holds; `mine` is false for a key whose `sent` came out of storage;
// `updatedHere` is holdsOwnUpdate's answer: the row still holds an update this sheet sent it. `fixed` (optional) is the
// caller's own reading of "a part the update route cannot carry" — off the row, where the row can say it
// exactly — in place of the prints' fixed halves. `nullIsUntouched` is the jar table's (rowIsThisSittings).
export function afterReplay(answer, sent, print, { row = null, mine = true, updatedHere = false, fixed = null, holds = false, nullIsUntouched = false, nowMs = Date.now() } = {}) {
  if (answer?.replayed !== true) return null
  const others = noteSent(sent, print).filter(s => s !== print)
  if (!others.length) return null
  const fixedHalf = (s) => s.slice(s.indexOf('/') + 1)
  const held = fixed == null ? others.some(s => fixedHalf(s) !== fixedHalf(print)) : fixed === true
  if (holds === true && !held) return null
  if (mine !== true || !rowIsThisSittings(row, nowMs, updatedHere, { nullIsUntouched })) return 'stale'
  return held ? 'fixed' : 'update'
}

// Two values as one fact: null, undefined and '' are all "nothing", text is compared trimmed, and with
// `numeric` a number and its text ("2" and 2.000) are one amount. For a sheet's reading of `holds`.
export function sameFact(a, b, { numeric = false, fold = false } = {}) {
  const norm = (v) => {
    if (v == null) return null
    let s = String(v).trim()
    if (s === '') return null
    if (numeric && Number.isFinite(Number(s))) s = String(Number(s))
    return fold ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}
