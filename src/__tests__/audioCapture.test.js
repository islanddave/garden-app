import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock module under test (re-import each test to pick up environment changes)
import { isAudioCaptureSupported, startRecording } from '../lib/audioCapture.js'

const realMediaRecorder = globalThis.MediaRecorder
const realNavigator     = globalThis.navigator

function makeFakeMediaRecorder({ failStart = false } = {}) {
  class FakeMediaRecorder {
    constructor(stream, opts) {
      this.stream    = stream
      this.mimeType  = (opts && opts.mimeType) || 'audio/webm'
      this.onstop    = null
      this.onerror   = null
      this.ondataavailable = null
      this._stopped = false
    }
    start() {
      if (failStart) throw new Error('start failed')
      // Synchronously emit one chunk so stop() has data to package
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new Blob(['chunk'], { type: this.mimeType }) })
      }, 0)
    }
    stop() {
      if (this._stopped) return
      this._stopped = true
      setTimeout(() => { if (this.onstop) this.onstop() }, 0)
    }
  }
  FakeMediaRecorder.isTypeSupported = (m) => m === 'audio/webm'
  return FakeMediaRecorder
}

function makeFakeStream() {
  return {
    getTracks: () => [{ stop: vi.fn() }],
  }
}

function withEnv({ navigator: nav, MediaRecorder: MR }, fn) {
  if (nav !== undefined) Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true })
  if (MR  !== undefined) globalThis.MediaRecorder = MR
  return fn().finally(() => {
    if (nav !== undefined) Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true })
    if (MR  !== undefined) globalThis.MediaRecorder = realMediaRecorder
  })
}

describe('audioCapture (Inc 2 Bite 4)', () => {
  it('isAudioCaptureSupported: false when MediaRecorder undefined', async () => {
    await withEnv({ MediaRecorder: undefined, navigator: { mediaDevices: { getUserMedia: () => {} } } }, async () => {
      expect(isAudioCaptureSupported()).toBe(false)
    })
  })

  it('isAudioCaptureSupported: false when getUserMedia missing', async () => {
    await withEnv({ MediaRecorder: makeFakeMediaRecorder(), navigator: {} }, async () => {
      expect(isAudioCaptureSupported()).toBe(false)
    })
  })

  it('isAudioCaptureSupported: true when both available + a MIME supported', async () => {
    await withEnv({
      MediaRecorder: makeFakeMediaRecorder(),
      navigator: { mediaDevices: { getUserMedia: () => Promise.resolve(makeFakeStream()) } },
    }, async () => {
      expect(isAudioCaptureSupported()).toBe(true)
    })
  })

  it('startRecording: returns handle, stop() resolves with {blob, mime, durationMs}', async () => {
    await withEnv({
      MediaRecorder: makeFakeMediaRecorder(),
      navigator: { mediaDevices: { getUserMedia: () => Promise.resolve(makeFakeStream()) } },
    }, async () => {
      const handle = await startRecording()
      expect(typeof handle.stop).toBe('function')
      expect(typeof handle.cancel).toBe('function')
      expect(handle.mime).toBe('audio/webm')
      const result = await handle.stop()
      expect(result.blob).toBeTruthy()
      expect(result.mime).toBe('audio/webm')
      expect(typeof result.durationMs).toBe('number')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  it('startRecording: throws "denied" when getUserMedia rejects with NotAllowedError', async () => {
    const err = Object.assign(new Error('x'), { name: 'NotAllowedError' })
    await withEnv({
      MediaRecorder: makeFakeMediaRecorder(),
      navigator: { mediaDevices: { getUserMedia: () => Promise.reject(err) } },
    }, async () => {
      await expect(startRecording()).rejects.toBe('denied')
    })
  })

  it('startRecording: throws "no-device" when getUserMedia rejects with NotFoundError', async () => {
    const err = Object.assign(new Error('x'), { name: 'NotFoundError' })
    await withEnv({
      MediaRecorder: makeFakeMediaRecorder(),
      navigator: { mediaDevices: { getUserMedia: () => Promise.reject(err) } },
    }, async () => {
      await expect(startRecording()).rejects.toBe('no-device')
    })
  })

  it('startRecording: throws "unavailable" when MediaRecorder missing', async () => {
    await withEnv({
      MediaRecorder: undefined,
      navigator: { mediaDevices: { getUserMedia: () => Promise.resolve(makeFakeStream()) } },
    }, async () => {
      await expect(startRecording()).rejects.toBe('unavailable')
    })
  })

  it('handle.cancel: releases the mic without producing a blob', async () => {
    let trackStop = null
    await withEnv({
      MediaRecorder: makeFakeMediaRecorder(),
      navigator: {
        mediaDevices: {
          getUserMedia: () => Promise.resolve({
            getTracks: () => [{ stop: () => { trackStop = true } }],
          }),
        },
      },
    }, async () => {
      const handle = await startRecording()
      handle.cancel()
      // Allow microtasks
      await new Promise((r) => setTimeout(r, 5))
      expect(trackStop).toBe(true)
    })
  })
})
