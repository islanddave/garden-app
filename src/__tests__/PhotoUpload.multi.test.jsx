// PhotoUpload.multi.test.jsx — V4-PHOTOBULK-001 S1 (design V100 §3 B2, B3, X1, X6).
//
// Covers the multi-attach branch of <PhotoUpload> and, just as load-bearing, the proof that the
// single branch did not move. The sibling PhotoUpload.test.jsx is the OTHER half of B2: it is the
// pre-existing suite and it must pass UNMODIFIED, so nothing in this file may edit it.
//
// DUAL-BRANCH (§3 X1, house pattern = SpacePhotos.flagOn/flagOff): the flag is mocked explicitly in
// each describe rather than read from source, so a future flip of PHOTO_MULTI_ATTACH_ENABLED cannot
// silently delete either branch's coverage by making one of them unreachable.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const { uploadSpy, stateRef, flagRef } = vi.hoisted(() => ({
  uploadSpy: vi.fn(),
  stateRef: { current: { isUploading: false, error: null, photo: null, preview: null } },
  flagRef: { current: true },
}));

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: uploadSpy,
    isUploading: stateRef.current.isUploading,
    error: stateRef.current.error,
    photo: stateRef.current.photo,
    preview: stateRef.current.preview,
    reset: vi.fn(),
    stage: stateRef.current.stage ?? null,
    progress: stateRef.current.progress ?? null,
  }),
}));

// importActual spread so every OTHER flag keeps its real value — mocking the module wholesale would
// silently zero PROJECTS_HIDDEN et al and change what this component renders for unrelated reasons.
vi.mock('../lib/featureFlags.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, get PHOTO_MULTI_ATTACH_ENABLED() { return flagRef.current; } };
});

import { PhotoUpload } from '../components/PhotoUpload.jsx';

const createdUrls = [];
const revokedUrls = [];
let origCreate;
let origRevoke;

beforeEach(() => {
  uploadSpy.mockReset();
  stateRef.current = { isUploading: false, error: null, photo: null, preview: null };
  flagRef.current = true;
  createdUrls.length = 0;
  revokedUrls.length = 0;
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  let n = 0;
  URL.createObjectURL = vi.fn(() => { const u = `blob:multi-${++n}`; createdUrls.push(u); return u; });
  URL.revokeObjectURL = vi.fn((u) => { revokedUrls.push(u); });
});

afterEach(() => {
  // jsdom ships NEITHER of these, so `origRevoke` is undefined — and RTL's auto-cleanup unmount runs
  // in its own afterEach, i.e. possibly AFTER this one. Restoring a literal undefined therefore made
  // the component's own unmount revocation throw inside React's commit phase, which surfaced as nine
  // failures that had nothing to do with the component. Always leave a callable behind.
  URL.createObjectURL = typeof origCreate === 'function' ? origCreate : (() => 'blob:noop');
  URL.revokeObjectURL = typeof origRevoke === 'function' ? origRevoke : (() => {});
});

const file = (name) => new File(['x'], name, { type: 'image/jpeg' });
const ok = (id) => ({ photo: { id, storage_path: `k/${id}.jpg` } });

async function pick(files) {
  const input = screen.getByTestId('photo-upload-input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => { fireEvent.change(input); });
}

describe('PhotoUpload multi — flag ON', () => {
  it('B2: the single-mode DOM is unchanged — no `multiple` attribute without the prop', () => {
    render(<PhotoUpload />);
    expect(screen.getByTestId('photo-upload-input').hasAttribute('multiple')).toBe(false);
  });

  it('renders `multiple` only when the prop asks for it', () => {
    render(<PhotoUpload multiple />);
    expect(screen.getByTestId('photo-upload-input').hasAttribute('multiple')).toBe(true);
  });

  it('B1/B3: three files picked in ONE invocation upload serially and all three land', async () => {
    const order = [];
    uploadSpy.mockImplementation(async (f) => { order.push(f.name); return ok(f.name); });
    const onComplete = vi.fn();
    render(<PhotoUpload multiple onUploadComplete={onComplete} />);

    await pick([file('a.jpg'), file('b.jpg'), file('c.jpg')]);

    expect(uploadSpy).toHaveBeenCalledTimes(3);
    // X6: serial, in pick order. A parallel implementation would still call three times, so the
    // ORDER plus the single-flight assertion below is what actually pins the concurrency.
    expect(order).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // The array form. Callers discriminate on Array.isArray, so this shape IS the contract.
    const arg = onComplete.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg.map(p => p.id)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('X6: never more than one upload in flight at a time', async () => {
    let live = 0;
    let peak = 0;
    uploadSpy.mockImplementation(async (f) => {
      live += 1; peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
      return ok(f.name);
    });
    render(<PhotoUpload multiple />);
    await pick([file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')]);
    expect(peak).toBe(1);
  });

  it('B3: a failure on file 2 of 3 does not abort 1 and 3, and is reported PER FILE', async () => {
    uploadSpy.mockImplementation(async (f) =>
      (f.name === 'b.jpg' ? { error: 'S3 refused b' } : ok(f.name)));
    const onComplete = vi.fn();
    const onError = vi.fn();
    render(<PhotoUpload multiple onUploadComplete={onComplete} onUploadError={onError} />);

    await pick([file('a.jpg'), file('b.jpg'), file('c.jpg')]);

    expect(uploadSpy).toHaveBeenCalledTimes(3);            // 1 and 3 still ran
    expect(onComplete.mock.calls[0][0].map(p => p.id)).toEqual(['a.jpg', 'c.jpg']);
    // onUploadError keeps its SINGLE-error shape, fired once for the one file that failed.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('S3 refused b');

    // The per-file surface: exactly one item in error, and it names its own reason. A single
    // collapsed banner is what B3 forbids, so assert the failure is attached to a row.
    const items = screen.getAllByTestId('photo-upload-staged-item');
    expect(items.map(el => el.getAttribute('data-status'))).toEqual(['done', 'error', 'done']);
    expect(screen.getAllByTestId('photo-upload-staged-error')).toHaveLength(1);
    expect(screen.getByTestId('photo-upload-staged-error').textContent).toContain('S3 refused b');
  });

  it('B3: the hook-level collapsed banner does NOT render in multi mode', async () => {
    stateRef.current.error = 'last file failed';
    render(<PhotoUpload multiple errorMode="surface" />);
    expect(screen.queryByTestId('photo-upload-error')).toBeNull();
  });

  it('the collapsed banner DOES still render in single mode', () => {
    stateRef.current.error = 'it failed';
    render(<PhotoUpload errorMode="surface" />);
    expect(screen.getByTestId('photo-upload-error').textContent).toContain('it failed');
  });

  it('does not call onUploadComplete at all when every file failed', async () => {
    uploadSpy.mockResolvedValue({ error: 'nope' });
    const onComplete = vi.fn();
    render(<PhotoUpload multiple onUploadComplete={onComplete} />);
    await pick([file('a.jpg'), file('b.jpg')]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('onUploadStart fires ONCE per batch, so a caller busy-bit stays balanced', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    const onStart = vi.fn();
    const onComplete = vi.fn();
    render(<PhotoUpload multiple onUploadStart={onStart} onUploadComplete={onComplete} />);
    await pick([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('caps the batch at maxFiles and says how many were dropped', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    render(<PhotoUpload multiple maxFiles={2} />);
    await pick([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('photo-upload-stage-notice').textContent)
      .toContain('1 not added');
  });

  it('remove revokes that file\'s object URL and drops only that row', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    render(<PhotoUpload multiple />);
    await pick([file('a.jpg'), file('b.jpg')]);
    expect(screen.getAllByTestId('photo-upload-staged-item')).toHaveLength(2);

    await act(async () => { fireEvent.click(screen.getAllByTestId('photo-upload-staged-remove')[0]); });
    expect(screen.getAllByTestId('photo-upload-staged-item')).toHaveLength(1);
    expect(revokedUrls).toContain(createdUrls[0]);
    expect(revokedUrls).not.toContain(createdUrls[1]);
  });

  it('unmount revokes every staged object URL — N in, N out', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    const { unmount } = render(<PhotoUpload multiple />);
    await pick([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    expect(createdUrls).toHaveLength(3);
    expect(revokedUrls).toHaveLength(0);
    await act(async () => { unmount(); });
    expect(new Set(revokedUrls)).toEqual(new Set(createdUrls));
  });

  // HALF ONE of a two-file guard; the other half is in PlantingPhotoSheet.test.jsx. jsdom cannot see
  // that the 216px cap hid 7 of 10 tiles inside the sheet — that took a browser
  // (tests/harness/plantingphotosheet.jsx) — but it CAN see which cap each caller gets, which is the
  // decision that measurement produced. Reverting either side fails one of the two.
  it('keeps the built-in card-footer cap when no stripMaxHeight is passed', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    render(<PhotoUpload multiple />);
    await pick([file('a.jpg')]);
    expect(screen.getByTestId('photo-upload-staged').style.maxHeight).toBe('216px');
  });

  it('honours stripMaxHeight when a caller has room for the whole batch', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    render(<PhotoUpload multiple stripMaxHeight="none" />);
    await pick([file('a.jpg')]);
    expect(screen.getByTestId('photo-upload-staged').style.maxHeight).toBe('none');
  });

  it('a second trip to the picker APPENDS rather than replacing', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    render(<PhotoUpload multiple />);
    await pick([file('a.jpg')]);
    await pick([file('b.jpg')]);
    expect(screen.getAllByTestId('photo-upload-staged-item')).toHaveLength(2);
  });

  it('forwards the SAME linkage to every file in the batch (§3 B4 — real parent, no inbox)', async () => {
    uploadSpy.mockImplementation(async (f) => ok(f.name));
    render(<PhotoUpload multiple keyPrefix="plants" parentId="p1" linkage={{ plant_id: 'p1' }} />);
    await pick([file('a.jpg'), file('b.jpg')]);
    for (const call of uploadSpy.mock.calls) {
      expect(call[1].keyPrefix).toBe('plants');
      expect(call[1].parentId).toBe('p1');
      expect(call[1].linkage).toEqual({ plant_id: 'p1' });
      // Nothing on this path may invent an intake_status or route to the Track A inbox.
      expect(call[1].linkage).not.toHaveProperty('intake_status');
      expect(call[1].keyPrefix).not.toBe('inbox');
    }
  });
});

describe('PhotoUpload multi — flag OFF (X1: byte-identical)', () => {
  beforeEach(() => { flagRef.current = false; });

  it('the `multiple` prop is INERT — no attribute, no strip', async () => {
    uploadSpy.mockResolvedValue(ok('a.jpg'));
    render(<PhotoUpload multiple />);
    expect(screen.getByTestId('photo-upload-input').hasAttribute('multiple')).toBe(false);
    await pick([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    // Single semantics: files[0] only, one call, one photo object.
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][0].name).toBe('a.jpg');
    expect(screen.queryByTestId('photo-upload-staged')).toBeNull();
  });

  it('onUploadComplete still receives ONE photo object, not an array', async () => {
    uploadSpy.mockResolvedValue(ok('a.jpg'));
    const onComplete = vi.fn();
    render(<PhotoUpload multiple onUploadComplete={onComplete} />);
    await pick([file('a.jpg'), file('b.jpg')]);
    expect(Array.isArray(onComplete.mock.calls[0][0])).toBe(false);
    expect(onComplete.mock.calls[0][0].id).toBe('a.jpg');
  });

  it('the collapsed hook banner comes back, because it is the only report there is', () => {
    stateRef.current.error = 'it failed';
    render(<PhotoUpload multiple errorMode="surface" />);
    expect(screen.getByTestId('photo-upload-error').textContent).toContain('it failed');
  });
});
