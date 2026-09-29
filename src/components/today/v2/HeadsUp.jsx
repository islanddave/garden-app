import React, { useCallback, useId } from 'react'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import Badge from '../../forms/Badge.jsx'
import Icon from '../../Icon.jsx'
import { splitCopy, plateText, deadlineSoon } from './useHeadsUp.js'

// HeadsUp — the body of the redesigned Today's Heads-up (V5-TODAYREDESIGN-001 S5; plan-v2 §1.5, §4 "Heads-up
// row", §7 #18 — Dave's D2/D5 moved V1's StorageDeadlineAlert here, second on the page, above Needs care).
//
// One row card per crop group. The row is a disclosure (<h3><button>): line 1 is the dataset's copy up to its first
// " — " (a VERBATIM prefix, never reworded: storageDeadlines.json owns the words and its provenance rule) with the
// date plate beside it — "by Oct 10", warn tone and the severity icon on the last two days (§5.9: 4.56:1 plus the
// icon, never colour alone); line 2 names the plantings. Opened, the panel carries the rest of the sentence, from
// the dash on, so line 1 and the panel together are the dataset's sentence character for character. The date is
// on the plate only, never repeated in copy. Operational, not a reward surface: no interrupt, no count badge, no
// notification permission (V1's posture, StorageDeadlineAlert.jsx).
export default function HeadsUp({ headsup, record, update }) {
  const open = record?.headsup?.open || []
  const toggle = useCallback((slug) => update((r) => {
    const cur = new Set(r.headsup?.open || [])
    if (cur.has(slug)) cur.delete(slug); else cur.add(slug)
    return { ...r, headsup: { ...(r.headsup || {}), open: [...cur] } }
  }), [update])
  return (
    <ul data-testid="storage-deadline-alert" style={list}>
      {headsup.groups.map((g) => <HeadsUpRow key={g.slug} g={g} open={open.includes(g.slug)} onToggle={() => toggle(g.slug)} />)}
    </ul>
  )
}

function HeadsUpRow({ g, open, onToggle }) {
  const panelId = useId()
  const [line1, rest] = splitCopy(g.copy)
  const soon = deadlineSoon(g)
  const head = (
    <>
      <span style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={titleStyle}>
          {line1}
          {rest && <span aria-hidden="true" style={{ fontSize: T.type.xs, fontWeight: 400, color: P.light }}>{open ? ' ▾' : ' ▸'}</span>}
        </span>
        <Badge tone={soon ? 'warn' : 'neutral'} data-testid="headsup-plate" data-soon={soon ? 'true' : 'false'} style={{ flexShrink: 0, gap: 4 }}>
          {soon && <Icon name="severity.med" size={14} decorative />}
          {plateText(g)}
        </Badge>
      </span>
      {g.names.length > 0 && <span style={namesStyle}>{g.names.join(' · ')}</span>}
    </>
  )
  return (
    <li data-testid="headsup-row" data-slug={g.slug} style={card}>
      <h3 style={{ margin: 0, display: 'flex' }}>
        {rest ? (
          <button type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle} style={hit}>{head}</button>
        ) : (
          <span style={{ ...hit, cursor: 'default' }}>{head}</span>
        )}
      </h3>
      {open && rest && <p id={panelId} data-testid="headsup-rest" style={panelStyle}>{'— ' + rest}</p>}
    </li>
  )
}

const list = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: T.space.xs }
const card = { listStyle: 'none', background: P.white, border: '1px solid ' + P.border, borderRadius: T.radiusCard, overflow: 'clip' }
const hit = {
  flex: 1, minWidth: 0, minHeight: 48, padding: `6px ${T.space.sm}px`, display: 'flex', flexDirection: 'column', justifyContent: 'center',
  gap: 2, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark, overflowWrap: 'anywhere',
}
const titleStyle = { flex: 1, minWidth: 0, fontSize: T.type.base, fontWeight: 600, color: P.dark }
const namesStyle = { fontSize: T.type.xs, color: P.mid }
const panelStyle = { margin: 0, padding: `0 ${T.space.sm}px ${T.space.sm}px`, fontSize: T.type.sm, fontWeight: 400, color: P.dark, lineHeight: 1.45 }
