// src/components/PhotoUpload.jsx
// V2-PHOTO-F1 — thin visual layer over useUploadPhoto.
//
// Mobile-first. The single reusable photo widget for the whole app.
//
// ONE TRIGGER, NEVER THE CAMERA (V4-HIDECAPTURE-001, Dave 2026-08-21: "hide the ability to take a
// photo from the app, streamline any photo flow (e.g. from Snap) to go straight into choosing a
// photo. One less tap."). This supersedes the 2026-06-02 camera-unification `mode="both"` design and
// the 2026-08-17 V4-SNAPCAPTURE-001 ruling, which DEMOTED the camera to a secondary control rather
// than removing it — demote is not hide, and the demoted control was still rendering.
//
// THE `mode`, `capture`, `takeLabel` AND `chooseLabel` PROPS ARE GONE, not defaulted-off. A `capture`
// prop that still exists is a camera one prop away from returning silently, and "the default is safe"
// is exactly the shape that let the demoted control survive a ruling meant to remove it. Deleting the
// API is the only version of this that a future edit cannot quietly undo.
//
// WHAT THIS DOES AND DOES NOT GUARANTEE. It removes every in-app camera affordance and collapses the
// take-or-choose decision to a single tap — that is the "one less tap". It does NOT and cannot remove
// the camera from the OS file chooser: with `accept="image/*"` and no `capture`, the browser decides
// what to offer, and Android Chrome may still list Camera alongside Photos/Files depending on version
// and whether the Android Photo Picker handles that accept type. Verify on a real device before
// claiming the camera is unreachable; the app's own surface is all this controls.
//
// Props:
//   keyPrefix     : 'standalone' | 'events' | 'projects' | 'plants' | 'locations' | 'inventory' (default 'standalone')
//   parentId      : parent entity id (required when keyPrefix !== 'standalone')
//   linkage       : object forwarded to POST /api/photos as body fields
//   caption       : optional, forwarded to POST /api/photos
//   is_public     : default true
//   accept        : default 'image/*'
//   errorMode     : 'surface' | 'swallow' — passed to useUploadPhoto
//   buttonLabel   : trigger content (default 'Add Photo'); may be a node (e.g. an Icon)
//   ariaLabel     : accessible name — REQUIRED when buttonLabel is icon-only/decorative (else the
//                   control has no accessible name). Lands on the trigger <button>, which has a role
//                   that can carry it.
//   showPreview   : default true
//   onUploadStart / onUploadComplete / onUploadError
//   disabled      : boolean
//   buttonStyle   : style override applied to the trigger.

import React, { useCallback, useRef } from 'react';
import { useUploadPhoto } from '../hooks/useUploadPhoto.js';
import { P } from '../lib/constants.js';
import { T } from './forms/formStyles.js';

const DEFAULT_BTN_STYLE = {
  display: 'inline-block',
  padding: T.photo.triggerPad,
  background: P.sage,
  // P.white is '#ffffff' to the literal '#fff' this replaced — the same computed colour,
  // so the render is unchanged; only the source of the value moves.
  color: P.white,
  borderRadius: T.photo.radius,
  cursor: 'pointer',
  fontSize: T.type.lg,
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

export function PhotoUpload({
  keyPrefix     = 'standalone',
  parentId      = null,
  linkage       = {},
  caption       = null,
  is_public     = true,
  accept        = 'image/*',
  errorMode     = 'surface',
  buttonLabel   = 'Add Photo',
  ariaLabel     = null,
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

  // Opens the picker inside the user gesture, which is what makes it open at all on mobile.
  // V4-HIDECAPTURE-001: takes no argument and touches no `capture` attribute. The previous
  // tri-state (true = set capture, false = remove, undefined = leave the JSX's static) existed
  // solely to switch the one hidden input between camera and library; with the camera gone there
  // is one behaviour, and the input below never carries `capture` in the first place.
  const openPicker = useCallback(() => {
    const el = inputRef.current;
    if (!el || busy) return;
    el.click();
  }, [busy]);

  const triggerStyle = busy
    ? { ...TRIGGER_RESET, ...(buttonStyle ?? DEFAULT_BTN_STYLE), opacity: 0.6, cursor: 'not-allowed' }
    : { ...TRIGGER_RESET, ...(buttonStyle ?? DEFAULT_BTN_STYLE) };

  return (
    <div className="photo-upload" data-testid="photo-upload">
      {/* V4-A11YGATE-001 history: ariaLabel used to sit on the <label>, which has no ARIA role
          and so dropped it. BUG-PHOTOUPLOADKBD-001 retires the <label> entirely — the name now
          rides the <button>, whose role can carry it, and which is in the tab order. The input
          keeps id={resolvedId}: the plant-list-photo-<id> / plant-photo-<id> / project-photo-<id>
          contract is driven by automated bulk-attach sessions outside the app. */}
      <button
        type="button"
        onClick={openPicker}
        disabled={busy}
        aria-label={ariaLabel || undefined}
        data-testid="photo-upload-trigger"
        style={triggerStyle}
      >
        {isUploading ? busyLabel : buttonLabel}
      </button>
      {/* V4-HIDECAPTURE-001: NO `capture` attribute, ever. Its absence is the whole feature, which
          makes it invisible in a diff and easy to reinstate "for mobile" — the guard against that is
          PhotoUpload.test.jsx asserting the attribute is absent, not this comment. */}
      <input
        ref={inputRef}
        id={resolvedId}
        type="file"
        accept={accept}
        onChange={handleChange}
        disabled={busy}
        aria-hidden="true"
        tabIndex={-1}
        style={{ display: 'none' }}
        data-testid="photo-upload-input"
      />

      {showPreview && preview && (
        <div style={{ marginTop: T.photo.gapMd }}>
          <img
            src={preview}
            alt="Upload preview"
            data-testid="photo-upload-preview"
            style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: T.photo.thumbRadius }}
          />
        </div>
      )}

      {error && errorMode === 'surface' && (
        <div role="alert" data-testid="photo-upload-error"
             style={{ marginTop: T.photo.gapSm, color: P.photoErrorInk, fontSize: T.type.base }}>
          {error}
        </div>
      )}

      {photo && (
        <button type="button" onClick={reset} data-testid="photo-upload-reset"
                style={{ marginTop: T.photo.gapSm, fontSize: T.photo.linkFont,
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
