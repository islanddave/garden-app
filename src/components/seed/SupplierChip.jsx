// src/components/seed/SupplierChip.jsx — V5-SEEDCARDS-001. The supplier as a featured, coloured chip
// on a seed card: the supplier's designated fill (src/lib/supplierPalette.js), its secondary as the
// border (DASHED for a source that is not a shop — the non-colour cue), and its NAME as the text, which
// is the cue that never depends on colour. Composes the frozen <Badge> with a style override rather
// than adding per-supplier tones to it (components/forms/FROZEN.md).
//
// NOT a button, and deliberately not shaped like one: Botanical Interests' green is ~11 ΔE00 from the
// app's primary-button fill, so the chip keeps Badge's small pill metrics and carries no tap handler.
import React from 'react'
import Badge from '../forms/Badge.jsx'
import { T } from '../forms/formStyles.js'
import { supplierColors, supplierLabel, NO_SUPPLIER } from '../../lib/supplierPalette.js'

// `full` renders the supplier's whole name (the detail page); the default is the <=12-character short
// label a row uses. A PILL (radius 999) where state Badges keep radius 8, so shape alone tells a
// supplier from a state. Never ellipsised: the label is sized to fit.
export default function SupplierChip({ name, full = false, style, ...rest }) {
  const c = supplierColors(name) ?? NO_SUPPLIER
  const label = !name ? 'No supplier' : full ? name : supplierLabel(name)
  return (
    <Badge
      data-testid="supplier-chip"
      data-supplier={name || ''}
      title={name || 'No supplier on record'}
      aria-label={name ? `Supplier: ${name}` : 'No supplier on record'}
      style={{
        backgroundColor: c.primary,
        color: c.on,
        border: `1px ${c.shop === false ? 'dashed' : 'solid'} ${c.secondary}`,
        borderRadius: 999,
        fontSize: T.type.xs,
        fontWeight: 700,
        flex: '0 0 auto',
        whiteSpace: full ? 'normal' : 'nowrap',
        ...style,
      }}
      {...rest}
    >
      {label}
    </Badge>
  )
}
