// V4-SEEDINV-001 unit tests for the extract-seeds pure module.
// Imports ONLY extract.js (dep-free) — index.js is guarded separately by the
// static-source tests in sow-routes.test.js because it imports SDK modules at load.

import { describe, it, expect } from 'vitest';
import { validateExtractRequest, buildAnthropicRequest, parseExtractResponse } from './extract.js';

const B64 = 'aGVsbG8gd29ybGQ='; // "hello world"

function packet(overrides = {}) {
  return {
    name: 'Tomato Black Krim',
    crop: 'Tomato',
    variety: 'Black Krim',
    quantity_on_hand: 2,
    vendor: 'Botanical Interests',
    source: 'Botanical Interests',
    source_url: 'https://example.com/black-krim',
    purchase_date: '2026-02-14',
    price_usd: 3.29,
    sku: 'BI-1234',
    metadata: { seeds_per_packet: 30, organic: true, heirloom: true, item_category: 'vegetable' },
    crop_type_slug_guess: 'tomato',
    sow_profile: {
      life_cycle: 'annual',
      season: 'warm',
      sun: 'full sun',
      start_method: 'start indoors',
      start_indoor_weeks_before_lastfrost: '6-8',
      direct_sow_timing: null,
      sow_depth_in: '0.25',
      seed_spacing_in: '24',
      row_spacing_in: '36',
      days_to_germ: '7-14',
      days_to_maturity: '80-90',
      zone_notes: null,
      packet_notes: 'Indeterminate.',
    },
    needs_confirmation: [],
    ...overrides,
  };
}

describe('validateExtractRequest', () => {
  const cases = [
    [null, /body required/],
    [[], /body required/],
    [{}, /mode must be one of/],
    [{ mode: 'audio' }, /mode must be one of/],
    [{ mode: 'text' }, /non-empty text/],
    [{ mode: 'text', text: '' }, /non-empty text/],
    [{ mode: 'text', text: '   ' }, /non-empty text/],
    [{ mode: 'text', text: 42 }, /non-empty text/],
    [{ mode: 'text', text: 'x'.repeat(50_001) }, /exceeds 50000 characters/],
    [{ mode: 'image' }, /requires image_base64/],
    [{ mode: 'image', image_base64: '' }, /requires image_base64/],
    [{ mode: 'image', image_base64: 'data:image/png;base64,AAAA', media_type: 'image/png' }, /raw base64/],
    [{ mode: 'image', image_base64: 'not base64!!', media_type: 'image/png' }, /raw base64/],
    [{ mode: 'image', image_base64: B64 }, /media_type must be one of/],
    [{ mode: 'image', image_base64: B64, media_type: 'image/gif' }, /media_type must be one of/],
  ];
  for (const [body, errRe] of cases) {
    it(`rejects ${JSON.stringify(body)?.slice(0, 60)} with 400`, () => {
      const r = validateExtractRequest(body);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(400);
      expect(r.error).toMatch(errRe);
    });
  }

  it('accepts valid text mode', () => {
    expect(validateExtractRequest({ mode: 'text', text: 'Order #123: Tomato Black Krim x1' })).toEqual({ ok: true });
  });
  it('accepts text at exactly the 50000-char cap', () => {
    expect(validateExtractRequest({ mode: 'text', text: 'x'.repeat(50_000) })).toEqual({ ok: true });
  });
  for (const mt of ['image/jpeg', 'image/png', 'image/webp']) {
    it(`accepts valid image mode with ${mt}`, () => {
      expect(validateExtractRequest({ mode: 'image', image_base64: B64, media_type: mt })).toEqual({ ok: true });
    });
  }
});

describe('buildAnthropicRequest', () => {
  it('text mode: sonnet model, 8192 max_tokens, ONE user message with a single text block containing prompt + pasted order', () => {
    const req = buildAnthropicRequest({ mode: 'text', text: 'ORDER-XYZ pasted here' });
    expect(req.model).toBe('claude-sonnet-4-5');
    expect(req.max_tokens).toBe(8192);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
    expect(req.messages[0].content).toHaveLength(1);
    expect(req.messages[0].content[0].type).toBe('text');
    const text = req.messages[0].content[0].text;
    expect(text).toContain('JSON array');
    expect(text).toContain('sow_profile');
    expect(text).toContain('needs_confirmation');
    expect(text).toContain('ORDER-XYZ pasted here');
  });

  it('image mode: content = [base64 image block, text prompt]', () => {
    const req = buildAnthropicRequest({ mode: 'image', image_base64: B64, media_type: 'image/webp' });
    expect(req.model).toBe('claude-sonnet-4-5');
    expect(req.max_tokens).toBe(8192);
    expect(req.messages).toHaveLength(1);
    const [img, txt] = req.messages[0].content;
    expect(img).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: B64 } });
    expect(txt.type).toBe('text');
    expect(txt.text).toContain('JSON array');
  });
});

describe('parseExtractResponse', () => {
  it('happy path: bare JSON array round-trips with schema fields intact', () => {
    const r = parseExtractResponse(JSON.stringify([packet()]));
    expect(r.ok).toBe(true);
    expect(r.packets).toHaveLength(1);
    const p = r.packets[0];
    expect(p.name).toBe('Tomato Black Krim');
    expect(p.crop).toBe('Tomato');
    expect(p.variety).toBe('Black Krim');
    expect(p.quantity_on_hand).toBe(2);
    expect(p.purchase_date).toBe('2026-02-14');
    expect(p.price_usd).toBe(3.29);
    expect(p.sku).toBe('BI-1234');
    expect(p.crop_type_slug_guess).toBe('tomato');
    expect(p.metadata.seeds_per_packet).toBe(30);
    expect(p.metadata.organic).toBe(true);
    expect(p.sow_profile.start_indoor_weeks_before_lastfrost).toBe('6-8');
    expect(p.sow_profile.days_to_maturity).toBe('80-90');
    expect(p.needs_confirmation).toEqual([]);
  });

  it('strips ```json markdown fences', () => {
    const r = parseExtractResponse('```json\n' + JSON.stringify([packet()]) + '\n```');
    expect(r.ok).toBe(true);
    expect(r.packets[0].name).toBe('Tomato Black Krim');
  });

  it('strips bare ``` fences', () => {
    const r = parseExtractResponse('```\n' + JSON.stringify([packet()]) + '\n```');
    expect(r.ok).toBe(true);
    expect(r.packets).toHaveLength(1);
  });

  it('rejects arrays over 40 packets', () => {
    const arr = Array.from({ length: 41 }, () => packet());
    const r = parseExtractResponse(JSON.stringify(arr));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too many packets \(41 > 40\)/);
  });

  it('accepts exactly 40 packets', () => {
    const arr = Array.from({ length: 40 }, () => packet());
    const r = parseExtractResponse(JSON.stringify(arr));
    expect(r.ok).toBe(true);
    expect(r.packets).toHaveLength(40);
  });

  it('drops unknown top-level junk fields injected by the model', () => {
    const r = parseExtractResponse(JSON.stringify([packet({ __proto__pollute: 'x', totally_made_up: 1, sql: 'DROP TABLE' })]));
    expect(r.ok).toBe(true);
    const keys = Object.keys(r.packets[0]).sort();
    expect(keys).toEqual([
      'crop', 'crop_type_slug_guess', 'metadata', 'name', 'needs_confirmation',
      'price_usd', 'purchase_date', 'quantity_on_hand', 'sku', 'source',
      'source_url', 'sow_profile', 'variety', 'vendor',
    ]);
    expect(r.packets[0]).not.toHaveProperty('totally_made_up');
    expect(r.packets[0]).not.toHaveProperty('sql');
  });

  it('drops unknown sow_profile keys and keeps known ones', () => {
    const r = parseExtractResponse(JSON.stringify([packet({
      sow_profile: { days_to_germ: '5-10', invented_field: 'junk' },
    })]));
    expect(r.ok).toBe(true);
    expect(r.packets[0].sow_profile.days_to_germ).toBe('5-10');
    expect(r.packets[0].sow_profile).not.toHaveProperty('invented_field');
  });

  it('coerces numerics and defaults quantity_on_hand', () => {
    const r = parseExtractResponse(JSON.stringify([
      packet({ quantity_on_hand: '3', price_usd: '4.50' }),
      packet({ quantity_on_hand: undefined, price_usd: null }),
      packet({ quantity_on_hand: -5, price_usd: -1 }),
      packet({ quantity_on_hand: 2.9, price_usd: 'not a number' }),
    ]));
    expect(r.ok).toBe(true);
    expect(r.packets[0].quantity_on_hand).toBe(3);
    expect(r.packets[0].price_usd).toBe(4.5);
    expect(r.packets[1].quantity_on_hand).toBe(1); // default
    expect(r.packets[1].price_usd).toBeNull();
    expect(r.packets[2].quantity_on_hand).toBe(1); // negative -> default, never < 0
    expect(r.packets[2].price_usd).toBeNull();
    expect(r.packets[3].quantity_on_hand).toBe(2); // floored int
    expect(r.packets[3].price_usd).toBeNull();
  });

  it('nulls malformed purchase_date and caps oversized strings at 2000 chars', () => {
    const r = parseExtractResponse(JSON.stringify([
      packet({ purchase_date: 'Feb 14, 2026', vendor: 'v'.repeat(5000) }),
    ]));
    expect(r.ok).toBe(true);
    expect(r.packets[0].purchase_date).toBeNull();
    expect(r.packets[0].vendor).toHaveLength(2000);
  });

  it('replaces metadata with {} when its JSON serialization would exceed the 8000-byte cap', () => {
    const r = parseExtractResponse(JSON.stringify([
      packet({ metadata: { blob: 'm'.repeat(1900), blob2: 'm'.repeat(1900), blob3: 'm'.repeat(1900), blob4: 'm'.repeat(1900), blob5: 'm'.repeat(1900) } }),
    ]));
    expect(r.ok).toBe(true);
    expect(r.packets[0].metadata).toEqual({});
  });

  it('non-object sow_profile and metadata degrade to null / {}', () => {
    const r = parseExtractResponse(JSON.stringify([
      packet({ sow_profile: 'annual', metadata: [1, 2, 3], needs_confirmation: 'not-an-array' }),
    ]));
    expect(r.ok).toBe(true);
    expect(r.packets[0].sow_profile).toBeNull();
    expect(r.packets[0].metadata).toEqual({});
    expect(r.packets[0].needs_confirmation).toEqual([]);
  });

  it('rejects non-JSON output', () => {
    const r = parseExtractResponse('Sorry, I cannot find any seed packets in this image.');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid JSON/);
  });

  it('rejects a JSON object (not an array)', () => {
    const r = parseExtractResponse(JSON.stringify({ packets: [packet()] }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a JSON array/);
  });

  it('rejects a packet with no usable name', () => {
    const r = parseExtractResponse(JSON.stringify([packet(), packet({ name: '  ' })]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/packet 1 is missing a name/);
  });

  it('rejects a non-object packet entry', () => {
    const r = parseExtractResponse(JSON.stringify([packet(), 'stray string']));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/packet 1 is not an object/);
  });

  it('salvages an array wrapped in stray prose', () => {
    const r = parseExtractResponse('Here are the packets:\n' + JSON.stringify([packet()]) + '\nDone!');
    expect(r.ok).toBe(true);
    expect(r.packets).toHaveLength(1);
  });
});
