import { describe, it, expect } from 'vitest';
import { normalizeSocialUrl, normalizeWebsiteUrl, sourceLinkChips, isBadLinkError, BAD_LINK_MESSAGE } from '../lib/sourceLinks';

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

// The server and the DB CHECK read the scheme case-sensitively; a phone capitalises the first letter.
describe('a capitalised scheme is lower-cased, the rest of the link kept', () => {
  it('Https:// and HTTPS:// on the social links', () => {
    expect(normalizeSocialUrl('instagram', 'Https://www.instagram.com/StarviewGardens')).toBe('https://www.instagram.com/StarviewGardens');
    expect(normalizeSocialUrl('facebook', 'HTTPS://www.facebook.com/Starview')).toBe('https://www.facebook.com/Starview');
    expect(normalizeSocialUrl('facebook', 'HTTP://www.facebook.com/x')).toBe('http://www.facebook.com/x');
  });
  it('Https:// and HTTPS:// on the website', () => {
    expect(normalizeWebsiteUrl('Https://RareSeeds.com/Shop')).toBe('https://RareSeeds.com/Shop');
    expect(normalizeWebsiteUrl('HTTPS://X.COM')).toBe('https://X.COM');
  });
  it('every result passes the server CHECK regex, case-sensitive', () => {
    for (const u of ['Https://a.org', 'HTTPS://a.org', 'hTtP://a.org']) {
      expect(normalizeWebsiteUrl(u)).toMatch(/^https?:\/\//);
      expect(normalizeSocialUrl('instagram', u)).toMatch(/^https?:\/\//);
    }
  });
});

describe('isBadLinkError', () => {
  it('a 400 naming a link field is a bad link; anything else is not', () => {
    expect(isBadLinkError({ status: 400, error: 'instagram_url must start with http:// or https://' })).toBe(true);
    expect(isBadLinkError({ status: 400, error: 'website_url must be a string or null' })).toBe(true);
    expect(isBadLinkError({ status: 400, error: 'name must be 2-200 characters' })).toBe(false);
    expect(isBadLinkError({ status: 500, error: 'facebook_url blew up' })).toBe(false);
    expect(BAD_LINK_MESSAGE).not.toMatch(/_url|http/);
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
