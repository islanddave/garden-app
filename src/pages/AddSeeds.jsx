// src/pages/AddSeeds.jsx — V4-SEEDINV-001 /inventory/add-seeds bulk seed intake.
// ChoiceGrid chooser: Photo of packets (camera -> canvas downscale -> extract-seeds
// mode:image) | Paste an order (textarea -> extract-seeds mode:text) | One item
// (-> /inventory/add). Extracted packets[] land in a local review list with per-row
// variety auto-match chips + a Sheet editor (VarietyPicker override + name/qty/price/
// date). Save all runs sequentially: NEW rows create the variety first via
// useVarieties().createVariety(packetToVarietyCols(packet)) (409 {error, existing}
// -> auto-use existing.id), then POST /api/inventory-items with a payload mirroring
// InventoryAdd.buildPayload (server sets created_by — never sent from the client)
// plus packet metadata. All state stays local to this page.
import React, { useState, useMemo, useRef, useEffect, useId } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { useVarieties } from '../hooks/useVarieties.js'
import { useToast } from '../context/ToastContext.jsx'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'
import { packetToVarietyCols } from '../lib/parseSowProfile.js'
import { P } from '../lib/tokens.js'
import { formatMoney } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import VarietyPicker from '../components/VarietyPicker.jsx'
import { Sheet, Field, Input, Textarea, Button } from '../components/forms'
import ChoiceGrid from '../components/forms/ChoiceGrid.jsx'

// Canvas downscale ceiling (Anthropic vision long-edge sweet spot) + JPEG quality.
const MAX_LONG_EDGE = 1568
const JPEG_QUALITY = 0.85

// V4-DIRTYGUARDSWEEP-001 — draft-stash route key (siblings: 'logone', 'logmany').
const DRAFT_KEY = 'addseeds'

async function fileToJpegBase64(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('Could not read that image file.'))
      i.src = url
    })
    const long = Math.max(img.width, img.height)
    const scale = long > MAX_LONG_EDGE ? MAX_LONG_EDGE / long : 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    return dataUrl.slice(dataUrl.indexOf(',') + 1) // strip data:image/jpeg;base64, prefix
  } finally {
    URL.revokeObjectURL(url)
  }
}

const EXTRACTOR_501_MSG =
  "The photo/paste extractor isn't configured yet — you can still add packets one at a time."

function extractErrorMessage(err) {
  if (err?.status === 501) return EXTRACTOR_501_MSG
  if (err?.status === 413) return 'Photo too large — try a closer shot of fewer packets.'
  return "Couldn't read the packets — please try again."
}

function parseNum(val) {
  if (val === '' || val === null || val === undefined) return null
  const n = parseFloat(val)
  return isNaN(n) ? null : n
}

function packetToRow(packet, idx) {
  return {
    id: `row-${idx}`,
    packet,
    name: packet.name ?? '',
    quantity: String(packet.quantity_on_hand ?? 1),
    price: packet.price_usd != null ? String(packet.price_usd) : '',
    purchase_date: packet.purchase_date ?? '',
    override: null,   // VarietyPicker override (full variety object)
    status: 'pending', // pending | saving | saved | error
    error: null,
  }
}

// Inventory POST body — mirrors InventoryAdd.buildPayload for a consumable seeds
// item exactly (same keys; server sets created_by) + packet metadata per
// packetToInventoryPayload's metadata rules.
function buildRowPayload(row, varietyId) {
  const packet = row.packet
  const metadata = { ...(packet.metadata || {}) }
  metadata.sku = packet.sku ?? null
  metadata.vendor = packet.vendor ?? null
  metadata.origin = packet.origin ?? null
  if (packet.needs_confirmation != null) metadata.needs_confirmation = packet.needs_confirmation
  return {
    name: row.name.trim(),
    type: 'consumable',
    category: 'seeds',
    notes: null,
    source: packet.source ?? null,
    source_url: packet.source_url ?? null,
    purchase_date: row.purchase_date || null,
    unit_cost: parseNum(row.price),
    location_text: null,
    status: 'active',
    quantity_on_hand: parseNum(row.quantity) ?? 1,
    unit: 'packet',
    reorder_threshold: null,
    reorder_quantity: null,
    quantity_purchased: null,
    variety_id: varietyId,
    metadata,
  }
}

export default function AddSeeds() {
  const navigate = useNavigate()
  // V4-BACKNAV-001 Slice P (extended) — the row-edit sheet closes in place (setEditingIdx(null)).
  const { fetch } = useApiFetch()
  const { show } = useToast()
  // ONE shared varieties list at page level — rows auto-match against it.
  const { varieties, createVariety } = useVarieties()

  const [mode, setMode] = useState('')          // '' | 'photo' | 'paste'
  const [pasteText, setPasteText] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [banner, setBanner] = useState(null)    // extraction error banner text
  const [rows, setRows] = useState(null)        // null until an extract succeeds
  const [editingIdx, setEditingIdx] = useState(null)
  const [savingAll, setSavingAll] = useState(false)
  const fileRef = useRef(null)
  // Render-synced mirror of rows so the sequential save loop reads fresh row
  // state across awaits without re-subscribing.
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // V4-DIRTYGUARDSWEEP-001 — restore an interrupted intake, one-shot on mount.
  // `status: 'saving'` is downgraded to 'pending' on the way in: that value only ever exists mid-loop
  // inside handleSaveAll, so a draft carrying it was written by a session that died during the save.
  // Restoring it verbatim would render a row stuck on "Saving…" with no Edit control and no way to
  // retry — the row would be un-saveable and un-editable for the rest of the session.
  useEffect(() => {
    const draft = readDraft(DRAFT_KEY)
    if (!draft) return
    if (typeof draft.mode === 'string') setMode(draft.mode)
    if (typeof draft.pasteText === 'string') setPasteText(draft.pasteText)
    if (Array.isArray(draft.rows)) {
      setRows(draft.rows.map(r => (r.status === 'saving' ? { ...r, status: 'pending', error: null } : r)))
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // STASH predicate — BROAD: the chooser mode rides along with the content, because restoring
  // pasteText without mode='paste' would put the text back into a textarea that is not rendered.
  // Over-capturing costs nothing; the draft is cleared at both spent moments (a clean Save all, and
  // Start over) rather than by this effect, so a first-mount write can never race the restore above.
  const hasDraftContent = !!mode || !!pasteText || Array.isArray(rows)

  useEffect(() => {
    if (hasDraftContent) writeDraft(DRAFT_KEY, { mode, pasteText, rows })
  }, [hasDraftContent, mode, pasteText, rows])

  // GUARD predicate — SEPARATE and NARROWER than the stash. Two terms only:
  //   • typed/pasted order text, and
  //   • an extracted review list with work still outstanding.
  // `mode` alone is deliberately NOT counted: tapping "Paste an order" and typing nothing is a
  // navigation act, and holding the service-worker reload for it would wedge updates for a user who
  // merely looked at the chooser. `rows` IS counted even though it is not typed — it is the output
  // of a paid extraction call plus a hand review pass, which is the most expensive state on this
  // page to lose. The `status !== 'saved'` term makes the predicate self-clearing: once every packet
  // has landed the hold releases with no post-save special case.
  const hasUnsavedInput = !!(
    pasteText.trim() ||
    (Array.isArray(rows) && rows.some(r => r.status !== 'saved'))
  )

  useReportOverlayDirty(hasUnsavedInput)

  // /inventory/add-seeds is not an overlayable route today, so the hook above is a strict no-op and
  // the reload gate below is what actually protects this page. Per-instance key + BOOLEAN dep for
  // the reasons EventNew.jsx:933-941 records.
  const reloadGateKey = `add-seeds:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  // Exact case-insensitive variety-name index for auto-match chips.
  const varietyByLowerName = useMemo(() => {
    const m = new Map()
    for (const v of varieties) {
      const key = (v.name || '').trim().toLowerCase()
      if (key && !m.has(key)) m.set(key, v)
    }
    return m
  }, [varieties])

  function autoMatch(row) {
    const name = (packetToVarietyCols(row.packet).name || '').trim().toLowerCase()
    return name ? (varietyByLowerName.get(name) ?? null) : null
  }

  // Effective variety for a row: explicit VarietyPicker override wins, else auto-match.
  function effectiveVariety(row) {
    return row.override ?? autoMatch(row)
  }

  async function runExtract(body) {
    setExtracting(true)
    setBanner(null)
    try {
      const data = await fetch('/api/inventory-items/extract-seeds', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const packets = Array.isArray(data?.packets) ? data.packets : []
      setRows(packets.map(packetToRow))
    } catch (err) {
      setBanner(extractErrorMessage(err))
    } finally {
      setExtracting(false)
    }
  }

  function handleChoose(value) {
    setMode(value)
    setBanner(null)
    if (value === 'one_item') {
      navigate('/inventory/add')
      return
    }
    if (value === 'photo') {
      // Open the (hidden) file input straight away.
      setTimeout(() => fileRef.current?.click(), 0)
    }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    setExtracting(true)
    setBanner(null)
    try {
      const image_base64 = await fileToJpegBase64(file)
      await runExtract({ mode: 'image', image_base64, media_type: 'image/jpeg' })
    } catch (err) {
      setBanner(err?.message ?? 'Could not read that image file.')
      setExtracting(false)
    }
  }

  function handlePasteSubmit(e) {
    e.preventDefault()
    const text = pasteText.trim()
    if (!text) return
    runExtract({ mode: 'text', text })
  }

  function patchRow(idx, patch) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  async function handleSaveAll() {
    if (!rows || savingAll) return
    setSavingAll(true)
    let saved = 0
    let failed = 0
    // Sequential per-row saves — NEW varieties first, then the inventory row.
    for (let i = 0; i < rows.length; i++) {
      // Read the freshest copy of the row (edits before this loop iteration).
      const row = (rowsRef.current ?? rows)[i]
      if (!row || row.status === 'saved') continue
      patchRow(i, { status: 'saving', error: null })

      let varietyId = effectiveVariety(row)?.id ?? null
      if (!varietyId) {
        const res = await createVariety(packetToVarietyCols(row.packet), { allowDuplicate: false })
        if (res.variety) {
          varietyId = res.variety.id
        } else if (res.existing) {
          // 409 fuzzy-dup conflict — auto-use the existing variety.
          varietyId = res.existing.id
          patchRow(i, { override: res.existing })
        } else {
          failed += 1
          patchRow(i, { status: 'error', error: res.error || 'Failed to create variety' })
          continue
        }
      }

      try {
        await fetch('/api/inventory-items', {
          method: 'POST',
          body: JSON.stringify(buildRowPayload(row, varietyId)),
        })
        saved += 1
        patchRow(i, { status: 'saved', error: null })
      } catch (err) {
        failed += 1
        patchRow(i, { status: 'error', error: err?.message ?? 'Failed to save packet' })
      }
    }
    setSavingAll(false)
    if (failed === 0) {
      clearDraft(DRAFT_KEY)   // every packet is in the DB — the working draft is spent
      show({ message: `Saved ${saved} packet${saved === 1 ? '' : 's'}` })
    } else {
      show({ message: `Saved ${saved}, ${failed} failed — see rows below`, tone: 'error' })
    }
  }

  const editingRow = rows && editingIdx != null ? rows[editingIdx] : null
  const pendingCount = rows ? rows.filter((r) => r.status !== 'saved').length : 0

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '28px 16px 80px' }}>

        {/* Breadcrumb */}
        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 8 }}>
          <Link to="/inventory" style={{ color: P.green, textDecoration: 'none' }}>Inventory</Link>
          {' › Add seeds'}
        </div>

        <h1 style={{ margin: '0 0 20px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>
          Add seeds
        </h1>

        {/* Chooser */}
        {!rows && (
          <div style={card}>
            <ChoiceGrid
              layout="grid"
              columns={3}
              ariaLabel="How do you want to add seeds?"
              value={mode}
              onChange={handleChoose}
              options={[
                { value: 'photo', label: 'Photo of packets', icon: <Icon name="media.camera" size={26} decorative /> },
                { value: 'paste', label: 'Paste an order', icon: <Icon name="status.planning" size={26} decorative /> },
                { value: 'one_item', label: 'One item', icon: <Icon name="status.seed" size={26} decorative /> },
              ]}
            />

            {/* Hidden photo input (opened by the Photo choice) */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleFile}
              aria-label="Seed packet photo"
              style={{ display: 'none' }}
            />

            {mode === 'paste' && (
              <form onSubmit={handlePasteSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Paste your order confirmation or seed list">
                  <Textarea
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="Paste the order email or packet list here&hellip;"
                    rows={8}
                  />
                </Field>
                <div>
                  <Button type="submit" variant="primary" loading={extracting} loadingLabel="Reading&hellip;">
                    Extract packets
                  </Button>
                </div>
              </form>
            )}

            {mode === 'photo' && extracting && (
              <div style={{ padding: 16, textAlign: 'center', color: P.light, fontSize: '0.875rem' }}>
                Reading your photo&hellip;
              </div>
            )}

            {banner && (
              <div role="alert" style={bannerStyle}>{banner}</div>
            )}
          </div>
        )}

        {/* Review list */}
        {rows && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: '0.9rem', color: P.mid }}>
                {rows.length} packet{rows.length === 1 ? '' : 's'} found — review, then save.
              </div>
              {/* clearDraft here, not in the stash effect: an explicit Start over is the user
                  discarding the extraction, so the stored copy must go with it — otherwise the next
                  mount restores the list they just threw away. */}
              <button type="button" onClick={() => { setRows(null); setMode(''); setBanner(null); clearDraft(DRAFT_KEY) }} style={linkBtn}>
                Start over
              </button>
            </div>

            {banner && <div role="alert" style={bannerStyle}>{banner}</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map((row, i) => {
                const match = effectiveVariety(row)
                return (
                  <div key={row.id} style={rowCard}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: P.dark, fontSize: '0.92rem' }}>{row.name}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                        <span style={match ? matchChip : newChip}>
                          {match ? `Matches: ${match.name}` : 'New variety'}
                        </span>
                        <span style={{ fontSize: '0.76rem', color: P.light }}>
                          Qty {row.quantity || '1'}
                          {row.price ? ` · ${formatMoney(row.price)}` : ''}
                          {row.purchase_date ? ` · ${row.purchase_date}` : ''}
                        </span>
                      </div>
                      {row.status === 'error' && row.error && (
                        <div role="alert" style={{ fontSize: '0.76rem', color: P.terra, marginTop: 4 }}>
                          {row.error}
                        </div>
                      )}
                    </div>
                    {row.status === 'saved' ? (
                      <span style={savedChip} role="status">Saved &#10003;</span>
                    ) : row.status === 'saving' ? (
                      <span style={savingChip} role="status">Saving&hellip;</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditingIdx(i)}
                        aria-label={`Edit ${row.name}`}
                        style={editBtn}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            <div style={{ display: 'flex', gap: 14, alignItems: 'center', paddingTop: 4 }}>
              <Button
                type="button"
                variant="primary"
                onClick={handleSaveAll}
                loading={savingAll}
                loadingLabel="Saving&hellip;"
                disabled={pendingCount === 0}
              >
                {pendingCount === 0 ? 'All saved' : `Save all (${pendingCount})`}
              </Button>
              <Link to="/inventory" style={{ color: P.mid, textDecoration: 'none', fontSize: '0.88rem' }}>
                Done
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Row edit Sheet */}
      <Sheet
        armsBack
        open={!!editingRow}
        onClose={() => setEditingIdx(null)}
        title={editingRow ? `Edit ${editingRow.name}` : undefined}
      >
        {editingRow && (
          <div style={{ padding: '4px 24px 8px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* BUG-FIELDCHILDDROP-001: this hint was a second child of the Field and had
                never rendered. The `help` prop is where it belongs — same position under
                the control, plus the aria-describedby the loose <div> never had. */}
            <Field
              label="Variety"
              help={<>Leave blank to create &ldquo;{packetToVarietyCols(editingRow.packet).name}&rdquo; as a new variety on save.</>}
            >
              <VarietyPicker
                value={effectiveVariety(editingRow)}
                onChange={(variety) => patchRow(editingIdx, { override: variety })}
                placeholder="Search or create a variety&hellip;"
              />
            </Field>
            <Field label="Item name">
              <Input
                value={editingRow.name}
                onChange={(e) => patchRow(editingIdx, { name: e.target.value })}
              />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Qty on hand">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={editingRow.quantity}
                  onChange={(e) => patchRow(editingIdx, { quantity: e.target.value })}
                />
              </Field>
              <Field label="Unit cost ($)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editingRow.price}
                  onChange={(e) => patchRow(editingIdx, { price: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Purchase date">
              <Input
                type="date"
                value={editingRow.purchase_date}
                onChange={(e) => patchRow(editingIdx, { purchase_date: e.target.value })}
              />
            </Field>
            <div style={{ display: 'flex', paddingBottom: 8 }}>
              <Button type="button" variant="primary" onClick={() => setEditingIdx(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const card = {
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: 10,
  padding: '20px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

const bannerStyle = {
  backgroundColor: P.warn,
  border: `1px solid ${P.warnBorder}`,
  borderRadius: 8,
  padding: '12px 16px',
  fontSize: '0.875rem',
  color: P.dark,
}

const rowCard = {
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: 10,
  padding: '12px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const matchChip = {
  fontSize: '0.72rem',
  fontWeight: 700,
  color: P.green,
  backgroundColor: P.greenPale,
  borderRadius: 10,
  padding: '2px 8px',
}

const newChip = {
  fontSize: '0.72rem',
  fontWeight: 700,
  color: P.gold,
  backgroundColor: P.warn,
  border: `1px solid ${P.warnBorder}`,
  borderRadius: 10,
  padding: '2px 8px',
}

const savedChip = {
  fontSize: '0.8rem',
  fontWeight: 700,
  color: P.green,
  backgroundColor: P.greenPale,
  borderRadius: 999,
  padding: '6px 12px',
  flexShrink: 0,
}

const savingChip = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: P.mid,
  flexShrink: 0,
}

const editBtn = {
  backgroundColor: 'transparent',
  color: P.green,
  border: `1px solid ${P.green}`,
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: '0.82rem',
  fontWeight: 600,
  cursor: 'pointer',
  minHeight: 40,
  flexShrink: 0,
}

const linkBtn = {
  background: 'none',
  border: 'none',
  color: P.green,
  cursor: 'pointer',
  fontSize: '0.82rem',
  textDecoration: 'underline',
  padding: 0,
}
