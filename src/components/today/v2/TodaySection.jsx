import React from 'react'
import FacetGroupHeader from '../../forms/FacetGroupHeader.jsx'
import { T } from '../../forms/formStyles.js'

// TodaySection — one section of the redesigned Today (plan-v2 §1.0, §4 "Section band", §5.2). V5-TODAYREDESIGN-001 S2.
//
// CONTROLLED: the page owns open/closed (Layer 1 + the visit, useTodaySections / useTodayVisit) and passes
// `open` + `onToggle`. The band is FacetGroupHeader's native mode — <h2><button aria-expanded>, title, count,
// a one-line summary — and the body is its panel: mounted only while open (closed means unmounted, never
// hidden), under an id from useId. Every band is identical: facet "type", no per-section tint, never sticky.
// Without `onToggle` it is the non-collapsible form: a static heading over a body that is always there.
//
// `data-testid="today-sec-<key>"` is the anchor gate:today-shape:v2 reads (today-v2-contract.mjs ANCHORS);
// its first [aria-expanded] is the header toggle. The gate treats EVERY testid starting "today-sec-" as a
// section, so nothing inside a section may carry one. The section sets no outer margin (the page's flex
// gap spaces sections); the band → body gap is T.space.xs.
export default function TodaySection({ sectionKey, title, count, summary, open = false, onToggle, headingLevel = 2, children, style }) {
  return (
    <section data-testid={`today-sec-${sectionKey}`} data-section={sectionKey} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs, ...style }}>
      <FacetGroupHeader
        headingLevel={headingLevel}
        size="section"
        facet="type"
        label={title}
        count={count}
        summary={summary}
        collapsed={!open}
        onToggle={onToggle}
      >
        {children}
      </FacetGroupHeader>
    </section>
  )
}
