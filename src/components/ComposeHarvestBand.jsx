// src/components/ComposeHarvestBand.jsx
// V4-COMPOSEPOST-001 — compose tonight's harvest post from what you just logged, on Today.
//
// WHY THIS EXISTS: the harvest list is the one thing Dave hand-types every night, and it is
// reconstructible from data he has already entered — the 2026-08-05 post reconciles 19/19 against
// rows logged 23:08–23:14. This surface removes the transcription and the arithmetic. It does NOT
// write the post: the lead paragraph, the annotations, and the final wording stay his.
//
// WHY ON-DEMAND AND NOT A NIGHTLY JOB (crucible 2026-08-10): a scheduled draft fires ~30 min after
// the last pick — while he is still holding the phone — and a nightly queue with something waiting
// in it turns a hobby into a chore, which is the likeliest form of "automation making the posting
// worse". Posting stays a PULL.
//
// Reward-UX V102: ambient. Self-fetching, error swallowed, renders NOTHING when there is no recent
// batch — no push, no modal, no toast, no badge, no count chip, no streak, no urgency colour.
//
// AUDIT FIXES 2026-08-10 (V4-COMPOSEPOST-002), each one a defect that reached dev:
//   BUG-COMPOSETOTALS-001 — season chips summed a 50-row paginated page and published it as a season
//     total (36 vs a true 132). Now read from the aggregates block, which the endpoint computes over
//     the full range with no cursor.
//   BUG-COMPOSEOWNER-001 — detectLastBatch ran unscoped against a HOUSEHOLD-scoped read model, so the
//     second household member was offered the first one's harvest in his first person. Now scoped to
//     the viewer's own Clerk subject.
//   Plus: a "1st" chip that could not be un-checked, a band that vanished irrecoverably when every
//     line was excluded, and no floor on a one-item batch.
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useApiFetch } from '../lib/api.js'
import { useAuthOptional } from '../context/AuthContext.jsx'
import { P } from '../lib/constants.js'
import { currentGrowYear } from '../lib/growYear.js'
import Icon from './Icon.jsx'
import { shareEntity, canShareFiles } from '../lib/shareEntity.js'
import { mintUrl } from './PhotoImg.jsx'
import { TIER } from '../lib/photoModel.js'
import {
  detectLastBatch, toLines, buildPostModel, renderPost, leadFacts, seasonCountsByCrop,
  LINE_SOFT_CAP, MIN_POST_LINES,
} from '../lib/harvestPost.js'
import { summarizeSeason, renderSeasonRetro } from '../lib/seasonRetro.js'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { collectBatchPhotos, fetchPostPhotos, MAX_POST_PHOTOS } from '../lib/harvestPostPhotos.js'

// A batch older than this is history, not "tonight" — offering it invites a post that describes the
// wrong evening. 18h covers a late-night pick read the next morning without reaching back a full day.
const MAX_BATCH_AGE_MS = 18 * 60 * 60 * 1000
// How far back to ask for LOGGING activity. Filters on created_at, so a backdated harvest logged
// tonight is still included; 24h comfortably covers the 18h freshness window above, and the busiest
// observed logging day (32 picks) sits well inside the endpoint's 50-row page.
const LOG_WINDOW_MS = 24 * 60 * 60 * 1000

// The ONLY thing this feature says while it works, and it is deliberately a line of grey text under
// the button rather than a spinner, a modal, a toast, a banner or a buzz (Reward-UX V102: ambient and
// in-context only). It is also the honesty surface: what will attach, what did not load, and what was
// left out are all stated BEFORE Dave taps, not discovered afterwards in the Facebook composer.
export function photoNote(photos, attachCount, canAttach) {
  if (!photos.total || photos.status === 'idle' || photos.status === 'none') return ''
  if (photos.status === 'loading') {
    return photos.total === 1 ? 'Getting the photo…' : `Getting ${photos.total} photos…`
  }
  if (!attachCount) {
    return photos.failed ? 'Photos didn’t load — the words will still go.' : ''
  }
  if (!canAttach) return 'This browser can’t attach photos — the words will go on their own.'
  const parts = [`${attachCount} ${attachCount === 1 ? 'photo' : 'photos'} will go with it`]
  if (photos.failed) parts.push(`${photos.failed} didn’t load`)
  if (photos.skipped) parts.push(`${photos.skipped} left out (${MAX_POST_PHOTOS} max)`)
  return parts.join(' · ')
}

function ageLabel(iso, now = Date.now()) {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((now - t) / 60000)
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`
  const hrs = Math.round(mins / 60)
  return hrs === 1 ? 'an hour ago' : `${hrs} hours ago`
}

export default function ComposeHarvestBand() {
  const { fetch } = useApiFetch()
  const { profile } = useAuthOptional()
  const viewerId = profile?.id ?? null
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  // Long pickers start collapsed so the post and its action stay above the fold (see the picker block).
  const [pickerOpen, setPickerOpen] = useState(false)
  const inflight = useRef(false)

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    const since = new Date(Date.now() - LOG_WINDOW_MS).toISOString()
    // entries are narrowed to recent LOGGING activity; aggregates deliberately are not, so the season
    // chips come from the full-range totals rather than from whatever fits on one page of entries.
    // The year is REQUIRED: parseTimeframe only matches /^season:(\d{4})$/, so a bare `season` returns
    // null and the endpoint 400s — which the catch below swallowed, so the band silently never
    // rendered from ~v4.10.0 until this line was fixed.
    const qs = `?include=entries,aggregates&timeframe=season:${currentGrowYear(new Date())}&created_since=${encodeURIComponent(since)}`
    fetch('/api/harvests' + qs)
      .then((d) => setData({
        entries: Array.isArray(d?.entries) ? d.entries : [],
        aggregates: d?.aggregates ?? null,
      }))
      .catch(() => { /* supplementary glance — never surface a fetch error onto Today */ })
      .finally(() => { inflight.current = false })
  }, [fetch])

  useEffect(() => { load() }, [load])

  const entries = data?.entries ?? null
  // Scoped to the viewer. The read model is HOUSEHOLD-scoped by design, so without this the most
  // recent logger in the household wins and the other member is offered someone else's harvest.
  const batch = useMemo(
    () => (entries && viewerId ? detectLastBatch(entries, { createdBy: viewerId }) : null),
    [entries, viewerId],
  )
  const baseLines = useMemo(() => (batch ? toLines(batch.items) : []), [batch])
  const seasonCounts = useMemo(() => seasonCountsByCrop(data?.aggregates), [data])

  // Per-line state, keyed by event id, so a refetch never clobbers Dave's choices.
  const [excluded, setExcluded] = useState(() => new Set())
  // Tri-state, NOT a Set: a Set can only ADD a first-harvest. Rows pre-checked from Dave's own
  // first_harvest event type could never be turned off, which broke the one promise the design makes
  // about this annotation — that it is a suggestion he ratifies rather than an emission.
  const [firstOverride, setFirstOverride] = useState(() => new Map())
  const [annotations, setAnnotations] = useState({})
  const [lead, setLead] = useState('')
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')

  const lines = useMemo(() => baseLines.map((l) => ({
    ...l,
    include: !excluded.has(l.id),
    isFirst: firstOverride.has(l.id) ? firstOverride.get(l.id) : l.isFirst,
  })), [baseLines, excluded, firstOverride])

  const model = useMemo(() => buildPostModel(lines), [lines])
  const batchText = useMemo(() => renderPost(model, { lead, annotations }), [model, lead, annotations])

  // V4-SEASONRETRO-001 (B13). The season draft is free here: this component ALREADY fetches
  // `timeframe=season:<growYear>&include=aggregates` for the per-crop totals in the lead facts, and
  // the aggregates block is unpaginated over the full range. So the retrospective is a second render
  // of data already in state — no extra request, no new endpoint, no Lambda change.
  const retroText = useMemo(() => {
    const m = summarizeSeason(data?.aggregates)
    return m ? renderSeasonRetro(m) : ''
  }, [data])

  // 'batch' = what was picked tonight; 'season' = the year so far. Same textarea, same share and
  // copy paths — the retrospective is a different DRAFT, not a different feature.
  const [mode, setMode] = useState('batch')
  const generated = mode === 'season' ? retroText : batchText
  const facts = useMemo(
    () => (batch ? leadFacts(batch, seasonCounts, 'this season') : []),
    [batch, seasonCounts],
  )

  // The textarea starts from the generated text and stops tracking it once Dave edits — his words are
  // never overwritten by a toggle. "Rebuild" is the explicit way back.
  useEffect(() => { if (!dirty) setDraft(generated) }, [generated, dirty])

  // ── V4-COMPOSEDRAFT-001: the caption survives closing the composer ──────────────────────────────
  //
  // It did not. Every open rebuilt from `generated` and Dave's edits were gone — and Business Suite,
  // which this replaces, keeps drafts. So this was a REGRESSION against the tool it is meant to beat,
  // not a missing nicety, which is why the IG crucible ranked it second of five.
  //
  // Reuses src/lib/draftStash.js rather than adding a second persistence mechanism. That is the whole
  // point: this repo has already paid for two implementations of one job drifting apart (the metadata
  // strippers), and a bespoke localStorage key here would be the same bet.
  //
  // sessionStorage, inherited from that module, is the right scope by accident of being right on
  // purpose: a harvest caption is for tonight. A localStorage draft would resurface weeks later
  // against a batch that no longer exists, and on a shared device it would surface Dave's words in
  // Jen's session — the shape V4-RANKCLEAR-001 already had to fix once for crop ordering.
  //
  // KEYED ON startedAt, NOT endedAt, and that is load-bearing. Crucible B2 measured that 6 of 66
  // batch boundaries sit in the 90-180 min window, so one later-logged event BRIDGES two batches into
  // one — under `endedAt` the key moves and the draft orphans; under `startedAt` the merged batch
  // keeps the earlier value and the draft still resolves. `createdBy` is in the key so Dave's and
  // Jen's drafts cannot collide on the shared tablet.
  const draftKeyRef = batch ? `compose.${batch.createdBy ?? 'anon'}.${batch.startedAt}` : null

  // Restore runs ONCE per batch key, guarded by a ref rather than by `dirty`: an effect that reran on
  // every keystroke would keep re-seeding the textarea from the stash and fight the user for the
  // caret. Excluded lines ride along because unchecking six rows and losing that on a close is the
  // same loss as losing the words — a Set is stored as an array since Sets do not serialise.
  const restoredKeyRef = useRef(null)
  useEffect(() => {
    if (!draftKeyRef || restoredKeyRef.current === draftKeyRef) return
    restoredKeyRef.current = draftKeyRef
    const saved = readDraft(draftKeyRef)
    if (!saved) return
    if (Array.isArray(saved.excluded)) setExcluded(new Set(saved.excluded))
    if (typeof saved.lead === 'string') setLead(saved.lead)
    if (saved.mode === 'season' || saved.mode === 'batch') setMode(saved.mode)
    // Only a DIRTY draft is restored as text. A clean one is reproducible from the data, and
    // re-seeding it would pin a stale generation over a batch that has since gained a row.
    if (saved.dirty && typeof saved.draft === 'string') { setDraft(saved.draft); setDirty(true) }
  }, [draftKeyRef])

  useEffect(() => {
    if (!draftKeyRef || restoredKeyRef.current !== draftKeyRef) return
    writeDraft(draftKeyRef, { draft, dirty, lead, mode, excluded: [...excluded] })
  }, [draftKeyRef, draft, dirty, lead, mode, excluded])

  const postText = dirty ? draft : generated

  // ── Photos (V4-HARVPOSTPHOTOS-001) ──────────────────────────────────────────────────────────────
  // Fetched when the composer OPENS, never inside the share handler: navigator.share needs transient
  // user activation, Chrome Android drops it across an await, and a handler that fetched five photos
  // first would find the activation gone. The minutes Dave spends writing his lead ARE the prefetch
  // window. Nothing runs until he taps "Compose post" — the band stays ambient on Today, and a batch
  // with no photos costs no requests at all.
  const [photos, setPhotos] = useState(() => ({ status: 'idle', items: [], failed: 0, skipped: 0, total: 0 }))
  const photoRunRef = useRef(null)
  const photoAbortRef = useRef(null)
  // Unmount-only. Deliberately NOT tied to `open`: aborting when the composer collapses would strand
  // a half-fetched set that the run guard then refuses to restart on reopen.
  useEffect(() => () => photoAbortRef.current?.abort(), [])

  useEffect(() => {
    if (!open || !batch) return
    const runKey = batch.endedAt
    if (photoRunRef.current === runKey) return
    photoRunRef.current = runKey
    const { photos: refs, total, dropped } = collectBatchPhotos(batch.items)
    if (!refs.length) { setPhotos({ status: 'none', items: [], failed: 0, skipped: 0, total }); return }
    const ac = new AbortController()
    photoAbortRef.current = ac
    setPhotos({ status: 'loading', items: [], failed: 0, skipped: dropped, total: refs.length })
    fetchPostPhotos(refs, {
      mint: (id) => mintUrl(id, fetch, TIER.FULL),
      signal: ac.signal,
      onProgress: ({ failed }) => setPhotos((p) => (p.status === 'loading' ? { ...p, failed } : p)),
    })
      .then((r) => setPhotos({ status: 'ready', items: r.items, failed: r.failed, skipped: dropped + r.skipped, total: refs.length }))
      // fetchPostPhotos absorbs per-photo failures itself, so reaching here means the whole run threw.
      .catch(() => setPhotos({ status: 'ready', items: [], failed: refs.length, skipped: dropped, total: refs.length }))
  }, [open, batch, fetch])

  // Photos follow the SAME exclusion the lines do — one control, not two. Leaving the cucumbers out
  // of the words leaves the picture of them out too.
  const attachFiles = useMemo(
    () => photos.items.filter((p) => !excluded.has(p.eventId)).map((p) => p.file),
    [photos.items, excluded],
  )
  const canAttach = useMemo(() => canShareFiles(attachFiles), [attachFiles])

  const onShare = useCallback(async () => {
    // Held in a local const BEFORE any await: Chrome Android drops transient user activation across
    // an await, and both navigator.share and the clipboard fallback then reject silently. `files` is
    // read here for the same reason — and it is already bytes, so nothing is fetched on this path.
    const text = postText
    if (!text.trim()) return
    const files = attachFiles
    const n = canShareFiles(files) ? files.length : 0
    const result = await shareEntity({ text, files })
    // V4-COMPOSEDRAFT-001: a draft that reached the share sheet has done its job — keeping it would
    // re-seed tonight's caption on the next open, over a batch he has already posted. Cleared ONLY
    // on 'shared'/'copied'; the fallback branch means the text never left the textarea, which is
    // precisely when it is most important not to throw it away.
    if (draftKeyRef && (result === 'shared' || result === 'copied')) clearDraft(draftKeyRef)
    setStatus(result === 'shared'
      ? (n ? `Sent to your share sheet with ${n} ${n === 1 ? 'photo' : 'photos'}.` : 'Sent to your share sheet.')
      : result === 'copied' ? 'Copied — paste it into your post.'
      : 'Select the text above and copy it.')
  }, [postText, attachFiles, draftKeyRef])

  // Straight to the clipboard, never through shareEntity: on Chrome Android shareEntity always takes
  // the navigator.share leg and its clipboard branch is unreachable, so a Copy wired through it opens
  // the share sheet and never copies (HarvestExportSheet header, landmine 1). This is the recovery for
  // an Android share target that keeps the images and discards EXTRA_TEXT — the words stay one tap away.
  const onCopyText = useCallback(() => {
    const text = postText
    if (!text.trim()) return
    try {
      const r = navigator?.clipboard?.writeText?.(text)
      if (!r) { setStatus('Select the text above and copy it.'); return }
      Promise.resolve(r).then(() => setStatus('Copied.')).catch(() => setStatus('Select the text above and copy it.'))
    } catch { setStatus('Select the text above and copy it.') }
  }, [postText])

  if (!batch) return null
  if (Date.now() - new Date(batch.endedAt).getTime() > MAX_BATCH_AGE_MS) return null
  // Gate on what the BATCH contains, never on the current model: gating on model.lineCount let Dave
  // exclude every line and delete the surface holding the un-exclude buttons, with no way back short
  // of a reload that discarded his lead, annotations and draft.
  const postableCount = baseLines.filter((l) => l.postable).length
  if (postableCount < MIN_POST_LINES) return null

  const S = {
    card: { background: P.white, border: `1px solid ${P.border}`, borderRadius: 12, padding: 14, marginTop: 14 },
    head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    title: { fontSize: '0.95rem', fontWeight: 700, color: P.dark },
    sub: { fontSize: '0.78rem', color: P.light, marginTop: 2 },
    btn: { background: P.green, color: P.white, border: 'none', borderRadius: 20, padding: '7px 14px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
    ghost: { background: 'none', color: P.mid, border: `1px solid ${P.border}`, borderRadius: 20, padding: '6px 12px', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' },
    chip: (on) => ({ background: on ? P.greenPale : 'none', color: on ? P.green : P.light, border: `1px solid ${on ? P.greenLight : P.border}`, borderRadius: 14, padding: '3px 9px', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', flexShrink: 0 }),
    row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${P.cream}` },
    ta: { width: '100%', boxSizing: 'border-box', border: `1px solid ${P.border}`, borderRadius: 8, padding: 10, fontSize: '0.86rem', lineHeight: 1.5, fontFamily: 'inherit', color: P.dark, resize: 'vertical' },
  }

  return (
    <div style={S.card} data-testid="compose-harvest-band">
      <div style={S.head}>
        <div style={{ minWidth: 0 }}>
          <div style={S.title}>Tonight&rsquo;s harvest</div>
          <div style={S.sub}>
            {postableCount} {postableCount === 1 ? 'pick' : 'picks'} &middot; logged {ageLabel(batch.endedAt)}
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
            placeholder="Say something first (optional)&hellip;"
            rows={2}
            style={S.ta}
            aria-label="Opening line"
          />

          {/* Collapsed by default on a long batch. Found by rendering at 390px: 17 lines of picker
              push "Send to Facebook" 1.8 screens down, so the post — the thing this surface exists to
              produce — and its only action both land below the fold. The picker is the exception
              path; the post is the point. */}
          <div>
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              aria-expanded={pickerOpen}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: '0.72rem', color: P.light, marginBottom: 4, textAlign: 'left' }}
            >
              What&rsquo;s in the post ({postableCount}) &mdash; {pickerOpen ? 'hide' : 'tap to leave something out'}
            </button>
            {pickerOpen && baseLines.map((l) => {
              const on = !excluded.has(l.id)
              const first = firstOverride.has(l.id) ? firstOverride.get(l.id) : l.isFirst
              return (
                <div key={l.id} style={S.row}>
                  <button type="button" onClick={() => setExcluded((s) => {
                    const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n
                  })}
                    aria-pressed={on}
                    disabled={!l.postable}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: l.postable ? 'pointer' : 'default', flex: 1, minWidth: 0, textAlign: 'left',
                      color: on && l.postable ? P.dark : P.light, textDecoration: on ? 'none' : 'line-through', fontSize: '0.85rem' }}>
                    {l.quantity} {l.name || <em>{l.crop || 'unnamed'} &mdash; needs a name</em>}
                    {!l.postable && <span style={{ color: P.light, fontSize: '0.72rem' }}> &middot; not in the post</span>}
                  </button>
                  {l.postable && (
                    <button type="button" style={S.chip(first)} aria-pressed={first}
                      onClick={() => setFirstOverride((m) => { const n = new Map(m); n.set(l.id, !first); return n })}>
                      1st
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* The logged note is offered, never published as-is: Dave rewrites these ("Fell off plant
              with major blotch" -> "(fell from plant w/ deformity, not 1st harvest)"). */}
          {baseLines.filter((l) => l.noteSuggestion && l.postable).map((l) => (
            <div key={`n-${l.id}`}>
              <div style={{ fontSize: '0.72rem', color: P.light, marginBottom: 4 }}>
                Note on {l.name || l.crop} &mdash; you logged &ldquo;{l.noteSuggestion}&rdquo;
              </div>
              <input
                value={annotations[l.id] ?? ''}
                onChange={(ev) => setAnnotations((a) => ({ ...a, [l.id]: ev.target.value }))}
                placeholder="Add it to the post in your words&hellip;"
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
            {model.lineCount === 0 && !dirty ? (
              <div style={{ fontSize: '0.82rem', color: P.mid, border: `1px dashed ${P.border}`, borderRadius: 8, padding: '12px 10px' }}>
                Everything is left out &mdash; tap a line above to put it back.
              </div>
            ) : (
              <textarea
                value={postText}
                onChange={(ev) => { setDraft(ev.target.value); setDirty(true); setStatus('') }}
                rows={Math.min(14, Math.max(6, postText.split('\n').length + 1))}
                style={S.ta}
                aria-label="Post text"
              />
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" style={S.btn} onClick={onShare} data-testid="compose-share"
              disabled={!postText.trim()}>
              <Icon name="action.share" size={14} decorative surface="inverse" style={{ marginRight: 5, verticalAlign: '-0.1em' }} />
              Send to Facebook
            </button>
            {/* Never disabled while photos load: a share tapped early sends the words, which is
                exactly today's behaviour, and the note below says so before he taps. */}
            <button type="button" style={S.ghost} onClick={onCopyText} data-testid="compose-copy"
              disabled={!postText.trim()}>
              Copy the words
            </button>
            {/* V4-SEASONRETRO-001. Switching mode is an EXPLICIT act, like Rebuild, so it clears
                `dirty` and loads the other draft. Without that, a mode switch after any edit would
                silently do nothing — the effect above only tracks `generated` while undirty — and
                the button would look broken rather than declining to overwrite his words. */}
            {retroText && (
              <button type="button" style={S.ghost} data-testid="compose-mode"
                aria-pressed={mode === 'season'}
                onClick={() => { setMode((m) => (m === 'season' ? 'batch' : 'season')); setDirty(false) }}>
                {mode === 'season' ? 'Back to tonight' : 'The season so far'}
              </button>
            )}
            {status && <span style={{ fontSize: '0.78rem', color: P.mid }}>{status}</span>}
          </div>

          <div aria-live="polite" data-testid="compose-photo-note"
            style={{ fontSize: '0.76rem', color: P.light, minHeight: 16, marginTop: -6 }}>
            {photoNote(photos, attachFiles.length, canAttach)}
          </div>
        </div>
      )}
    </div>
  )
}
