// SeasonEndConfirm — the confirm for End of season (src/pages/SeasonEnd.jsx).
//
// ONE OUTCOME, and it is on the button face: "End 7 plantings" sets status `ended`. There is no
// "didn't make it", no reason to pick, and no archive tick — see src/lib/seasonEnd.js for why each of
// those was left out. The body says where the ticks are ("Bag Area: 5 · Trough: 2") and names every
// ticked row from the Still growing through frost group, because those are the ticks most likely to
// be a slip.
//
// DISMISSAL GOES THROUGH <Sheet>, WHICH GOES THROUGH DismissRegistry — never hand-rolled. `armsBack`:
// this closes in place, so Android Back dismisses it WITHOUT ending anything. `busy` while the PUTs
// are in flight: the registry swallows Escape/Back and the backdrop tap no-ops, so the sheet is held
// open over the writes and shows the progress line instead of closing optimistically.
//
// BUTTON ORDER copies BatchUndoConfirm: stacked full width, the action first and Cancel bottom-most.
// testids rather than names, because Sheet's own close control is also labelled "Cancel".
//
// PRESENTATIONAL ONLY: no fetch, no toast. The page owns the writes.
import React from 'react'
import { P } from '../lib/constants.js'
import { T } from './forms/formStyles.js'
import Sheet from './forms/Sheet.jsx'
import Button from './forms/Button.jsx'
import { confirmSummary, progressLine } from '../lib/seasonEnd.js'

const body = { display: 'flex', flexDirection: 'column', gap: T.space.md, padding: `0 ${T.space.md}px ${T.space.sm}px` }
const line = { margin: 0, color: P.mid, fontSize: T.type.md, lineHeight: 1.45 }
const note = { margin: 0, color: P.dark, fontSize: T.type.sm2, lineHeight: 1.45 }
const buttons = { display: 'flex', flexDirection: 'column', gap: T.space.sm }

export default function SeasonEndConfirm({ open, items = [], progress = null, onConfirm, onCancel }) {
  const s = confirmSummary(items)
  const busy = !!progress
  const progressText = busy ? progressLine('Ending', progress.done, progress.total) : null
  return (
    <Sheet open={!!open && items.length > 0} onClose={onCancel} title={s.title} closeLabel="Cancel" busy={busy} armsBack>
      <div data-testid="season-end-confirm-body" style={body}>
        <p data-testid="season-end-counts" style={line}>{s.counts}</p>
        {s.stillGrowingNames.length > 0 && (
          <p data-testid="season-end-still-growing" style={note}>
            Includes {s.stillGrowingNames.length} still growing through frost: {s.stillGrowingNames.join(', ')}.
          </p>
        )}
        <p style={line}>Each is marked Ended. Its photos, harvests and history stay.</p>
        {busy && (
          <p role="status" data-testid="season-end-progress" style={note}>{progressText}</p>
        )}
        <div style={buttons}>
          <Button data-testid="season-end-confirm" onClick={() => onConfirm?.()} loading={busy} loadingLabel={progressText} style={{ width: '100%' }}>
            {s.button}
          </Button>
          <Button data-testid="season-end-cancel" variant="secondary" onClick={onCancel} disabled={busy} style={{ width: '100%' }}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
