// V3-CONTAINEROPTS-001 / V3-SOLOCUP-001 — the canonical dropdown registry must include
// every container_type value that exists in prod data (trough/whiskey_barrel/soil_block)
// plus solo_cup. Guards against the registry drifting behind the DB CHECK again.
import { describe, it, expect } from 'vitest';
import { PLANT_CONTAINER_TYPE_OPTIONS, PLANT_CONTAINER_TYPE_LABELS } from '../lib/dropdownRegistry.js';

const REQUIRED = ['fabric_bag','plastic_pot','terracotta','ceramic','raised_bed','in_ground',
  'tray_cell','hanging_basket','window_box','trough','whiskey_barrel','soil_block','solo_cup','other'];

describe('PLANT_CONTAINER_TYPE_OPTIONS registry', () => {
  const values = PLANT_CONTAINER_TYPE_OPTIONS.map(o => o.value);
  it('includes every required container_type value', () => {
    const missing = REQUIRED.filter(v => !values.includes(v));
    expect(missing, `missing options: ${missing.join(', ')}`).toEqual([]);
  });
  it('newly added values carry derived labels', () => {
    for (const v of ['trough','whiskey_barrel','soil_block','solo_cup']) {
      expect(PLANT_CONTAINER_TYPE_LABELS[v]).toBeTruthy();
    }
  });
});
