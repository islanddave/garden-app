import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import Badge from '../components/forms/Badge.jsx'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import { selectChrome, T } from '../components/forms/formStyles.js'
import { useInventory } from '../hooks/useInventory.js'
import { P } from '../lib/constants.js'
import { formatQty, formatMoney, formatDate } from '../lib/format.js'
import {
  INVENTORY_TYPES,
  INVENTORY_STATUS_OPTIONS,
  INVENTORY_CATEGORY_OPTIONS,
  INVENTORY_CATEGORY_LABELS,
  INVENTORY_CATEGORIES,
} from '../lib/inventoryEnums.js'

// HG-4.2 Inventory-list redesign (V4-DESIGNSYS / Tranche 0). The list was the last "raw"
// surface — a database-table of text rows. Same data + logic (useInventory), re-executed
// visually: a category-tinted coin per row, qty + low-stock at a glance, collapsible
// category sections, token-native filter chrome, and a stat-row cost bar. Composes existing
// primitives (Icon / Badge / SegmentedControl / selectChrome) + P tokens only — no schema,
// no freeze surface, no new raw hex. Category→coin identity is a page-local presentational
// map (like other page-local CTAs); 8 of 11 categories resolve to a real registry glyph,
// the 3 without (amendment/shelving/climate_control) use a monogram in the same coin frame
// (interim per Dave 2026-07; mint 5 category anchors as a fast-follow).

const CATEGORY_OPTIONS = INVENTORY_CATEGORY_OPTIONS
const CATEGORY_ORDER = INVENTORY_CATEGORIES.map(c => c.v)

// Translucent white rules/ink for the DARK toast surface. Named here rather than left as
// anonymous inline rgba() per the constants.js scrim convention: the palette token holds the
// base color, translucency is composed at the point of use. P.onPhotoFg is the same #ffffff.
const TOAST_RULE = 'rgba(255,255,255,0.4)'      // Undo button hairline
const TOAST_MUTED_INK = 'rgba(255,255,255,0.6)' // dismiss glyph, de-emphasised vs the message
const TOAST_SHADOW = '0 4px 16px rgba(0,0,0,0.22)'

// Category identity: an existing registry icon where one fits, else a monogram; each paired
// with a facet-token color trio (all from P — reinforces the section header, never the sole
// signal since the section label + item name carry the category in text).
const CATEGORY_STYLE = {
  seeds:           { icon: 'lifecycle.sprout', bg: P.fTypeBg,       text: P.fTypeText,       border: P.fTypeBorder },
  growing_media:   { icon: 'care.inground',    bg: P.fLocationBg,   text: P.fLocationText,   border: P.fLocationBorder },
  fertilizer:      { icon: 'care.drop',        bg: P.fLcPerennialBg, text: P.fLcPerennialText, border: P.fLcPerennialBorder },
  amendment:       { mono: 'Am',               bg: P.fLcTenderBg,   text: P.fLcTenderText,   border: P.fLcTenderBorder },
  pest_control:    { icon: 'nav.critters',     bg: P.alert,         text: P.alertBorder,     border: P.alertBorder },
  containers:      { icon: 'care.containers',  bg: P.fGroupBg,      text: P.fGroupText,      border: P.fGroupBorder },
  lighting:        { icon: 'care.sun',         bg: P.fLcAnnualBg,   text: P.fLcAnnualText,   border: P.fLcAnnualBorder },
  shelving:        { mono: 'Sh',               bg: P.fFreeformBg,   text: P.fFreeformText,   border: P.fFreeformBorder },
  climate_control: { mono: 'Cl',               bg: P.badgeInfoBg,   text: P.blue,            border: P.blue },
  tools:           { icon: 'action.settings',  bg: P.fLcBiennialBg, text: P.fLcBiennialText, border: P.fLcBiennialBorder },
  other:           { icon: 'nav.inventory',    bg: P.fFreeformBg,   text: P.fFreeformText,   border: P.fFreeformBorder },
}
const catStyle = cat => CATEGORY_STYLE[cat] ?? CATEGORY_STYLE.other

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Inventory() {
  const { items, loading, error, toast, dismissToast, adjustQuantity } = useInventory()

  const [filterType,     setFilterType]     = useState('all')
  const [filterCategory, setFilterCategory] = useState('all')
  const [filterStatus,   setFilterStatus]   = useState('active')
  const [sortBy,         setSortBy]         = useState('name_asc')
  const [collapsed,      setCollapsed]      = useState(() => new Set())

  if (loading) return <Shell><SkeletonList /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  const resetFilters = () => {
    setFilterType('all'); setFilterCategory('all'); setFilterStatus('active'); setSortBy('name_asc')
  }
  const toggleSection = cat => setCollapsed(prev => {
    const next = new Set(prev)
    next.has(cat) ? next.delete(cat) : next.add(cat)
    return next
  })

  // ── Filter ──
  const filtered = items.filter(item => {
    if (filterType     !== 'all' && item.type     !== filterType)     return false
    if (filterCategory !== 'all' && item.category !== filterCategory) return false
    if (filterStatus   !== 'all' && item.status   !== filterStatus)   return false
    return true
  })

  // ── Sort (applied WITHIN each category section) ──
  const sortItems = arr => [...arr].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc':   return a.name.localeCompare(b.name)
      case 'name_desc':  return b.name.localeCompare(a.name)
      case 'date_desc':  return (b.purchase_date ?? '').localeCompare(a.purchase_date ?? '')
      case 'qty_asc':    return (a.quantity_on_hand ?? Infinity) - (b.quantity_on_hand ?? Infinity)
      default:           return 0
    }
  })

  // ── Group by category (canonical order; unknown categories bucket last) ──
  const known = new Set(CATEGORY_ORDER)
  const groups = CATEGORY_ORDER
    .map(cat => ({ cat, items: sortItems(filtered.filter(i => i.category === cat)) }))
    .filter(g => g.items.length)
  const leftover = sortItems(filtered.filter(i => !known.has(i.category)))
  if (leftover.length) groups.push({ cat: 'other', items: leftover })

  // ── Cost summary ──
  const withCost   = items.filter(i => i.unit_cost != null && i.quantity_purchased != null)
  const totalCost  = withCost.reduce((sum, i) => sum + i.unit_cost * i.quantity_purchased, 0)
  const consCost   = withCost.filter(i => i.type === 'consumable').reduce((sum, i) => sum + i.unit_cost * i.quantity_purchased, 0)
  const duraCost   = withCost.filter(i => i.type === 'durable')   .reduce((sum, i) => sum + i.unit_cost * i.quantity_purchased, 0)
  const noCostCount = items.filter(i => i.unit_cost == null || i.quantity_purchased == null).length

  const lowStockItems = items.filter(i =>
    i.type === 'consumable' &&
    i.reorder_threshold !== null &&
    i.reorder_threshold !== undefined &&
    (i.quantity_on_hand ?? 0) <= i.reorder_threshold
  )

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      {/* Bottom padding clears the sticky cost-bar + nav. */}
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px 180px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 10 }}>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
            Inventory
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {/* V4-SEEDINV-001 / DRG-SOWNOW-001 entry points — compact icon chips, all three kept. */}
            <Link to="/inventory/add-seeds" style={chipActionStyle}>
              <Icon name="status.seed" size={16} decorative style={{ marginRight: 6, flexShrink: 0 }} />
              Add seeds
            </Link>
            <Link to="/sow" style={chipActionStyle}>
              <Icon name="event.sowing" size={16} decorative style={{ marginRight: 6, flexShrink: 0 }} />
              Sow now
            </Link>
            <Link to="/inventory/add" style={addBtnStyle}>
              + Add
            </Link>
          </div>
        </div>

        {/* ── Filters ── */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 20,
          padding: 12,
          backgroundColor: P.white,
          border: `1px solid ${P.border}`,
          borderRadius: 12,
        }}>
          <SegmentedControl
            ariaLabel="Type"
            value={filterType}
            onChange={setFilterType}
            options={[{ value: 'all', label: 'All' }, ...INVENTORY_TYPES.map(t => ({ value: t.value, label: t.label }))]}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <FilterSelect label="Category" value={filterCategory} onChange={setFilterCategory}>
              <option value="all">All categories</option>
              {CATEGORY_OPTIONS.map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </FilterSelect>

            <FilterSelect label="Status" value={filterStatus} onChange={setFilterStatus}>
              {INVENTORY_STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              <option value="all">All</option>
            </FilterSelect>

            <FilterSelect label="Sort" value={sortBy} onChange={setSortBy}>
              <option value="name_asc">Name A→Z</option>
              <option value="name_desc">Name Z→A</option>
              <option value="date_desc">Newest first</option>
              <option value="qty_asc">Low qty first</option>
            </FilterSelect>
          </div>
        </div>

        {/* ── Grouped item list ── */}
        {groups.length === 0 ? (
          items.length === 0 ? <EmptyState /> : (
            <div style={{
              textAlign: 'center', color: P.light, padding: '36px 20px',
              backgroundColor: P.white, border: `1px solid ${P.border}`,
              borderRadius: 12, fontSize: '0.875rem',
            }}>
              No items match these filters.
              <div>
                <button onClick={resetFilters} style={clearFiltersStyle}>Clear filters</button>
              </div>
            </div>
          )
        ) : (
          groups.map(g => {
            const isCollapsed = collapsed.has(g.cat)
            return (
              <div key={g.cat}>
                <SectionHeader
                  cat={g.cat}
                  label={INVENTORY_CATEGORY_LABELS[g.cat] ?? 'Other'}
                  count={g.items.length}
                  collapsed={isCollapsed}
                  onToggle={() => toggleSection(g.cat)}
                />
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
                    {g.items.map(item => (
                      <InventoryRow key={item.id} item={item} onAdjust={adjustQuantity} />
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}

      </div>

      {/* ── Cost summary bar (sticky, above BottomNav) ── */}
      <div style={{
        position: 'fixed',
        bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
        left: 0, right: 0,
        backgroundColor: P.cream,
        borderTop: `1px solid ${P.gold}`,
        padding: '11px 20px 12px',
        zIndex: 50,
      }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'stretch', justifyContent: 'space-between', gap: 6 }}>
            <CostStat label="Total"       value={formatMoney(totalCost)} />
            <CostStat label="Consumables" value={formatMoney(consCost)} divider />
            <CostStat label="Durables"    value={formatMoney(duraCost)} divider />
          </div>
          {(lowStockItems.length > 0 || noCostCount > 0) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 9 }}>
              {lowStockItems.length > 0 ? (
                <button
                  onClick={() => { setFilterType('consumable'); setFilterStatus('active') }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    backgroundColor: P.warn, border: `1px solid ${P.warnBorder}`,
                    color: P.gold, fontWeight: 700, fontSize: '0.76rem',
                    borderRadius: 10, padding: '6px 11px', cursor: 'pointer',
                    minHeight: T.tapMinHeight, fontFamily: 'inherit',
                  }}
                >
                  <Icon name="severity.high" size={15} decorative style={{ flexShrink: 0 }} />
                  <span>{lowStockItems.length} need restock</span>
                </button>
              ) : <span />}
              {noCostCount > 0 && (
                <span style={{ fontSize: '0.7rem', color: P.light }}>
                  {noCostCount} item{noCostCount > 1 ? 's' : ''} without cost
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Undo / error toast ── */}
      {toast && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed',
          bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 60px)',
          left: '50%', transform: 'translateX(-50%)',
          backgroundColor: P.dark, color: P.white,
          padding: '11px 20px', borderRadius: 8,
          fontSize: '0.875rem', fontWeight: 500,
          boxShadow: TOAST_SHADOW,
          zIndex: 200,
          display: 'flex', alignItems: 'center', gap: 14, whiteSpace: 'nowrap',
        }}>
          <span>{toast.msg}</span>
          {toast.onUndo && (
            <button
              onClick={toast.onUndo}
              style={{
                background: 'none', border: `1px solid ${TOAST_RULE}`,
                color: P.white, borderRadius: 4, padding: '0 12px',
                cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
                minHeight: T.tapMinHeight, fontFamily: 'inherit', flexShrink: 0,
              }}
            >
              Undo
            </button>
          )}
          <button
            onClick={dismissToast}
            aria-label="Dismiss notification"
            style={{
              background: 'none', border: 'none', color: TOAST_MUTED_INK,
              cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0,
              minWidth: T.tapMinHeight, minHeight: T.tapMinHeight, fontSize: '1rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

// ── Category coin ─────────────────────────────────────────────────────────────
function CategoryCoin({ cat }) {
  const s = catStyle(cat)
  return (
    <span data-testid="inv-coin" data-category={cat} style={{
      width: 42, height: 42, flexShrink: 0, borderRadius: 11,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: s.bg, color: s.text, border: `1px solid ${s.border}`,
    }}>
      {s.icon
        ? <Icon name={s.icon} size={22} decorative />
        : <span style={{ fontSize: '0.82rem', fontWeight: 800, letterSpacing: '0.3px' }}>{s.mono}</span>}
    </span>
  )
}

// ── Category section header (collapsible; tinted to the category) ───────────────
function SectionHeader({ cat, label, count, collapsed, onToggle }) {
  const s = catStyle(cat)
  return (
    <div
      data-testid="inv-section"
      data-category={cat}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      aria-label={`${label} (${count}) — ${collapsed ? 'expand' : 'collapse'}`}
      onClick={onToggle}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
      style={{
        display: 'flex', alignItems: 'center', gap: 9,
        padding: '8px 11px', borderRadius: 7, margin: '16px 0 8px',
        cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem', minHeight: T.tapMinHeight,
        backgroundColor: s.bg, color: s.text, borderLeft: `3px solid ${s.border}`,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '0.7rem', opacity: 0.75 }}>{collapsed ? '▸' : '▾'}</span>
      <span>{label}</span>
      <span style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.65, fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </div>
  )
}

// ── Inventory row ─────────────────────────────────────────────────────────────
function InventoryRow({ item, onAdjust }) {
  const [expanded, setExpanded] = useState(false)

  const isLowStock = (
    item.type === 'consumable' &&
    item.reorder_threshold !== null &&
    item.reorder_threshold !== undefined &&
    (item.quantity_on_hand ?? 0) <= item.reorder_threshold
  )
  const isOut = isLowStock && (item.quantity_on_hand ?? 0) === 0

  return (
    <div data-testid="inv-row" style={{
      backgroundColor: P.white,
      border: `1px solid ${P.border}`,
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      {/* Main row */}
      <button
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        aria-label={`${item.name} — ${expanded ? 'collapse' : 'expand'} details`}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          padding: '12px 14px', textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 12, minHeight: 64,
        }}
      >
        <CategoryCoin cat={item.category} />

        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{
            fontWeight: 600, color: P.dark, fontSize: '0.95rem', lineHeight: 1.25,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {item.name}
          </span>
          <MetaLine item={item} />
        </span>

        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {isLowStock && <StockBadge isOut={isOut} />}
          <span style={{ color: P.light, fontSize: '0.75rem' }}>
            {expanded ? '▾' : '▸'}
          </span>
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div style={{
          padding: '0 14px 16px',
          borderTop: `1px solid ${P.border}`,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>

          {/* Qty adjust — consumable */}
          {item.type === 'consumable' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14 }}>
              <span style={{ fontSize: '0.82rem', color: P.mid, flexShrink: 0 }}>Qty on hand:</span>
              <button onClick={() => onAdjust(item.id, -1)} style={qtyBtn} aria-label="Decrease quantity">−</button>
              <span style={{ fontWeight: 700, fontSize: '1rem', minWidth: T.tapMinHeight, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                {formatQty(item.quantity_on_hand ?? 0)}
                {item.unit
                  ? <span style={{ fontWeight: 400, fontSize: '0.78rem', color: P.mid }}> {item.unit}</span>
                  : null}
              </span>
              <button onClick={() => onAdjust(item.id, +1)} style={qtyBtn} aria-label="Increase quantity">+</button>
              {item.reorder_threshold === null && (
                <span style={{ fontSize: '0.75rem', color: P.light, fontStyle: 'italic' }}>
                  No reorder reminder set
                </span>
              )}
            </div>
          )}

          {/* Qty adjust + condition — durable */}
          {item.type === 'durable' && (
            <div style={{ paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: '0.82rem', color: P.mid, flexShrink: 0 }}>Qty:</span>
                <button onClick={() => onAdjust(item.id, -1)} style={qtyBtn} aria-label="Decrease quantity">−</button>
                <span style={{ fontWeight: 700, fontSize: '1rem', minWidth: T.tapMinHeight, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                  {formatQty(item.quantity)}
                </span>
                <button onClick={() => onAdjust(item.id, +1)} style={qtyBtn} aria-label="Increase quantity">+</button>
              </div>
              {item.condition && (
                <div style={{ fontSize: '0.82rem', color: P.mid }}>
                  Condition: <strong style={{ color: P.dark }}>{item.condition}</strong>
                </div>
              )}
            </div>
          )}

          {/* Detail cells */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            gap: '6px 20px', paddingTop: 4,
            fontSize: '0.82rem', color: P.mid,
          }}>
            {item.status !== 'active' && <DetailCell label="Status" value={item.status} />}
            {item.location_text   && <DetailCell label="Location"  value={item.location_text} />}
            {item.source          && <DetailCell label="Source"    value={item.source} />}
            {item.unit_cost != null && <DetailCell label="Unit cost" value={formatMoney(item.unit_cost)} />}
            {item.purchase_date   && <DetailCell label="Purchased" value={formatDate(item.purchase_date)} />}
            {item.brand           && <DetailCell label="Brand"     value={item.brand} />}
            {item.model           && <DetailCell label="Model"     value={item.model} />}
          </div>

          {item.notes && (
            <p style={{ margin: 0, fontSize: '0.82rem', color: P.mid, fontStyle: 'italic' }}>
              {item.notes}
            </p>
          )}

          {item.source_url && (
            <a href={item.source_url} target="_blank" rel="noopener noreferrer"
               style={{ fontSize: '0.8rem', color: P.green }}>
              Buy again →
            </a>
          )}

          <div style={{ borderTop: `1px solid ${P.border}`, paddingTop: 10, marginTop: 4 }}>
            <Link to={`/inventory/${item.id}`}
              style={{ fontSize: '0.82rem', color: P.green, textDecoration: 'none', fontWeight: 600 }}>
              Edit item →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

// At-a-glance meta line: quantity (prominent) then muted secondary (cost / condition),
// separated by a middot. Cost is omitted cleanly when absent — no placeholder.
function MetaLine({ item }) {
  const parts = []
  if (item.type === 'consumable') {
    parts.push({ qty: true, text: formatQty(item.quantity_on_hand ?? 0), unit: item.unit })
    if (item.unit_cost != null) parts.push({ text: `${formatMoney(item.unit_cost)} ea` })
  } else {
    parts.push({ qty: true, text: `Qty ${formatQty(item.quantity ?? 0)}` })
    if (item.condition) parts.push({ text: item.condition[0].toUpperCase() + item.condition.slice(1) })
    if (item.unit_cost != null) parts.push({ text: `${formatMoney(item.unit_cost)}${(item.quantity ?? 0) > 1 ? ' ea' : ''}` })
  }
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: P.light, minWidth: 0 }}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {i > 0 && <span aria-hidden="true" style={{ color: P.border }}>·</span>}
          {p.qty
            ? <span style={{ fontWeight: 700, color: P.mid, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {p.text}
                {p.unit ? <span style={{ fontWeight: 400, color: P.light, fontSize: '0.76rem' }}> {p.unit}</span> : null}
              </span>
            : <span style={{ color: P.light, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.text}</span>}
        </span>
      ))}
    </span>
  )
}

// Low-stock / out badge — icon shape + text + color (WCAG 1.4.1: never color alone).
// The two states differ in SHAPE, not just hue: severity.med is a bare triangle, severity.high
// adds the bang. Registry SVG rather than a literal ⚠ so the mark renders identically on every
// OS (the per-OS emoji divergence the icon registry exists to close, contract §5).
function StockBadge({ isOut }) {
  return (
    <Badge
      tone={isOut ? 'danger' : 'warn'}
      role="img"
      aria-label={isOut ? 'Out of stock' : 'Low stock'}
      style={{ gap: 3, fontSize: '0.72rem', fontWeight: 700 }}
    >
      <Icon name={isOut ? 'severity.high' : 'severity.med'} size={13} decorative style={{ flexShrink: 0 }} />
      {isOut ? 'Out' : 'Low'}
    </Badge>
  )
}

function FilterSelect({ label, value, onChange, children }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <label style={{
        display: 'block', fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.5px',
        textTransform: 'uppercase', color: P.light, margin: '0 0 4px 2px',
      }}>
        {label}
      </label>
      <select
        aria-label={label}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ ...selectChrome(), backgroundColor: P.cream, height: T.tapMinHeight, fontSize: '0.82rem' }}
      >
        {children}
      </select>
    </div>
  )
}

function CostStat({ label, value, divider }) {
  return (
    <div style={{
      flex: 1, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 2,
      borderLeft: divider ? `1px solid ${P.border}` : 'none',
    }}>
      <span style={{ fontSize: '1.02rem', fontWeight: 800, color: P.dark, letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: P.light }}>{label}</span>
    </div>
  )
}

function DetailCell({ label, value }) {
  return (
    <div>
      <span style={{ color: P.light }}>{label}: </span>
      <span style={{ color: P.dark }}>{value}</span>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      textAlign: 'center', padding: '52px 20px',
      backgroundColor: P.white, border: `1px solid ${P.border}`,
      borderRadius: 12,
    }}>
      <span style={{
        width: 66, height: 66, margin: '0 auto 14px', borderRadius: 18,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: P.fTypeBg, border: `1px solid ${P.fTypeBorder}`, color: P.fTypeText,
      }}>
        <Icon name="nav.inventory" size={34} decorative />
      </span>
      <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
        Nothing here yet
      </p>
      <p style={{ margin: '0 0 24px', color: P.light, fontSize: '0.875rem' }}>
        Add your first item to start tracking seeds, supplies and tools.
      </p>
      <Link to="/inventory/add" style={addBtnStyle}>
        + Add item
      </Link>
    </div>
  )
}

// Skeleton placeholder rows (Dave 2026-07: skeleton over bare spinner). Pure P-token
// shimmer; honors prefers-reduced-motion via the media query in the injected keyframes.
function SkeletonList() {
  return (
    <div>
      <style>{`
        @keyframes invSkelPulse { 0%{opacity:1} 50%{opacity:0.55} 100%{opacity:1} }
        @media (prefers-reduced-motion: reduce){ .inv-skel{animation:none !important} }
      `}</style>
      {[0, 1, 2, 3].map(i => (
        <div key={i} style={{
          backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
          height: 66, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', marginBottom: 8,
        }}>
          <span className="inv-skel" style={{ width: 42, height: 42, borderRadius: 11, backgroundColor: P.preparingFill, animation: 'invSkelPulse 1.3s ease-in-out infinite' }} />
          <span style={{ flex: 1 }}>
            <span className="inv-skel" style={{ display: 'block', width: '58%', height: 12, borderRadius: 6, backgroundColor: P.preparingFill, marginBottom: 8, animation: 'invSkelPulse 1.3s ease-in-out infinite' }} />
            <span className="inv-skel" style={{ display: 'block', width: '34%', height: 10, borderRadius: 6, backgroundColor: P.preparingFill, animation: 'invSkelPulse 1.3s ease-in-out infinite' }} />
          </span>
        </div>
      ))}
    </div>
  )
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px' }}>{children}</div>
    </div>
  )
}
function ErrMsg({ msg }) {
  return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div>
}

// ── Styles ────────────────────────────────────────────────────────────────────
const addBtnStyle = {
  display: 'inline-flex', alignItems: 'center',
  backgroundColor: P.terra, color: P.white,
  textDecoration: 'none', borderRadius: 9,
  padding: '0 15px', height: T.tapMinHeight, fontSize: '0.86rem', fontWeight: 700,
}

// Compact icon-chip variant for the "Add seeds" / "Sow now" header entries. Height is the
// tap floor, not the visual weight: these were 38px, under SC 2.5.8's target, while reading
// as secondary next to the terra "+ Add". Muted fill keeps the hierarchy; the box is tappable.
const chipActionStyle = {
  display: 'inline-flex', alignItems: 'center',
  backgroundColor: P.white, color: P.mid,
  border: `1px solid ${P.border}`,
  textDecoration: 'none', borderRadius: 9,
  padding: '0 11px', height: T.tapMinHeight, fontSize: '0.78rem', fontWeight: 600,
}

const clearFiltersStyle = {
  marginTop: 12, background: 'none', border: 'none',
  color: P.green, fontWeight: 600, fontSize: '0.84rem',
  cursor: 'pointer', padding: 0,
}

const qtyBtn = {
  width: T.tapMinHeight, height: T.tapMinHeight, borderRadius: T.radiusButton,
  border: `1px solid ${P.border}`,
  backgroundColor: P.cream, color: P.dark,
  cursor: 'pointer', fontSize: '1.2rem', fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
}
