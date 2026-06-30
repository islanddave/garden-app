// V3-PRIMITIVES-001 — freeze guard for the canonical shared primitive set.
// The barrel src/components/forms/index.js is the single source of truth for shared
// primitives. This test pins the EXACT export surface so the set cannot drift silently:
//   - removing/renaming a primitive  -> "missing" failure
//   - exporting a new ad-hoc primitive without updating the freeze -> "unexpected" failure
// To intentionally change the set: edit FROZEN below AND src/components/forms/FROZEN.md in
// the same change. See src/components/forms/FROZEN.md.
import { describe, it, expect } from 'vitest'
import * as forms from '../components/forms/index.js'

// The frozen canonical set (component exports) + the formStyles token namespace.
const FROZEN = [
  'Card', 'Section', 'PageShell',
  'Field', 'Input', 'Textarea', 'Select', 'EnumSelect', 'StatusSelect', 'SelectChip',
  'Button', 'Badge',
  'SegmentedControl', 'Sheet',
  'EventTypePicker', 'ScopeChecklist', 'PlantForm',
  'Spinner', 'ErrorBanner', 'Toast',
  'formStyles',
]

describe('forms primitive freeze (V3-PRIMITIVES-001)', () => {
  it('exports exactly the frozen set — no missing, no unexpected', () => {
    const actual = Object.keys(forms).sort()
    const frozen = [...FROZEN].sort()
    const missing = frozen.filter(k => !actual.includes(k))
    const unexpected = actual.filter(k => !frozen.includes(k))
    expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] })
  })

  it('every frozen component export is defined', () => {
    for (const name of FROZEN) {
      if (name === 'formStyles') continue
      expect(forms[name], `forms.${name} should be defined`).toBeTruthy()
    }
  })

  it('formStyles exposes the token namespace (T)', () => {
    expect(forms.formStyles).toBeTruthy()
    expect(forms.formStyles.T).toBeTruthy()
  })
})
