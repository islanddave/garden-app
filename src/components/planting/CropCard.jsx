// Per-crop attribute card on the planting page: the computed maturity/harvest band, the cultivar's structured
// attributes and the projected type:/lifecycle: faceted chips (useEntityTags).
import React from 'react'
import { P } from '../../lib/constants.js'
import { computeMaturity } from '../../lib/plantingMaturity.js'
import { useEntityTags } from '../../hooks/useTags.js'
import TagChip from '../forms/TagChip.jsx'
import TransplantDatePrompt from './TransplantDatePrompt.jsx'
import { shuLabel, determinacyLabel, sunLabel } from '../../lib/varietySpec.js'
import { resolveRipenessCues } from '../../lib/ripenessCues.js'

// The colour-window dataset is ~110KB gzip of JSON reached ONLY from this card, so the resolver module
// (`../../lib/harvestWindows.js`, which statically imports the JSON) is loaded LAZILY in an effect below. NEVER
// reintroduce a static `import { resolveHarvestWindow }` here: it silently pulls the dataset back into the entry
// bundle with every test green; `scripts/verify-window-chunk.sh` is the only detector. React.lazy is forbidden
// at/above this card: an offline chunk-miss would throw into the route ErrorBoundary and replace the whole
// PlantingDetail page, which the `.catch -> render nothing` branch below cannot. Module-scope cache: once the chunk
// lands, later mounts resolve synchronously at first render.
let hwModule = null

// created_at is a full timestamp (not the length-10 date string the lifecycle columns carry), so it is parsed plainly.
// Same "Mon D, YYYY" shape as plantingMaturity's window dates, so the two dates in this band read as one set.
function fmtAdded(value) {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function Attr({ label, value }) {
  if (value == null || value === '') return null
  return (
    <div>
      <div style={{ fontSize: '0.72rem', fontWeight: 600, color: P.light, marginBottom: 2,
        textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: '0.9rem', color: P.dark, lineHeight: 1.5, wordBreak: 'break-word' }}>{value}</div>
    </div>
  )
}

// "How will I know it's ripe": rendered as an ordinary Attr row, at the same weight as Sun and Expected yield, on
// purpose:
//   - It is instructions for a task the user already started, not a nudge, so the reward-UX rule does not apply. It
//     still gets the lowest salience the card has: no badge, no colour encoding, no promotion, no time-decaying state.
//   - The cultivar target-state leads the crop mechanic when both exist, because the target state is what
//     disambiguates ("full canary yellow" tells you what "full colour" means for THIS plant).
// The source line is not decoration: it is the verifiability half of the downgrade path (no cue ships without one),
// so the claim can be checked against the page it came from.
function RipenessCue({ cues }) {
  const { target, mechanic } = cues
  if (!target && !mechanic) return null   // unsourced crop / anything not harvested -> render NOTHING
  const attribution = target ?? mechanic
  return (
    <div>
      <div style={{ fontSize: '0.72rem', fontWeight: 600, color: P.light, marginBottom: 2,
        textTransform: 'uppercase', letterSpacing: '0.5px' }}>When it&rsquo;s ripe</div>
      {target && (
        <div style={{ fontSize: '0.9rem', color: P.dark, lineHeight: 1.5, wordBreak: 'break-word' }}>{target.cue}</div>
      )}
      {mechanic && (
        <div style={{ fontSize: '0.9rem', color: target ? P.mid : P.dark, lineHeight: 1.5, wordBreak: 'break-word',
          marginTop: target ? 4 : 0 }}>{mechanic.cue}</div>
      )}
      {/* A 'low'-confidence cue is a DERIVATION, not a quotation, and the module requires it to say so; rendering the */}
      {/* caveat keeps a derived cue from reading like a quoted extension instruction. Read off BOTH records, not off */}
      {/* `attribution`: a caveat belongs to the claim it qualifies, so a cultivar override must not hide one on the */}
      {/* crop mechanic under it. */}
      {[target?.caveat, mechanic?.caveat].filter(Boolean).map(c => (
        <div key={c} style={{ fontSize: '0.78rem', color: P.mid, lineHeight: 1.5, marginTop: 4, fontStyle: 'italic' }}>
          {c}
        </div>
      ))}
      <div style={{ fontSize: '0.72rem', color: P.light, lineHeight: 1.5, marginTop: 4 }}>
        {attribution.source_url ? (
          <a href={attribution.source_url} target="_blank" rel="noreferrer noopener" style={{ color: P.light }}>
            {attribution.source}
          </a>
        ) : attribution.source}
      </div>
    </div>
  )
}

// The harvest colour WINDOW: every colour you can legitimately pick at, and what each one buys.
//
// EVERY POINT RENDERS, not a summary label with the payoffs behind a tap: the payoffs ARE the feature, and the label
// alone is the old single-cue model with an arrow in it.
//
// ONLY ONE GRAIN RENDERS. `resolveHarvestWindow` returns both the cultivar colour sequence and the crop-level
// mechanic. Rendering both would double an already tall block, and cultivar records carry their own maturity test
// inside `ripe_vs_unripe`, so the cultivar window wins when present and the crop mechanic fills in only when it does
// not.
function HarvestWindow({ window: win }) {
  // Disclosure: windows of 3 points or fewer render fully expanded (zero taps). Only longer windows collapse, and the
  // collapsed view keeps the first and FINAL point (endpoint comparison is the canonical question: what does letting
  // it go to full ripeness give me vs green?) plus ripe_vs_unripe and the caveat, which render OUTSIDE the points list
  // and are never hidden by collapse: a collapsed unlabelled low-confidence point would be a confidently-presented
  // derived claim (colour-window canon §4/§9). Content is never cut; disclosure manages length. This deviates from
  // canon §6 "every window point renders" for records over 3 points (noted in the harvest-colour-window design doc).
  const [expanded, setExpanded] = React.useState(false)
  const rec = win.cultivar ?? win.crop
  if (!rec) return null
  const pts = rec.window ?? []
  const collapsed = pts.length > 3 && !expanded
  const shown = collapsed ? [pts[0], pts[pts.length - 1]] : pts
  return (
    <div>
      <div style={{ fontSize: '0.72rem', fontWeight: 600, color: P.light, marginBottom: 4,
        textTransform: 'uppercase', letterSpacing: '0.5px' }}>When you can pick</div>
      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: P.green, lineHeight: 1.4,
        marginBottom: 8 }}>{rec.window_label}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {shown.map((p, i) => (
          <div key={`${p.at}-${i}`} style={{ borderLeft: `2px solid ${P.greenPale}`, paddingLeft: 10 }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: P.dark, lineHeight: 1.4 }}>{p.at}</div>
            <div style={{ fontSize: '0.82rem', color: P.mid, lineHeight: 1.5, wordBreak: 'break-word' }}>{p.look}</div>
            <div style={{ fontSize: '0.82rem', color: P.dark, lineHeight: 1.5, marginTop: 2,
              wordBreak: 'break-word' }}>→ {p.gives}</div>
          </div>
        ))}
      </div>

      {/* In-place downward expansion — no sheet, no scroll re-anchor. ≥48px touch target (§5.8). */}
      {collapsed && (
        <button type="button" onClick={() => setExpanded(true)}
          style={{ display: 'block', minHeight: 48, padding: '4px 0', marginTop: 2, border: 'none',
            background: 'none', textAlign: 'left', cursor: 'pointer', fontSize: '0.82rem',
            fontWeight: 600, color: P.green }}>
          Show all {pts.length} points ▾
        </button>
      )}

      {/* The green-when-ripe answer: on a cultivar whose ripe state looks unripe this is the ONLY field that */}
      {/* resolves the plant in front of the user, so it gets its own labelled block. */}
      {rec.ripe_vs_unripe && (
        <div style={{ marginTop: 10, backgroundColor: P.greenPale, borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: P.green, marginBottom: 2,
            textTransform: 'uppercase', letterSpacing: '0.5px' }}>Telling ripe from unripe</div>
          <div style={{ fontSize: '0.82rem', color: P.dark, lineHeight: 1.5,
            wordBreak: 'break-word' }}>{rec.ripe_vs_unripe}</div>
        </div>
      )}

      {/* A `low`-confidence window is a DERIVATION from the market class, not a quotation about this cultivar; */}
      {/* rendering the caveat is what makes complete coverage safe. */}
      {rec.caveat && (
        <div data-testid="harvest-window-caveat" style={{ fontSize: '0.78rem', color: P.mid, lineHeight: 1.5, marginTop: 8,
          fontStyle: 'italic', wordBreak: 'break-word' }}>{rec.caveat}</div>
      )}

      <div style={{ fontSize: '0.72rem', color: P.light, lineHeight: 1.5, marginTop: 6 }}>
        {rec.source_url
          ? <a href={rec.source_url} target="_blank" rel="noreferrer noopener" style={{ color: P.light }}>{rec.source}</a>
          : rec.source}
      </div>
    </div>
  )
}

// The derived `determinacy` facet slug (lambda/varieties/crop-derive.js DETERMINACY_LABELS) that names the
// same class as each word of the green determinacy pill. `dwarf` is the facet's own refinement: no pill
// word, so never a duplicate.
const DETERMINACY_CHIP_SLUG = { Determinate: 'determinate', 'Semi-determinate': 'semi_determinate', Indeterminate: 'indeterminate' }

export default function CropCard({ planting, onUpdated }) {
  const { projected } = useEntityTags('plant', planting?.id)
  const vref = planting?.variety_ref ?? null
  // Async window state: pending | resolved-with-window | resolved-empty | failed. Only resolved-with-window changes
  // rendered output (the others render the card as it renders without windows, and null for a sparse record), so it
  // is the ONLY transition that re-renders: mounts whose cultivar has no window stay free of async churn, and the
  // non-window test suites stay race-free under the sync stub.
  const [, bumpWindow] = React.useReducer(t => t + 1, 0)
  React.useEffect(() => {
    // A bare record (null variety_ref) fires NO import at all and stays synchronous. A landed chunk (hwModule set,
    // here or by main.jsx's idle warm import) resolves at render, with no effect work.
    if (!vref || hwModule) return
    let alive = true
    import('../../lib/harvestWindows.js')
      .then(m => {
        hwModule = m
        if (!alive) return
        const w = m.resolveHarvestWindow(vref)
        if (w.cultivar || w.crop) bumpWindow() // re-render only when a window will render
      })
      // failed -> render nothing: card unchanged, PlantingDetail intact, no error surface. hwModule stays null so the
      // next mount retries.
      .catch(() => {})
    return () => { alive = false }
  }, [vref])
  const m = computeMaturity(planting)
  const v = planting?.variety_ref || {}
  const shu = shuLabel(v)
  const determinacy = determinacyLabel(v)
  const specChips = [
    shu && { key: 'shu', label: shu, bg: P.terra },
    determinacy && { key: 'det', label: determinacy, bg: P.green },
  ].filter(Boolean)

  const dtm = (v.days_to_maturity_min != null || v.days_to_maturity_max != null)
    ? (v.days_to_maturity_min != null && v.days_to_maturity_max != null && v.days_to_maturity_min !== v.days_to_maturity_max
        ? `${v.days_to_maturity_min}–${v.days_to_maturity_max} days`
        : `${v.days_to_maturity_min ?? v.days_to_maturity_max} days`)
    : null

  const hasMaturity = m.ageDays != null || m.harvestWindowLabel
  // Display-only and conditional; see the render site below.
  const addedDate = fmtAdded(planting?.created_at)
  // The growth type shows once: the green pill above and the cultivar's derived determinacy facet chip under it would
  // name the same class twice. On THIS card the chip that names the pill's own class is dropped, matched on the tag's
  // facet and slug, never its label. The tag itself is untouched (filters, grouping, Search). With no green pill, or a
  // chip naming another class (Dwarf; a column that disagrees with the prose), it stays.
  const facetChips = (Array.isArray(projected) ? projected : [])
    .filter(t => !(determinacy && t?.facet === 'determinacy' && t.slug === DETERMINACY_CHIP_SLUG[determinacy]))
  const hasChips = facetChips.length > 0
  // A sourced cue is enough on its own to earn the card. Without this a planting whose cultivar carries no
  // DTM/sun/yield prose renders no card at all, silently dropping the cue from exactly the sparsest records.
  const cues = resolveRipenessCues(v)
  const hasCue = !!(cues.target || cues.mechanic)
  // Sync resolution once the lazy chunk has landed. `win` is null while pending/failed and when the record has no
  // window, all indistinguishable by design.
  const win = (vref && hwModule) ? hwModule.resolveHarvestWindow(vref) : null
  const hasWindow = !!(win && (win.cultivar || win.crop))
  // The column holds a code ('full_sun'); sunLabel gives the words VarietyEditor offers. null still hides the row.
  const sun = sunLabel(v.sun_requirements)
  // The cultivar's growth_habit prose as stored, under the label Search's peek gives the same field. Not shown beside
  // the determinacy pill: there the prose opens with the class the pill already names. It counts in `attrs`, so a
  // habit alone earns the card.
  const habit = !determinacy && typeof v.growth_habit === 'string' && v.growth_habit.trim() ? v.growth_habit.trim() : null
  const attrs = [dtm, sun, habit, v.expected_yield_notes].filter(Boolean)
  // The early return stays SYNC over today's signals; `!hasWindow` is the async-sparse term: a window-ONLY sparse card
  // renders once the window resolves (pending+sparse renders null, resolved-empty/failed+sparse returns null
  // permanently).
  if (!hasMaturity && !hasChips && specChips.length === 0 && attrs.length === 0 && !hasCue && !hasWindow) return null

  return (
    <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24,
      display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* maturity band */}
      {hasMaturity && (
        <div>
          {m.ageDays != null && (
            <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.green }}>
              Day {m.ageDays}{m.anchorLabel ? ` since ${m.anchorLabel}` : ''}
            </div>
          )}
          {/* A from-transplant crop with no transplant date has an unknowable window. Rather than a bare suppressed */}
          {/* label, the slot the date would have occupied carries a low-key tappable prompt that sets the date and */}
          {/* yields a correct window on the spot; see TransplantDatePrompt for why this is not headline treatment. */}
          {m.awaitingTransplant ? (
            <div style={{ marginTop: 3 }}>
              <TransplantDatePrompt planting={planting} onSaved={onUpdated} />
            </div>
          ) : m.harvestWindowLabel && (
            <div style={{ fontSize: '0.82rem', color: m.isMature ? P.green : P.mid, marginTop: 3 }}>
              {m.isMature ? '✅ ' : '⏳ '}{m.harvestWindowLabel}
              {/* Name the basis when it moved the number off the sow date, so a corrected window reads as explained. */}
              {m.dtmBasis === 'from-transplant' && m.dtmAnchorLabel && (
                <span style={{ color: P.light }}> (from {m.dtmAnchorLabel})</span>
              )}
            </div>
          )}
          {/* progress bar toward maturity */}
          {m.pctToMaturity != null && !m.isMature && (
            <div style={{ marginTop: 8, height: 6, backgroundColor: P.greenPale, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(m.pctToMaturity * 100)}%`, height: '100%', backgroundColor: P.green }} />
            </div>
          )}
        </div>
      )}

      {/* With no sown_at, transplanted_at OR planted_out_at, garden_node.created_at is the only date the record */}
      {/* carries, a within-days proxy for when the plant arrived. DISPLAY ONLY: computeMaturity refuses to project a */}
      {/* window off a guessed anchor (start_indoor_weeks is populated for well under half the affected plantings), */}
      {/* and this must not smuggle one back in. It is labelled as the app-added date, never "sown"/"transplanted", */}
      {/* and feeds no computation. Two deliberate limits: it renders ONLY when m.anchorDate is null, and it is NOT in */}
      {/* the hasMaturity/early-return test above, because created_at is non-null on every row and earning the card on */}
      {/* it would put a card on every sparse planting, the exact thing that early return exists to stop. */}
      {m.anchorDate == null && addedDate && (
        <div data-testid="planting-added-date" style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.5 }}>
          Added to the app {addedDate}
        </div>
      )}

      {/* First-class spec chips (SHU / determinacy) */}
      {specChips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {specChips.map(c => (
            <span key={c.key} style={{ fontSize: '0.75rem', fontWeight: 700, color: P.white,
              backgroundColor: c.bg, borderRadius: 999, padding: '3px 10px', lineHeight: 1.4 }}>{c.label}</span>
          ))}
        </div>
      )}
      {/* projected faceted chips */}
      {hasChips && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {facetChips.map(t => <TagChip key={`${t.facet}:${t.slug}`} tag={t} />)}
        </div>
      )}

      {/* structured cultivar attributes */}
      {(attrs.length > 0 || hasCue || hasWindow) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Attr label="Days to maturity" value={dtm} />
          <Attr label="Sun" value={sun} />
          <Attr label="Habit" value={habit} />
          <Attr label="Expected yield" value={v.expected_yield_notes} />
          <RipenessCue cues={cues} />
          {/* The window renders BELOW the corrective cue: the cue answers "what would I get wrong", the window */}
          {/* answers "when can I pick and what does each colour buy". One visual section. */}
          {hasWindow && <HarvestWindow window={win} />}
        </div>
      )}
    </div>
  )
}
