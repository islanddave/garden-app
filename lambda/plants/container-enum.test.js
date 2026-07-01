// BUG-CONTVAL-001 static-source guard: the plants Lambda ALLOWED_CONTAINER enum
// must stay in lockstep with the live DB CHECK chk_plants_container_type (14 values,
// verified against prod 2026-07-01) and the frontend PLANT_CONTAINER_TYPE_OPTIONS.
// Regression class L-091 (constraint-vs-code drift); the stale 10-value list rejected
// valid `trough` plantings (8 live rows) at the add-planting API.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const REQUIRED = ['fabric_bag','plastic_pot','terracotta','ceramic','raised_bed','in_ground','tray_cell','hanging_basket','window_box','trough','whiskey_barrel','soil_block','solo_cup','other'];

describe('BUG-CONTVAL-001 container_type enum parity', () => {
  it('ALLOWED_CONTAINER includes every live DB CHECK value (incl. trough)', () => {
    const m = SRC.match(/ALLOWED_CONTAINER\s*=\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    for (const v of REQUIRED) expect(m[1]).toContain(`'${v}'`);
  });
  it('defines ALLOWED_CONTAINER on both the create and update paths', () => {
    const count = (SRC.match(/ALLOWED_CONTAINER\s*=/g) || []).length;
    expect(count).toBe(2);
  });
});
