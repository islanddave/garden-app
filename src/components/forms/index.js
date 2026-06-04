// src/components/forms/index.js
// Lane D / Phase A barrel — canonical shared form primitives. Import from here:
//   import { Field, Input, Select, Textarea, Button, Card, Section, PageShell,
//            Spinner, ErrorBanner, Toast } from '../components/forms'
// Phases B/C/D/E migrate the ~14 scattered form surfaces onto these. formStyles
// tokens are re-exported for the rare consumer that needs raw chrome composition.
export { default as Field } from './Field.jsx'
export { default as Input } from './Input.jsx'
export { default as Select } from './Select.jsx'
export { default as Textarea } from './Textarea.jsx'
export { default as Button } from './Button.jsx'
export { default as EnumSelect } from './EnumSelect.jsx'
export { default as StatusSelect } from './StatusSelect.jsx'
export { default as EventTypePicker } from './EventTypePicker.jsx'
export { default as Card } from './Card.jsx'
export { default as Section } from './Section.jsx'
export { default as PageShell } from './PageShell.jsx'
export { default as Spinner } from './Spinner.jsx'
export { default as ErrorBanner } from './ErrorBanner.jsx'
export { default as Toast } from './Toast.jsx'
export * as formStyles from './formStyles.js'
