import React from 'react'
import { coldRangeLow } from '../../lib/coldRange.js'
import { P } from '../../lib/constants.js'
import { T } from '../forms/formStyles.js'

// V5-WXCOLDBAND-001 — "as cold as 41°" beside tonight's low, on the V2 glance row and in WeatherWidget.
// When to show it is coldRangeLow's call (src/lib/coldRange.js); this only prints it. Quiet text in the
// low's own muted color: display only, never alert styling.
export default function ColdRangeNote({ coldRange, planDate, lowShown }) {
  const cold = coldRangeLow(coldRange, { planDate, lowShown })
  if (cold == null) return null
  return (
    <span data-testid="cold-range" style={noteStyle}>
      {`as cold as ${cold}°`}
    </span>
  )
}

const noteStyle = {
  alignSelf: 'center', whiteSpace: 'nowrap', fontSize: T.type.xs, fontWeight: 400, lineHeight: 1.2, color: P.mid,
}
