// src/components/forms/EnumSelect.jsx
// Lane D / Phase B+C — enum-driven <select> on the Phase A Select primitive.
// `enumValues` accepts [{value,label}] | [{v,label}] | string[]; options are
// alphabetized by label (app-wide alpha rule, V3-SORT-001/V3-ORDER-001) and the
// `label` is the SOLE humanizer (no per-surface casing transforms). Inherits all
// Select escape hatches / ARIA / chrome.
import React from 'react'
import Select from './Select.jsx'

export default function EnumSelect({ enumValues, sort = true, placeholder, ...rest }) {
  let opts = (enumValues ?? []).map(o =>
    (o && typeof o === 'object') ? { value: o.value ?? o.v, label: o.label ?? String(o.value ?? o.v) }
                                 : { value: o, label: String(o) }
  )
  if (sort) opts = [...opts].sort((a, b) => String(a.label).localeCompare(String(b.label)))
  return <Select options={opts} placeholder={placeholder} {...rest} />
}
