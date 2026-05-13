// src/components/PhotoUpload.jsx
// V2-PHOTO-F1 — thin visual layer over useUploadPhoto.
//
// Mobile-first. `capture="environment"` invokes the rear camera on iOS Safari
// and Chrome Android directly; falls back gracefully on desktop (still opens
// the regular file picker). Primary target: Jen's iPhone in the garden.
//
// Props:
//   keyPrefix     : one of 'standalone' | 'events' | 'projects' | 'plants' | 'locations' | 'inventory' (default 'standalone')
//   parentId      : parent entity id (required when keyPrefix !== 'standalone')
//   linkage       : object forwarded to POST /api/photos as body fields, e.g. { project_id, plant_id, event_id, location_id, inventory_item_id }
//   caption       : optional, forwarded to POST /api/photos
//   is_public     : default true
//   accept        : default 'image/*'
//   capture       : default 'environment' (set to '' or null to disable camera invocation)
//   errorMode     : 'surface' | 'swallow' — passed to useUploadPhoto
//   buttonLabel   : trigger button text (default 'Add Photo')
//   showPreview   : default true
//   onUploadStart : () => void
//   onUploadComplete : (photo) => void
//   onUploadError    : (errorMsg) => void
//   disabled      : boolean
//
// Renders the trigger as a styled <label> wrapping a hidden <input type="file">
// — the same iOS-friendly pattern proven by PhotoLibrary and EventNew.

import React, { useCallback, useRef } from 'react';
import { useUploadPhoto } from '../hooks/useUploadPhoto.js';

const DEFAULT_BTN_STYLE = {
  display: 'inline-block',
  padding: '0.75rem 1.25rem',
  background: '#7c9885',
  color: '#fff',
  borderRadius: '0.5rem',
  cursor: 'pointer',
  fontSize: '1rem',
  border: 'none',
  fontWeight: 500,
  textAlign: 'center',
  userSelect: 'none',
};

export function PhotoUpload({
  keyPrefix     = 'standalone',
  parentId      = null,
  linkage       = {},
  caption       = null,
  is_public     = true,
  accept        = 'image/*',
  capture       = 'environment',
  errorMode     = 'surface',
  buttonLabel   = 'Add Photo',
  showPreview   = true,
  onUploadStart,
  onUploadComplete,
  onUploadError,
  disabled      = false,
  inputId,
  buttonStyle,
}) {
  const { upload, isUploading, error, photo, preview, reset } = useUploadPhoto({ errorMode });
  const inputRef = useRef(null);

  const handleChange = useCallback(async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    if (typeof onUploadStart === 'function') {
      try { onUploadStart(); } catch (cbErr) { console.error('onUploadStart threw', cbErr); }
    }
    const result = await upload(file, { keyPrefix, parentId, linkage, caption, is_public });
    if (result?.error) {
      if (typeof onUploadError === 'function') {
        try { onUploadError(result.error); } catch (cbErr) { console.error('onUploadError threw', cbErr); }
      }
    } else if (result?.photo) {
      if (typeof onUploadComplete === 'function') {
        try { onUploadComplete(result.photo); } catch (cbErr) { console.error('onUploadComplete threw', cbErr); }
      }
    }
    // Reset native input so re-selecting the same file refires `onChange`.
    if (inputRef.current) inputRef.current.value = '';
  }, [upload, keyPrefix, parentId, linkage, caption, is_public, onUploadStart, onUploadComplete, onUploadError]);

  const labelStyle = disabled || isUploading
    ? { ...(buttonStyle ?? DEFAULT_BTN_STYLE), opacity: 0.6, cursor: 'not-allowed' }
    : (buttonStyle ?? DEFAULT_BTN_STYLE);

  // capture is intentionally only added when truthy — passing the empty string
  // explicitly tells some browsers "I want capture" which is the opposite of
  // what we want for desktop fallback. Use a conditional spread.
  const captureProps = capture ? { capture } : {};

  return (
    <div className="photo-upload" data-testid="photo-upload">
      <label htmlFor={inputId ?? 'photo-upload-input'} style={labelStyle}>
        {isUploading ? 'Uploading…' : buttonLabel}
        <input
          ref={inputRef}
          id={inputId ?? 'photo-upload-input'}
          type="file"
          accept={accept}
          {...captureProps}
          onChange={handleChange}
          disabled={disabled || isUploading}
          style={{ display: 'none' }}
          data-testid="photo-upload-input"
        />
      </label>

      {showPreview && preview && (
        <div style={{ marginTop: '0.75rem' }}>
          <img
            src={preview}
            alt="Upload preview"
            data-testid="photo-upload-preview"
            style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: '0.375rem' }}
          />
        </div>
      )}

      {error && errorMode === 'surface' && (
        <div role="alert" data-testid="photo-upload-error"
             style={{ marginTop: '0.5rem', color: '#b14a3c', fontSize: '0.9rem' }}>
          {error}
        </div>
      )}

      {photo && (
        <button type="button" onClick={reset} data-testid="photo-upload-reset"
                style={{ marginTop: '0.5rem', fontSize: '0.85rem',
                         background: 'transparent', border: 'none',
                         color: '#7c9885', cursor: 'pointer',
                         textDecoration: 'underline' }}>
          Upload another
        </button>
      )}
    </div>
  );
}

export default PhotoUpload;
