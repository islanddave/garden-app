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
// them may be the one that landed, so the body in hand is put on the row.
// A sheet keeps `sent` next to its key, notes the print BEFORE the request goes, and drops both together.
// A key this client has no `sent` for (a draft stored by a bundle from before this rule) is read as one body.

// The print of a body: the same for the same content whatever order its keys were written in, and without
// the body's OWN key (a line's key is content, and stays). 64 bits of cyrb53 and the length; never sent.
export function payloadPrint(body) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o }, {})
    : v)
  const own = { ...(body ?? {}) }
  delete own.idempotency_key
  const s = JSON.stringify(canon(own))
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
//   null      it is saved as sent (not a replay, or no other body ever went out under this key);
//   'update'  a replay, and another body went out before: put this one on the row the answer names;
//   'fixed'   … and they differ in a part the update route cannot carry: write nothing, and say so.
export function afterReplay(answer, sent, print) {
  if (answer?.replayed !== true) return null
  const others = noteSent(sent, print).filter(s => s !== print)
  if (!others.length) return null
  const fixedHalf = (s) => s.slice(s.indexOf('/') + 1)
  return others.some(s => fixedHalf(s) !== fixedHalf(print)) ? 'fixed' : 'update'
}
