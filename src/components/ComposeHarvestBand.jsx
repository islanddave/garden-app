// src/components/ComposeHarvestBand.jsx
// V4-COMPOSEPOST-001 — compose tonight's harvest post from what you just logged, on Today.
//
// WHY THIS EXISTS: the harvest list is the one thing Dave hand-types every night, and it is
// reconstructible from data he has already entered — the 2026-08-05 post reconciles 19/19 against
// rows logged 23:08–23:14. This surface removes the transcription and the arithmetic. It does NOT
// write the post: the lead paragraph, the annotations, and the final wording stay his.
//
// WHY ON-DEMAND AND NOT A NIGHTLY JOB (crucible 2026-08-10): a scheduled draft fires ~30 min after
// the last pick — while he is still holding the phone — so a button on the page he is already
// looking at reaches him sooner, for none of the infrastructure. It also keeps posting a PULL: a
// nightly queue with something waiting in it turns a hobby into a chore, which is the likeliest
// form of "automation making the posting worse".
//
// Reward-UX V102: ambient. Self-fetching, error swallowed, renders NOTHING when there is no recent
// batch — no push, no modal, no toast, no badge, no count chip, no streak, no urgency colour.
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import Icon from './Icon.jsx'
import { shareEntity } from '../lib/shareEntity.js'
import {
  detectLastBatch, toLines, buildPostModel, renderPost, leadFacts, LINE_SOFT_CAP,
} from '../lib/harvestPost.js'

// A batch older than this is history, not "tonight" — offering it invites a post that describes the
// wrong evening. 18h covers a late-night pick read the next morning without reaching back a full day.
const MAX_BATCH_AGE_MS = 18 * 60 * 60 * 1000

function ageLabel(iso) {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`
  const hrs = Math.round(mins / 60)
  return hrs === 1 ? 'an hour ago' : `${hrs} hours ago`
}

export default function ComposeHarvestBand() {
  const { fetch } = useApiFetch()
  const [entries, setEntries] = useState(null)
  const [open, setOpen] = useState(false)
  const inflight = useRef(false)

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    fetch('/api/harvests?include=entries&timeframe=7d')
      .then((d) => setEntries(Array.isArray(d?.entries) ? d.entries : []))
      .catch(() => { /* supplementary glance — never surface a fetch error onto Today */ })
      .finally(() => { inflight.current = false })
  }, [fetch])

  useEffect(() => { load() }, [load])

  const batch = useMemo(() => (entries ? detectLastBatch(entries) : null), [entries])
  const baseLines = useMemo(() => (batch ? toLines(batch.items) : []), [batch])

  // Per-line state lives here, keyed by event id, so re-fetches don't clobber Dave's choices.
  const [excluded, setExcluded] = useState(() => new Set())
  const [firsts, setFirsts] = useState(() => new Set())
  const [annotations, setAnnotations] = useState({})
  const [lead, setLead] = useState('')
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')

  const lines = useMemo(() => baseLines.map((l) => ({
    ...l,
    include: !excluded.has(l.id),
    isFirst: l.isFirst || firsts.has(l.id),
  })), [baseLines, excluded, firsts])

  const model = useMemo(() => buildPostModel(lines), [lines])
  const generated = useMemo(() => renderPost(model, { lead, annotations }), [model, lead, annotations])
  const facts = useMemo(() => (batch ? leadFacts(batch, entries || []) : []), [batch, entries])

  // The textarea starts from the generated text and stops tracking it once Dave edits — his words
  // are never overwritten by a toggle. "Rebuild" is the explicit way back.
  useEffect(() => { if (!dirty) setDraft(generated) }, [generated, dirty])

  const postText = dirty ? draft : generated

  const onShare = useCallback(async () => {
    // Held in a local const BEFORE any await: Chrome Android drops transient user activation across
    // an await, and both navigator.share and the clipboard fallback then reject silently.
    const text = postText
    if (!text.trim()) return
    const result = await shareEntity({ text })
    setStatus(result === 'shared' ? 'Sent to your share sheet.'
      : result === 'copied' ? 'Copied — paste it into your post.'
      : 'Select the text above and copy it.')
  }, [postText])

  if (!batch || !model.lineCount) return null
  const stale = Date.now() - new Date(batch.endedAt).getTime() > MAX_BATCH_AGE_MS
  if (stale) return null

  const S = {
    card: { background: P.white, border: `1px solid ${P.border}`, borderRadius: 12, padding: 14, marginTop: 14 },
    head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    title: { fontSize: '0.95rem', fontWeight: 700, color: P.dark },
    sub: { fontSize: '0.78rem', color: P.light, marginTop: 2 },
    btn: { background: P.green, color: P.white, border: 'none', borderRadius: 20, padding: '7px 14px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
    ghost: { background: 'none', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 20, padding: '6px 12px', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' },
    chip: (on) => ({ background: on ? P.greenPale : 'none', color: on ? P.green : P.light, border: `1px solid ${on ? P.greenLight : P.border}`, borderRadius: 14, padding: '3px 9px', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }),
    row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${P.cream}` },
    ta: { width: '100%', boxSizing: 'border-box', border: `1px solid ${P.border}`, borderRadius: 8, padding: 10, fontSize: '0.86rem', lineHeight: 1.5, fontFamily: 'inherit', color: P.dark, resize: 'vertical' },
  }

  return (
    <div style={S.card} data-testid="compose-harvest-band">
      <div style={S.head}>
        <div>
          <div style={S.title}>Tonight&rsquo;s harvest</div>
          <div style={S.sub}>
            {model.lineCount} {model.lineCount === 1 ? 'pick' : 'picks'} &middot; logged {ageLabel(batch.endedAt)}
          </div>
        </div>
        <button type="button" style={S.btn} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide' : 'Compose post'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Material for the lead, never a written lead. Tapping a fact appends it; the sentence
              stays Dave's. A generated sentence in his voice is worse than no lead at all. */}
          {facts.length > 0 && (
            <div>
              <div style={{ fontSize: '0.72rem', color: P.light, marginBottom: 5 }}>Numbers you might want</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {facts.map((f) => (
                  <button key={f} type="button" style={S.chip(false)}
                    onClick={() => setLead((v) => (v ? `${v.trimEnd()} ${f}` : f))}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}

          <textarea
            value={lead}
            onChange={(ev) => setLead(ev.target.value)}
            placeholder="Say something first (optional)…"
            rows={2}
            style={S.ta}
            aria-label="Opening line"
          />

          <div>
            <div style={{ fontSize: '0.72rem', color: P.light, marginBottom: 4 }}>
              What&rsquo;s in the post &mdash; tap to leave something out
            </div>
            {baseLines.map((l) => {
              const on = !excluded.has(l.id)
              const first = l.isFirst || firsts.has(l.id)
              return (
                <div key={l.id} style={S.row}>
                  <button type="button" onClick={() => setExcluded((s) => {
                    const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n
                  })}
                    aria-pressed={on}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flex: 1, textAlign: 'left',
                      color: on ? P.dark : P.light, textDecoration: on ? 'none' : 'line-through', fontSize: '0.85rem' }}>
                    {l.quantity} {l.name || <em>{l.crop} (needs a name)</em>}
                    {!l.postable && <span style={{ color: P.light, fontSize: '0.72rem' }}> &middot; not counted</span>}
                  </button>
                  <button type="button" style={S.chip(first)} aria-pressed={first}
                    onClick={() => setFirsts((s) => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n })}>
                    1st
                  </button>
                </div>
              )
            })}
          </div>

          {/* The logged note is offered, never published as-is: Dave rewrites these ("Fell off plant
              with major blotch" -> "(fell from plant w/ deformity, not 1st harvest)"). */}
          {baseLines.filter((l) => l.noteSuggestion).map((l) => (
            <div key={`n-${l.id}`}>
              <div style={{ fontSize: '0.72rem', color: P.light, marginBottom: 4 }}>
                Note on {l.name || l.crop} &mdash; you logged &ldquo;{l.noteSuggestion}&rdquo;
              </div>
              <input
                value={annotations[l.id] ?? ''}
                onChange={(ev) => setAnnotations((a) => ({ ...a, [l.id]: ev.target.value }))}
                placeholder="Add it to the post in your words…"
                style={{ ...S.ta, resize: 'none' }}
                aria-label={`Note for ${l.name || l.crop}`}
              />
            </div>
          ))}

          {model.overCap && (
            <div style={{ fontSize: '0.76rem', color: P.mid, background: P.warn, border: `1px solid ${P.warnBorder}`, borderRadius: 8, padding: '8px 10px' }}>
              {model.lineCount} lines &mdash; past about {LINE_SOFT_CAP} the end of the list falls below
              Facebook&rsquo;s &ldquo;See more&rdquo; fold. Consider leaving a few out.
            </div>
          )}

          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: '0.72rem', color: P.light }}>Your post</span>
              {dirty && (
                <button type="button" style={{ ...S.ghost, padding: '3px 9px', fontSize: '0.72rem' }}
                  onClick={() => { setDirty(false); setStatus('') }}>
                  Rebuild from selections
                </button>
              )}
            </div>
            <textarea
              value={postText}
              onChange={(ev) => { setDraft(ev.target.value); setDirty(true); setStatus('') }}
              rows={Math.min(18, Math.max(6, postText.split('\n').length + 1))}
              style={S.ta}
              aria-label="Post text"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" style={S.btn} onClick={onShare} data-testid="compose-share">
              <Icon name="action.share" size={14} decorative surface="inverse" style={{ marginRight: 5, verticalAlign: '-0.1em' }} />
              Send to Facebook
            </button>
            {status && <span style={{ fontSize: '0.78rem', color: P.mid }}>{status}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
