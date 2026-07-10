import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { useInventory } from '../hooks/useInventory.js'
import { P } from '../lib/constants.js'
import { formatQty, formatMoney, formatDate } from '../lib/format.js'
import { INVENTORY_TYPES, INVENTORY_STATUS_OPTIONS, INVENTORY_CATEGORY_OPTIONS, INVENTORY_CATEGORY_LABELS } from '../lib/inventoryEnums.js'

// V3-CONFIG-001 — inventory filter vocabulary is single-sourced from inventoryEnums.js (the
// drift-guarded canonical mirror of the live CHECK constraints); no local re-declaration here.
// The alphabetized option list still guarantees every category is selectable even when empty.
const CATEGORY_OPTIONS = INVENTORY_CATEGORY_OPTIONS

// ── Main page ────────────────────────────────────────────────────────────────────
export default function Inventory() {
  const { items, loading, error, toast, dismissToast, adjustQuantity } = useInventory()

  const [filterType,     setFilterType]     = useState('all')
  const [filterCategory, setFilterCategory] = useState('all')
  const [filterStatus,   setFilterStatus]   = useState('active')
  const [sortBy,         setSortBy]         = useState('name_asc')

  if (loading) return <Shell><Spinner /></Shell>
  if (error)   return <Shell><ErrMsg msg={error} /></Shell>

  // ── Filter ──
  const filtered = items.filter(item => {
    if (filterType     !== 'all' && item.type     !== filterType)     return false
    if (filterCategory !== 'all' && item.category !== filterCategory) return false
    if (filterStatus   !== 'all' && item.status   !== filterStatus)   return false
    return true
  })

  // ── Sort ──
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case 'name_asc':   return a.name.localeCompare(b.name)
      case 'name_desc':  return b.name.localeCompare(a.name)
      case 'date_desc':  return (b.purchase_date ?? '').localeCompare(a.purchase_date ?? '')
      case 'qty_asc':    return (a.quantity_on_hand ?? Infinity) - (b.quantity_on_hand ?? Infinity)
      default:           return 0
    }
  })

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

  const fmt = formatMoney

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      {/* P2 fix: bottom padding raised to clear cost-bar + nav (was 120, now 180). */}
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px 180px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h1 style={{ margin: 0, color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
            Inventory
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {/* V4-SEEDINV-001 / DRG-SOWNOW-001 entry points — compact header actions. */}
            <Link to="/inventory/add-seeds" style={headerActionStyle}>
              <Icon name="status.seed" size={16} decorative style={{ marginRight: 6, flexShrink: 0 }} />
              Add seeds
            </Link>
            <Link to="/sow" style={headerActionStyle}>
              <Icon name="event.sowing" size={16} decorative style={{ marginRight: 6, flexShrink: 0 }} />
              Sow now
            </Link>
            <Link to="/inventory/add" style={addBtnStyle}>
              + Add item
            </Link>
          </div>
        </div>

        {/* ── Filters ── */}
        <div style={{
          display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20,
          padding: '14px 16px',
          backgroundColor: P.white,
          border: `1px solid ${P.border}`,
          borderRadius: 8,
        }}>
          <FilterSelect label="Type" value={filterType} onChange={setFilterType}>
            <option value="all">All types</option>
            {INVENTORY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </FilterSelect>

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

        {/* ── Item list ── */}
        {sorted.length === 0 ? (
          items.length === 0 ? <EmptyState /> : (
            <div style={{
              textAlign: 'center', color: P.light, padding: '40px 20px',
              backgroundColor: P.white, border: `1px solid ${P.border}`,
              borderRadius: 8, fontSize: '0.875rem',
            }}>
              No items match these filters.
            </div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sorted.map(item => (
              <InventoryRow
                key={item.id}
                item={item}
                onAdjust={adjustQuantity}
              />
            ))}
          </div>
        )}

      </div>

      {/* ── Cost summary bar (sticky bottom, ABOVE BottomNav) ──
           P2 fix (2026-05-18, V1.2a-3 Increment C / PR-C1): moved up by
           --bottom-nav-height + safe-area-inset-bottom so it sits on top
           of BottomNav instead of being hidden behind it. */}
      <div style={{
        position: 'fixed',
        bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom))',
        left: 0, right: 0,
        backgroundColor: P.cream,
        borderTop: `1px solid ${P.gold}`,
        padding: '10px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 18, flexWrap: 'wrap',
        fontSize: '0.82rem', color: P.dark,
        zIndex: 50,
      }}>
        <span>
          <span style={{ color: P.light }}>Purchased cost: </span>
          <strong>{fmt(totalCost)}</strong>
        </span>
        <span style={{ color: P.border }}>|</span>
        <span>
          <span style={{ color: P.light }}>Consumables: </span>
          <strong>{fmt(consCost)}</strong>
        </span>
        <span style={{ color: P.border }}>|</span>
        <span>
          <span style={{ color: P.light }}>Durables: </span>
          <strong>{fmt(duraCost)}</strong>
        </span>
        {lowStockItems.length > 0 && (
          <>
            <span style={{ color: P.border }}>|</span>
            <button
              onClick={() => { setFilterType('consumable'); setFilterStatus('active') }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#b45309', fontWeight: 700, fontSize: '0.82rem',
                display: 'flex', alignItems: 'center', gap: 4, padding: 0,
              }}
            >
              <span aria-hidden="true">⚠</span>
              <span>Low stock: {lowStockItems.length}</span>
            </button>
          </>
        )}
        {noCostCount > 0 && (
          <span style={{ color: P.light, fontSize: '0.75rem' }}>
            ({noCostCount} item{noCostCount > 1 ? 's' : ''} without cost data)
          </span>
        )}
      </div>

      {/* ── Undo / error toast ──
           P2 fix (2026-05-18): floats above the cost-summary bar (which now
           sits above BottomNav). Stacks: BottomNav (var) + safe-area + cost-bar (~60px). */}
      {toast && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed',
          bottom: 'calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 60px)',
          left: '50%', transform: 'translateX(-50%)',
          backgroundColor: P.dark, color: P.white,
          padding: '11px 20px', borderRadius: 8,
          fontSize: '0.875rem', fontWeight: 500,
          boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
          zIndex: 200,
          display: 'flex', alignItems: 'center', gap: 14, whiteSpace: 'nowrap',
        }}>
          <span>{toast.msg}</span>
          {toast.onUndo && (
            <button
              onClick={toast.onUndo}
              style={{
                background: 'none', border: `1px solid rgba(255,255,255,0.4)`,
                color: P.white, borderRadius: 4, padding: '3px 10px',
                cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
              }}
            >
              Undo
            </button>
          )}
          <button
            onClick={dismissToast}
            aria-label="Dismiss notification"
            style={{
              background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)',
              cursor: 'pointer', fontSize: '1rem', padding: 0, lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

// ── Inventory row ─────────────────────────────────────────────────────────────────
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
    <div style={{
      backgroundColor: P.white,
      border: `1px solid ${P.border}`,
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      {/* Main row */}
      <button
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        aria-label={`${item.name} — ${expanded ? 'collapse' : 'expand'} details`}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          padding: '14px 16px', textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 10, minHeight: 52,
        }}
      >
        <span style={{ flex: 1, fontWeight: 600, color: P.dark, fontSize: '0.95rem' }}>
          {item.name}
        </span>

        <span style={{
          fontSize: '0.72rem', color: P.mid,
          backgroundColor: '#f0ece8', borderRadius: 10,
          padding: '2px 8px', flexShrink: 0,
        }}>
          {INVENTORY_CATEGORY_LABELS[item.category] ?? item.category}
        </span>

        {/* Low-stock badge — triangle icon + color (WCAG 1.4.1: never color alone) */}
        {isLowStock && (
          <span
            role="img"
            aria-label={isOut ? 'Out of stock' : 'Low stock'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: '0.72rem', fontWeight: 700, flexShrink: 0,
              color: isOut ? P.terra : '#b45309',
              backgroundColor: isOut ? P.alert : P.warn,
              border: `1px solid ${isOut ? P.alertBorder : P.warnBorder}`,
              borderRadius: 10, padding: '2px 8px',
            }}
          >
            <span aria-hidden="true">⚠</span>
            {isOut ? 'Out' : 'Low'}
          </span>
        )}

        <span style={{ color: P.light, fontSize: '0.75rem', flexShrink: 0 }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div style={{
          padding: '0 16px 16px',
          borderTop: `1px solid ${P.border}`,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>

          {/* Qty adjust — consumable only */}
          {item.type === 'consumable' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14 }}>
              <span style={{ fontSize: '0.82rem', color: P.mid, flexShrink: 0 }}>Qty on hand:</span>
              <button
                onClick={() => onAdjust(item.id, -1)}
                style={qtyBtn}
                aria-label="Decrease quantity"
              >−</button>
              <span style={{ fontWeight: 700, fontSize: '1rem', minWidth: 40, textAlign: 'center' }}>
                {formatQty(item.quantity_on_hand ?? 0)}
                {item.unit
                  ? <span style={{ fontWeight: 400, fontSize: '0.78rem', color: P.mid }}> {item.unit}</span>
                  : null}
              </span>
              <button
                onClick={() => onAdjust(item.id, +1)}
                style={qtyBtn}
                aria-label="Increase quantity"
              >+</button>
              {item.reorder_threshold === null && (
                <span style={{ fontSize: '0.75rem', color: P.light, fontStyle: 'italic' }}>
                  No reorder reminder set
                </span>
              )}
            </div>
          )}

          {/* Durable qty adjust + condition
               P4 fix (2026-05-18, V1.2a-3 Increment C / PR-C1): exposes ± buttons
               from the list (was read-only, forcing a detail-page round-trip).
               Hook is type-aware — durables adjust `quantity` column. */}
          {item.type === 'durable' && (
            <div style={{ paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: '0.82rem', color: P.mid, flexShrink: 0 }}>Qty:</span>
                <button
                  onClick={() => onAdjust(item.id, -1)}
                  style={qtyBtn}
                  aria-label="Decrease quantity"
                >−</button>
                <span style={{ fontWeight: 700, fontSize: '1rem', minWidth: 40, textAlign: 'center' }}>
                  {formatQty(item.quantity)}
                </span>
                <button
                  onClick={() => onAdjust(item.id, +1)}
                  style={qtyBtn}
                  aria-label="Increase quantity"
                >+</button>
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
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '0.8rem', color: P.green }}
            >
              Buy again →
            </a>
          )}

          <div style={{ borderTop: `1px solid ${P.border}`, paddingTop: 10, marginTop: 4 }}>
            <Link
              to={`/inventory/${item.id}`}
              style={{ fontSize: '0.82rem', color: P.green, textDecoration: 'none', fontWeight: 500 }}
            >
              Edit item →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────────
function FilterSelect({ label, value, onChange, children }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        padding: '6px 28px 6px 10px',
        border: `1px solid ${P.border}`,
        borderRadius: 6, fontSize: '0.82rem',
        backgroundColor: P.cream, color: P.dark,
        cursor: 'pointer',
        appearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23777' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center',
      }}
    >
      {children}
    </select>
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
      borderRadius: 8,
    }}>
      <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📦</div>
      <p style={{ margin: '0 0 6px', fontWeight: 700, color: P.dark, fontSize: '1rem' }}>
        Nothing here yet
      </p>
      <p style={{ margin: '0 0 24px', color: P.light, fontSize: '0.875rem' }}>
        Add your first item to start tracking
      </p>
      <Link to="/inventory/add" style={addBtnStyle}>
        Add item
      </Link>
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
function Spinner() {
  return <div style={{ padding: 48, textAlign: 'center', color: P.light }}>Loading…</div>
}
function ErrMsg({ msg }) {
  return <div style={{ padding: 48, textAlign: 'center', color: P.terra }}>{msg}</div>
}

// ── Styles ────────────────────────────────────────────────────────────────────────
const addBtnStyle = {
  display: 'inline-flex', alignItems: 'center',
  backgroundColor: P.terra, color: P.white,
  textDecoration: 'none', borderRadius: 8,
  padding: '10px 20px', fontSize: '0.9rem', fontWeight: 700,
  minHeight: 44,
}

// Compact header-action variant of addBtnStyle (same chrome, smaller footprint)
// for the V4-SEEDINV-001 "Add seeds" + DRG-SOWNOW-001 "Sow now" entries.
const headerActionStyle = {
  ...addBtnStyle,
  padding: '8px 12px',
  fontSize: '0.82rem',
  minHeight: 36,
}

const qtyBtn = {
  width: 36, height: 36, borderRadius: 6,
  border: `1px solid ${P.border}`,
  backgroundColor: P.cream, color: P.dark,
  cursor: 'pointer', fontSize: '1.1rem', fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
}

