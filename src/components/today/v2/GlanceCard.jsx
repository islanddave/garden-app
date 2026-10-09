import React, { useId, useMemo } from 'react'
import Icon from '../../Icon.jsx'
import WeatherWidget, { ConditionIcon, asOfLabel } from '../WeatherWidget.jsx'
import WeatherCueLine from '../WeatherCueLine.jsx'
import FrostAlertLine from '../FrostAlertLine.jsx'
import DroughtLine from '../DroughtLine.jsx'
import LeafWetnessLine from '../LeafWetnessLine.jsx'
import { DroughtList } from '../CareNeeded.jsx'
import RainHold from './RainHold.jsx'
import { glanceHeadline, urgentPhrase, glanceRain } from '../../../lib/todayV2/verdict.js'
import { P } from '../../../lib/constants.js'
import { ICON_COLORS } from '../../../lib/tokens.js'
import { T } from '../../forms/formStyles.js'

// GlanceCard — the redesigned Today's first screen (V5-TODAYREDESIGN-001 S3; plan-v2 §1.1 row 3, §4 "Glance
// card", §5.1–5.2; §13 MF2, SF9 update). Dave D1: one compact card — high/low, rain today + tomorrow on one line,
// a one-line verdict — with the rain detail, the update time, deep-soak and leaf-wetness notes behind a tap.
//
// CLOSED (the default; nothing ever opens it but a tap): one button, inside a visually quiet h2 "Weather",
// holding rows A–C — A the condition, high and low (the one low the card, cue and frost line all print); B the
// card's own rain sentences (verdict.js glanceRain → rainSentences, the same text WeatherWidget prints); C the
// verdict: headlineFor verbatim behind the empty-list guard, plus at most one urgent phrase. The verdict is ONE
// visible, wrapping text element — no ellipsis, no sr-only twin (the old card's truncated headline is why) —
// with two lines reserved so the phrase never shifts what sits below. Under the button, still inside the card:
// the weather cue and the frost line, mounted unchanged; and, only for a plan that is not today's, how old it is.
//
// OPEN (MF2): the card's rows give way to the UNMODIFIED WeatherWidget, rendered ONCE — never beside rows A–C,
// which would be two weather cards stacked — under a one-line "Weather" toggle. Then the cue and the frost line,
// then the drought line, leaf wetness, the dry list, the rain lines and the basis stamp, in V1's reading order.
// The rain lines (RainHold) carry the plantings waiting for rain, each with its Water chip — under the details,
// never inside the toggle button; they need the page's care state (`care`, the visit `record` / `update`).
// The open state drops the card's own chrome: WeatherWidget is the card.
//
// The cue and frost line keep ONE place in the tree in both states, so a toggle never remounts them (the cue's
// impression beacon would fire again) — the open-only parts are `false` holes around them.
//
// data-testid anchors (today-glance, today-verdict, [data-stale]) are gate:today-shape:v2's contract.
// The chevrons are the section bands' (FacetGroupHeader): one disclosure grammar on the page.
const CHEVRON = { closed: '▸', open: '▾' }

export default function GlanceCard({
  plan, generatedAt = null, planDate = null, liveHydrology = null, refreshedAt = null,
  agreed = null, current = null, cueCallout = null, stale = null, open = false, onToggle,
  care = null, record = null, update, announce, writesHeld = false,
}) {
  const weather = plan.weather || {}
  const headline = useMemo(() => glanceHeadline(plan), [plan])
  const urgent = useMemo(() => urgentPhrase(plan, agreed), [plan, agreed])
  const { rainNote, nextNote } = useMemo(
    () => glanceRain({ hydrology: plan.hydrology, liveHydrology, generatedAt, planDate }),
    [plan, liveHydrology, generatedAt, planDate],
  )
  const widgetId = useId()
  const detailsId = useId()
  const basis = asOfLabel(generatedAt)
  const low = agreed?.lowF ?? weather.tonightLow
  const rain = [rainNote, nextNote].filter(Boolean)

  return (
    <div data-testid="today-glance" style={open ? openFrame : card}>
      <h2 style={headingStyle}>
        <button type="button" aria-expanded={open} aria-controls={open ? `${widgetId} ${detailsId}` : undefined} onClick={onToggle} style={open ? openToggle : closedToggle}>
          {open ? (
            <>
              <span>Weather</span>
              <span aria-hidden="true" style={chevronStyle}>{CHEVRON.open}</span>
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
                <span aria-hidden="true" style={{ ...chevronStyle, marginLeft: 'auto', alignSelf: 'center' }}>{CHEVRON.closed}</span>
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
                {headline}
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
          <WeatherWidget weather={plan.weather} hydrology={plan.hydrology} generatedAt={generatedAt} planDate={planDate} liveHydrology={liveHydrology} refreshedAt={refreshedAt} waterDueCount={Array.isArray(plan.water_due) ? plan.water_due.length : 0} lowShown={agreed?.lowF} />
        </div>
      )}
      {stale ? (
        <p data-stale="true" style={staleStyle}>
          <Icon name="severity.low" size={14} decorative style={{ flexShrink: 0 }} />
          <span>{stale}</span>
        </p>
      ) : null}
      <WeatherCueLine callout={cueCallout} generatedAt={generatedAt} planDate={planDate} />
      <FrostAlertLine alertsSent={plan.alerts_sent} lowShown={agreed?.lowF} planLow={weather.tonightLow} current={current} />
      {open && (
        <div id={detailsId} style={detailsStyle}>
          <DroughtLine plan={plan} />
          <LeafWetnessLine plan={plan} />
          <DroughtList plan={plan} />
          <RainHold plan={plan} care={care} record={record} update={update} announce={announce} writesHeld={writesHeld} />
          {basis && <p data-testid="today-basis-stamp" style={basisStyle}>Plan from overnight · as of {basis}</p>}
        </div>
      )}
    </div>
  )
}

// ── styles (plan-v2 §4; tokens P / T) ──────────────────────────────────────────────────────────────────────
// Closed: the one card treatment WeatherWidget uses (white, 1px border, card radius, 16 padding). Everything in
// it is a flex item 8px apart, so a line that renders nothing leaves no gap behind.
const card = {
  display: 'flex', flexDirection: 'column', gap: 8, boxSizing: 'border-box',
  background: P.white, border: `1px solid ${P.border}`, borderRadius: T.radiusCard, padding: T.space.md,
}
const openFrame = { display: 'flex', flexDirection: 'column', gap: 8 }
const headingStyle = { margin: 0, fontSize: 'inherit', fontWeight: 'inherit' }
const toggleBase = {
  margin: 0, padding: 0, background: 'none', border: 'none', font: 'inherit', color: 'inherit',
  textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
}
const closedToggle = { ...toggleBase, display: 'block', width: '100%', minHeight: T.buttonMinHeight }
const openToggle = {
  ...toggleBase, display: 'flex', alignItems: 'center', gap: 6, minHeight: T.tapMinHeight,
  fontSize: T.type.sm, fontWeight: 700, color: P.green,
}
const chevronStyle = { fontSize: T.type.xs, color: P.light }
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
// Two lines reserved: the urgent phrase arriving on a refetch never pushes the card's lines down.
const verdictStyle = {
  display: 'block', fontSize: T.type.base, fontWeight: 700, color: P.dark, lineHeight: 1.35,
  minHeight: '2.7em', overflowWrap: 'anywhere',
}
const staleStyle = { margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: T.type.xs, color: P.mid }
const detailsStyle = { display: 'flex', flexDirection: 'column', gap: 8 }
const basisStyle = { margin: 0, fontSize: T.type.xs, color: P.light }
const srOnly = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }
