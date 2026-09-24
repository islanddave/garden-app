// src/components/seed/SowSheet.jsx — V5-SEEDSTAB-001 slice 2a. THE Sow sheet: one packet, sown today,
// into a real place. Extracted from SowNow.jsx, where it was inline JSX closing over page state, so the
// seed's detail page opens the SAME sheet ("Sow this") instead of sending the packet through Garden's add
// form with other defaults and an emoji (design-seedshome-V102 §6).
//
// WHAT THE SHEET OWNS, so no host can carry half of it:
//   · The canonical PlantingEditor in add mode, pre-seeded status seed / sown today / the packet's source
//     type — so a sown planting always gets a real place and full details (BUG-ORPHANNAV-001, the old
//     mini-form's project_id:null).
//   · ITS OWN projects fetch, and the editor waits for it. PlantingEditor reads projects[0] ONCE, at
//     mount, as the default place, and with PROJECTS_HIDDEN on there is no picker to correct it from: an
//     editor mounted before the list landed would POST project_id ''. On Sow now the list had always
//     landed long before a tap; on a packet's page the sheet mounts with the page, so a quick tap could
//     beat it. The fetch still starts at mount, exactly when Sow now's did.
//   · The editor's dirty and busy signals, wired to the Sheet's backdrop guard, ConfirmSheet and the
//     BLOCKED branch (V4-PLANTEDITORWIRE-001, BUG-DIRTYDISMISSGAP-001).
//   · The service-worker reload hold while it is open (V4-RELOADGATEWIRE-001).
//   · The draft stash's WRITE (while open) and CLEAR (on every deliberate close), under the key the HOST
//     names. The restore is the host's, because only the host can check a stashed id against its live rows.
//
// WHAT THE HOST OWNS: which packet is open (`packet`, null = closed), that restore, what "sown" means on
// its page (`onSown(packet, planting)`), and the overlay-dirty report. That channel holds one value per
// page (OverlayContext: the last writer wins), so a second reporter in here would fight the host's own.
//
// PER-HOST DRAFT KEY. One shared key would let a sow interrupted on a packet's page reopen itself the
// next time Sow now loads — on a page the user never left mid-sow — and the other way round.
import React, { useState, useEffect, useCallback, useId } from 'react'
import { useApiFetch } from '../../lib/api.js'
import { useToast } from '../../context/ToastContext.jsx'
import { writeDraft, clearDraft } from '../../lib/draftStash.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import { todayLocalISO } from '../../lib/dateLocal.js'
import { Sheet } from '../forms'
import Spinner from '../forms/Spinner.jsx'
import PlantingEditor from '../PlantingEditor.jsx'
import { isSavedLot } from './seedLots.js'

// The one shape a Sow sheet opens on, from either host's rows: a v_sow_candidates row (Sow now) or an
// inventory row (the packet's page). `saved` is isSavedLot — the predicate every Seeds surface uses for
// "saved, not bought" — and it decides the planting's source below. The detail page passes its LIVE
// provenance (a parent picked on that page a moment ago), which is why it is a field and not a lookup.
export function sowPacketFromCandidate(c) {
  return { id: c.inventory_item_id, varietyId: c.variety_id ?? null, title: c.variety_name || c.item_name, saved: isSavedLot(c) }
}

export function sowPacketFromItem(item) {
  return { id: item.id, varietyId: item.variety_id ?? null, title: item.variety_name || item.name, saved: isSavedLot(item) }
}

// V5-SEEDSTAB-001 §8 / seat-seed-systems-geneticist — a planting grown from seed Dave saved himself is
// recorded as 'saved_seed', not as a bought 'seed_packet'. Both values are PLANT_SOURCE_OPTIONS'
// (dropdownRegistry.js) and plants.source_type is free text server-side, so this is a client choice with
// no Lambda contact. It is the planting's one human-readable provenance field, and the one a later
// "grown from my own seed" filter would read; the lot link (source_inventory_item_id) rides as before.
export function sowSourceType(packet) {
  return packet?.saved ? 'saved_seed' : 'seed_packet'
}

export default function SowSheet({ packet, draftKey, todayISO = todayLocalISO(), onSown, onClose }) {
  const { fetch } = useApiFetch()
  const { show } = useToast()
  const packetId = packet?.id ?? null
  const open = packetId != null

  // null until the first answer; a failed load is an empty list, which leaves the editor to say why the
  // create failed rather than holding the sheet on a spinner.
  const [projects, setProjects] = useState(null)
  // V4-PLANTEDITORWIRE-001: mirror of the embedded editor's own clean/dirty state, reported through its
  // `onDirty` prop. This is the ONLY thing the sheet can know about content typed INSIDE it — `packet`
  // says which packet is being sown, never whether anything has been entered.
  const [editorDirty, setEditorDirty] = useState(false)
  // BUG-DIRTYDISMISSGAP-001 — the editor's in-flight-write signal. Without it decideBack's BLOCKED branch
  // could never fire here, so the sheet was dismissable mid-POST as well as mid-typing: closing unmounts
  // the editor, so a create that FAILED had nothing left to render its error into and looked exactly like
  // one that succeeded.
  const [editorBusy, setEditorBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/projects')
      .then((data) => { if (alive) setProjects(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) setProjects([]) })
    return () => { alive = false }
  }, [fetch])

  // Persist while the sheet holds a packet — for ABNORMAL exits only (see `close`: a deliberate
  // dismissal clears it, unlike EventNew/LogMany).
  //
  // WHAT THIS RECOVERS, PRECISELY: the inventory_item_id, i.e. WHICH packet was mid-sow, and nothing
  // else. It does NOT preserve anything typed or picked inside the sheet — place, location, quantity,
  // notes, dates — because PlantingEditor owns that state internally. So a mid-sheet SW reload that beats
  // the hold re-opens the right packet on an EMPTY form. `onDirty` reports a BOOLEAN, not the values: it
  // lets the sheet DEFEND the fields (the backdrop guard below) but gives it nothing to write down, and a
  // stash that claimed to restore a form it cannot read would be worse than one that honestly restores
  // only the packet. Keyed on the id, not the object, so a host re-render never rewrites it.
  useEffect(() => {
    if (packetId == null) return
    writeDraft(draftKey, { inventoryItemId: packetId })
  }, [draftKey, packetId])

  // V4-RELOADGATEWIRE-001 — hold the service-worker reload while the sheet is open. Both hosts are plain
  // full-page routes, so this is the guard that actually runs; the overlay-dirty report the hosts keep is
  // forward-compat. The hold is on OPEN, not on the editor's dirty signal: the stash restores a sheet on
  // a packet the user chose, and that choice is worth deferring a deploy for whether or not a field is
  // filled. Cleanup releases the key, so a closed or unmounted sheet can never wedge updates
  // (BUG-STALECLIENT-001). Per-instance key: reloadGate holds a Set, and a shared literal would let one
  // instance's unmount release another's hold.
  const reloadGateKey = `sow-sheet:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, open)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, open])

  // The single close path: the Sheet's Close control, Escape, an un-dirty backdrop tap, the back gesture,
  // the editor's own Cancel and a successful create all land here.
  //
  // CLEARS THE STASH, which is the opposite of what EventNew and LogMany do on a dismiss — and the
  // difference is what is being restored. Their drafts refill FIELDS in a form the user is already
  // looking at; this one restores a MODAL'S OPEN STATE. Kept through a deliberate Close, the sheet would
  // re-open itself on every later visit in the tab, with no way to stop it short of actually sowing the
  // packet. An exit the guards could NOT defer (SW reload, hard refresh, navigating away mid-sheet) never
  // runs this, so the recovery case still works: the stash survives precisely the exits the user did
  // not choose.
  const close = useCallback(() => {
    clearDraft(draftKey)
    // Cleared here as well as by PlantingEditor's unmount release, which lands a commit later: a stale
    // `true` would leave the NEXT sheet undismissable from its first frame — the stuck-busy trap the
    // bounded Back guard exists to survive, reached with no write in flight at all.
    setEditorBusy(false)
    onClose?.()
  }, [draftKey, onClose])

  // Operational confirmation, not a celebration (Reward UX: a sow is a task the user started). The host
  // hears first, so its own "sown" state is in place before the sheet goes.
  const created = useCallback((planting) => {
    onSown?.(packet, planting)
    show({ message: 'Planted!' })
    close()
  }, [onSown, packet, show, close])

  return (
    <Sheet
      armsBack
      open={open}
      onClose={close}
      // V4-PLANTEDITORWIRE-001 — a backdrop tap is the one exit that is neither deliberate nor
      // deferrable: Sheet no-ops it while dirty (Sheet.jsx §5.2) and leaves Escape and the labelled
      // Close live — a stray tap beside a half-filled sow form must not discard it, but a user who means
      // to leave still has two ways out. Gated on the EDITOR's signal, not on "open": that would make the
      // backdrop inert for every sow, including the common one where the sheet was opened by mistake.
      dirty={editorDirty}
      // BUG-DIRTYDISMISSGAP-001 — Escape, Android Back and the labelled Close raise the registry's
      // ConfirmSheet on a dirty sheet. `close` clears the stash as its FIRST act, so an unconfirmed
      // dismiss used to destroy both the typed fields and the crumb that said which packet was mid-sow.
      confirmOnDirty
      confirmTitle="Discard this sowing?"
      confirmBody="This packet has not been sown yet. What you typed will be lost, and the sheet will not reopen on this packet."
      busy={editorBusy}
      title={open ? `Sow ${packet.title}` : undefined}
    >
      {open && (projects ? (
        <div style={{ padding: '0 16px 4px' }}>
          <PlantingEditor
            key={packetId}
            mode="add"
            fetch={fetch}
            projects={projects.filter((p) => !p.archived_at)}
            sourceInventoryItemId={packetId}
            varietyId={packet.varietyId}
            addDefaults={{ status: 'seed', sown_at: todayISO, source_type: sowSourceType(packet) }}
            onCreated={created}
            onClose={close}
            // The setter itself, not an inline arrow — PlantingEditor keeps `onDirty` behind a ref so an
            // unstable prop cannot fire a spurious release, and a stable identity means the sheet never
            // has to rely on that. Same contract for `onBusy`, which feeds <Sheet busy> above.
            onDirty={setEditorDirty}
            onBusy={setEditorBusy}
          />
        </div>
      ) : (
        <Spinner block label="Loading places…" style={{ padding: 24 }} />
      ))}
    </Sheet>
  )
}
