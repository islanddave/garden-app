// src/lib/uploadPut.js
// BUG-PHOTOUPLOADHANG-001 — the original S3 PUT was a bare window.fetch with NO bound (the
// deliberate v3.69 decision: "a large original legitimately takes a while"). That is exactly
// where a stuck save was traced on 2026-07-27: presign logged at the Lambda, no object ever
// landed in S3, no register call — the PUT sat on a dead socket forever with no error and no
// timeout, and the UI showed "Uploading…" until the app was killed.
//
// XHR instead of fetch because fetch has no upload-progress events, and progress is the only
// honest way to bound a big upload on a slow uplink: a short total timeout kills legitimate
// slow-but-moving uploads (a 7MB fallback original on a weak connection), while a long one is
// not a real bound. The watchdog aborts only when BYTES STOP MOVING for PUT_STALL_MS; a hard
// PUT_MAX_MS ceiling backstops the pathological trickle. Progress % is surfaced so the UI can
// show "Uploading… 43%" — which also turns the next stall report into a named, located fact.

export const PUT_STALL_MS = 30_000;   // no progress event for this long = the socket is dead
export const PUT_MAX_MS   = 180_000;  // absolute ceiling even for a moving upload

export function putWithProgress(url, body, contentType, opts = {}) {
  const {
    onProgress = null,
    stallMs = PUT_STALL_MS,
    maxMs = PUT_MAX_MS,
    XHR = (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null),
  } = opts;
  if (!XHR) return Promise.reject(new Error('uploadPut: XMLHttpRequest unavailable'));

  return new Promise((resolve, reject) => {
    const xhr = new XHR();
    let settled = false;
    let stallTimer = null;
    const maxTimer = setTimeout(() => fail(new Error('Upload timed out — took longer than 3 minutes')), maxMs);

    function cleanup() {
      clearTimeout(maxTimer);
      if (stallTimer) clearTimeout(stallTimer);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      try { xhr.abort(); } catch { /* noop */ }
      reject(err);
    }
    function armStallTimer() {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => fail(new Error('Upload stalled — the connection stopped sending. Check your signal and try again.')), stallMs);
    }

    armStallTimer();
    if (xhr.upload && typeof xhr.upload.addEventListener === 'function') {
      xhr.upload.addEventListener('progress', (e) => {
        if (settled) return;
        armStallTimer();
        if (e && e.lengthComputable && e.total > 0 && typeof onProgress === 'function') {
          try { onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100))); } catch { /* noop */ }
        }
      });
    }
    xhr.addEventListener('load', () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, status: xhr.status });
      else reject(new Error(`S3 upload failed: ${xhr.status}`));
    });
    xhr.addEventListener('error', () => fail(new Error('S3 upload failed: network error')));
    xhr.addEventListener('abort', () => fail(new Error('Upload cancelled')));

    xhr.open('PUT', url);
    if (contentType && typeof xhr.setRequestHeader === 'function') xhr.setRequestHeader('Content-Type', contentType);
    xhr.send(body);
  });
}
