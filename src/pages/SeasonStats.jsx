// Season stats — how this grow-year went, as eight cards. Reached from the More row "Season stats"
// (src/lib/moreRegistry.js); the route itself is added in App.jsx by the stitch commit.
//
// WHAT IS SHOWN is decided by the server: GET /api/harvests/season-stats?season=YYYY returns a v1
// envelope keyed by section id (plan D4). This page only draws it: it walks the stats-kit registry's
// order, draws each section it has a renderer for, and skips any section that is missing or unknown.
// Verdict sentences and Limits lines are written client-side from each section's meta
// (src/lib/stats-kit/verdicts.js).
//
// Structure copied from SeasonEnd.jsx: page shell, title + lede, skeleton while cold, AsyncRegion for
// error (with Try again) / empty / content.
//
// REWARD UX: a look-back surface. No celebration, no scores, no badges; nothing animates.
import React, { useMemo } from 'react'
import { P } from '../lib/constants.js'
import { T } from '../components/forms/formStyles.js'
import AsyncRegion from '../components/forms/AsyncRegion.jsx'
import EmptyState from '../components/forms/EmptyState.jsx'
import StatCard from '../components/stats/StatCard.jsx'
import { useSeasonStats } from '../hooks/useSeasonStats.js'
import { getRenderer, drawableSectionIds } from '../lib/stats-kit/registry.js'
import { verdictFor, limitsText } from '../lib/stats-kit/verdicts.js'
import { statsThemeVars, v } from '../lib/stats-kit/palette.js'
import { monthDay } from '../lib/stats-kit/format.js'

const column = { maxWidth: 700, margin: '0 auto', padding: `${T.space.lg}px ${T.space.md}px ${T.space.lg * 4}px` }
const title = { margin: 0, color: v('title'), fontSize: '1.3rem', fontWeight: 700 }
const lede = { margin: `${T.space.xs}px 0 0`, color: v('ink'), fontSize: T.type.md }
const aside = { margin: `${T.space.xs}px 0 ${T.space.md}px`, color: v('ink-3'), fontSize: T.type.sm }
const skeleton = { height: T.buttonMinHeight * 3, margin: `${T.space.sm}px 0`, borderRadius: T.radiusCard, backgroundColor: P.photoPlaceholder }

// A table builder that trips on an odd row costs the card its table, never the page.
function safeTable(r, section) {
  try { return r.table(section) } catch { return null }
}

function seasonLine(stats, year) {
  const s = stats?.season
  const y = s?.year ?? year
  if (s?.start && s?.end) return `${y} season · ${monthDay(s.start)} to ${monthDay(s.end)}`
  return `${y} season`
}

export default function SeasonStats() {
  const { year, stats, loading, error, refetch } = useSeasonStats()
  const ids = useMemo(() => drawableSectionIds(stats), [stats])
  const themeVars = useMemo(() => statsThemeVars(), [])
  const empty = !loading && !error && ids.length === 0

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: v('page'), ...themeVars }} data-testid="season-stats">
      <div style={column}>
        <h1 style={title}>Season stats</h1>
        <p style={lede}>{seasonLine(stats, year)}</p>
        <p style={aside}>Numbers so far this season. Tap “The numbers” on any card for the table behind it.</p>

        {loading ? (
          <div role="status" aria-label="Loading your season stats" data-testid="season-stats-loading">
            <div style={skeleton} /><div style={skeleton} />
          </div>
        ) : (
          <AsyncRegion error={error ? 'Couldn’t load your season stats.' : null} onRetry={refetch} retryLabel="Try again" errorTitle={null}
            empty={empty} emptyLabel={<EmptyState title="Nothing to show yet." body="Season stats fill in once this season has picks and weather." />}>
            <div data-testid="season-stats-list">
              {ids.map((id) => {
                const r = getRenderer(id)
                const section = stats.sections[id]
                const Body = r.Body
                return (
                  <StatCard key={id} id={id} title={r.title} verdict={verdictFor(id, section)} limits={limitsText(section)} table={safeTable(r, section)}>
                    <Body section={section} />
                  </StatCard>
                )
              })}
            </div>
          </AsyncRegion>
        )}
      </div>
    </div>
  )
}
