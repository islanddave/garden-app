// src/components/PhotoUpload.jsx
// V2-PHOTO-F1 — thin visual layer over useUploadPhoto.
//
// Mobile-first. The single reusable photo widget for the whole app.
//
// mode="both" (RECOMMENDED, 2026-06-02 camera-unification): renders TWO triggers —
//   "Take photo" (camera, capture="environment") and "Choose photo" (library, no
//   capture attr). One hidden <input> whose `capture` attribute is toggled imperatively
//   per choice, then .click()'d inside the user gesture so the camera/library opens on
//   mobile. This is the consistent take-OR-choose flow that plugs into every surface.
//
// mode="single" (default, legacy): one trigger; behavior controlled by the `capture` prop
//   (default 'environment' = camera on mobile, file-picker on desktop). Unchanged so the
//   existing call sites + unit tests are untouched.
//
// Props:
//   keyPrefix     : 'standalone' | 'events' | 'projects' | 'plants' | 'locations' | 'inventory' (default 'standalone')
//   parentId      : parent entity id (required when keyPrefix !== 'standalone')
//   linkage       : object forwarded to POST /api/photos as body fields
//   caption       : optional, forwarded to POST /api/photos
//   is_public     : default true
//   accept        : default 'image/*'
//   capture       : default 'environment' (single mode only; '' or null disables camera invocation)
//   errorMode     : 'surface' | 'swallow' — passed to useUploadPhoto
//   mode          : 'single' (default) | 'both'
//   buttonLabel   : single-mode trigger content (default 'Add Photo'); may be a node (e.g. an Icon)
//   ariaLabel     : single-mode accessible name — REQUIRED when buttonLabel is icon-only/decorative
//                   (else the control has no accessible name). Lands on the trigger <button>, which
//                   has a role that can carry it. No-op in both mode.
//   takeLabel     : both-mode camera trigger text (default '📷 Take photo')
//   chooseLabel   : both-mode library trigger text (default '🖼️ Choose photo')
//   showPreview   : default true
//   onUploadStart / onUploadComplete / onUploadError
//   disabled      : boolean
//   buttonStyle   : style override applied to the trigger(s); in both mode it overrides each button.

import React, { useCallback, useRef } from 'react';
import { useUploadPhoto } from '../hooks/useUploadPhoto.js';
import { P } from '../lib/constants.js';

const DEFAULT_BTN_STYLE = {
  display: 'inline-block',
  padding: '0.75rem 1.25rem',
  background: P.sage,
  color: '#fff',
  borderRadius: '0.5rem',
  cursor: 'pointer',
  fontSize: '1rem',
  border: 'none',
  fontWeight: 500,
  textAlign: 'center',
  userSelect: 'none',
};

// BUG-PHOTOUPLOADKBD-001: the single-mode trigger was a <label> wrapping a display:none <input>.
// display:none takes the input out of the tab order AND the a11y tree, and a <label> has neither a
// tabindex nor a role, so the control was pointer-only — unreachable by keyboard at all. It is now a
// real <button> that clicks the hidden input, the pattern both mode has always used. A <button>
// carries UA form-control defaults a <label> does not (system font, line-height:normal, native
// chrome); this reset goes UNDER the caller's style so the re-roled trigger renders identically.
const TRIGGER_RESET = {
  fontFamily: 'inherit',
  fontSize: 'inherit',
  fontWeight: 'inherit',
  lineHeight: 'inherit',
  letterSpacing: 'inherit',
  textAlign: 'inherit',
  margin: 0,
  appearance: 'none',
  WebkitAppearance: 'none',
};

const CHOICE_BTN_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.4rem',
  flex: '1 1 0',
  minWidth: 0,
  padding: '0.7rem 0.9rem',
  background: P.sage,
  color: '#fff',
  borderRadius: '0.5rem',
  cursor: 'pointer',
  fontSize: '0.95rem',
  border: 'none',
  fontWeight: 600,
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
  mode          = 'single',
  buttonLabel   = 'Add Photo',
  ariaLabel     = null,
  takeLabel     = '📷 Take photo',
  chooseLabel   = '🖼️ Choose photo',
  showPreview   = true,
  onUploadStart,
  onUploadComplete,
  onUploadError,
  disabled      = false,
  inputId,
  buttonStyle,
}) {
  const { upload, isUploading, error, photo, preview, reset, stage, progress } = useUploadPhoto({ errorMode });
  const inputRef = useRef(null);

  // BUG-PHOTOUPLOADHANG-001: name the step, not just "Uploading…" — a stall report can then say
  // WHERE it stuck ("Uploading… 43%" = the S3 PUT at 43%). stage/progress may be undefined when
  // the hook is mocked; every branch falls back to the old label.
  const busyLabel =
    stage === 'preparing' ? 'Preparing…' :
    stage === 'saving' ? 'Saving…' :
    (typeof progress === 'number' ? `Uploading… ${progress}%` : 'Uploading…');

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

  const resolvedId = inputId ?? 'photo-upload-input';
  const busy = disabled || isUploading;

  // both-mode: toggle the capture attribute imperatively, then open the picker within the
  // user gesture so iOS/Android open the camera (capture) vs the photo library (no capture).
  // Tri-state, not truthy: single mode calls this with NO argument, and its `capture` is a
  // prop-driven static (captureProps below), so the attribute must be left exactly as the JSX
  // set it — a truthy test would strip capture="environment" on every single-mode open.
  const openPicker = useCallback((useCamera) => {
    const el = inputRef.current;
    if (!el || busy) return;
    if (useCamera === true) el.setAttribute('capture', 'environment');
    else if (useCamera === false) el.removeAttribute('capture');
    el.click();
  }, [busy]);

  // single-mode: capture is only added when truthy. Passing '' / null disables it (desktop fallback).
  const captureProps = capture ? { capture } : {};

  const choiceStyle = (buttonStyle ?? CHOICE_BTN_STYLE);
  const choiceStyleBusy = busy ? { ...choiceStyle, opacity: 0.6, cursor: 'not-allowed' } : choiceStyle;
  const triggerStyle = busy
    ? { ...TRIGGER_RESET, ...(buttonStyle ?? DEFAULT_BTN_STYLE), opacity: 0.6, cursor: 'not-allowed' }
    : { ...TRIGGER_RESET, ...(buttonStyle ?? DEFAULT_BTN_STYLE) };

  return (
    <div className="photo-upload" data-testid="photo-upload">
      {mode === 'both' ? (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => openPicker(true)}
              disabled={busy}
              data-testid="photo-upload-take"
              style={choiceStyleBusy}
            >
              {isUploading ? 'Uploading…' : takeLabel}
            </button>
            <button
              type="button"
              onClick={() => openPicker(false)}
              disabled={busy}
              data-testid="photo-upload-choose"
              style={choiceStyleBusy}
            >
              {chooseLabel}
            </button>
          </div>
          <input
            ref={inputRef}
            id={resolvedId}
            type="file"
            accept={accept}
            onChange={handleChange}
            disabled={busy}
            style={{ display: 'none' }}
            data-testid="photo-upload-input"
          />
        </>
      ) : (
        <>
          {/* V4-A11YGATE-001 history: ariaLabel used to sit on the <label>, which has no ARIA role
              and so dropped it. BUG-PHOTOUPLOADKBD-001 retires the <label> entirely — the name now
              rides the <button>, whose role can carry it, and which is in the tab order. The input
              keeps id={resolvedId}: the plant-list-photo-<id> / plant-photo-<id> / project-photo-<id>
              contract is driven by automated bulk-attach sessions outside the app. */}
          <button
            type="button"
            onClick={() => openPicker()}
            disabled={busy}
            aria-label={ariaLabel || undefined}
            data-testid="photo-upload-trigger"
            style={triggerStyle}
          >
            {isUploading ? busyLabel : buttonLabel}
          </button>
          <input
            ref={inputRef}
            id={resolvedId}
            type="file"
            accept={accept}
            {...captureProps}
            onChange={handleChange}
            disabled={busy}
            aria-hidden="true"
            tabIndex={-1}
            style={{ display: 'none' }}
            data-testid="photo-upload-input"
          />
        </>
      )}

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
                         color: P.sage, cursor: 'pointer',
                         textDecoration: 'underline' }}>
          Upload another
        </button>
      )}
    </div>
  );
}

export default PhotoUpload;
