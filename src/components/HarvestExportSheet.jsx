// HarvestExportSheet — V4-HARVEXPORT-001. Copyable text export of the Harvests page (BD-005).
//
// COMPOSITION, NOT CONSTRUCTION: shareEntity, the harvestSummary/harvestGrouping text primitives and
// the Sheet fly-up all ship today; this wires them together and adds the fetch the sheet OWNS.
//
// ── The two Chrome Android landmines this file exists to defuse (design §2c, adjudicated) ─────────
// 1. `shareEntity` CAN NEVER COPY on Chrome Android. It tries navigator.share first and returns
//    'noop' on ANY throw, so the clipboard leg is unreachable wherever navigator.share exists —
//    i.e. always, on Dave's actual device. A Copy button wired through it opens the OS share sheet
//    and never copies. Copy therefore goes DIRECT to navigator.clipboard.writeText.
// 2. TRANSIENT USER ACTIVATION DIES ACROSS AN AWAIT. Building the string inside the tap handler and
//    writing afterwards makes both navigator.share and the clipboard reject silently. So the fetch
//    and the cursor drain run when the sheet OPENS or a selection CHANGES — never in the handler —
//    and Copy/Share are DISABLED (not hidden) until the full string is materialized. The populated
//    preview is the readiness signal; the handlers begin with the string already in a local and call
//    the platform API synchronously.
//
// DRAIN INTEGRITY: the export exists to be trustworthy, so it never silently truncates. Log mode
// runs ONE unfiltered timeframe-scoped drain and client-filters by crop_type_slug (the server takes
// a single `crop` param; 549 harvest events all-time — trivially cheap). A failed OR CACHE-SERVED
// page mid-drain aborts with a visible error + retry and NO partial clipboard write. Offline is this
// app's normal condition, and a silently-short export is worse than no export.
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { P } from '../lib/constants.js'
import Sheet from './forms/Sheet.jsx'
import SegmentedControl from './forms/SegmentedControl.jsx'
import FilterChipRow from './forms/FilterChipRow.jsx'
import HarvestTimeframeChips from './HarvestTimeframeChips.jsx'
import { useApiFetch } from '../lib/api.js'
import { shareEntity } from '../lib/shareEntity.js'
import { buildTotalsExport, buildLogExport, narratedHeader } from '../lib/harvestExport.js'
import { etDay } from '../lib/harvestSummary.js'
import { HARVEST_TZ } from '../lib/growYear.js'
import { PROJECTS_HIDDEN } from '../lib/featureFlags.js'

// The service worker stamps X-From-Cache on an API response it served from cache because the
// network was unavailable, and api.js carries that across the parse boundary as a NON-ENUMERABLE
// global-registry Symbol. Read via Symbol.for rather than importing api.js's isFromCache, following
// the same reasoning api.js records for dataCache: the registry symbol is the dependency-free seam.
// Cache-served pages are the silent-truncation vector — the cache holds page 1, not the drain.
const FROM_CACHE = Symbol.for('garden-app.fromCache')
const servedFromCache = (v) => !!v && typeof v === 'object' && v[FROM_CACHE] === true

const MAX_PAGES = 200 // a bound, not a limit: 549 lifetime events at ~50/page. Hitting it is a bug.

function qs({ include, timeframe, cursor }) {
  const p = new URLSearchParams()
  p.set('include', include)
  if (timeframe) p.set('timeframe', timeframe)
  if (cursor) p.set('cursor', cursor)
  return `/api/harvests?${p.toString()}`
}

export default function HarvestExportSheet({
  open,
  onClose,
  defaultFormat = 'totals',
  initialTimeframe = '',
  initialCrops = [],
  cropOptions = [],
  seasonYears,
}) {
  const { fetch: apiFetch } = useApiFetch()
  // Sheet edits are sheet-LOCAL and session-ephemeral (design §2c) — they never write back to the
  // page's filters, so opening the export can't silently rescope the page behind it.
  const [format, setFormat] = useState(defaultFormat)
  const [timeframe, setTimeframe] = useState(initialTimeframe)
  const [crops, setCrops] = useState(() => new Set(initialCrops))
  const [text, setText] = useState(null)      // null = not materialized ⇒ Copy/Share DISABLED
  const [shareText, setShareText] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [hasRows, setHasRows] = useState(false) // an EMPTY result is ready-but-unsendable, not an error
  const [pages, setPages] = useState(0)
  const [outcome, setOutcome] = useState(null) // null | 'copied' | 'shared' | 'failed'
  const runRef = useRef(0)
  // cropOptions is a fresh array identity on every parent render. If it sat in load's dep array the
  // load effect would refire on each one — an unbounded fetch loop behind an open sheet. It is only
  // ever read for DISPLAY names, so it rides a ref instead of the dependency graph.
  const cropOptionsRef = useRef(cropOptions)
  cropOptionsRef.current = cropOptions

  // Re-seed from the page every time the sheet RE-opens: it must reflect what Dave is looking at now,
  // not what he was looking at last time. Deliberately SKIPPED on the first open — the useState
  // initializers already seeded it, and re-seeding would hand `crops` a fresh Set identity, change
  // `load`, and fire the whole fetch (or the whole cursor drain) a second time on every open.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!open) return
    if (!seededRef.current) { seededRef.current = true; return }
    setFormat(defaultFormat)
    setTimeframe(initialTimeframe)
    setCrops(new Set(initialCrops))
    setOutcome(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const load = useCallback(async () => {
    const rid = ++runRef.current
    setStatus('loading'); setText(null); setShareText(null); setPages(0); setOutcome(null); setHasRows(false)
    const selected = crops
    const cropNames = cropOptionsRef.current.filter((c) => selected.has(c.crop_type_slug)).map((c) => c.display_name)
    const today = etDay(new Date(), HARVEST_TZ)
    const currentYear = Number(String(today).slice(0, 4))
    try {
      if (format === 'totals') {
        // Aggregates are cursor-free and full-range, so Totals needs exactly one request and may
        // proceed with the app's existing cached-data semantics (design §2c).
        const data = await apiFetch(qs({ include: 'aggregates', timeframe }))
        if (runRef.current !== rid) return
        const agg = data?.aggregates ?? null
        const filtered = selected.size === 0 ? agg : {
          ...agg,
          crops: (agg?.crops ?? []).filter((c) => selected.has(c.crop_type_slug)),
          first_pick: (agg?.first_pick ?? []).filter((f) => selected.has(f.crop_type_slug)),
          // weight is a whole-universe total; under a crop filter it cannot be attributed to the
          // selection, so it is DROPPED rather than reprinted as if it were the subset's weight.
          weight: null,
        }
        const opts = { aggregates: filtered, timeframe, cropNames, generatedOn: today, currentYear, cropFilterActive: selected.size > 0, projectsHidden: PROJECTS_HIDDEN }
        const body = buildTotalsExport(opts)
        setText(body)
        setShareText(`${narratedHeader({ mode: 'totals', aggregates: filtered, timeframe })}\n\n${body}`)
        setHasRows((filtered?.crops?.length ?? 0) > 0 || (!opts.cropFilterActive && (filtered?.other?.length ?? 0) > 0))
        setStatus('ready')
        return
      }
      // Log mode: drain the cursor. ONE unfiltered pass, client-filtered after — never one request
      // per selected crop.
      let cursor = null
      let all = []
      for (let i = 0; i < MAX_PAGES; i++) {
        const data = await apiFetch(qs({ include: 'entries,aggregates', timeframe, cursor }))
        if (runRef.current !== rid) return
        if (servedFromCache(data)) throw new Error('cache')
        all = all.concat(Array.isArray(data?.entries) ? data.entries : [])
        setPages(i + 1)
        cursor = data?.cursor ?? null
        if (!cursor) break
      }
      if (runRef.current !== rid) return
      const rows = selected.size === 0 ? all : all.filter((e) => selected.has(e.crop_type_slug))
      const opts = { entries: rows, timeframe, cropNames, generatedOn: today, currentYear }
      const body = buildLogExport(opts)
      setText(body)
      setShareText(`${narratedHeader({ mode: 'log', entries: rows, timeframe })}\n\n${body}`)
      setHasRows(rows.length > 0)
      setStatus('ready')
    } catch {
      if (runRef.current !== rid) return
      // No partial text is ever left behind: a half-drained export that LOOKS complete is the exact
      // failure this abort exists to prevent.
      setText(null); setShareText(null); setHasRows(false); setStatus('error')
    }
  }, [apiFetch, format, timeframe, crops])

  useEffect(() => { if (open) load() }, [open, load])

  const empty = status === 'ready' && !hasRows
  const canSend = status === 'ready' && !!text && hasRows

  // SYNCHRONOUS in the click handler. The string is already in a local before the platform call —
  // no await precedes navigator.clipboard.writeText, or transient activation is gone (see header).
  const onCopy = () => {
    const t = text
    if (!t) return
    try {
      const r = navigator?.clipboard?.writeText?.(t)
      if (!r) { setOutcome('failed'); return }
      Promise.resolve(r).then(() => setOutcome('copied')).catch(() => setOutcome('failed'))
    } catch { setOutcome('failed') }
  }

  const onShare = () => {
    const t = shareText
    if (!t) return
    // STATICALLY imported and called synchronously — a dynamic import() here would put an await
    // before the platform call and kill transient activation, the same landmine as Copy. 'shared'
    // must NEVER render "Copied": the OS sheet may have gone anywhere, or nowhere.
    Promise.resolve(shareEntity({ text: t }))
      .then((r) => setOutcome(r === 'shared' ? 'shared' : r === 'copied' ? 'copied' : 'failed'))
      .catch(() => setOutcome('failed'))
  }

  return (
    <Sheet open={open} onClose={onClose} title="Export harvests" size="full" armsBack>
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Explicit format segment (design §2c): one affordance must never silently produce two
            different artifacts. Defaulted from the view Dave is on. */}
        <SegmentedControl
          options={[{ value: 'totals', label: 'Totals summary' }, { value: 'log', label: 'Log lines' }]}
          value={format}
          onChange={setFormat}
          ariaLabel="Export format"
        />

        <HarvestTimeframeChips value={timeframe} onChange={setTimeframe} seasonYears={seasonYears} ariaLabel="Export timeframe" />

        {cropOptions.length > 0 && (
          <FilterChipRow
            // Merge reconciliation (Lane A mint vs Lane B stub): the shipped primitive destructures
            // the DOM-cased 'aria-label', not ariaLabel — the camelCase form was silently dropped and
            // the row fell back to its default "Filters" label. Do not "tidy" this to camelCase.
            aria-label="Export crops"
            options={cropOptions.map((c) => ({ value: c.crop_type_slug, label: c.display_name }))}
            selected={crops}
            onToggle={(v) => setCrops((prev) => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n })}
            onClear={() => setCrops(new Set())}
          />
        )}
        <p style={{ margin: 0, fontSize: '0.76rem', color: P.light }}>
          {crops.size === 0
            ? 'All crops, including harvests logged without a planting.'
            : 'Harvests logged without a planting are left out while a crop filter is on.'}
        </p>

        {status === 'loading' && (
          <p data-testid="export-progress" style={{ margin: 0, fontSize: '0.82rem', color: P.mid }}>
            Gathering{pages > 0 ? ` — ${pages} page${pages === 1 ? '' : 's'}` : ''}…
          </p>
        )}
        {status === 'error' && (
          <div data-testid="export-error" style={{ background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: '10px 12px' }}>
            <p style={{ margin: '0 0 8px', fontSize: '0.85rem', color: P.mid }}>Couldn’t gather every harvest — nothing was copied.</p>
            <button type="button" onClick={load} style={{ padding: '8px 16px', minHeight: 48, borderRadius: 8, border: `1px solid ${P.border}`, background: P.white, color: P.green, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>Try again</button>
          </div>
        )}

        {/* The preview IS the readiness signal, and it is selectable/focusable so the manual
            select-and-copy fallback is real when the clipboard is blocked. */}
        <textarea
          data-testid="export-preview"
          aria-label="Export preview"
          readOnly
          value={text ?? ''}
          rows={12}
          style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem', lineHeight: 1.5, color: P.dark, background: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 10, resize: 'vertical' }}
        />

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onCopy}
            disabled={!canSend}
            style={{ flex: 1, minHeight: 48, borderRadius: 10, border: 'none', background: canSend ? P.green : P.border, color: P.white, fontSize: '0.9rem', fontWeight: 700, cursor: canSend ? 'pointer' : 'default' }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={onShare}
            disabled={!canSend}
            style={{ flex: 1, minHeight: 48, borderRadius: 10, border: `1px solid ${P.border}`, background: P.white, color: canSend ? P.green : P.light, fontSize: '0.9rem', fontWeight: 700, cursor: canSend ? 'pointer' : 'default' }}
          >
            Share
          </button>
        </div>

        {/* Ambient inline confirmation, never a celebration surface (design §5.4). 'shared' shows no
            "Copied" lie — the OS sheet may have gone anywhere, or nowhere. */}
        <p aria-live="polite" style={{ margin: 0, minHeight: 18, fontSize: '0.8rem', color: outcome === 'failed' ? P.mid : P.green }}>
          {empty ? 'No harvests match — nothing to export.'
            : outcome === 'copied' ? 'Copied'
            : outcome === 'shared' ? 'Shared'
            : outcome === 'failed' ? 'Couldn’t copy — select the text above'
            : ''}
        </p>
      </div>
    </Sheet>
  )
}
