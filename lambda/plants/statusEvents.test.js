// V3-EVENT-003 — status-change event helper (pure). DB path proven separately via Neon CoW dry-run.
import { describe, it, expect } from 'vitest';
import { isStatusChange, formatStatusChangeNote, buildStatusChangeMetadata, STATUS_CHANGE_EVENT_TYPE } from './statusEvents.js';

describe('isStatusChange', () => {
  it('true only on an actual change', () => {
    expect(isStatusChange('vegetative', 'flowering')).toBe(true);
    expect(isStatusChange('vegetative', 'vegetative')).toBe(false);
  });
  it('null-safe', () => {
    expect(isStatusChange(null, 'seedling')).toBe(true);
    expect(isStatusChange(null, null)).toBe(false);
    expect(isStatusChange(undefined, null)).toBe(false);
  });
});

describe('formatStatusChangeNote', () => {
  it('uses display labels + arrow', () => {
    expect(formatStatusChangeNote('vegetative', 'flowering', 'plant')).toBe('Status: Vegetative → Flowering');
    expect(formatStatusChangeNote('growing', 'fruiting', 'project')).toBe('Status: Growing → Fruiting');
  });
  it('renders (unset) for null sides', () => {
    expect(formatStatusChangeNote(null, 'seedling', 'plant')).toBe('Status: (unset) → Seedling');
  });
  it('falls back to raw value for unknown status', () => {
    expect(formatStatusChangeNote('weird', 'flowering', 'plant')).toBe('Status: weird → Flowering');
  });
});

describe('buildStatusChangeMetadata', () => {
  it('emits the frozen status_change.v1 contract', () => {
    expect(buildStatusChangeMetadata('vegetative', 'flowering', 'plant')).toEqual({
      schema: 'status_change.v1', status_from: 'vegetative', status_to: 'flowering', entity_level: 'plant',
    });
  });
  it('null sides serialize as null', () => {
    expect(buildStatusChangeMetadata(null, 'seedling', 'plant').status_from).toBe(null);
  });
});

describe('STATUS_CHANGE_EVENT_TYPE', () => {
  it('is the reserved literal', () => { expect(STATUS_CHANGE_EVENT_TYPE).toBe('status_change'); });
});
