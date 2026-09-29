import { describe, it, expect } from 'vitest';
import { normalizeSocialUrl, normalizeWebsiteUrl, sourceLinkChips } from '../lib/sourceLinks';

describe('normalizeSocialUrl', () => {
  it('returns null for blank input', () => {
    expect(normalizeSocialUrl('instagram', '')).toBeNull();
    expect(normalizeSocialUrl('instagram', '   ')).toBeNull();
    expect(normalizeSocialUrl('facebook', null)).toBeNull();
    expect(normalizeSocialUrl('facebook', '@')).toBeNull();
  });
  it('keeps full URLs as typed', () => {
    expect(normalizeSocialUrl('instagram', 'https://www.instagram.com/skawskifarms/')).toBe('https://www.instagram.com/skawskifarms/');
  });
  it('turns a handle into a profile URL', () => {
    expect(normalizeSocialUrl('instagram', '@skawskifarms')).toBe('https://www.instagram.com/skawskifarms');
    expect(normalizeSocialUrl('facebook', 'StarviewGardens')).toBe('https://www.facebook.com/StarviewGardens');
  });
  it('adds a scheme to a pasted host path', () => {
    expect(normalizeSocialUrl('instagram', 'instagram.com/abc')).toBe('https://www.instagram.com/abc');
    expect(normalizeSocialUrl('facebook', 'm.facebook.com/abc')).toBe('https://www.facebook.com/abc');
  });
});

describe('normalizeWebsiteUrl', () => {
  it('adds https when missing', () => {
    expect(normalizeWebsiteUrl('skawskifarms.com')).toBe('https://skawskifarms.com');
    expect(normalizeWebsiteUrl('http://a.org')).toBe('http://a.org');
    expect(normalizeWebsiteUrl(' ')).toBeNull();
  });
});

describe('sourceLinkChips', () => {
  it('returns nothing for a missing source', () => {
    expect(sourceLinkChips(null)).toEqual([]);
  });
  it('shows only filled fields, in a fixed order', () => {
    const chips = sourceLinkChips({ website_url: 'https://x.com', facebook_url: 'https://www.facebook.com/x', instagram_url: null, address: '' });
    expect(chips.map((c) => c.kind)).toEqual(['website', 'facebook']);
  });
  it('ignores non-http values', () => {
    expect(sourceLinkChips({ website_url: 'javascript:alert(1)' })).toEqual([]);
  });
  it('links an address to a map search', () => {
    const [c] = sourceLinkChips({ address: '12 Main St, Greenfield, MA' });
    expect(c.kind).toBe('address');
    expect(c.href).toContain(encodeURIComponent('12 Main St, Greenfield, MA'));
  });
});
