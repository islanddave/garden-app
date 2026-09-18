// src/pages/MySeeds.jsx — V5-SEEDSTAB-001 §5.1. The My seeds view of the Seeds page: "What seed do I
// have?" over every packet and saved lot, one row each.
//
// Not a route — the Seeds shell mounts it, owns the fetch (useSeedItems) and hands the store down, so a
// stage moved in Saved seeds or a packet archived in Sow now shows here without a reload.
//
// WHY THIS VIEW EXISTS. Dave's seed lived in three places: the Seeds section of the Inventory list (327
// of 521 rows, no variety, stage, year or vendor on the row), Saved seeds (tracked lots only) and Sow
// now (a timing list, not an inventory). He asked for "inventory seeds" to have a proper home with the
// "standard robust filtering/sorting … appropriate to the entity type" (09-03); this is it, and the
// Inventory list now points here instead of listing seed.
//
// THE STEPPER moved here from the Inventory row, re-plumbed rather than moved as-is: the − / + with
// Undo runs lib/quantityAdjuster.js against this page's store, with both of its guards
// (BUG-INVPUTREORDER-001 response order, BUG-INVUNDOQTY-001 undo against the live row). It still
// writes the wide PUT until the narrow quantity route lands (slice 3), and strips the presence-guarded
// seed columns from the body, so a row read before a stage change elsewhere cannot re-assert the old
// stage or source with a 200.
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'
import { T } from '../components/forms/formStyles.js'
import { useToast } from '../context/ToastContext.jsx'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import Badge from '../components/forms/Badge.jsx'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import FilterChipRow from '../components/forms/FilterChipRow.jsx'
import FacetGroupHeader from '../components/forms/FacetGroupHeader.jsx'
import { useCropFacetOptions } from '../hooks/useCropFacetOptions.js'
import { useSources } from '../hooks/useSources.js'
import useScrollRestore from '../hooks/useScrollRestore.js'
import { looseIncludes } from '../lib/comboboxInput.js'
import { createQuantityAdjuster } from '../lib/quantityAdjuster.js'
import { labelCandidates } from '../components/seed/seedLots.js'
import {
  rowTitle, stateChips, howMuch, whereFrom, howOld, lineText, isSowedPreviously, ageOf,
  SORTS, sortRows, groupByCrop,
} from '../components/seed/mySeedsModel.js'
import { useLotOutline, outlineStyle } from '../components/seed/useLotOutline.js'
import { seedsHref, addPacketHref, seedsReturnState } from '../lib/seedsRoutes.js'
import { isInProcess } from '../lib/sowEngine.js'
// The list-row → wide-PUT strip lives with the other writer of list rows; the Seeds shell already
// loads that page, so this import adds nothing to the chunk.
import { listRowPutBody } from './SavedSeeds.jsx'

const MINE_HREF = seedsHref('mine')
const RETURN_HERE = seedsReturnState(MINE_HREF)
const cropSlugOf = (i) => i.crop_slug

// ── Filters survive the visit, not the history entry ────────────────────────────────────────────────
// sessionStorage per PAGE, never the URL: any post-mount replace write re-keys useScrollRestore's
// entry and deletes an armed sheet's Back marker (DismissRegistry.jsx:232-236). Search, crop chips and
// sort are always visible in the controls, so a remembered filter is never a hidden one.
const FILTER_KEY = 'seeds.mine.filters.v1'
const SORT_VALUES = new Set(SORTS.map((s) => s.value))

function readFilters() {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(FILTER_KEY) || 'null')
    return {
      q: typeof raw?.q === 'string' ? raw.q : '',
      crops: Array.isArray(raw?.crops) ? raw.crops.filter((c) => typeof c === 'string') : [],
      sort: SORT_VALUES.has(raw?.sort) ? raw.sort : 'name',
    }
  } catch {
    return { q: '', crops: [], sort: 'name' }
  }
}

function writeFilters(f) {
  try { window.sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch { /* private mode — the view still works */ }
}

export default function MySeeds({ store, highlight = null, onGoToLot }) {
  const { fetch } = useApiFetch()
  const { show, showUndo } = useToast()
  const items = store?.items ?? null
  const firstLoadError = items === null ? store?.error : null

  const [initial] = useState(readFilters)
  const [q, setQ] = useState(initial.q)
  const [crops, setCrops] = useState(() => new Set(initial.crops))
  const [sort, setSort] = useState(initial.sort)
  useEffect(() => { writeFilters({ q, crops: [...crops], sort }) }, [q, crops, sort])

  const { restoredState, saveState } = useScrollRestore({ id: 'seeds-mine', ready: items != null })
  const [expanded, setExpanded] = useState(() => restoredState?.expanded ?? null)
  const [sowedOpenByUser, setSowedOpenByUser] = useState(() => restoredState?.sowedOpen ?? null)
  useEffect(() => { saveState({ expanded, sowedOpen: sowedOpenByUser }) }, [expanded, sowedOpenByUser, saveState])

  // Vendor names come from the source registry; `source` is an order reference.
  const { sources } = useSources()
  const vendorOf = useMemo(() => {
    const byId = new Map((sources ?? []).map((s) => [String(s.id), s.name]))
    return (i) => (i?.source_id != null ? byId.get(String(i.source_id)) ?? '' : '')
  }, [sources])

  const rows = items ?? []
  const facet = useCropFacetOptions(rows, cropSlugOf)
  const cropLabel = useCallback((slug) => facet.labelBySlug.get(slug) || slug.replace(/_/g, ' '), [facet.labelBySlug])

  const filtered = useMemo(() => {
    const needle = q.trim()
    return rows.filter((i) => {
      if (crops.size && !crops.has(i.crop_slug)) return false
      if (!needle) return true
      return looseIncludes(rowTitle(i), needle) || looseIncludes(i.name, needle)
        || looseIncludes(i.variety_name, needle) || looseIncludes(vendorOf(i), needle)
    })
  }, [rows, q, crops, vendorOf])

  const main = useMemo(() => filtered.filter((i) => !isSowedPreviously(i)), [filtered])
  const sowed = useMemo(() => sortRows(filtered.filter(isSowedPreviously), 'name'), [filtered])
  const filterActive = !!q.trim() || crops.size > 0
  // An active search or chip opens Sowed previously when it holds a match — otherwise a packet that
  // IS here reads as "no seed matches". A choice the user made with the toggle wins.
  const sowedOpen = sowedOpenByUser ?? (filterActive && sowed.length > 0)

  // ── A write never lands out of sight (§4.3) ─────────────────────────────────────────────────────────
  // The shell names a row it just wrote (a save, an add). If the remembered filters would hide it,
  // they are cleared and the page says so; if it is under Sowed previously, that section opens.
  const [notice, setNotice] = useState(null)
  const handledRef = useRef(null)
  const target = highlight?.id != null ? rows.find((i) => String(i.id) === String(highlight.id)) ?? null : null
  useEffect(() => {
    if (!target) return
    const key = `${highlight.id}|${highlight.seq ?? 0}`
    if (handledRef.current === key) return
    handledRef.current = key
    const hidden = filtered.every((i) => i.id !== target.id)
    if (hidden) {
      setQ('')
      setCrops(new Set())
      setNotice(`Showing all · ${rowTitle(target)}`)
    }
    if (isSowedPreviously(target)) setSowedOpenByUser(true)
  }, [target, highlight?.seq])  // eslint-disable-line react-hooks/exhaustive-deps
  const outlined = useLotOutline(highlight, {
    ready: !!target && filtered.some((i) => i.id === target.id),
    skipArrival: restoredState !== undefined,
  })

  // ── The stepper ───────────────────────────────────────────────────────────────────────────────────
  const putSeqRef = useRef(new Map())
  const showToast = useCallback((t) => {
    if (!t) return
    if (t.onUndo) showUndo({ message: t.msg, onUndo: t.onUndo })
    else show({ message: t.msg, tone: 'error' })
  }, [show, showUndo])
  const adjust = useMemo(() => createQuantityAdjuster({
    fetch,
    getRow: store?.getRow ?? (() => null),
    commitRow: store?.patch ?? (() => {}),
    showToast,
    putSeq: putSeqRef.current,
    buildBody: (row, col, value) => ({ ...listRowPutBody(row), [col]: value }),
    // Keep the list-only projections (variety name, crop, stage age): the PUT answers bare columns.
    applyServerRow: (row, updated) => ({ ...row, ...(updated && typeof updated === 'object' ? updated : {}) }),
  }), [fetch, store?.getRow, store?.patch, showToast])

  // ── Uniqueness over what is actually on screen ────────────────────────────────────────────────────
  // Rows carry a stepper, so two rows that read alike would let a thumb write to the wrong lot. The
  // ordinal ("1 of 2 with identical details") is computed over the rendered title + line 2.
  const lineOf = useCallback((i) => lineText(i, { vendorOf }), [vendorOf])
  const onScreen = useMemo(() => [...main, ...(sowedOpen ? sowed : [])], [main, sowed, sowedOpen])
  const labels = useMemo(() => {
    const m = new Map()
    for (const r of labelCandidates(onScreen, lineOf, rowTitle)) m.set(r.item.id, r)
    return m
  }, [onScreen, lineOf])

  const toggleCrop = useCallback((v) => setCrops((prev) => {
    const next = new Set(prev)
    if (next.has(v)) next.delete(v); else next.add(v)
    return next
  }), [])
  const clearFilters = useCallback(() => { setQ(''); setCrops(new Set()) }, [])

  // What labelCandidates appended to this row's line to make it unique (an ordinal, or the id as the
  // last resort) — rendered after the facts, so the chips and facts stay in their own spans.
  const suffixOf = (i) => {
    const lab = labels.get(i.id)
    if (!lab) return ''
    return lab.detail.slice(lineOf(i).length).replace(/^ · /, '')
  }

  const renderRow = (i) => (
    <SeedRow
      key={i.id}
      item={i}
      title={labels.get(i.id)?.title ?? rowTitle(i)}
      suffix={suffixOf(i)}
      vendorOf={vendorOf}
      expanded={expanded === i.id}
      outlined={outlined === String(i.id)}
      onToggle={() => setExpanded((cur) => (cur === i.id ? null : i.id))}
      onAdjust={adjust}
      onGoToLot={onGoToLot}
    />
  )

  let body
  if (rows.length === 0) {
    body = (
      <div data-testid="my-seeds-empty" style={emptyCard}>
        <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark }}>No seed yet</p>
        <p style={{ margin: '0 0 14px', color: P.mid, fontSize: T.type.sm }}>
          Add the packets you have and they will be listed here, with what to sow when under Sow now.
        </p>
        <Link to={addPacketHref(MINE_HREF)} state={RETURN_HERE} style={primaryLink}>+ Add seeds</Link>
      </div>
    )
  } else if (filtered.length === 0) {
    body = (
      <div data-testid="my-seeds-no-match" style={emptyCard}>
        <p style={{ margin: '0 0 10px', color: P.mid }}>No seed matches.</p>
        <button type="button" onClick={clearFilters} style={textBtn}>Clear search</button>
      </div>
    )
  } else if (sort === 'name') {
    const groups = groupByCrop(sortRows(main, 'name'), cropLabel)
    body = groups.map((g) => (
      <section key={g.slug} data-testid="my-seeds-group" style={{ marginBottom: T.space.md }}>
        <div style={groupHeaderWrap}>
          <FacetGroupHeader label={g.label} count={g.rows.length} facet="type" value={g.slug} style={{ minHeight: T.tapMinHeight }} />
        </div>
        <div style={listStyle}>{g.rows.map(renderRow)}</div>
      </section>
    ))
  } else {
    const sorted = sortRows(main, sort)
    const known = sort === 'oldest' ? sorted.filter((i) => ageOf(i)) : sorted
    const unknown = sort === 'oldest' ? sorted.filter((i) => !ageOf(i)) : []
    body = (
      <>
        <div style={listStyle}>{known.map(renderRow)}</div>
        {unknown.length > 0 && (
          <>
            <div data-testid="my-seeds-date-unknown" style={dividerStyle}>Date unknown ({unknown.length})</div>
            <div style={listStyle}>{unknown.map(renderRow)}</div>
          </>
        )}
      </>
    )
  }

  return (
    <div data-testid="my-seeds-view">
      <AsyncRegion
        loading={items === null && !firstLoadError}
        error={firstLoadError}
        onRetry={store?.reload}
        errorTitle="Couldn't load your seed"
      >
        {rows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: T.space.sm, marginBottom: T.space.md }}>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${rows.length} packets and lots…`}
              aria-label="Search your seed by variety, lot name or vendor"
              data-testid="my-seeds-search"
              style={searchStyle}
            />
            {rows.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: T.type.xs2, color: P.mid, flexShrink: 0 }}>Sort</span>
                <SegmentedControl
                  small
                  options={SORTS}
                  value={sort}
                  onChange={setSort}
                  ariaLabel="Sort your seed by name, oldest seed or newest added"
                  data-testid="my-seeds-sort"
                />
              </div>
            )}
            {facet.options.length > 1 && (
              <FilterChipRow
                options={facet.options}
                selected={crops}
                pinned={facet.pinned}
                trayMaxHeight={180}
                onToggle={toggleCrop}
                onClear={() => setCrops(new Set())}
                aria-label="Filter your seed by crop"
                data-testid="my-seeds-crop-filter"
              />
            )}
          </div>
        )}
        {notice && (
          <p data-testid="my-seeds-notice" role="status" style={{ margin: '0 0 10px', color: P.mid, fontSize: T.type.sm }}>
            {notice}
          </p>
        )}
        {rows.length > 0 && main.length === 0 && sowed.length > 0 && !filterActive && (
          <p data-testid="my-seeds-all-sowed" style={{ margin: '0 0 10px', color: P.mid, fontSize: T.type.sm }}>
            None left of any of it — every packet is under Sowed previously below.
          </p>
        )}
        {body}
        {sowed.length > 0 && (
          <section data-testid="my-seeds-sowed" style={{ marginTop: T.space.md }}>
            <button
              type="button"
              aria-expanded={sowedOpen}
              onClick={() => setSowedOpenByUser(!sowedOpen)}
              style={disclosureBtn}
            >
              <span aria-hidden="true" style={{ fontSize: '0.8rem' }}>{sowedOpen ? '▾' : '▸'}</span>
              Sowed previously
              <span style={countPill}>{sowed.length}</span>
            </button>
            {sowedOpen && (
              <>
                <p style={{ margin: '0 0 8px', color: P.mid, fontSize: T.type.xs2 }}>
                  None of these left. Kept so you can see what you have grown.
                </p>
                <div style={listStyle}>{sowed.map(renderRow)}</div>
              </>
            )}
          </section>
        )}
      </AsyncRegion>
    </div>
  )
}

// One packet or lot. Tap expands in place, as Inventory rows did.
function SeedRow({ item, title, suffix, vendorOf, expanded, outlined, onToggle, onAdjust, onGoToLot }) {
  const chips = stateChips(item)
  const facts = [howMuch(item), whereFrom(item, vendorOf), howOld(item)].filter(Boolean).join(' · ')
  const inProcess = isInProcess(item)
  const qty = Number(item.quantity_on_hand ?? 0)
  const unit = item.unit || 'packet'

  return (
    <div
      data-testid="my-seed-row"
      data-lot-id={item.id}
      data-outlined={outlined ? 'true' : undefined}
      style={{ ...rowCard, ...(outlined ? outlineStyle(P.green) : null) }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${title} — ${expanded ? 'collapse' : 'expand'}`}
        style={rowBtn}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={titleStyle}>{title}</span>
          <span data-testid="my-seed-line" style={lineStyle}>
            {chips.map((c) => (
              <Badge key={c.key} tone={c.tone} data-testid="my-seed-chip" style={{ flexShrink: 0, fontSize: T.type.xs }}>
                {c.label}
              </Badge>
            ))}
            <span style={factsStyle}>{[facts, suffix].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
        <span aria-hidden="true" style={{ color: P.light, fontSize: T.type.xs2, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div data-testid="my-seed-expanded" style={expandedStyle}>
          {item.type !== 'durable' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: T.type.sm, color: P.mid, flexShrink: 0 }}>On hand</span>
              <button type="button" onClick={() => onAdjust(item.id, -1)} style={qtyBtn} aria-label={`One fewer ${unit} of ${title}`}>−</button>
              <span data-testid="my-seed-qty" style={{ fontWeight: 700, minWidth: T.tapMinHeight, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                {Number.isFinite(qty) ? Math.round(qty) : 0}
                <span style={{ fontWeight: 400, fontSize: T.type.xs2, color: P.mid }}> {unit}</span>
              </span>
              <button type="button" onClick={() => onAdjust(item.id, +1)} style={qtyBtn} aria-label={`One more ${unit} of ${title}`}>+</button>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {inProcess && onGoToLot && (
              <button type="button" onClick={() => onGoToLot(item.id)} data-testid="my-seed-change-stage" style={secondaryBtn}>
                Change stage in Saved seeds →
              </button>
            )}
            <Link to={`/inventory/${item.id}`} state={RETURN_HERE} data-testid="my-seed-details" style={secondaryLink}>
              Open details →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Styles — from T tokens, matching the Saved seeds card (48px buttons, 44px taps) ──────────────────
const listStyle = { display: 'flex', flexDirection: 'column', gap: 8 }
const rowCard = {
  backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusCard, overflow: 'hidden',
}
const rowBtn = {
  width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
  padding: '10px 12px', minHeight: 56, display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit',
}
const titleStyle = {
  fontWeight: 600, color: P.dark, fontSize: T.type.md, lineHeight: 1.25,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}
const lineStyle = {
  display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: T.type.xs2, color: P.mid,
  whiteSpace: 'nowrap', overflow: 'hidden',
}
const factsStyle = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const expandedStyle = {
  padding: '10px 12px 12px', borderTop: `1px solid ${P.border}`, display: 'flex', flexDirection: 'column', gap: 10,
}
const qtyBtn = {
  width: T.tapMinHeight, height: T.tapMinHeight, borderRadius: T.radiusButton, border: `1px solid ${P.border}`,
  backgroundColor: P.cream, color: P.dark, cursor: 'pointer', fontSize: '1.2rem', fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0,
}
const secondaryBtn = {
  minHeight: T.tapMinHeight, padding: '0 12px', borderRadius: T.radiusButton, border: `1px solid ${P.green}`,
  background: P.white, color: P.green, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit',
}
const secondaryLink = {
  ...secondaryBtn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none',
}
const searchStyle = {
  display: 'block', width: '100%', minHeight: T.buttonMinHeight, padding: '0 12px', boxSizing: 'border-box',
  borderRadius: T.radiusButton, border: `1px solid ${P.border}`, fontSize: '1rem', backgroundColor: P.white,
}
const groupHeaderWrap = {
  position: 'sticky', top: 52, zIndex: 1, backgroundColor: P.cream, paddingBottom: 6,
}
const dividerStyle = {
  margin: '14px 0 8px', fontSize: T.type.xs2, fontWeight: 700, color: P.mid, letterSpacing: '0.04em',
  textTransform: 'uppercase',
}
const disclosureBtn = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center',
  gap: 8, fontSize: T.type.sm, fontWeight: 700, color: P.mid, minHeight: T.tapMinHeight, fontFamily: 'inherit',
}
const countPill = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, padding: '1px 7px',
  borderRadius: 999, backgroundColor: P.greenPale, color: P.green, fontSize: T.type.xs, fontWeight: 700,
}
const emptyCard = {
  backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusCard, padding: '18px 16px',
}
const primaryLink = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, padding: '0 16px',
  borderRadius: T.radiusButton, backgroundColor: P.green, color: P.white, fontWeight: 700, textDecoration: 'none',
}
const textBtn = {
  background: 'none', border: 'none', color: P.green, fontWeight: 600, cursor: 'pointer',
  minHeight: T.tapMinHeight, padding: 0, fontFamily: 'inherit', fontSize: T.type.sm,
}
