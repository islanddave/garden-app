// Unit tests for src/components/PhotoUpload.jsx
// Render + interaction tests. Mock the upload hook to keep tests
// fast and decoupled from the 3-step network mocking already covered
// in useUploadPhoto.test.js.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { uploadSpy, stateRef } = vi.hoisted(() => ({
  uploadSpy: vi.fn(),
  stateRef: { current: { isUploading: false, error: null, photo: null, preview: null } },
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

import { PhotoUpload } from '../components/PhotoUpload.jsx';

beforeEach(() => {
  uploadSpy.mockReset();
  stateRef.current = { isUploading: false, error: null, photo: null, preview: null };
});

function fakeFile(name = 'p.jpg', type = 'image/jpeg') {
  return new File(['x'], name, { type });
}

describe('PhotoUpload — render', () => {
  it('renders trigger button with default label', () => {
    render(<PhotoUpload />);
    expect(screen.getByText('Add Photo')).toBeTruthy();
    expect(screen.getByTestId('photo-upload-input')).toBeTruthy();
  });

  it('renders custom buttonLabel', () => {
    render(<PhotoUpload buttonLabel="Take Photo" />);
    expect(screen.getByText('Take Photo')).toBeTruthy();
  });

  it('sets capture="environment" by default on the input', () => {
    render(<PhotoUpload />);
    const input = screen.getByTestId('photo-upload-input');
    expect(input.getAttribute('capture')).toBe('environment');
  });

  it('omits capture attribute when capture prop is empty string', () => {
    render(<PhotoUpload capture="" />);
    const input = screen.getByTestId('photo-upload-input');
    expect(input.hasAttribute('capture')).toBe(false);
  });

  it('omits capture attribute when capture prop is null', () => {
    render(<PhotoUpload capture={null} />);
    const input = screen.getByTestId('photo-upload-input');
    expect(input.hasAttribute('capture')).toBe(false);
  });

  it('input accepts image/* by default', () => {
    render(<PhotoUpload />);
    const input = screen.getByTestId('photo-upload-input');
    expect(input.getAttribute('accept')).toBe('image/*');
  });

  it('respects custom accept prop', () => {
    render(<PhotoUpload accept="image/png" />);
    const input = screen.getByTestId('photo-upload-input');
    expect(input.getAttribute('accept')).toBe('image/png');
  });
});

describe('PhotoUpload — upload trigger', () => {
  it('calls upload with file + props when input changes', async () => {
    uploadSpy.mockResolvedValueOnce({ photo: { id: 'p1' } });
    render(<PhotoUpload keyPrefix="plants" parentId="plant-1" linkage={{ plant_id: 'plant-1' }} />);
    const input = screen.getByTestId('photo-upload-input');
    const file = fakeFile();
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [calledFile, opts] = uploadSpy.mock.calls[0];
    expect(calledFile).toBe(file);
    expect(opts.keyPrefix).toBe('plants');
    expect(opts.parentId).toBe('plant-1');
    expect(opts.linkage).toEqual({ plant_id: 'plant-1' });
  });

  it('does nothing when no file selected', async () => {
    render(<PhotoUpload />);
    const input = screen.getByTestId('photo-upload-input');
    await act(async () => {
      fireEvent.change(input, { target: { files: [] } });
    });
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

describe('PhotoUpload — callbacks', () => {
  it('fires onUploadStart before upload + onUploadComplete after success', async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    uploadSpy.mockResolvedValueOnce({ photo: { id: 'p1', storage_path: 's/p1.jpg' } });
    render(<PhotoUpload onUploadStart={onStart} onUploadComplete={onComplete} />);
    await act(async () => {
      fireEvent.change(screen.getByTestId('photo-upload-input'), { target: { files: [fakeFile()] } });
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ id: 'p1', storage_path: 's/p1.jpg' });
  });

  it('fires onUploadError when upload returns error', async () => {
    const onError = vi.fn();
    uploadSpy.mockResolvedValueOnce({ error: 'boom' });
    render(<PhotoUpload onUploadError={onError} />);
    await act(async () => {
      fireEvent.change(screen.getByTestId('photo-upload-input'), { target: { files: [fakeFile()] } });
    });
    expect(onError).toHaveBeenCalledWith('boom');
  });

  it('does not throw when callbacks themselves throw', async () => {
    uploadSpy.mockResolvedValueOnce({ photo: { id: 'p1' } });
    const badCallback = vi.fn(() => { throw new Error('cb fail'); });
    render(<PhotoUpload onUploadComplete={badCallback} />);
    await act(async () => {
      fireEvent.change(screen.getByTestId('photo-upload-input'), { target: { files: [fakeFile()] } });
    });
    expect(badCallback).toHaveBeenCalled();
  });
});

describe('PhotoUpload — visual state', () => {
  it('shows error in surface mode', () => {
    stateRef.current = { isUploading: false, error: 'bad upload', photo: null, preview: null };
    render(<PhotoUpload errorMode="surface" />);
    expect(screen.getByTestId('photo-upload-error').textContent).toContain('bad upload');
  });

  it('does NOT show error in swallow mode even if hook reports one', () => {
    stateRef.current = { isUploading: false, error: 'bad upload', photo: null, preview: null };
    render(<PhotoUpload errorMode="swallow" />);
    expect(screen.queryByTestId('photo-upload-error')).toBeNull();
  });

  it('renders preview when hook supplies one', () => {
    stateRef.current = { isUploading: false, error: null, photo: null, preview: 'blob:abc' };
    render(<PhotoUpload />);
    const img = screen.getByTestId('photo-upload-preview');
    expect(img.getAttribute('src')).toBe('blob:abc');
  });

  it('hides preview when showPreview=false', () => {
    stateRef.current = { isUploading: false, error: null, photo: null, preview: 'blob:abc' };
    render(<PhotoUpload showPreview={false} />);
    expect(screen.queryByTestId('photo-upload-preview')).toBeNull();
  });

  it('shows "Uploading…" label when isUploading', () => {
    stateRef.current = { isUploading: true, error: null, photo: null, preview: null };
    render(<PhotoUpload />);
    expect(screen.getByText('Uploading…')).toBeTruthy();
  });

  it('disables input when prop disabled=true', () => {
    render(<PhotoUpload disabled />);
    expect(screen.getByTestId('photo-upload-input').disabled).toBe(true);
  });
});

// BUG-PHOTOUPLOADKBD-001 — the single-mode trigger was a <label> wrapping a display:none <input>.
// display:none removes the input from the tab order AND the accessibility tree, and a <label> has no
// tabindex and no role, so the control was operable by pointer only.
//
// WHY THESE ASSERTIONS AND NOT AN AXE CASE. a11yGate.test.jsx already renders this component's
// icon-only single mode through axe (a11yGate.test.jsx:83) and was green on the defective markup.
// Measured on the pre-fix tree: axe returns ZERO findings — not merely zero violations — for the
// gate's rule set AND for axe's full default rule set. It cannot see this class at all: a
// display:none subtree is excluded from the audit outright, and a <label> is not an interactive
// element, so no rule has anything to fire on. Only focus + activation are observable, so those are
// what these assert. document.activeElement rather than a matcher: this file loads no jest-dom.
describe('PhotoUpload — single-mode keyboard reachability (BUG-PHOTOUPLOADKBD-001)', () => {
  it('the trigger is in the tab order', async () => {
    const user = userEvent.setup();
    render(<PhotoUpload buttonLabel="Add Photo" />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add Photo' }));
  });

  it('an icon-only trigger is reachable and named by ariaLabel', async () => {
    const user = userEvent.setup();
    render(<PhotoUpload buttonLabel={<span aria-hidden="true">📷</span>} ariaLabel="Add photo" />);
    await user.tab();
    // The high-traffic call sites (PlantingTile, ProjectDetail per-plant) are all this shape.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add photo' }));
  });

  it('Enter on the focused trigger opens the file picker', async () => {
    const user = userEvent.setup();
    render(<PhotoUpload buttonLabel="Add Photo" />);
    const clickSpy = vi.spyOn(screen.getByTestId('photo-upload-input'), 'click');
    await user.tab();
    await user.keyboard('{Enter}');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('Space on the focused trigger opens the file picker', async () => {
    const user = userEvent.setup();
    render(<PhotoUpload buttonLabel="Add Photo" />);
    const clickSpy = vi.spyOn(screen.getByTestId('photo-upload-input'), 'click');
    await user.tab();
    await user.keyboard(' ');
    // Enter AND Space, separately: a focusable <label> with tabIndex={0} — the tempting cheap fix —
    // would satisfy the tab-order test above and forward neither key to its control.
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('the hidden input stays out of the tab order and the a11y tree', () => {
    render(<PhotoUpload buttonLabel="Add Photo" />);
    const input = screen.getByTestId('photo-upload-input');
    expect(input.getAttribute('tabindex')).toBe('-1');
    expect(input.getAttribute('aria-hidden')).toBe('true');
  });

  it('a busy trigger does not open the picker', async () => {
    const user = userEvent.setup();
    stateRef.current = { isUploading: true, error: null, photo: null, preview: null };
    render(<PhotoUpload buttonLabel="Add Photo" />);
    const clickSpy = vi.spyOn(screen.getByTestId('photo-upload-input'), 'click');
    await user.click(screen.getByRole('button', { name: 'Uploading…' }));
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('opening the picker leaves single-mode capture as the JSX set it', async () => {
    const user = userEvent.setup();
    render(<PhotoUpload buttonLabel="Add Photo" />);
    const input = screen.getByTestId('photo-upload-input');
    vi.spyOn(input, 'click');
    await user.click(screen.getByRole('button', { name: 'Add Photo' }));
    // openPicker is shared with both mode, where it SETS/REMOVES capture per choice. Single mode's
    // capture is a prop-driven static, so it must pass no argument and openPicker must test for an
    // explicit boolean — a truthy test would strip capture="environment" on every open and silently
    // kill camera invocation on Android.
    expect(input.getAttribute('capture')).toBe('environment');
  });
});

// BUG-PHOTOUPLOADHANG-001 — step-labeled busy states so a stall report names its step.
describe('PhotoUpload — stage labels', () => {
  it('shows "Preparing…" during the downscale stage', () => {
    stateRef.current = { isUploading: true, error: null, photo: null, preview: null, stage: 'preparing' };
    render(<PhotoUpload />);
    expect(screen.getByText('Preparing…')).toBeTruthy();
  });

  it('shows "Uploading… N%" once the PUT reports progress', () => {
    stateRef.current = { isUploading: true, error: null, photo: null, preview: null, stage: 'uploading', progress: 43 };
    render(<PhotoUpload />);
    expect(screen.getByText('Uploading… 43%')).toBeTruthy();
  });

  it('shows "Saving…" during the register stage', () => {
    stateRef.current = { isUploading: true, error: null, photo: null, preview: null, stage: 'saving' };
    render(<PhotoUpload />);
    expect(screen.getByText('Saving…')).toBeTruthy();
  });
});
