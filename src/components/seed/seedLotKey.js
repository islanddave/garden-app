// src/components/seed/seedLotKey.js — BUG-NEWLOTNOIDEMPOTENCYKEY-001. The key a NEW seed lot's create
// carries (SaveSeedSheet.jsx, POST /api/inventory-items), so that a draft saved twice can be answered
// with one lot instead of making two.
//
// The add-to-a-lot form has a key already (AddToLot.jsx): minted when the form opens on its lot, sent
// with every try, gone when the form is. Its two rules are kept here and held another way, because
// this form differs from that one in two places:
//
//   ONE KEY NEVER CARRIES TWO BODIES. The add form locks its fields until an answer comes. This form
//   stays open and editable after a lost answer, so the key belongs to the DRAFT instead: everything
//   the save would send (the create's body, the measures, the process). The same draft sends the same
//   key; a draft that differs in anything is another draft, with a key of its own.
//
//   THE KEY OUTLIVES THE SHEET. The add form asks before it is closed on an unanswered request. This
//   one closes at once, and it can be opened again and the same words typed while the first request
//   is still out. So the keys are kept here, in memory, outside any sheet. Never in storage: a reload
//   starts with none.
//
// WHEN A KEY IS LET GO:
//   · an OPEN sheet saw the save finish. He was shown the lot; the same words typed afterwards are a
//     second lot he means to make.
//   · ten minutes after it last went out (REPLAY_FRESH_MS, the Put-Up sheets' "the row this Save just
//     made"), when nobody saw it finish: the answer was lost, or the sheet was closed and nothing came.
//   · a save that finished AFTER its sheet was closed keeps its key for a sheet that was already open
//     again by then (he may have typed the same draft before "Seed lot saved" was said) and for no
//     sheet opened later.
// A refusal lets go of nothing. Nothing landed under the key, and the same draft sent again is the
// same request.
//
// TWO SAVES, ONE LOT. When two saves of one draft are both answered with the same lot, the second
// answer is the first one's lot again and not a new one. The lot is finished ONCE, by the save that
// heard of it first (the count, the stage, the timeline entries, the toast); the other waits for that
// ending and writes nothing. Two answers naming two different lots are two lots, each finished by its
// own save.
import { mintKey, REPLAY_FRESH_MS } from '../kitchen/idempotencyKey.js'

// The text of what a draft sends -> { key, sentAt, lateAt, lots }.
const kept = new Map()
// Counts sheet openings and late endings, so "opened before it ended" has an order and never a tie
// (two of them inside one millisecond).
let turn = 0

// Called once by a sheet when it opens. What it returns is that sheet's place in the order.
export function sheetOpened() {
  return ++turn
}

// The key for a draft, and what its save has to tell it. `sends` is everything the save would send,
// as values JSON can carry; `openedAt` is the asking sheet's sheetOpened().
//   key              the uuid to send with the create.
//   otherSaveOf(id)  the create answered with this lot. null when this save is the first to hear of
//                    it, and so the one that finishes it; otherwise a promise of the first save's
//                    ending (what it passed to `ended`, or null when it stopped short).
//   ended(result, sheetOpen)  this save is over. Said once; a second call changes nothing.
export function keyForDraft(sends, openedAt, nowMs = Date.now()) {
  const print = JSON.stringify(sends)
  // Every key past its ten minutes goes, not only this draft's: a draft that is never saved again
  // would otherwise be kept until the page is.
  for (const [text, old] of kept) {
    if (nowMs - old.sentAt > REPLAY_FRESH_MS) kept.delete(text)
  }
  let held = kept.get(print)
  if (held && held.lateAt != null && !(openedAt < held.lateAt)) held = null
  if (!held) {
    held = { key: mintKey(), sentAt: nowMs, lateAt: null, lots: new Map() }
    kept.set(print, held)
  }
  held.sentAt = nowMs

  let mine = null
  let over = false
  return {
    key: held.key,
    otherSaveOf(lotId) {
      if (lotId == null) return null
      const first = held.lots.get(String(lotId))
      if (first) return first.ending
      let tell
      const ending = new Promise((resolve) => { tell = resolve })
      mine = { ending, tell }
      held.lots.set(String(lotId), mine)
      return null
    },
    ended(result, sheetOpen) {
      if (over) return
      over = true
      mine?.tell(result ?? null)
      if (sheetOpen) {
        if (kept.get(print) === held) kept.delete(print)
      } else if (mine && held.lateAt == null) {
        held.lateAt = ++turn
      }
    },
  }
}
