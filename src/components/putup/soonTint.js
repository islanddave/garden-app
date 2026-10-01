// src/components/putup/soonTint.js
// Put-Up UX pass R1 (prep) — THE SOON TINT. A discard-date line whose status is "soon" or "past" is set on
// the warn background, in dark ink, at weight 600. The WORDS still carry the state ("… · soon", "discard
// date passed …"); the tint and the weight are two more channels beside them, and none of the three is an
// interrupt. One style object, so every surface that shows the line tints it the same way.
//
// TOKENS ONLY (P, src/lib/constants.js): no colour is spelled in this file. The padding and the radius are
// the ones the nearest tinted chip already uses — the "N use soon" pill on the planting page
// (planting/PutUpFromPlanting.jsx). The ink-on-background contrast is measured in
// src/__tests__/putUpSoonTint.test.jsx, against the AA floor and against the gold that pill used.
import { P } from '../../lib/tokens.js'

export const SOON_CHIP_STYLE = Object.freeze({
  backgroundColor: P.warn,
  color: P.dark,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 999,
})
