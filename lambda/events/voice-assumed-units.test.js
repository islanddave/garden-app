// V5-VOICEVOCAB-001 (QA F11) — the events Lambda accepts the voice page's assumed-unit marker.
//
// metadata.assumed_units is the first ARRAY-valued key in event_log.metadata (lane D1): the voice
// harvest page records which units it inferred rather than heard — ['count', 'g'], ['count'], ['g'],
// the crop's default unit ('head'), or [] when both were spoken. Acceptance was checked ad hoc in lane D1
// (validatePostBody returned null for each shape); nothing committed pinned it, so a validator that
// began policing metadata keys, or rejecting nested arrays, would break every voice save with no red
// test. DB-free and pure: the body below is the exact shape VoiceHarvest.jsx's saveRecord POSTs.
import { describe, it, expect } from 'vitest';
import { validatePostBody, validateEventMetadata } from './validators.js';

const PLANT = '11111111-1111-4111-8111-111111111111';
const voiceHarvest = (assumed) => ({
  project_id: null,
  event_type: 'harvest',
  event_date: '2026-09-24',
  notes: null,
  private_notes: null,
  quantity: null,
  plant_id: PLANT,
  has_photo: false,
  metadata: { harvest_input_source: 'voice', assumed_units: assumed },
  harvest: { quantity: 2, unit: 'count', quality_rating: null, weight: 165, weight_unit: 'g' },
});

describe('validatePostBody — the voice page\'s metadata.assumed_units is accepted as sent', () => {
  it.each([
    [['count', 'g']], [['count']], [['g']], [['head']], [[]],
  ])('assumed_units %j', (assumed) => {
    expect(validatePostBody(voiceHarvest(assumed))).toBeNull();
    expect(validateEventMetadata(voiceHarvest(assumed).metadata)).toBeNull();
  });

  it('the validator does read metadata — a non-object is still refused (the control)', () => {
    // Without this, a validator that ignored metadata entirely would pass every case above.
    const body = { ...voiceHarvest(['count', 'g']), metadata: ['count', 'g'] };
    const r = validatePostBody(body);
    expect(r?.status).toBe(400);
    expect(r?.error).toMatch(/metadata must be an object/);
  });
});
