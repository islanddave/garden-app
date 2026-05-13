// Unit tests for src/components/PhotoUpload.jsx
// Render + interaction tests. Mock the upload hook to keep tests
// fast and decoupled from the 3-step network mocking already covered
// in useUploadPhoto.test.js.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

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
