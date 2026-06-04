// src/components/forms/StatusSelect.jsx
// Lane D / Phase B+C — status <select> that consumes the SAME status registry the
// badges render from (constants.js), so the select can never offer a value the
// badge can't show. `kind="plant"|"project"` picks the vocabulary; labels come from
// statusLabel() (single humanizer). Alpha-sorted by label.
import React from 'react'
import EnumSelect from './EnumSelect.jsx'
import { PLANT_STATUSES, PROJECT_STATUSES, statusLabel } from '../../lib/constants.js'

export default function StatusSelect({ kind = 'plant', emptyLabel = '— none —', ...rest }) {
  const values = kind === 'project' ? PROJECT_STATUSES : PLANT_STATUSES
  const enumValues = values.map(v => ({ value: v, label: statusLabel(v) }))
  return <EnumSelect enumValues={enumValues} placeholder={emptyLabel} {...rest} />
}
