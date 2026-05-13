// Unit tests for src/lib/photoKeys.js
import { describe, it, expect } from 'vitest';
import { buildPhotoKey, extFromFile, mimeFromFile, PHOTO_PREFIXES } from '../lib/photoKeys.js';

describe('buildPhotoKey', () => {
  it('builds standalone key without id', () => {
    expect(buildPhotoKey({ prefix: 'standalone', uuid: 'abc-123', ext: 'jpg' }))
      .toBe('standalone/abc-123.jpg');
  });

  it('builds events key with id', () => {
    expect(buildPhotoKey({ prefix: 'events', id: 'E1', uuid: 'p-1', ext: 'jpg' }))
      .toBe('events/E1/p-1.jpg');
  });

  it.each(['projects', 'plants', 'locations', 'inventory'])('builds %s key', (prefix) => {
    expect(buildPhotoKey({ prefix, id: 'PA', uuid: 'u1', ext: 'png' }))
      .toBe(`${prefix}/PA/u1.png`);
  });

  it('throws on unknown prefix', () => {
    expect(() => buildPhotoKey({ prefix: 'varieties', id: 'V', uuid: 'u', ext: 'jpg' })).toThrow();
  });

  it('throws when uuid missing', () => {
    expect(() => buildPhotoKey({ prefix: 'standalone', ext: 'jpg' })).toThrow(/uuid/);
  });

  it('throws when uuid contains unsafe chars', () => {
    expect(() => buildPhotoKey({ prefix: 'standalone', uuid: '../etc', ext: 'jpg' })).toThrow();
  });

  it('throws when ext missing', () => {
    expect(() => buildPhotoKey({ prefix: 'standalone', uuid: 'u' })).toThrow(/ext/);
  });

  it('throws when ext has a dot', () => {
    expect(() => buildPhotoKey({ prefix: 'standalone', uuid: 'u', ext: '.jpg' })).toThrow();
  });

  it('throws when id missing for non-standalone prefix', () => {
    expect(() => buildPhotoKey({ prefix: 'events', uuid: 'u', ext: 'jpg' })).toThrow(/id is required/);
  });

  it('throws when id contains slash', () => {
    expect(() => buildPhotoKey({ prefix: 'events', id: 'a/b', uuid: 'u', ext: 'jpg' })).toThrow();
  });

  it('exposes the frozen prefix list', () => {
    expect(Object.isFrozen(PHOTO_PREFIXES)).toBe(true);
    expect(PHOTO_PREFIXES).toContain('standalone');
    expect(PHOTO_PREFIXES).toContain('inventory');
  });
});

describe('extFromFile', () => {
  it('prefers explicit', () => {
    expect(extFromFile({ name: 'a.png', type: 'image/png' }, 'webp')).toBe('webp');
  });

  it('falls back to filename ext', () => {
    expect(extFromFile({ name: 'photo.JPG', type: '' }, null)).toBe('jpg');
  });

  it('derives from MIME when no filename ext', () => {
    expect(extFromFile({ name: 'noext', type: 'image/png' }, null)).toBe('png');
    expect(extFromFile({ name: 'noext', type: 'image/heic' }, null)).toBe('heic');
  });

  it('defaults to jpg as final fallback', () => {
    expect(extFromFile({ name: '', type: '' }, null)).toBe('jpg');
    expect(extFromFile(null, null)).toBe('jpg');
  });

  it('ignores invalid explicit values', () => {
    expect(extFromFile({ name: 'a.png' }, '../jpg')).toBe('png');
  });
});

describe('mimeFromFile', () => {
  it('returns file.type when present', () => {
    expect(mimeFromFile({ type: 'image/png' })).toBe('image/png');
  });
  it('defaults to image/jpeg', () => {
    expect(mimeFromFile({})).toBe('image/jpeg');
    expect(mimeFromFile(null)).toBe('image/jpeg');
  });
});
