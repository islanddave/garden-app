// src/components/PhotoUpload.jsx
// Thin visual layer over useUploadPhoto.
//
// Mobile-first. The single reusable photo widget for the whole app.
//
// ONE TRIGGER, NEVER THE CAMERA. There is no in-app camera affordance: the trigger goes straight to
// choosing a photo. There are deliberately no `mode`, `capture`, `takeLabel` or `chooseLabel` props
// — a `capture` prop that still exists is a camera one prop away from returning silently, and
// deleting the API is the only version a future edit cannot quietly undo.
//
// WHAT THIS DOES AND DOES NOT GUARANTEE. It removes every in-app camera affordance and collapses the
// take-or-choose decision to a single tap. It does NOT and cannot remove the camera from the OS file
// chooser: with `accept="image/*"` and no `capture`, the browser decides what to offer, and Android
// Chrome may still list Camera alongside Photos/Files depending on version and whether the Android
// Photo Picker handles that accept type. Verify on a real device before claiming the camera is
// unreachable; the app's own surface is all this controls.
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
//   multiple      : default false. See MULTI-ATTACH below.
//   maxFiles      : default DEFAULT_MAX_FILES; multi mode only.
//
// MULTI-ATTACH. `multiple` lets one picker invocation stage N files, which then upload SERIALLY with
// per-file status and per-file failure.
//
// THE DEFAULT IS THE WHOLE CONTRACT. With `multiple` absent/false this component is byte-identical to
// single mode: one hidden input WITHOUT a `multiple` attribute, `files?.[0]` semantics, the hook's
// single preview, the hook's single error banner, and `onUploadComplete(photo)` with ONE photo
// object. Guard both branches when editing here; `PhotoUpload.test.jsx` pins the single-mode DOM.
//
// IN MULTI MODE `onUploadComplete` RECEIVES AN ARRAY — the successfully-uploaded photos, fired once
// after the queue drains, and not fired at all when every file failed. Callers discriminate with
// `Array.isArray`. `onUploadError` still receives ONE error string, fired once PER failed file, so
// its argument shape never varies; the per-file surface below is the primary report and the callback
// is the secondary. `onUploadStart` fires ONCE per batch, so a caller that flips a busy bit on start
// and clears it on complete/error stays balanced.
//
// SERIAL, NEVER PARALLEL. Each file's decode/resize/strip peaks at ~50MB of native RGBA for
// a 4096x3072 original, on Android-only devices. `for..of` + `await` is load-bearing, not stylistic
// — a `Promise.all` here would multiply peak memory by the batch size on exactly the devices where
// single uploads already stall. useUploadPhoto is a single-file engine with singleton state and one
// preview ref, which is safe to drive sequentially and is NOT safe to drive concurrently.
//
// STAGED OBJECT URLs ARE OURS, NOT THE HOOK'S. The hook holds exactly one preview URL and revokes
// the previous on every upload, so it cannot back a grid of N thumbnails. Multi mode creates its own
// URL per staged file and revokes on remove and on unmount.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useUploadPhoto } from '../hooks/useUploadPhoto.js';
import { P } from '../lib/constants.js';
import { T } from './forms/formStyles.js';
import { snapshotPicked } from '../lib/fileSnapshot.js';

// In-context multi-attach is "the handful I just took of this plant", not a camera-roll drain —
// that is the bulk-select flow, which has its own server-side cap. Ten keeps the serial queue's
// worst case around a minute on a phone uplink and the thumbnail strip on one screen.
const DEFAULT_MAX_FILES = 10;

let stagedSeq = 0;
const nextStagedId = () => `staged-${++stagedSeq}`;

const DEFAULT_BTN_STYLE = {
  display: 'inline-block',
  padding: T.photo.triggerPad,
  background: P.sage,
  color: P.white,
  borderRadius: T.photo.radius,
  cursor: 'pointer',
  fontSize: T.type.lg,
  border: 'none',
  fontWeight: 500,
  textAlign: 'center',
  userSelect: 'none',
};

// The trigger is a real <button> that clicks the hidden input: a <label> wrapping a display:none
// <input> has no tabindex or role and display:none drops the input from the tab order AND the a11y
// tree, so it would be unreachable by keyboard. A <button> carries UA form-control defaults a
// <label> does not (system font, line-height:normal, native chrome); this reset goes UNDER the
// caller's style so the trigger renders as the caller styled it.
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
  multiple      = false,
  maxFiles      = DEFAULT_MAX_FILES,
  // Override what the visible TRIGGER does, while leaving the hidden input mounted and directly
  // drivable. PlantingTile needs exactly this: its camera button opens a batch SHEET rather than the
  // picker, but every rendered row must still expose `input#plant-list-photo-<id>` because automated
  // bulk-attach sessions drive uploads through it (Garden.photoUpload.test.jsx §1). Moving the whole
  // component into the sheet would silently break that, since the input would only exist while a
  // human had the sheet open.
  //
  // Only the human tap is redirected. NOT a mode switch on the upload behaviour — everything
  // downstream of a file landing on that input is unchanged.
  onTriggerClick = null,
  // Override the staged strip's height cap. Default null = the two built-in caps below. Exists
  // because those caps are sized for a CARD FOOTER, and PlantingPhotoSheet renders the same strip in
  // a fly-up with hundreds of spare pixels (tests/harness/plantingphotosheet.jsx).
  stripMaxHeight = null,
}) {
  const { upload, isUploading, error, photo, preview, reset, stage, progress } = useUploadPhoto({ errorMode });
  const inputRef = useRef(null);

  const multiEnabled = multiple === true;

  // [{ id, file, url, status: 'staged'|'uploading'|'done'|'error', error, photo }] — multi mode only.
  // Stays empty in single mode, where nothing below it renders.
  const [staged, setStaged] = useState([]);
  const [stageNotice, setStageNotice] = useState(null);

  // Unmount revocation needs the CURRENT urls, and the cleanup below must not re-run on every
  // staged change (that would revoke a live thumbnail mid-render). A ref mirror is the standard
  // shape for "latest value, empty dep list".
  const stagedUrlsRef = useRef([]);
  useEffect(() => { stagedUrlsRef.current = staged.map(s => s.url).filter(Boolean); }, [staged]);
  useEffect(() => () => {
    for (const url of stagedUrlsRef.current) URL.revokeObjectURL(url);
    stagedUrlsRef.current = [];
  }, []);

  // Name the step, not just "Uploading…" — a stall report can then say WHERE it stuck ("Uploading…
  // 43%" = the S3 PUT at 43%). stage/progress may be undefined when the hook is mocked; every branch
  // falls back to the plain label.
  const busyLabel =
    stage === 'preparing' ? 'Preparing…' :
    stage === 'saving' ? 'Saving…' :
    (typeof progress === 'number' ? `Uploading… ${progress}%` : 'Uploading…');

  const removeStaged = useCallback((id) => {
    setStaged(prev => {
      const hit = prev.find(s => s.id === id);
      // Never revoke an in-flight file's URL — the upload is uncancellable, and the strip must keep
      // showing what is still on the wire. The control is disabled for that row anyway; this is the
      // second half of the same rule, because a caller could reach removeStaged some other way.
      if (!hit || hit.status === 'uploading') return prev;
      if (hit.url) URL.revokeObjectURL(hit.url);
      return prev.filter(s => s.id !== id);
    });
  }, []);

  const clearStaged = useCallback(() => {
    setStaged(prev => {
      const keep = prev.filter(s => s.status === 'uploading');
      for (const s of prev) if (s.status !== 'uploading' && s.url) URL.revokeObjectURL(s.url);
      return keep;
    });
    setStageNotice(null);
  }, []);

  // Per-file error isolation. `upload()` resolves `{ error }` and never throws, so a failed
  // file cannot break the loop; the try/catch guards only the callbacks, which are caller code.
  const runQueue = useCallback(async (items) => {
    const uploaded = [];
    for (const item of items) {
      setStaged(prev => prev.map(s => (s.id === item.id ? { ...s, status: 'uploading', error: null } : s)));
      const result = await upload(item.file, { keyPrefix, parentId, linkage, caption, is_public });
      if (result?.error) {
        setStaged(prev => prev.map(s => (s.id === item.id ? { ...s, status: 'error', error: result.error } : s)));
        if (typeof onUploadError === 'function') {
          try { onUploadError(result.error); } catch (cbErr) { console.error('onUploadError threw', cbErr); }
        }
      } else if (result?.photo) {
        uploaded.push(result.photo);
        setStaged(prev => prev.map(s => (s.id === item.id ? { ...s, status: 'done', photo: result.photo } : s)));
      }
    }
    // Array form, once, and only when something actually landed — a caller that refetches on
    // complete should not be told to refetch after a batch in which nothing was created.
    if (uploaded.length && typeof onUploadComplete === 'function') {
      try { onUploadComplete(uploaded); } catch (cbErr) { console.error('onUploadComplete threw', cbErr); }
    }
  }, [upload, keyPrefix, parentId, linkage, caption, is_public, onUploadComplete, onUploadError]);

  const handleChange = useCallback(async (e) => {
    if (multiEnabled) {
      // Snapshot the FileList before anything can reset the input — a FileList is live against the
      // element, so reading it after `value = ''` yields nothing.
      const picked = Array.from(e.target?.files ?? []);
      if (inputRef.current) inputRef.current.value = '';
      if (!picked.length) return;

      // Ids are minted HERE, before the state update, so the queue below owns the exact identities
      // it is about to drive. Deriving them afterwards from the committed array would depend on
      // React running the updater synchronously, which it does not promise.
      const room = Math.max(0, maxFiles - staged.length);
      const accepted = picked.slice(0, room);
      setStageNotice(
        accepted.length < picked.length
          ? `Only ${maxFiles} photos at a time — ${picked.length - accepted.length} not added.`
          : null
      );
      if (!accepted.length) return;

      // Copy the bytes out of the picker's handles BEFORE queueing. runQueue below is serial, so
      // files 2..N are read seconds-to-minutes after the pick; on Android those handles are
      // reclaimable and the first photo's decode is itself the memory pressure that reclaims the
      // rest (Chrome: "could not be read ... after a reference to a file was acquired"). Mechanism
      // in lib/fileSnapshot.js.
      const { ok, failed, failedNames: names } = await snapshotPicked(accepted);
      if (failed.length) {
        // Folded into the existing notice rather than given its own slot — the cap message and this
        // one are both "what did not make it into the strip", and a card footer is too tight for two
        // stacked lines.
        setStageNotice(prev => [
          prev,
          `${failed.length} couldn't be read and ${failed.length === 1 ? 'was' : 'were'} not added` +
          `${names.length ? ` (${names.slice(0, 2).join(', ')}${names.length > 2 ? '…' : ''})` : ''}.`,
        ].filter(Boolean).join(' '));
      }
      if (!ok.length) return;
      const queued = ok.map(({ file }) => ({
        id: nextStagedId(),
        file,
        // Minted from the snapshot, not the original handle — an object URL is a pointer, so one
        // taken from the handle we just replaced would die on the same schedule as the read did.
        url: URL.createObjectURL(file),
        status: 'staged',
        error: null,
        photo: null,
      }));
      setStaged(prev => prev.concat(queued));
      if (typeof onUploadStart === 'function') {
        try { onUploadStart(); } catch (cbErr) { console.error('onUploadStart threw', cbErr); }
      }
      await runQueue(queued);
      return;
    }

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
  }, [multiEnabled, maxFiles, staged, runQueue, upload, keyPrefix, parentId, linkage, caption, is_public, onUploadStart, onUploadComplete, onUploadError]);

  const resolvedId = inputId ?? 'photo-upload-input';
  const busy = disabled || isUploading;

  // Opens the picker inside the user gesture, which is what makes it open at all on mobile.
  // Takes no argument and touches no `capture` attribute: the input below never carries one.
  const openPicker = useCallback(() => {
    if (busy) return;
    // The override runs INSTEAD of the picker, never before it — a caller that opened a sheet and
    // also fired the file chooser would put two surfaces on screen from one tap.
    if (typeof onTriggerClick === 'function') { onTriggerClick(); return; }
    const el = inputRef.current;
    if (!el) return;
    el.click();
  }, [busy, onTriggerClick]);

  const triggerStyle = busy
    ? { ...TRIGGER_RESET, ...(buttonStyle ?? DEFAULT_BTN_STYLE), opacity: 0.6, cursor: 'not-allowed' }
    : { ...TRIGGER_RESET, ...(buttonStyle ?? DEFAULT_BTN_STYLE) };

  return (
    <div className="photo-upload" data-testid="photo-upload">
      {/* ariaLabel rides the <button>, whose role can carry it and which is in the tab order. The
          input keeps id={resolvedId}: the plant-list-photo-<id> / plant-photo-<id> /
          project-photo-<id> contract is driven by automated bulk-attach sessions outside the app. */}
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
      {/* NO `capture` attribute, ever. Its absence is the whole feature, which makes it invisible in
          a diff and easy to reinstate "for mobile" — the guard against that is PhotoUpload.test.jsx
          asserting the attribute is absent, not this comment. */}
      {/* `multiple` is rendered ONLY in multi mode — `multiple={false}` would still emit the
          attribute in some renderers, and the single-mode DOM must not carry it. `undefined` is
          the only spelling React omits outright. */}
      <input
        ref={inputRef}
        id={resolvedId}
        type="file"
        accept={accept}
        multiple={multiEnabled ? true : undefined}
        onChange={handleChange}
        disabled={busy}
        aria-hidden="true"
        tabIndex={-1}
        style={{ display: 'none' }}
        data-testid="photo-upload-input"
      />

      {/* MULTI-ONLY from here to the end of the block: the staged strip, which REPLACES the hook's
          single preview and single error banner. It needs a per-file surface — one collapsed banner
          for "2 of 5 failed" cannot say WHICH two, and the user's only recovery would be to re-pick
          all five. */}
      {multiEnabled && stageNotice && (
        <div role="status" data-testid="photo-upload-stage-notice"
             style={{ marginTop: T.photo.gapSm, color: P.mid, fontSize: T.type.base }}>
          {stageNotice}
        </div>
      )}

      {multiEnabled && staged.length > 0 && (
        <>
          {/* HEIGHT-CAPPED. Uncapped, this strip's cost is unbounded in the number of files, on a
              surface that is a scrolling column of siblings: ten staged files on a PlantingTile
              grew the card past the viewport and pushed the next card off screen
              (tests/harness/photostrips.jsx, measured at 390x844).

              Two caps because the two modes have different rows: 216px is about two rows of 88px
              tiles; 120px is about four compact filename rows, tighter because that mode renders
              inside a card footer. Scrolling inside keeps every file reachable and the cost
              constant.

              BOTH CAPS ARE CARD-FOOTER CONSTANTS, and `stripMaxHeight` exists because the strip
              also renders outside a card footer. Measured in a real browser at 390x844
              (tests/harness/plantingphotosheet.jsx), neither visible to jsdom:
                • 216 is NOT quite two rows. A row is 108px — an 88px tile plus its 4px margin and
                  its 16px status line — so two rows need 224px and the cap slices row 2's "Added"
                  labels through the middle of the glyphs.
                • Inside PlantingPhotoSheet the cap is actively harmful: it hides tiles behind an
                  inner scrollbar while the screen sits empty above the sheet, and in the failure
                  state it hides WHICH files failed. That sheet passes 'none' and lets its own panel
                  be the single scroller. */}
          <ul
            data-testid="photo-upload-staged"
            style={{ display: 'flex', flexWrap: 'wrap', gap: T.photo.gapSm,
                     listStyle: 'none', padding: 0, margin: 0, marginTop: T.photo.gapMd,
                     maxHeight: stripMaxHeight ?? (showPreview ? 216 : 120), overflowY: 'auto' }}
          >
            {staged.map(item => (
              <li key={item.id} data-testid="photo-upload-staged-item" data-status={item.status}
                  style={{ position: 'relative', width: showPreview ? 88 : '100%' }}>
                {/* `showPreview={false}` callers (PlantingTile's 34px footer circle) get a COMPACT
                    row instead of an 88px tile — a thumbnail grid would wreck that card. The
                    per-file status and per-file error still render either way; only the picture is
                    optional. */}
                {showPreview ? (
                  <img
                    src={item.url}
                    alt={item.file?.name ? `Staged photo ${item.file.name}` : 'Staged photo'}
                    style={{ width: 88, height: 88, objectFit: 'cover',
                             borderRadius: T.photo.thumbRadius, display: 'block',
                             border: `1px solid ${P.border}`,
                             opacity: item.status === 'uploading' ? 0.55 : 1 }}
                  />
                ) : (
                  <span style={{ fontSize: T.type.xs, color: P.mid, wordBreak: 'break-all' }}>
                    {item.file?.name ?? 'photo'}
                  </span>
                )}
                {item.status !== 'uploading' && (
                  <button
                    type="button"
                    onClick={() => removeStaged(item.id)}
                    aria-label={`Remove ${item.file?.name ?? 'photo'}`}
                    data-testid="photo-upload-staged-remove"
                    // T.radiusPill (20) on a 22px box is a circle for all practical purposes; the
                    // design system carries no 50% token.
                    style={showPreview
                      ? { position: 'absolute', top: 4, right: 4,
                          background: 'rgba(0,0,0,0.55)', color: P.white,
                          border: 'none', borderRadius: T.radiusPill, width: 22, height: 22,
                          cursor: 'pointer', fontSize: T.type.xs, lineHeight: 1 }
                      : { marginLeft: T.space.xs, background: 'transparent', color: P.mid,
                          border: 'none', cursor: 'pointer', fontSize: T.type.sm, lineHeight: 1 }}
                  >×</button>
                )}
                {/* The status line is TEXT, not a colour or an icon: "which one failed" has to
                    survive a screen reader and a monochrome glance, and the error text itself is
                    what tells the user whether a retry is worth it. */}
                <div data-testid="photo-upload-staged-status"
                     style={{ fontSize: T.type.xs, marginTop: T.space.xs, textAlign: 'center',
                              color: item.status === 'error' ? P.photoErrorInk : P.mid }}>
                  {item.status === 'uploading' ? (typeof progress === 'number' ? `${progress}%` : 'Uploading…')
                    : item.status === 'done' ? 'Added'
                    : item.status === 'error' ? 'Failed'
                    : 'Ready'}
                </div>
                {item.status === 'error' && item.error && (
                  <div role="alert" data-testid="photo-upload-staged-error"
                       style={{ fontSize: T.type.xs, color: P.photoErrorInk, textAlign: 'center' }}>
                    {item.error}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!isUploading && (
            /* The link LOOK is small but the hit box meets the app's 44px floor (T.tapMinHeight),
               on the one control that discards a whole batch; inline-flex keeps the text centred
               in it. */
            <button type="button" onClick={clearStaged} data-testid="photo-upload-staged-clear"
                    style={{ marginTop: T.photo.gapSm, fontSize: T.photo.linkFont,
                             display: 'inline-flex', alignItems: 'center',
                             // Padding on the RIGHT only: it buys the width back (33px of text ->
                             // 48px box) without shifting "Clear" off the strip's left edge.
                             minHeight: T.tapMinHeight, padding: 0, paddingRight: T.space.md,
                             background: 'transparent', border: 'none',
                             color: P.sage, cursor: 'pointer', textDecoration: 'underline' }}>
              Clear
            </button>
          )}
        </>
      )}

      {!multiEnabled && showPreview && preview && (
        <div style={{ marginTop: T.photo.gapMd }}>
          <img
            src={preview}
            alt="Upload preview"
            data-testid="photo-upload-preview"
            style={{ maxWidth: '100%', maxHeight: '240px', borderRadius: T.photo.thumbRadius }}
          />
        </div>
      )}

      {/* The hook-level banner is single-mode only. In multi mode `error` holds whichever file
          failed LAST, so rendering it here would restate one per-file failure as if it described
          the batch. */}
      {!multiEnabled && error && errorMode === 'surface' && (
        <div role="alert" data-testid="photo-upload-error"
             style={{ marginTop: T.photo.gapSm, color: P.photoErrorInk, fontSize: T.type.base }}>
          {error}
        </div>
      )}

      {!multiEnabled && photo && (
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
