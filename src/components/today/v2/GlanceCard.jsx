import React, { useId, useMemo } from 'react'
import Icon from '../../Icon.jsx'
import WeatherWidget, { ConditionIcon, asOfLabel } from '../WeatherWidget.jsx'
import WeatherCueLine from '../WeatherCueLine.jsx'
import LeafWetnessLine from '../LeafWetnessLine.jsx'
import RainHold from './RainHold.jsx'
import ColdRangeNote from '../ColdRangeNote.jsx'
import { glanceHeadline, verdictLead, urgentPhrase, glanceRain } from '../../../lib/todayV2/verdict.js'
import { cueFolds, frostPlacement, frostLineText, frostTonight } from '../../../lib/todayV2/alerts.js'
import { buildFrostAlertLines } from '../../../lib/frostAlertLine.js'
import { buildDroughtLine } from '../../../lib/droughtLine.js'
import { droughtRows } from '../../../lib/careNeeded.js'
import { P } from '../../../lib/constants.js'
import { ICON_COLORS } from '../../../lib/tokens.js'
import { T } from '../../forms/formStyles.js'

// GlanceCard — the redesigned Today's first screen (V5-TODAYREDESIGN-001 S3; plan-v2 §1.1 row 3, §4 "Glance
// card", §5.1–5.2; §13 MF2, SF9 update; finish plan §3.2–3.3, Dave's D15, 2026-10-14). Dave D1: one compact card —
// high/low, rain today + tomorrow on one line, a one-line verdict — with the rain detail, the update time, deep-soak
// and leaf-wetness notes behind a tap.
//
// CLOSED (the default; nothing ever opens it but a tap): one button, inside a visually quiet h2 "Weather",
// holding rows A–C — A the condition, high and low (the ONE place on the page tonight's low is stated), the cold
// range as "could reach 40°" and the "Details ▾" control (44 px tall); B the card's own rain sentences
// (verdict.js glanceRain → rainSentences, the same text WeatherWidget prints); C the verdict in its short form
// (verdict.js glanceHeadline) plus at most one urgent phrase. The verdict is ONE visible, wrapping text element —
// no ellipsis, no sr-only twin (the old card's truncated headline is why) — with ONE line reserved (finish plan
// D-8); an urgent phrase that needs a second line takes it. Under the button, still inside the card, only the
// stale marker for a plan that is not today's.
//
// UNDER THE CARD, the alert stack (finish plan §3.3, D15), only what is left to say: the weather cue, unless a
// Protect tonight section takes it (a pick cue becomes Protect's pick link; lib/todayV2/alerts.js), and — only
// with NO Protect section — one frost line, tonight's in its short form ("Frost watch tonight — clear and calm.":
// row A states the low). Tonight's line carries the warning mark and the warn rule; nothing here is a banner,
// a toast or a fill.
//
// OPEN (MF2): rows A–C give way to WeatherWidget, rendered ONCE, its headline the closed card's verdict (finish
// plan D-2) and its cold range in the same words — never beside rows A–C, which would be two weather cards stacked.
// The toggle reads "Less ▴" in the place "Details ▾" held: the same button, laid over the widget's row A at the
// card's inner right edge. Then one plain, normal-weight list, one line each (finish plan §3.2): the frost
// line(s) in full, the deep-soak line with the dry plantings named in it, leaf wetness, the rain lines (RainHold:
// what rain already watered, then the plantings waiting for rain, each with its Water chip — under the details,
// never inside the toggle button; they need the page's care state, `care`, the visit `record` / `update`), and the
// muted basis stamp. The open state drops the card's own chrome: WeatherWidget is the card.
//
// The cue keeps ONE place in the tree in both states, so a toggle never remounts it (its impression beacon would
// fire again) — the state-only parts are `false` holes around it.
//
// data-testid anchors (today-glance, today-verdict, [data-stale]) are gate:today-shape:v2's contract.
const COLD_PHRASE = 'could reach'

export default function GlanceCard({
  plan, generatedAt = null, planDate = null, liveHydrology = null, refreshedAt = null,
  agreed = null, current = null, cueCallout = null, stale = null, open = false, onToggle,
  care = null, record = null, update, announce, writesHeld = false, coldRange = null, waterDue,
  protectShown = false,
}) {
  const weather = plan.weather || {}
  const headline = useMemo(() => glanceHeadline(plan, waterDue), [plan, waterDue])
  const urgent = useMemo(() => urgentPhrase(plan, agreed), [plan, agreed])
  const { rainNote, nextNote } = useMemo(
    () => glanceRain({ hydrology: plan.hydrology, liveHydrology, generatedAt, planDate }),
    [plan, liveHydrology, generatedAt, planDate],
  )
  // The frost lines as FrostAlertLine builds them (the same four inputs: one low per night, the warmed line), with
  // their halves so tonight's can be printed without the low; placed by whether Protect takes them.
  const frost = useMemo(() => frostPlacement(
    buildFrostAlertLines(plan.alerts_sent, { lowShown: agreed?.lowF, planLow: weather.tonightLow, current, parts: true }),
    { protectShown },
  ), [plan.alerts_sent, agreed, weather.tonightLow, current, protectShown])
  const cueShown = !cueFolds(cueCallout, protectShown)
  const widgetId = useId()
  const detailsId = useId()
  const basis = asOfLabel(generatedAt)
  const low = agreed?.lowF ?? weather.tonightLow
  const rain = [rainNote, nextNote].filter(Boolean)

  return (
    <div data-testid="today-glance" style={stack}>
      <div style={open ? openFrame : card}>
        <h2 style={open ? openHeading : headingStyle}>
          <button type="button" aria-expanded={open} aria-controls={open ? `${widgetId} ${detailsId}` : undefined} onClick={onToggle} style={open ? openToggle : closedToggle}>
            {open ? (
              <>
                <span style={srOnly}>Weather: </span>
                <span>Less</span>
                <span aria-hidden="true">{' ▴'}</span>
              </>
            ) : (
              <>
                <span style={srOnly}>Weather: </span>
                <span style={rowA}>
                  <ConditionIcon code={weather.code} />
                  <span style={tempPair}>
                    <span style={hiStyle}>{`${weather.highToday}°`}</span>
                    <Icon name="care.sun" size={16} title="day high" style={{ marginTop: 3 }} />
                  </span>
                  <span style={{ ...tempPair, marginLeft: 2 }}>
                    <span style={loStyle}>{`${low}°`}</span>
                    {/* WeatherWidget's crescent, copied: it has no registry twin (see its note there). */}
                    <svg width="11" height="11" viewBox="0 0 24 24" style={{ marginTop: 2 }} role="img" aria-label="night low"><path d="M20 14.5A8 8 0 1 1 10.5 4 6.3 6.3 0 0 0 20 14.5Z" fill={P.mid} /></svg>
                  </span>
                  {/* V5-WXCOLDBAND-001: the forecast's cold end, only when it is colder than this low. */}
                  <ColdRangeNote coldRange={coldRange} planDate={planDate} lowShown={low} phrase={COLD_PHRASE} />
                  <span style={detailsLabel}>Details<span aria-hidden="true">{' ▾'}</span></span>
                </span>
                <span data-testid="glance-rain" style={rowB}>
                  {rain.map((t) => (
                    <span key={t} style={rainItem}>
                      <Icon name="care.rainPct" size={13} decorative style={{ color: ICON_COLORS.dropBody, flexShrink: 0 }} />
                      {t}
                    </span>
                  ))}
                </span>
                <span aria-hidden="true" style={hairline} />
                <span data-testid="today-verdict" style={verdictStyle}>
                  {urgent ? verdictLead(headline) : headline}
                  {urgent && (
                    <>
                      {' · '}
                      <Icon name="severity.med" size={16} decorative style={{ verticalAlign: '-0.2em', marginRight: 4 }} />
                      {urgent.text}
                    </>
                  )}
                </span>
              </>
            )}
          </button>
        </h2>
        {open && (
          <div id={widgetId}>
            <WeatherWidget weather={plan.weather} hydrology={plan.hydrology} generatedAt={generatedAt} planDate={planDate} liveHydrology={liveHydrology} refreshedAt={refreshedAt} waterDueCount={Array.isArray(plan.water_due) ? plan.water_due.length : 0} lowShown={agreed?.lowF} coldRange={coldRange} headline={headline} coldRangePhrase={COLD_PHRASE} />
          </div>
        )}
        {stale ? (
          <p data-stale="true" style={staleStyle}>
            <Icon name="severity.low" size={14} decorative style={{ flexShrink: 0 }} />
            <span>{stale}</span>
          </p>
        ) : null}
      </div>
      {cueShown && <WeatherCueLine callout={cueCallout} generatedAt={generatedAt} planDate={planDate} compact />}
      {!open && frost.under && <FrostLine line={frost.under} short />}
      {open && (
        <div id={detailsId} style={detailsStyle}>
          {[...(frost.under ? [frost.under] : []), ...frost.details].map((l, i) => <FrostLine key={i} line={l} />)}
          <DryLine plan={plan} />
          <LeafWetnessLine plan={plan} planDate={planDate} compact />
          <RainHold plan={plan} care={care} record={record} update={update} announce={announce} writesHeld={writesHeld} />
          {basis && <p data-testid="today-basis-stamp" style={basisStyle}>{`Updated ${basis} · plan from overnight`}</p>}
        </div>
      )}
    </div>
  )
}

// One frost line (frostAlertLine.js, `parts`): tonight's watch / possible line with the warning mark and the warn
// rule, without the low (short under the card: its first sentence); a warmed line or a later night's, as built, in
// the advisory treatment. FrostAlertLine's test id and data attributes, so a frost line is found the same way.
function FrostLine({ line, short = false }) {
  const tonight = frostTonight(line)
  return (
    <div
      data-testid="frost-alert-line" data-frost-tier={line.tier} data-frost-day-offset={String(line.dayOffset)}
      data-frost-night-offset={String(line.nightOffset)} style={tonight ? tonightLine : adviceLine}
    >
      {tonight && <Icon name="severity.med" size={16} decorative style={{ flexShrink: 0, marginTop: 2 }} />}
      <span>{frostLineText(line, { short })}</span>
    </div>
  )
}

// The deep-soak line with the dry list merged into it (finish plan §3.2): "No deep soak in 21 days — check soil at
// root depth: Peach tree, Hydrangeas." From the structured fields only — the day count the garden line and the
// list rows carry (droughtLine.js, careNeeded.js droughtRows, which already words "No deep soak … in N days"), never
// "no rain" (Dave's ruling, droughtLine.js). Counts that differ, or a truncated window, read "at least" the least.
// The names are the list's region (care-drought-list), inline. Shown only behind the tap (D1).
function DryLine({ plan }) {
  const line = useMemo(() => buildDroughtLine(plan), [plan])
  const rows = useMemo(() => droughtRows(plan), [plan])
  if (!line && !rows.length) return null
  const counts = [...(line ? [line.dryDays] : []), ...rows.map((r) => r.dryDays)].filter((n) => Number.isFinite(n))
  if (!counts.length) return null
  const days = Math.min(...counts)
  const atLeast = !!(line?.truncated) || rows.some((r) => r.truncated) || counts.some((n) => n !== days)
  const lead = `No deep soak in ${atLeast ? 'at least ' : ''}${days} day${days === 1 ? '' : 's'} — check soil at root depth`
  return (
    <p data-testid="drought-line" data-drought-days={String(days)} data-drought-truncated={String(atLeast)} style={adviceLine}>
      {rows.length ? `${lead}: ` : `${lead}.`}
      {rows.length > 0 && <span data-testid="care-drought-list">{`${rows.map((r) => r.name).join(', ')}.`}</span>}
    </p>
  )
}

// ── styles (plan-v2 §4; finish plan §3.2–3.3; design-visual-system §2–3; tokens P / T) ───────────────────────
// The glance: the card, then the alert stack and (open) the details, 8 px apart — a line that renders nothing
// leaves no gap behind.
const stack = { display: 'flex', flexDirection: 'column', gap: 8 }
// Closed: the one card treatment WeatherWidget uses (white, 1px border, card radius, 16 padding).
const card = {
  display: 'flex', flexDirection: 'column', gap: 8, boxSizing: 'border-box',
  background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusCard, padding: T.space.md,
}
// Open: WeatherWidget is the card; the toggle sits over its row A, at its border + padding from the top right —
// where "Details ▾" sits on the closed card (row A is the 44 px condition glyph's height in both).
const openFrame = { display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }
const headingStyle = { margin: 0, fontSize: 'inherit', fontWeight: 'inherit' }
const openHeading = { ...headingStyle, position: 'absolute', top: 1 + T.space.md, right: 1 + T.space.md, zIndex: 1 }
const toggleBase = {
  margin: 0, padding: 0, background: 'none', border: 'none', font: 'inherit', color: 'inherit',
  textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
}
const closedToggle = { ...toggleBase, display: 'block', width: '100%', minHeight: T.buttonMinHeight }
// "Details ▾" / "Less ▴": the page's text-link control (T.type.sm 600 P.green), 44 px tall.
const linkText = { fontSize: T.type.sm, fontWeight: 600, color: P.green, whiteSpace: 'nowrap' }
const openToggle = { ...toggleBase, ...linkText, display: 'flex', alignItems: 'center', minHeight: T.tapMinHeight, paddingLeft: 8 }
const detailsLabel = { ...linkText, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, paddingLeft: 8, flexShrink: 0 }
const rowA = { display: 'flex', alignItems: 'center', gap: 11 }
const tempPair = { display: 'flex', alignItems: 'flex-start', gap: 1, lineHeight: 1 }
const hiStyle = { fontWeight: 800, letterSpacing: '-0.02em', fontSize: 36, color: P.dark }
const loStyle = { fontWeight: 600, letterSpacing: '-0.02em', fontSize: 23, color: P.mid }
// Row B: the rain sentence(s) on one line, wrapping only if both will not fit; one line reserved when silent.
const rowB = {
  display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 2, marginTop: 5,
  minHeight: '1.35em', fontSize: T.type.xs, fontWeight: 400, lineHeight: 1.35, color: P.mid,
}
const rainItem = { display: 'inline-flex', alignItems: 'center', gap: 4 }
const hairline = { display: 'block', height: 1, background: P.border, margin: '5px 0' }
// One line reserved (finish plan D-8); a verdict that wraps takes its second line.
const verdictStyle = {
  display: 'block', fontSize: T.type.base, fontWeight: 700, color: P.dark, lineHeight: 1.35,
  minHeight: '1.35em', overflowWrap: 'anywhere',
}
const staleStyle = { margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: T.type.xs, color: P.mid }
const detailsStyle = { display: 'flex', flexDirection: 'column', gap: 8 }
// The alert-line treatment (design-visual-system §3): no fill, a 3 px left rule — P.warnBorder for tonight, P.sage
// for advice — T.type.sm at normal weight (finish plan §3.2 "one plain normal-weight list", §3.3).
const lineBase = { margin: 0, paddingLeft: T.space.sm, fontSize: T.type.sm, lineHeight: 1.45, color: P.dark, fontWeight: 400 }
const tonightLine = { ...lineBase, borderLeft: `3px solid ${P.warnBorder}`, display: 'flex', alignItems: 'flex-start', gap: 6 }
const adviceLine = { ...lineBase, borderLeft: `3px solid ${P.sage}` }
const basisStyle = { margin: 0, fontSize: T.type.xs, color: P.light }
const srOnly = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }
