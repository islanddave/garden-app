// src/pages/MySeeds.jsx — V5-SEEDSTAB-001 §5.1, redesigned by V5-SEEDCARDS-001. The My seeds view
// of the Seeds page: "What seed do I have?" over every packet and saved lot, one card each.
//
// Not a route — the Seeds shell mounts it, owns the fetch (useSeedItems) and hands the store down, so a
// stage moved in Saved seeds or a packet archived in Sow now shows here without a reload.
//
// WHY THIS VIEW EXISTS. Dave's seed lived in three places: the Seeds section of the Inventory list (327
// of 521 rows, no variety, stage, year or vendor on the row), Saved seeds (tracked lots only) and Sow
// now (a timing list, not an inventory). He asked for "inventory seeds" to have a proper home with the
// "standard robust filtering/sorting … appropriate to the entity type" (09-03); this is it.
//
// V5-SEEDCARDS-001 (Dave, 2026-09-19): "make each type collapsible and collapsed by default. Make the
// brand/supplier … a featured callout / chip / improved color of each card … each seed to include a
// seed packet img … The 'on hand' item in the details of each seed is not needed … add the ability to
// filter by supplier, and for peppers, to sort them by expected SHU". Design: the UX spec and the
// architecture plan in Projects/Gardening/_seedpacket_20260919/design/ (ux-spec.md, arch-plan.md).
//   • Crop groups FOLD and start folded. A filter opens every group that still has rows; the Hottest
//     sort opens Pepper; a write opens the group it landed in (a write never lands out of sight).
//   • Each card leads with its supplier: a 4px stripe and a pill in the supplier's designated colours
//     (src/lib/supplierPalette.js), and a 40px packet thumbnail (the app's row-thumb shape).
//   • Supplier chips filter; Hottest orders peppers by expected Scoville inside the Pepper group.
//   • The expanded card lost its "On hand − N +" stepper and gained the seed's facts (heat, country of
//     origin, species, days to maturity) and a link to the packet's page. A packet's count is still
//     edited on its detail page ("Qty on hand"); the Inventory page keeps its own stepper.
import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { P, BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'
import { T, selectChrome } from '../components/forms/formStyles.js'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import Badge from '../components/forms/Badge.jsx'
import FilterChipRow from '../components/forms/FilterChipRow.jsx'
import FacetGroupHeader from '../components/forms/FacetGroupHeader.jsx'
import Icon from '../components/Icon.jsx'
import PhotoView from '../components/photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'
import SupplierChip from '../components/seed/SupplierChip.jsx'
import { lotPhoto } from '../components/seed/lotPhoto.js'
import { supplierColors, NO_SUPPLIER } from '../lib/supplierPalette.js'
import { useCropFacetOptions } from '../hooks/useCropFacetOptions.js'
import { useSources } from '../hooks/useSources.js'
import useScrollRestore from '../hooks/useScrollRestore.js'
import { IMAGE_WINDOW_PAGE } from '../hooks/useImageWindow.js'
import useNearViewport from '../hooks/useNearViewport.js'
import { looseIncludes } from '../lib/comboboxInput.js'
import { labelCandidates, isSavedLot } from '../components/seed/seedLots.js'
import {
  rowTitle, stateChips, howMuch, originNote, howOld, lineText, isSowedPreviously, ageOf,
  heatOf, heatLabel, SORTS, sortRows, groupByCrop, NO_CROP, supplierOptions,
  matchesSuppliers, isFilterActive, groupIsOpen, NO_SUPPLIER_VALUE,
} from '../components/seed/mySeedsModel.js'
import { seedFacts } from '../components/seed/seedFacts.js'
import { useLotOutline, outlineStyle } from '../components/seed/useLotOutline.js'
import { seedsHref, addPacketHref, seedsReturnState } from '../lib/seedsRoutes.js'
import { isInProcess } from '../lib/sowEngine.js'

const MINE_HREF = seedsHref('mine')
const RETURN_HERE = seedsReturnState(MINE_HREF)
const cropSlugOf = (i) => i.crop_slug
const lotIdOf = (el) => el.getAttribute('data-lot-id')
const GROUPED_SORTS = new Set(['name', 'heat'])
// The sticky offset: headers of OPEN groups stick under the 52px top bar (TopChrome BAR_H).
const STICKY_TOP = 52
// How much of a just-opened group's SECOND row has to show above the bottom nav: the card's top edge
// (1px border, 6px padding) and its title line down past the baseline — enough to read which packet
// comes next, so the tap visibly opened a list. A thinner sliver reads as a stray border; asking for
// the whole 54-58px row is what scrolled the tapped header out from under the thumb.
const OPEN_PEEK_PX = 24

// ── The view's shape survives the visit, not the history entry ───────────────────────────────────────
// sessionStorage per PAGE, never the URL: any post-mount replace write re-keys useScrollRestore's
// entry and deletes an armed sheet's Back marker (DismissRegistry.jsx:232-236). Search, crop and
// supplier chips and sort are always visible in the controls, so a remembered filter is never a hidden
// one. The groups a user OPENED ride the same blob (one lifetime for the whole view's shape; a fresh
// launch starts collapsed). `.v1` is kept: the reader is field-tolerant both ways.
const FILTER_KEY = 'seeds.mine.filters.v1'
const SORT_VALUES = new Set(SORTS.map((s) => s.value))
const strings = (a) => (Array.isArray(a) ? a.filter((c) => typeof c === 'string') : [])

function readFilters() {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(FILTER_KEY) || 'null')
    return {
      q: typeof raw?.q === 'string' ? raw.q : '',
      crops: strings(raw?.crops),
      suppliers: strings(raw?.suppliers),
      sort: SORT_VALUES.has(raw?.sort) ? raw.sort : 'name',
      openGroups: strings(raw?.openGroups),
    }
  } catch {
    return { q: '', crops: [], suppliers: [], sort: 'name', openGroups: [] }
  }
}

function writeFilters(f) {
  try { window.sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch { /* private mode — the view still works */ }
}

const withAdded = (set, v) => (set.has(v) ? set : new Set(set).add(v))
const withRemoved = (set, v) => { if (!set.has(v)) return set; const n = new Set(set); n.delete(v); return n }

function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export default function MySeeds({ store, highlight = null, onGoToLot }) {
  const items = store?.items ?? null
  const firstLoadError = items === null ? store?.error : null

  const [initial] = useState(readFilters)
  const [q, setQ] = useState(initial.q)
  const [crops, setCrops] = useState(() => new Set(initial.crops))
  const [suppliers, setSuppliers] = useState(() => new Set(initial.suppliers))
  const [sort, setSort] = useState(initial.sort)
  const [openGroups, setOpenGroups] = useState(() => new Set(initial.openGroups))
  useEffect(() => {
    writeFilters({ q, crops: [...crops], suppliers: [...suppliers], sort, openGroups: [...openGroups] })
  }, [q, crops, suppliers, sort, openGroups])

  const { restoredState, saveState } = useScrollRestore({ id: 'seeds-mine', ready: items != null })
  const [expanded, setExpanded] = useState(() => restoredState?.expanded ?? null)
  const [sowedOpenByUser, setSowedOpenByUser] = useState(() => restoredState?.sowedOpen ?? null)
  // Explicit closes of groups a RULE had opened (a filter, Hottest). Per history entry, and cleared
  // whenever the filter signature changes — a stale close would otherwise hide the matches of a new
  // search behind a folded header.
  const [closedByUser, setClosedByUser] = useState(() => new Set(strings(restoredState?.closedByUser)))
  useEffect(() => {
    saveState({ expanded, sowedOpen: sowedOpenByUser, closedByUser: [...closedByUser] })
  }, [expanded, sowedOpenByUser, closedByUser, saveState])
  const signature = `${q.trim()}|${[...crops].sort()}|${[...suppliers].sort()}|${sort}`
  const signatureRef = useRef(signature)
  useEffect(() => {
    if (signatureRef.current === signature) return
    signatureRef.current = signature
    setClosedByUser((prev) => (prev.size ? new Set() : prev))
  }, [signature])

  // Vendor names come from the source registry; `source` is an order reference.
  const { sources, loading: sourcesLoading } = useSources()
  const vendorOf = useMemo(() => {
    const byId = new Map((sources ?? []).map((s) => [String(s.id), s.name]))
    return (i) => (i?.source_id != null ? byId.get(String(i.source_id)) ?? '' : '')
  }, [sources])

  const rows = items ?? []
  const facet = useCropFacetOptions(rows, cropSlugOf)
  const cropLabel = useCallback((slug) => facet.labelBySlug.get(slug) || slug.replace(/_/g, ' '), [facet.labelBySlug])

  // Supplier options from the PRE-filter rows, so the row does not shrink to what is already chosen.
  // Shown only when the WHOLE list holds at least two supplier values (a chip that cannot change the
  // answer is hidden) — computed on all rows, not the filtered view, or the row would jump in and out
  // under the thumb as other filters change.
  const supplierOpts = useMemo(() => supplierOptions(rows, vendorOf).map((o) => ({
    ...o, leading: <SupplierSwatch name={o.name} />,
  })), [rows, vendorOf])
  const supplierPinned = useMemo(() => supplierOpts.slice(0, 2).map((o) => o.value), [supplierOpts])

  // A remembered chip for a crop or supplier that no longer exists would filter to "No seed matches"
  // with no chip on screen to un-tap. Pruned once the rows (and, for suppliers, the registry) are in.
  useEffect(() => {
    if (items == null) return
    const cropValues = new Set(facet.options.map((o) => o.value))
    setCrops((prev) => { const keep = [...prev].filter((c) => cropValues.has(c)); return keep.length === prev.size ? prev : new Set(keep) })
    if (sourcesLoading) return
    const supplierValues = new Set(supplierOpts.map((o) => o.value))
    setSuppliers((prev) => { const keep = [...prev].filter((s) => supplierValues.has(s)); return keep.length === prev.size ? prev : new Set(keep) })
  }, [items, facet.options, supplierOpts, sourcesLoading])

  // Hottest is offered only when at least two rows of the whole list carry a heat figure. A remembered
  // Hottest with no data shows Name, without overwriting the preference.
  const heatOffered = useMemo(() => rows.filter((i) => heatOf(i)).length >= 2, [rows])
  const effectiveSort = sort === 'heat' && !heatOffered ? 'name' : sort
  const grouped = GROUPED_SORTS.has(effectiveSort)

  const needle = q.trim()
  const filtered = useMemo(() => rows.filter((i) => {
    if (crops.size && !crops.has(i.crop_slug)) return false
    if (!matchesSuppliers(i, suppliers, vendorOf)) return false
    if (!needle) return true
    const vendor = vendorOf(i)
    return looseIncludes(rowTitle(i), needle) || looseIncludes(i.name, needle)
      || looseIncludes(i.variety_name, needle) || looseIncludes(vendor, needle)
  }), [rows, crops, suppliers, needle, vendorOf])

  const main = useMemo(() => filtered.filter((i) => !isSowedPreviously(i)), [filtered])
  const sowed = useMemo(() => sortRows(filtered.filter(isSowedPreviously), 'name'), [filtered])
  const filterActive = isFilterActive({ q, crops, suppliers })
  // Sowed previously opens for a search/chip that finds something there, and when EVERY packet is used
  // up (§5.1: "everything sowed previously (section opened)"). A choice made with its toggle wins.
  const sowedOpen = sowedOpenByUser ?? ((filterActive || main.length === 0) && sowed.length > 0)

  const groups = useMemo(() => (grouped
    ? groupByCrop(sortRows(main, effectiveSort), cropLabel, { pinned: facet.pinned, leadSlug: effectiveSort === 'heat' ? 'pepper' : null })
    : []), [grouped, main, effectiveSort, cropLabel, facet.pinned])
  const isOpen = useCallback(
    (slug) => groupIsOpen(slug, { openGroups, closedByUser, filterActive, sort: effectiveSort }),
    [openGroups, closedByUser, filterActive, effectiveSort],
  )

  // ── A write never lands out of sight (§4.3) ─────────────────────────────────────────────────────────
  // The shell names a row it just wrote (a save, an add). Only the filters that EXCLUDE it are cleared,
  // and the page says which; its crop group is opened (or Sowed previously, where it is filed there).
  const [notice, setNotice] = useState(null)
  const handledRef = useRef(null)
  const target = highlight?.id != null ? rows.find((i) => String(i.id) === String(highlight.id)) ?? null : null
  useEffect(() => {
    if (!target) return
    const key = `${highlight.id}|${highlight.seq ?? 0}`
    if (handledRef.current === key) return
    handledRef.current = key
    const title = rowTitle(target)
    const hiddenByCrop = crops.size > 0 && !crops.has(target.crop_slug)
    const hiddenBySupplier = !matchesSuppliers(target, suppliers, vendorOf)
    const vendor = vendorOf(target)
    const hiddenBySearch = !!needle && !(looseIncludes(title, needle) || looseIncludes(target.name, needle)
      || looseIncludes(target.variety_name, needle) || looseIncludes(vendor, needle))
    if (hiddenByCrop) setCrops(new Set())
    if (hiddenBySupplier) setSuppliers(new Set())
    if (hiddenBySearch) setQ('')
    if (hiddenByCrop || hiddenBySupplier || hiddenBySearch) {
      const onlySupplier = hiddenBySupplier && !hiddenByCrop && !hiddenBySearch
      setNotice(`${onlySupplier ? 'Showing all suppliers' : 'Showing all'} · ${title}`)
    }
    if (isSowedPreviously(target)) {
      setSowedOpenByUser(true)
    } else {
      const slug = target.crop_slug || NO_CROP
      setOpenGroups((prev) => withAdded(prev, slug))
      setClosedByUser((prev) => withRemoved(prev, slug))
    }
  }, [target, highlight?.seq])  // eslint-disable-line react-hooks/exhaustive-deps
  // The outline fires once per write, so it must wait until the row is RENDERED — not merely past the
  // filters. Into a folded group it would be spent on a row that is not in the DOM.
  const targetRendered = !!target && filtered.some((i) => i.id === target.id) && (
    isSowedPreviously(target) ? sowedOpen : (!grouped || isOpen(target.crop_slug || NO_CROP))
  )
  const outlined = useLotOutline(highlight, { ready: targetRendered, skipArrival: restoredState !== undefined })

  // ── What is on screen, in order: the rows that render, for uniqueness and the image window ──────────
  const onScreen = useMemo(() => {
    const out = []
    if (grouped) {
      for (const g of groups) if (isOpen(g.slug)) out.push(...g.rows)
    } else {
      out.push(...sortRows(main, effectiveSort))
    }
    if (sowedOpen) out.push(...sowed)
    return out
  }, [grouped, groups, isOpen, main, effectiveSort, sowedOpen, sowed])

  // Images are windowed, rows are not: search, counts, the outline and Back-restore all need every row
  // in the DOM, but 103 peppers mounting 103 thumbnails at once is the eager-image freeze
  // (BUG-PHOTOTHUMB-001). A row's thumbnail mounts when it is one of the first IMAGE_WINDOW_PAGE rows on
  // screen, or once the row comes within reach of the viewport, and then stays (useNearViewport). Not
  // useImageWindow: its growth waits for the DOCUMENT's bottom, and this page never grows — every row is
  // a fixed box — so rows 25+ of an open group stayed grey while scrolled through, then all mounted at
  // once near the bottom. Rows waiting keep their reserved box. A filter or fold change starts over.
  const viewRef = useRef(null)
  const inReach = useNearViewport(viewRef, {
    selector: '[data-testid="my-seed-row"]', keyOf: lotIdOf,
    resetKey: `${signature}|${[...openGroups].sort()}|${[...closedByUser].sort()}|${sowedOpen}`,
  })
  const imageRank = useMemo(() => {
    const m = new Map()
    onScreen.forEach((i, n) => m.set(i.id, n))
    return m
  }, [onScreen])

  // ── Uniqueness over what is actually on screen ────────────────────────────────────────────────────
  // Two rows that read alike would let a thumb open the wrong lot's details; the ordinal ("1 of 2
  // identical") is computed over the rendered title + line 2. Identical rows share a variety and so a
  // crop group, so they are shown or folded together.
  const lineOf = useCallback((i) => lineText(i, { vendorOf }), [vendorOf])
  const labels = useMemo(() => {
    const m = new Map()
    for (const r of labelCandidates(onScreen, lineOf, rowTitle)) m.set(r.item.id, r)
    return m
  }, [onScreen, lineOf])
  const ordinalOf = (i) => {
    const lab = labels.get(i.id)
    if (!lab) return ''
    const suffix = lab.detail.slice(lineOf(i).length).replace(/^ · /, '')
    return suffix.replace(' with identical details', ' identical')
  }

  const toggleCrop = useCallback((v) => setCrops((prev) => (prev.has(v) ? withRemoved(prev, v) : withAdded(prev, v))), [])
  const toggleSupplier = useCallback((v) => setSuppliers((prev) => (prev.has(v) ? withRemoved(prev, v) : withAdded(prev, v))), [])
  const clearFilters = useCallback(() => { setQ(''); setCrops(new Set()); setSuppliers(new Set()) }, [])

  // ── Folding ────────────────────────────────────────────────────────────────────────────────────────
  // Folding a group from its STUCK header re-anchors, so the header the thumb just tapped stays at the
  // top instead of the page stranding thousands of pixels down in unrelated groups. Opening one keeps
  // the header still (UX spec §3.3): the page scrolls only when the group's first row would be cut by
  // the bottom nav or less than OPEN_PEEK_PX of its second row would show, and then by the least
  // distance that shows both. The old rule wanted row 2 WHOLE, 8px clear of the nav — on a 360x640
  // first screen that moved the header a thumb had just tapped by 24px (gate:seeds-page (e2)).
  const anchorRef = useRef(null)
  const toggleGroup = useCallback((slug) => {
    const open = isOpen(slug)
    const el = typeof document !== 'undefined' ? document.querySelector(`[data-group-slug="${slug}"]`) : null
    anchorRef.current = el ? { slug, opening: !open } : null
    if (open) {
      setOpenGroups((prev) => withRemoved(prev, slug))
      setClosedByUser((prev) => withAdded(prev, slug))
    } else {
      setOpenGroups((prev) => withAdded(prev, slug))
      setClosedByUser((prev) => withRemoved(prev, slug))
    }
  }, [isOpen])
  useLayoutEffect(() => {
    const a = anchorRef.current
    if (!a) return
    anchorRef.current = null
    const el = document.querySelector(`[data-group-slug="${a.slug}"]`)
    if (!el || typeof el.getBoundingClientRect !== 'function') return
    const rect = el.getBoundingClientRect()
    // No layout (jsdom, a hidden tab): nothing is on screen to keep in place.
    if (!rect.height) return
    const top = rect.top
    if (!a.opening) {
      if (top < STICKY_TOP) window.scrollBy?.(0, top - STICKY_TOP)
      return
    }
    const [first, second] = el.querySelectorAll('[data-testid="my-seed-row"]')
    if (!first) return
    const bandBottom = window.innerHeight - BOTTOM_NAV_HEIGHT_PX
    const need = Math.max(
      first.getBoundingClientRect().bottom - bandBottom,
      second ? second.getBoundingClientRect().top + OPEN_PEEK_PX - bandBottom : 0,
    )
    if (need > 0) window.scrollBy?.({ top: need, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  })

  const sectionSlugs = grouped ? groups.map((g) => g.slug) : []
  const sectionCount = sectionSlugs.length + (sowed.length > 0 ? 1 : 0)
  const allOpen = sectionSlugs.every(isOpen) && (sowed.length === 0 || sowedOpen)
  const showExpandAll = grouped && sectionCount >= 2 && rows.length > 0
  const expandAll = () => {
    if (allOpen) {
      setOpenGroups(new Set())
      setClosedByUser(new Set(sectionSlugs))
      setSowedOpenByUser(false)
    } else {
      setOpenGroups((prev) => new Set([...prev, ...sectionSlugs]))
      setClosedByUser(new Set())
      if (sowed.length > 0) setSowedOpenByUser(true)
    }
  }

  const renderRow = (i) => (
    <SeedRow
      key={i.id}
      item={i}
      title={labels.get(i.id)?.title ?? rowTitle(i)}
      ordinal={ordinalOf(i)}
      vendor={vendorOf(i)}
      withPhoto={(imageRank.get(i.id) ?? Infinity) < IMAGE_WINDOW_PAGE || inReach.has(String(i.id))}
      expanded={expanded === i.id}
      outlined={outlined === String(i.id)}
      onToggle={() => setExpanded((cur) => (cur === i.id ? null : i.id))}
      onGoToLot={onGoToLot}
    />
  )

  const noPepperOnScreen = effectiveSort === 'heat' && !main.some((i) => i.crop_slug === 'pepper')

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
    const what = [
      needle ? `“${needle}”` : '',
      ...[...crops].map(cropLabel),
      ...[...suppliers].map((s) => (s === NO_SUPPLIER_VALUE ? 'No supplier' : supplierOpts.find((o) => o.value === s)?.label ?? s)),
    ].filter(Boolean).join(' · ')
    body = (
      <div data-testid="my-seeds-no-match" style={emptyCard}>
        <p style={{ margin: '0 0 10px', color: P.mid }}>No seed matches{what ? ` ${what}` : ''}.</p>
        <button type="button" onClick={clearFilters} style={textBtn}>Clear filters</button>
      </div>
    )
  } else if (grouped) {
    body = groups.map((g) => {
      const open = isOpen(g.slug)
      const heatSorted = effectiveSort === 'heat' && g.slug === 'pepper'
      const known = heatSorted ? g.rows.filter((i) => heatOf(i)) : g.rows
      const unknown = heatSorted ? g.rows.filter((i) => !heatOf(i)) : []
      return (
        <section key={g.slug} data-testid="my-seeds-group" data-group-slug={g.slug} style={{ marginBottom: 6 }}>
          <div style={open ? groupHeaderSticky : undefined}>
            <FacetGroupHeader
              label={heatSorted ? `${g.label} · hottest first` : g.label}
              count={g.rows.length}
              facet="type"
              value={g.slug}
              collapsed={!open}
              onToggle={() => toggleGroup(g.slug)}
              style={groupHeaderStyle}
            />
          </div>
          {open && (
            <div data-testid="my-seeds-group-rows" style={{ ...listStyle, marginTop: 6 }}>
              {known.map(renderRow)}
              {unknown.length > 0 && (
                <>
                  <div data-testid="my-seeds-heat-unknown" style={dividerStyle}>Heat unknown ({unknown.length})</div>
                  {unknown.map(renderRow)}
                </>
              )}
            </div>
          )}
        </section>
      )
    })
  } else {
    const sorted = sortRows(main, effectiveSort)
    const known = effectiveSort === 'oldest' ? sorted.filter((i) => ageOf(i)) : sorted
    const unknown = effectiveSort === 'oldest' ? sorted.filter((i) => !ageOf(i)) : []
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

  const sortOptions = SORTS.filter((s) => s.value !== 'heat' || heatOffered)

  return (
    <div data-testid="my-seeds-view" ref={viewRef}>
      {/* The view's question, with Expand all / Collapse all on the same line (UX spec §3.4) — the
          Garden pattern Dave approved for collapsed-by-default sections, at a 44px tap floor. */}
      <div style={questionRow}>
        <p data-testid="seeds-question" style={questionStyle}>What seed do I have?</p>
        {showExpandAll && (
          <button type="button" onClick={expandAll} data-testid="my-seeds-expand-all" style={expandAllBtn}>
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      <AsyncRegion
        loading={items === null && !firstLoadError}
        error={firstLoadError}
        onRetry={store?.reload}
        errorTitle="Couldn't load your seed"
      >
        {/* THREE control lines: search + sort, the crop chips, the supplier chips. The sort is a native
            select, as Inventory's own Sort is — segments cannot share a 328px line with a search box. */}
        {rows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${rows.length} seeds…`}
                aria-label="Search your seed by variety, lot name or supplier"
                data-testid="my-seeds-search"
                style={searchStyle}
              />
              {rows.length > 1 && (
                <label style={sortLabel}>
                  <span aria-hidden="true">Sort</span>
                  <select
                    value={effectiveSort}
                    onChange={(e) => setSort(e.target.value)}
                    aria-label={heatOffered
                      ? 'Sort your seed by name, oldest seed, newest added or hottest pepper'
                      : 'Sort your seed by name, oldest seed or newest added'}
                    data-testid="my-seeds-sort"
                    style={sortSelect}
                  >
                    {sortOptions.map((s) => <option key={s.value} value={s.value}>{s.value === 'heat' ? 'Hottest' : s.label}</option>)}
                  </select>
                </label>
              )}
            </div>
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
            {supplierOpts.length > 1 && (
              <FilterChipRow
                options={supplierOpts}
                selected={suppliers}
                pinned={supplierPinned}
                trayMaxHeight={180}
                onToggle={toggleSupplier}
                onClear={() => setSuppliers(new Set())}
                aria-label="Filter your seed by supplier"
                data-testid="my-seeds-supplier-filter"
              />
            )}
          </div>
        )}
        {notice && (
          <p data-testid="my-seeds-notice" role="status" style={{ margin: '0 0 10px', color: P.mid, fontSize: T.type.sm }}>
            {notice}
          </p>
        )}
        {noPepperOnScreen && filtered.length > 0 && (
          <p data-testid="my-seeds-no-pepper" style={{ margin: '0 0 10px', color: P.mid, fontSize: T.type.sm }}>
            No peppers here — Hottest orders peppers only.
          </p>
        )}
        {rows.length > 0 && main.length === 0 && sowed.length > 0 && !filterActive && (
          <p data-testid="my-seeds-all-sowed" style={{ margin: '0 0 10px', color: P.mid, fontSize: T.type.sm }}>
            None left of any of it — every packet is under Sowed previously below.
          </p>
        )}
        {body}
        {sowed.length > 0 && (
          <section data-testid="my-seeds-sowed" data-group-slug="__sowed__" style={{ marginTop: T.space.md }}>
            <FacetGroupHeader
              label="Sowed previously"
              count={sowed.length}
              isUnsorted
              collapsed={!sowedOpen}
              onToggle={() => setSowedOpenByUser(!sowedOpen)}
              style={groupHeaderStyle}
            />
            {sowedOpen && (
              <>
                <p style={{ margin: '6px 0 8px', color: P.mid, fontSize: T.type.xs2 }}>
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

// The supplier filter chip's swatch: the supplier's fill ringed in its secondary, so the chip doubles
// as the legend for the stripes on the cards. "No supplier" is hollow with a dashed ring.
function SupplierSwatch({ name }) {
  const c = name ? (supplierColors(name) ?? NO_SUPPLIER) : NO_SUPPLIER
  const none = !name
  return (
    <span
      aria-hidden="true"
      data-testid="supplier-swatch"
      style={{
        display: 'inline-block', width: 12, height: 12, borderRadius: '50%', flex: '0 0 auto',
        backgroundColor: none ? P.white : c.primary,
        boxShadow: none ? 'none' : `0 0 0 2px ${c.secondary}`,
        border: none ? `1.5px dashed ${P.light}` : 'none',
      }}
    />
  )
}

// A saved lot's heat is always an estimate: home-saved pepper seed crosses readily, and seed from an F1
// parent segregates. The cultivar's range is what it SHOULD be, not what this jar will do.
function rowHeat(item) {
  const label = heatLabel(item)
  if (!label) return ''
  if (isSavedLot(item) && !label.startsWith('est.')) return `est. ${label}`
  return label
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// One packet or lot. Tap expands in place, as Inventory rows did.
function SeedRow({ item, title, ordinal, vendor, withPhoto, expanded, outlined, onToggle, onGoToLot }) {
  const chips = stateChips(item)
  // Line 2, in order: the supplier chip, the state chips, the amount ("1 packet" is not printed), the
  // heat, then the tail — origin words and how old. What gives way first on a crowded line is set by
  // the styles below (giveWayBox), not by this order. The FIRST chip is a lot's live state when its
  // tone says so (fermenting, drying) and never gives way; every later chip is neutral bookkeeping.
  const live = chips[0] && chips[0].tone !== 'neutral' ? chips[0] : null
  const neutral = live ? chips.slice(1) : chips
  const amount = howMuch(item)
  const heat = rowHeat(item)
  const tail = [originNote(item), howOld(item)].filter(Boolean).join(' · ')
  // A chip anywhere on the line makes it one chip tall; a line with nothing to print stays empty.
  const chipTall = !!vendor || chips.length > 0
  const hasLine = chipTall || !!(amount || heat || tail)
  const inProcess = isInProcess(item)
  const colors = vendor ? supplierColors(vendor) : null
  const photo = useMemo(
    () => lotPhoto(item),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id, item.hero_photo_id, item.featured_photo_view_url, item.featured_photo_thumb_url],
  )
  const sep = (has) => (has ? ' · ' : '')

  return (
    <div
      data-testid="my-seed-row"
      data-lot-id={item.id}
      data-outlined={outlined ? 'true' : undefined}
      data-supplier={vendor || undefined}
      style={{
        ...rowCard,
        ...(colors ? { borderLeft: `4px solid ${colors.primary}` } : { paddingLeft: 3 }),
        ...(outlined ? outlineStyle(P.green) : null),
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${title}${vendor ? `, from ${vendor}` : ''} — ${expanded ? 'collapse' : 'expand'}`}
        style={rowBtn}
      >
        <span data-testid="my-seed-thumb" style={photo ? thumbBoxPhoto : thumbBoxEmpty}>
          {photo && withPhoto && (
            <PhotoView photo={photo} tier={TIER.THUMB} alt="" decoding="async" style={thumbImg} data-testid="my-seed-photo" />
          )}
          {!photo && <Icon name="lifecycle.sprout" size={24} decorative />}
        </span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={line1Style}>
            <span style={titleStyle}>{title}</span>
            {ordinal && <span data-testid="my-seed-ordinal" style={ordinalStyle}>{ordinal}</span>}
            <span aria-hidden="true" style={chevronStyle}>{expanded ? '▾' : '▸'}</span>
          </span>
          <span data-testid="my-seed-line" style={lineStyle}>
            {hasLine && (
              <>
                {vendor && <SupplierChip name={vendor} data-testid="my-seed-supplier" style={{ marginRight: 6 }} />}
                {live && (
                  <Badge tone={live.tone} data-testid="my-seed-chip" data-tone={live.tone} style={liveChipStyle}>{live.label}</Badge>
                )}
                <span style={giveWayBox}>
                  <span style={giveWayFlow}>
                    <LineStrut chip={chipTall} />
                    {neutral.length > 0 && (
                      <span style={chipsBox}>
                        {neutral.map((c) => (
                          <Badge key={c.key} tone={c.tone} data-testid="my-seed-chip" data-tone={c.tone} style={chipStyle}>{c.label}</Badge>
                        ))}
                      </span>
                    )}
                    {amount && <span data-testid="my-seed-amount" style={amountStyle}>{amount}</span>}
                    {heat && <span data-testid="my-seed-heat" style={heatStyle}>{sep(!!amount)}{heat}</span>}
                    {tail && <span data-testid="my-seed-rest" style={restStyle}>{sep(!!(amount || heat))}{tail}</span>}
                  </span>
                </span>
                <LineStrut chip={chipTall} />
              </>
            )}
          </span>
        </span>
      </button>

      {expanded && (
        <div data-testid="my-seed-expanded" style={expandedStyle}>
          <SeedFacts item={item} vendor={vendor} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <PacketLink item={item} />
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

// What holds line 2 open: the facts that give way sit in an absolutely positioned flow that adds no
// height, so the line gets it from an invisible stand-in. With a chip on the row, that is the chips'
// own Badge with its sideways padding and border taken off and an empty 1lh body — a chip's height by
// construction, zero wide, no text (the line's textContent is untouched). Without one, it is one text
// line. Either way the row keeps the height it had: 58px with a chip, 54 without.
function LineStrut({ chip }) {
  if (!chip) return <span aria-hidden="true" style={textStrut} />
  return (
    <Badge aria-hidden="true" style={chipStrut}>
      <span style={oneLineTall} />
    </Badge>
  )
}

// The seed's facts, in the words and order the detail page uses too (seedFacts.js), led by where the
// packet came from and how old it is.
function SeedFacts({ item, vendor }) {
  const from = [vendor || originNote(item), howOld(item)].filter(Boolean).join(' · ')
  const facts = seedFacts(item, { from })
  if (facts.length === 0) return null
  return (
    <dl data-testid="my-seed-facts" style={factsGrid}>
      {facts.map((f) => (
        <React.Fragment key={f.key}>
          <dt style={factLabel}>{f.label}</dt>
          <dd data-fact={f.label} style={factValue}>{f.italic ? <i>{f.value}</i> : f.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

// The packet's own page when the lot records one; otherwise a page about the variety. Each is named by
// where it goes — the variety URL is usually another seller's page, so neither is a "supplier page".
function PacketLink({ item }) {
  const packet = item.source_url && /^https?:\/\//.test(item.source_url) ? item.source_url : ''
  const variety = !packet && item.variety_source_url && /^https?:\/\//.test(item.variety_source_url) ? item.variety_source_url : ''
  const href = packet || variety
  if (!href) return null
  const host = hostOf(href)
  const label = packet ? `Packet page · ${host} ↗` : `About this variety · ${host} ↗`
  const name = packet ? `Packet page on ${host}, opens in browser` : `About this variety on ${host}, opens in browser`
  // Named by its CONTENT, not aria-label: the a11y gate's static layer rebuilds an <a> without its
  // href, where a name is prohibited — the same fix the detail page's packet link carries. The glyph
  // line is hidden from a screen reader, which hears the sentence instead.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="my-seed-packet-link"
      style={{ ...secondaryLink, position: 'relative' }}
    >
      <span aria-hidden="true">{label}</span>
      <span style={SR_ONLY}>{name}</span>
    </a>
  )
}

// LiveRegion.jsx's visually-hidden recipe.
const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}

// ── Styles — from T tokens, matching the Saved seeds card (48px buttons, 44px taps) ──────────────────
const listStyle = { display: 'flex', flexDirection: 'column', gap: 8 }
const rowCard = {
  backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusCard, overflow: 'hidden',
}
const rowBtn = {
  width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
  padding: '6px 10px 6px 8px', minHeight: 48, display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit',
}
// The app's ROW thumbnail (Garden tree rows, ProjectDetail planting rows): 40x40, radius 8. The box is
// fixed so an image arriving never moves the text; a photo box waits on the photo-tile fill, a lot
// with no photo shows the colour sprout — the two must not look alike, or a slow load reads as "none".
const thumbBase = {
  position: 'relative', flex: '0 0 auto', width: 40, height: 40, borderRadius: T.radiusButton,
  border: `1px solid ${P.border}`, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const thumbBoxPhoto = { ...thumbBase, backgroundColor: P.photoPlaceholder }
const thumbBoxEmpty = { ...thumbBase, backgroundColor: P.greenPale }
const thumbImg = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
const line1Style = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
const titleStyle = {
  flex: '1 1 auto', minWidth: 0, fontWeight: 600, color: P.dark, fontSize: T.type.md, lineHeight: 1.25,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}
const ordinalStyle = { flex: '0 0 auto', whiteSpace: 'nowrap', fontSize: T.type.xs2, color: P.mid }
const chevronStyle = { flex: '0 0 auto', color: P.light, fontSize: T.type.xs2 }
const lineStyle = {
  display: 'flex', alignItems: 'center', minWidth: 0, fontSize: T.type.xs2, color: P.mid,
  whiteSpace: 'nowrap', overflow: 'hidden',
}
// LINE 2 GIVES WAY IN A FIXED ORDER (UX spec §1.3), from never cut to cut first:
//   1. never cut: the supplier chip, the amount, and the first state chip when it is a lot's LIVE
//      state (tone info, warn or danger: fermenting, drying) — and the ordinal, on line 1;
//   2. then the heat, dropped WHOLE — never partly shown: a cut Scoville number is a wrong number;
//   3. then the neutral chips ("Archived for this season", a status, "Not started"), ellipsised;
//   4. cut first: the tail (where from · how old).
// The supplier and live chips are the line's own rigid items. Everything else sits in giveWayBox: a
// clipped box whose absolutely positioned child is a WRAPPING flex row with a huge row gap, so an item
// that does not fit on the first line wraps to a second one far below the clip — hidden whole, never
// sliced. In that row the neutral chips' box has a 0 basis, so it never pushes the heat off the line,
// and a 1000 grow capped at its own content, so it takes the free space before the tail does; the
// amount and the heat are rigid; the tail has a 0 basis and ellipsises. The ORDER does the rest: the
// amount comes before the heat, so the heat wraps first, and the tail after the heat, so a dropped heat
// takes its " · " and the tail with it — no separator is ever left dangling. `clip`, not `hidden`, so
// nothing (find-in-page, a focus) can scroll the wrapped line into view. No flex gap on either row:
// the chips carry their own margin, and the facts open with a NON-BREAKING space so "2 packets ·
// 30K–50K SHU" reads as one phrase. The flow adds no height; LineStrut holds the line.
const giveWayBox = { flex: '1 1 0', minWidth: 0, alignSelf: 'stretch', position: 'relative', overflow: 'clip' }
const giveWayFlow = {
  position: 'absolute', inset: 0, display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', alignItems: 'center',
  rowGap: 100, columnGap: 0,
}
const chipsBox = { display: 'flex', gap: 6, flex: '1000 1 0', minWidth: 0, maxWidth: 'max-content', overflow: 'hidden', marginRight: 6 }
const chipStyle = {
  display: 'block', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: T.type.xs,
}
const liveChipStyle = { ...chipStyle, flex: '0 0 auto', maxWidth: '100%', marginRight: 6 }
const amountStyle = { flex: '0 0 auto', whiteSpace: 'nowrap' }
const heatStyle = { flex: '0 0 auto', whiteSpace: 'nowrap', color: P.dark }
const restStyle = { flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
// LineStrut's pieces. `1lh` is one line box of the element's own font and line-height — Badge's 1.4 at
// the chips' size for the chip stand-in, the line's own for the text one.
const oneLineTall = { display: 'block', width: 0, height: '1lh' }
const textStrut = { ...oneLineTall, flex: '0 0 auto' }
const chipStrut = {
  flex: '0 0 auto', width: 0, paddingLeft: 0, paddingRight: 0, borderLeftWidth: 0, borderRightWidth: 0,
  fontSize: T.type.xs, visibility: 'hidden',
}
const expandedStyle = {
  padding: '10px 12px 12px', borderTop: `1px solid ${P.border}`, display: 'flex', flexDirection: 'column', gap: 10,
}
const factsGrid = {
  display: 'grid', gridTemplateColumns: '100px 1fr', columnGap: 10, rowGap: 6, margin: 0, alignItems: 'baseline',
}
const factLabel = { fontSize: T.type.xs2, color: P.mid }
const factValue = { margin: 0, fontSize: T.type.sm, color: P.dark, overflowWrap: 'anywhere' }
const secondaryBtn = {
  minHeight: T.tapMinHeight, padding: '0 12px', borderRadius: T.radiusButton, border: `1px solid ${P.green}`,
  background: P.white, color: P.green, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit',
}
const secondaryLink = {
  ...secondaryBtn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none',
}
const searchStyle = {
  display: 'block', flex: '1 1 auto', minWidth: 0, minHeight: T.tapMinHeight, padding: '0 12px', boxSizing: 'border-box',
  borderRadius: T.radiusButton, border: `1px solid ${P.border}`, fontSize: '1rem', backgroundColor: P.white,
}
const sortLabel = {
  display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: T.type.xs2, color: P.mid,
}
// selectChrome's own 1rem field font, not a smaller one: iOS zooms the page on focus under 16px.
const sortSelect = { ...selectChrome(), width: 'auto', paddingLeft: 10, paddingRight: 30, backgroundPosition: 'right 8px center' }
// Headers are interactive now (they fold), so the 44px tap floor V102 §16 dropped comes back.
const groupHeaderStyle = { minHeight: T.tapMinHeight, padding: '0 12px', boxSizing: 'border-box' }
const groupHeaderSticky = {
  position: 'sticky', top: STICKY_TOP, zIndex: 1, backgroundColor: P.cream, paddingBottom: 2,
}
const questionRow = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  minHeight: T.tapMinHeight, marginBottom: 2,
}
const questionStyle = { margin: 0, color: P.mid, fontSize: T.type.sm }
const expandAllBtn = {
  background: 'none', border: 'none', color: P.green, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer',
  minHeight: T.tapMinHeight, padding: '0 4px', fontFamily: 'inherit', flexShrink: 0,
}
const dividerStyle = {
  margin: '8px 0 2px', fontSize: T.type.xs2, fontWeight: 700, color: P.mid, letterSpacing: '0.04em',
  textTransform: 'uppercase',
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
