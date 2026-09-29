// Contact links for a source (seller, nursery, farm stand, person). Shared by the
// saved-seed cards on Season stats and the source edit screen.

const SOCIAL_BASE = {
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
};

// Accepts a full URL, a bare domain path, "@handle" or "handle". Returns an
// https URL string, or null for blank input. Never throws.
export function normalizeSocialUrl(kind, input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = SOCIAL_BASE[kind];
  if (!base) return /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(raw) ? `https://${raw}` : raw;
  const host = kind === 'instagram' ? /^(www\.)?instagram\.com\//i : /^(www\.|m\.)?facebook\.com\//i;
  if (host.test(raw)) return `https://www.${raw.replace(/^(www\.|m\.)/i, '')}`;
  const handle = raw.replace(/^@+/, '').replace(/\/+$/, '');
  return handle ? base + encodeURIComponent(handle).replace(/%2F/g, '/') : null;
}

export function normalizeWebsiteUrl(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

// Only chips whose field is filled; order is fixed so cards line up.
export function sourceLinkChips(source) {
  if (!source) return [];
  const chips = [];
  if (isHttp(source.website_url)) chips.push({ kind: 'website', label: 'Website', href: source.website_url });
  if (isHttp(source.instagram_url)) chips.push({ kind: 'instagram', label: 'Instagram', href: source.instagram_url });
  if (isHttp(source.facebook_url)) chips.push({ kind: 'facebook', label: 'Facebook', href: source.facebook_url });
  const addr = typeof source.address === 'string' ? source.address.trim() : '';
  if (addr) chips.push({ kind: 'address', label: 'Map', href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}` });
  return chips;
}
