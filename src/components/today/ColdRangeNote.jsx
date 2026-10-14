import React from 'react'
import { coldRangeLow } from '../../lib/coldRange.js'
import { P } from '../../lib/constants.js'
import { T } from '../forms/formStyles.js'

// V5-WXCOLDBAND-001 — "as cold as 41°" beside tonight's low, on the V2 glance row and in WeatherWidget.
// When to show it is coldRangeLow's call (src/lib/coldRange.js); this only prints it. Quiet text in the
// low's own muted color: display only, never alert styling.
// `phrase` (Today finish plan §3.2, 2026-10-14): the redesigned Today reads "could reach 41°" — "as cold as" is a
// comparison with no second term. The old page passes nothing and keeps "as cold as".
export default function ColdRangeNote({ coldRange, planDate, lowShown, phrase = 'as cold as' }) {
  const cold = coldRangeLow(coldRange, { planDate, lowShown })
  if (cold == null) return null
  return (
    <span data-testid="cold-range" style={noteStyle}>
      {`${phrase} ${cold}°`}
    </span>
  )
}

const noteStyle = {
  alignSelf: 'center', whiteSpace: 'nowrap', fontSize: T.type.xs, fontWeight: 400, lineHeight: 1.2, color: P.mid,
}
