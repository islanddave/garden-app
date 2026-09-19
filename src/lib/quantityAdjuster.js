// src/lib/quantityAdjuster.js — V5-SEEDSTAB-001. The inventory − / + stepper, with no store of its own.
//
// Extracted from useInventory.adjustQuantity, which closed over that hook's full-inventory list
// (itemsRef, putSeqRef, commitItems). The Seeds page moves the seed packet's stepper off the Inventory
// list and onto My seeds, whose rows live in a different store, so the logic could not simply be
// pointed at the new list — it had to stop owning one. The two guards that took two defects to learn
// travel with it unchanged, and they are the reason this is one function and not a copy:
//
//   BUG-INVUNDOQTY-001 — every read of "the row as it is now" goes through getRow(), which the host
//   answers from a ref assigned at write time. An undo closure that read the row captured by the
//   render that created it applied its delta twice (2 -> +1 -> 3 -> undo -> 1, persisted).
//
//   BUG-INVPUTREORDER-001 — `putSeq` records, per item, the sequence number of the most recently
//   ISSUED write. A response (or a failure) from a superseded write is dropped: two + taps issue
//   PUT(3) then PUT(4), and nothing in HTTP stops PUT(3)'s answer landing last and rewinding the row.
//   The host passes the Map in, from a ref, so the ordering survives a re-created adjuster.
//
// Still the WIDE PUT until the narrow /:id/quantity route lands (slice 3). `buildBody` is how a host
// decides what rides along with the new quantity: the Inventory list round-trips its row as it
// always has; My seeds strips the presence-guarded seed columns so a stale row cannot re-assert a
// stage or a source that another view changed a moment ago.

// The shipped body: the whole row, with the new value. Kept as the default so the Inventory page's
// write is byte-identical to what it was before the extraction.
export const wideBody = (row, col, value) => ({ ...row, [col]: value })

// The shipped success commit: the server's row replaces the list's. A host whose rows carry list-only
// projections (crop, variety name, stage age) merges instead, or the projection vanishes on write.
export const replaceWithServerRow = (_row, updated) => updated

/**
 * @param {object}   o
 * @param {Function} o.fetch       useApiFetch().fetch
 * @param {Function} o.getRow      id -> the row as it is NOW (from a ref, never a render closure)
 * @param {Function} o.commitRow   (id, row => nextRow) -> void; must assign the host's ref synchronously
 * @param {Function} o.showToast   ({ msg, onUndo? }) -> void
 * @param {Map}      [o.putSeq]    per-item write sequence; pass a ref's Map so it outlives this adjuster
 * @param {Function} [o.buildBody] (row, col, value) -> PUT body
 * @param {Function} [o.applyServerRow] (row, updated) -> row to commit after a successful PUT
 * @returns {(id: any, delta: number) => Promise<void>}
 */
export function createQuantityAdjuster({
  fetch,
  getRow,
  commitRow,
  showToast,
  putSeq = new Map(),
  buildBody = wideBody,
  applyServerRow = replaceWithServerRow,
}) {
  async function adjust(id, delta) {
    const current = getRow(id)
    if (!current) return
    // Type-aware column (P4, 2026-05-18): consumables count quantity_on_hand, durables quantity.
    const col = current.type === 'durable' ? 'quantity' : 'quantity_on_hand'
    const prevValue = Number(current[col] ?? 0)
    const newValue = Math.max(0, prevValue + Number(delta))
    if (newValue === prevValue) return

    // Claim this write's place in the order BEFORE issuing it.
    const seq = (putSeq.get(id) ?? 0) + 1
    putSeq.set(id, seq)
    const superseded = () => putSeq.get(id) !== seq

    // Optimistic. commitRow assigns the host's ref synchronously, so a second tap landing in this
    // same commit reads newValue and increments from it.
    commitRow(id, (row) => ({ ...row, [col]: newValue }))

    try {
      const updated = await fetch('/api/inventory-items/' + id, {
        method: 'PUT',
        body: JSON.stringify(buildBody(current, col, newValue)),
      })
      // A newer tap has been issued; its optimistic value is on screen and its own response is
      // authoritative. Dropping BOTH the commit and the toast: a toast naming this request's number
      // would be as wrong as the row, and its undo would reverse a delta the user can no longer see.
      if (superseded()) return
      commitRow(id, (row) => applyServerRow(row, updated))
      showToast({
        msg: `Quantity changed to ${newValue}`,
        // Re-enters adjust. Correct only because the `current` lookup above goes through getRow()
        // (the post-change row) — see BUG-INVUNDOQTY-001 in the header.
        onUndo: () => { adjust(id, prevValue - newValue) },
      })
    } catch {
      // Same guard, and the more damaging side: reverting to this request's prevValue after a later
      // tap moved the row would discard a change the user made and can still see.
      if (superseded()) return
      commitRow(id, (row) => ({ ...row, [col]: prevValue }))
      showToast({ msg: "Couldn't save — please try again" })
    }
  }
  return adjust
}
