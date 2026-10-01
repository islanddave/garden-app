// src/components/putup/HowItWasMadeSheet.jsx
// B′ release 3 — "How it was made →" (V4 §2.2): from a jar row, the Start-a-batch sheet in retrospective
// posture. The pure rules live in howItWasMade.js; the write is POST /api/kitchen-batches/from-jars.
//
// WHAT IT ASKS (required at open: the name, prefilled with the jar's):
//   · Name it — the jar's name, editable (the Start sheet's own words for the same field).
//   · When did it start? — in words: the jar's date, or with several jars chosen the EARLIEST of theirs
//     ("Sep 1 · the earliest of these jars"); "Change" opens the shared start chips.
//   · What kind of batch? — collapsed, optional (the shared KindChips).
//   · Like a past batch, except… — optional; copies that batch's lines and kind in (likeBatch.js).
//   · What went in — OPEN: the shared LineAdder (plantings, picks, put-ups, pantry items, crops, typed);
//     each added line is listed with a "Take out".
//   · Which jars came from this? — chips of the other batchless jars at the same place; this jar is
//     preselected and stays chosen (it is the door).
//   · How many did you make? — optional, only for one counted jar; raises the made count, never what is
//     left. The jar's own count shows as a placeholder ("6, from the jar"), never as a value: an untouched
//     field still sends nothing.
//   · Next time… — optional; the jars' own "Next time…" lines are copied in by the server as well, and
//     shown here as they read everywhere else (nextTimeWords).
// Saving is ONE write (all or nothing); the key is minted when the sheet opens and reused on every retry.
// THE UNADDED LINE (Put-Up UX pass R1, D2). A name typed into the adder and not added was dropped by Save
// without a word. Now Save stops, puts the cursor back in the adder and says, there:
// "Add “garlic” first — or clear it." Either act lets the next Save through.
//
// THE SEAM FOR OTHER SURFACES: `useHowItWasMade({ onSaved })` returns `{ open(jar), sheet }`. The Pantry
// row sheet (pantry-ui) passes `open` as its "How it was made →" callback and renders `sheet`; the shipped
// jar record row (PutUp.jsx RecordRow) does the same. `canSayHowItWasMade(jar)` says when to offer it.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import Field from '../forms/Field.jsx'
import Input from '../forms/Input.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, inputChrome } from '../forms/formStyles.js'
import { SheetStartChips, resolveSheetStart } from '../kitchen/StartChips.jsx'
import KindChips, { kindBody } from '../kitchen/KindChips.jsx'
import { mintKey } from '../kitchen/idempotencyKey.js'
import LineAdder, { addFirstWords } from './LineAdder.jsx'
import LikeBatchPicker from './LikeBatchPicker.jsx'
import { lineWords } from './lines.js'
import { putUpDateWords } from './jarWords.js'
import {
  FROM_JARS_PATH, canSayHowItWasMade, jarOf, jarName, earliestStart, candidateJars, asksMadeCount, nextTimeLines,
  nextTimeWords, startedOf, fromJarsBody, fromJarsRefusal,
} from './howItWasMade.js'

export { canSayHowItWasMade }
export const HOW_SHEET_TITLE = 'How it was made'

const link = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600,
}

function startWords(start) {
  if (!start || start.precision === 'unknown' || !start.date) return 'Not sure'
  return putUpDateWords(start.date, start.precision) || start.date
}

export default function HowItWasMadeSheet({ jar, open, onClose, onSaved }) {
  if (!open || !jar) return null
  return <HowItWasMadeOpen jar={jar} onClose={onClose} onSaved={onSaved} />
}

function HowItWasMadeOpen({ jar, onClose, onSaved }) {
  const { fetch } = useApiFetch()
  const [key] = useState(() => mintKey())
  const [label, setLabel] = useState(() => jarName(jar))
  const [rows, setRows] = useState(null)
  // The jar's full record from the put-up list once it loads (a Pantry row carries no date words of its
  // own); until then, what the door handed in.
  const full = useMemo(() => (rows ?? []).find(r => r.id === jar.id) ?? jar, [rows, jar])
  const [changingStart, setChangingStart] = useState(false)
  const [chip, setChip] = useState('earlier')
  const [earlier, setEarlier] = useState(null)
  const [pickedDate, setPickedDate] = useState('')
  const [kind, setKind] = useState(null)
  const [kindOther, setKindOther] = useState('')
  const [kindOpen, setKindOpen] = useState(false)
  const [lines, setLines] = useState([])
  const [like, setLike] = useState(null)
  const [chosen, setChosen] = useState(() => new Set([jar.id]))
  const [made, setMade] = useState('')
  const [nextTime, setNextTime] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  // The adder's unadded name (LineAdder's onPendingChange), and whether Save has stopped for it.
  const [pending, setPending] = useState(null)
  const [stopped, setStopped] = useState(false)
  const writingRef = useRef(false)
  const linesRef = useRef(null)
  const labelId = `how-label-${useId()}`
  const madeId = `how-made-${useId()}`
  const nextId = `how-next-${useId()}`

  // The other jars at the same place — read once from the shipped put-up list.
  useEffect(() => {
    let alive = true
    Promise.resolve(fetch('/api/preservation/whats-put-up'))
      .then(r => { if (alive) setRows((r?.groups ?? []).flatMap(g => g.records ?? [])) })
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [fetch])

  const candidates = useMemo(() => candidateJars(rows ?? [], full), [rows, full])
  const chosenJars = candidates.filter(j => chosen.has(j.id))
  // The start: the earliest date among the jars chosen — it moves as jars are ticked. `chosenJars` keeps
  // the candidates' order (the door's jar first), which is the order the ids are sent in.
  const fixedStart = earliestStart(chosenJars)
  const earliestOfSeveral = chosenJars.length > 1 && fixedStart.date != null
  // "6, from the jar": what the one counted jar already says was made, as a hint and never as a value.
  const madeSoFar = Number(chosenJars[0]?.package_count)
  const madeHint = Number.isInteger(madeSoFar) && madeSoFar >= 1 ? `${madeSoFar}, from the jar` : ''
  const copied = useMemo(() => {
    const out = []
    for (const j of chosenJars) for (const n of nextTimeLines(j.notes)) if (!out.includes(n)) out.push(n)
    return out
  }, [chosenJars])

  const toggle = (id) => {
    if (id === jar.id) return
    setChosen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  const pickLike = (draft) => {
    setLike(draft)
    setLines(draft.lines)
    if (draft.kind && kind == null) { setKind(draft.kind); setKindOpen(true) }
  }
  const clearLike = () => { setLike(null); setLines([]) }

  const save = useCallback(async () => {
    if (writingRef.current) return
    // A name still sitting in the adder is not a line yet, and this body would leave it out. Stop before
    // anything is sent: the cursor goes back to the adder and the line beneath it says what to do.
    if (pending) {
      setStopped(true); setErr(null)
      linesRef.current?.querySelector('input')?.focus()
      return
    }
    let started = fixedStart
    if (changingStart) {
      const r = resolveSheetStart({ chip, earlier, pickedDate, now: new Date() })
      if (r.error) { setErr(r.error); return }
      started = startedOf(r)
    }
    const kindPart = kindBody(kind, kindOther)
    if (kindPart === null) { setErr('Pick a kind — or leave it unpicked.'); return }
    const res = fromJarsBody({
      key, label, started, kind: kindPart.kind ?? null, lines, jarIds: chosenJars.map(j => j.id),
      madeCount: asksMadeCount(chosenJars) ? made : '', nextTime,
    })
    if (res.error) {
      setErr(res.error)
      if (res.field === 'label') document.getElementById(labelId)?.focus()
      if (res.field === 'made') document.getElementById(madeId)?.focus()
      return
    }
    if (kindPart.kind_other) res.body.kind_other = kindPart.kind_other
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      const batch = await fetch(FROM_JARS_PATH, { method: 'POST', body: JSON.stringify(res.body) })
      onClose?.()
      onSaved?.(batch)
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(fromJarsRefusal(e))
    }
  }, [changingStart, chip, chosenJars, earlier, fetch, fixedStart, key, kind, kindOther, label, labelId, lines, made, madeId, nextTime, onClose, onSaved, pending, pickedDate])

  return (
    <Sheet open onClose={onClose} title={HOW_SHEET_TITLE} size="full" busy={saving} armsBack>
      <div data-testid="how-sheet" style={{ padding: '0 18px' }}>
        <Field label="Name it" htmlFor={labelId} required style={{ marginBottom: T.space.md }}>
          <Input id={labelId} data-testid="how-label" value={label} disabled={saving} maxLength={120}
            onChange={e => { setLabel(e.target.value); setErr(null) }} />
        </Field>

        <div style={{ marginBottom: T.space.md }}>
          {!changingStart ? (
            <div data-testid="how-start" style={{ color: P.mid, fontSize: T.type.sm }}>
              <span style={labelChrome}>When did it start?</span>
              <span data-testid="how-start-words">{startWords(fixedStart)}</span>
              {earliestOfSeveral ? ' · the earliest of these jars ' : ' · the jar’s date '}
              <button type="button" style={{ ...link, fontWeight: 400 }} disabled={saving} data-testid="how-start-change"
                onClick={() => setChangingStart(true)}>Change</button>
            </div>
          ) : (
            <SheetStartChips idPrefix="how-when" value={chip} disabled={saving}
              onChange={v => { setChip(v); if (v !== 'earlier') { setEarlier(null); setPickedDate('') } setErr(null) }}
              earlier={earlier} onEarlierChange={v => { setEarlier(v); if (v !== 'pickdate') setPickedDate(''); setErr(null) }}
              pickedDate={pickedDate} onPickedDateChange={v => { setPickedDate(v); setErr(null) }} now={new Date()} />
          )}
        </div>

        <div style={{ marginBottom: T.space.sm }}>
          <LikeBatchPicker idPrefix="how-like" picked={like} onPick={pickLike} onClear={clearLike} disabled={saving} />
        </div>

        <div style={{ marginBottom: T.space.sm }}>
          <button type="button" style={link} aria-expanded={kindOpen} disabled={saving} data-testid="how-kind-toggle"
            onClick={() => setKindOpen(o => !o)}>
            What kind of batch?<span style={{ color: P.light, fontWeight: 400, fontSize: '0.78rem', marginLeft: 6 }}>optional</span>
          </button>
          {kindOpen && (
            <KindChips idPrefix="how-kind" value={kind} disabled={saving} onChange={v => { setKind(v); setErr(null) }}
              otherText={kindOther} onOtherTextChange={setKindOther} />
          )}
        </div>

        <section ref={linesRef} aria-label="What went in" data-testid="how-lines" style={{ marginBottom: T.space.md }}>
          {lines.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '0 0 4px', padding: 0 }}>
              {lines.map((l, i) => (
                <li key={l.idempotency_key ?? i} data-testid="how-line" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: T.type.sm, color: P.dark }}>
                  <span style={{ flex: 1 }}>{lineWords(l)}</span>
                  <button type="button" style={{ ...link, fontWeight: 400 }} disabled={saving} data-testid={`how-line-out-${i}`}
                    onClick={() => setLines(ls => ls.filter((_, k) => k !== i))}>Take out</button>
                </li>
              ))}
            </ul>
          )}
          <LineAdder idPrefix="how-add" lines={lines} disabled={saving} pinnable={false} label="What went in?"
            excludeJarIds={[...chosen]}
            onPendingChange={(text) => { setPending(text); if (!text) setStopped(false) }}
            onAdd={async (body) => { setLines(ls => [...ls, { ...body, ordinal: ls.length }]); return true }} />
          {/* Said at the adder, where the cursor was just put — the sheet's own error line is a screen below. */}
          {stopped && pending && (
            <div role="alert" data-testid="how-add-first" style={{ marginTop: 6, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>
              {addFirstWords(pending)}
            </div>
          )}
        </section>

        <div style={{ marginBottom: T.space.md }}>
          <span style={labelChrome}>Which jars came from this?</span>
          <div role="group" aria-label="Which jars came from this?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {candidates.map(j => (
              <SelectChip key={j.id} touch active={chosen.has(j.id)} disabled={saving || j.id === jar.id}
                data-testid={`how-jar-${j.id}`} onClick={() => toggle(j.id)}>
                {jarName(j) || 'A put-up'}
              </SelectChip>
            ))}
          </div>
          {rows == null && <div style={{ color: P.light, fontSize: '0.78rem', marginTop: 4 }}>Looking for others at the same place…</div>}
        </div>

        {asksMadeCount(chosenJars) && (
          <div style={{ marginBottom: T.space.md }}>
            <label htmlFor={madeId} style={labelChrome}>How many did you make?<span style={optionalMarkChrome}>optional</span></label>
            <input id={madeId} data-testid="how-made" type="text" inputMode="numeric" value={made} disabled={saving}
              placeholder={madeHint} onChange={e => { setMade(e.target.value.replace(/[^0-9]/g, '')); setErr(null) }}
              style={{ ...inputChrome(false), width: 168 }} />
            <div style={{ color: P.light, fontSize: '0.74rem', marginTop: 4 }}>What’s left stays as it is.</div>
          </div>
        )}

        <div style={{ marginBottom: T.space.md }}>
          <label htmlFor={nextId} style={labelChrome}>Next time…<span style={optionalMarkChrome}>optional</span></label>
          <input id={nextId} data-testid="how-next-time" type="text" value={nextTime} disabled={saving}
            onChange={e => setNextTime(e.target.value)} style={inputChrome(false)} />
          {copied.length > 0 && (
            <ul data-testid="how-copied-next-time" style={{ margin: '4px 0 0', paddingLeft: 18, color: P.mid, fontSize: '0.78rem' }}>
              {copied.map(n => <li key={n}>{nextTimeWords(n)}</li>)}
            </ul>
          )}
        </div>

        {err && <div role="alert" data-testid="how-error" style={{ marginBottom: T.space.sm, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>}
      </div>

      <div data-testid="how-footer" style={{ position: 'sticky', bottom: 0, background: P.white,
        padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="how-submit" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>
          Save how it was made
        </Button>
      </div>
    </Sheet>
  )
}

// The seam: `const how = useHowItWasMade({ onSaved })`; call `how.open(rowOrJar)` from a row's
// "How it was made →" and render `how.sheet` once, anywhere under the row. `open` takes a shipped jar
// record or a Pantry Row (stock_kind 'put_up'; a bought item is ignored).
export function useHowItWasMade({ onSaved } = {}) {
  const [jar, setJar] = useState(null)
  const open = useCallback((j) => { const x = jarOf(j); if (canSayHowItWasMade(x)) setJar(x) }, [])
  const close = useCallback(() => setJar(null), [])
  const sheet = <HowItWasMadeSheet jar={jar} open={!!jar} onClose={close} onSaved={onSaved} />
  return { open, close, sheet, jar }
}
