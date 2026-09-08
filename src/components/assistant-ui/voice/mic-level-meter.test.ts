import { describe, expect, it, vi } from "vitest"
import { MicLevelMeter, normalizedRms } from "./mic-level-meter"

describe("microphone level signal", () => {
  it("removes DC offset and maps real amplitude into bounded loudness", () => {
    expect(normalizedRms(new Float32Array(32).fill(0.25))).toBe(0)
    const wave = Float32Array.from({ length: 32 }, (_, index) =>
      index % 2 ? -0.5 : 0.5
    )
    expect(normalizedRms(wave)).toBeGreaterThan(0.7)
    expect(normalizedRms(new Float32Array([Infinity, NaN]))).toBe(0)
  })

  it("publishes a smoothed 14-sample history and releases only analyzer resources", async () => {
    let frame: FrameRequestCallback | undefined
    let frameId = 0
    const cancelFrame = vi.fn()
    const source = { connect: vi.fn(), disconnect: vi.fn() }
    const analyser = {
      fftSize: 0,
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((data: Float32Array) => {
        for (let index = 0; index < data.length; index++)
          data[index] = index % 2 ? -0.5 : 0.5
      }),
    }
    const context = {
      state: "running",
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    const stop = vi.fn()
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream
    const meter = new MicLevelMeter({
      createContext: () => context,
      requestFrame: (callback) => {
        frame = callback
        return ++frameId
      },
      cancelFrame,
      reducedMotion: false,
    })
    const listener = vi.fn()
    meter.subscribe(listener)
    meter.attach(stream)
    frame?.(50)
    const snapshot = meter.getSnapshot()
    expect(snapshot).toHaveLength(14)
    expect(snapshot.slice(0, 13)).toEqual(new Array(13).fill(0))
    expect(snapshot[13]).toBeGreaterThan(0)
    expect(snapshot.every((level) => level >= 0 && level <= 1)).toBe(true)
    meter.dispose()
    meter.dispose()
    await Promise.resolve()
    expect(source.disconnect).toHaveBeenCalledOnce()
    expect(analyser.disconnect).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(cancelFrame).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
    const calls = listener.mock.calls.length
    frame?.(100)
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it("drops quickly enough to preserve speech gaps", () => {
    let frame: FrameRequestCallback | undefined
    let loud = true
    const analyser = {
      fftSize: 0,
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((data: Float32Array) => {
        for (let index = 0; index < data.length; index++)
          data[index] = loud ? (index % 2 ? -0.5 : 0.5) : 0
      }),
    }
    const meter = new MicLevelMeter({
      createContext: () => ({
        state: "running",
        createMediaStreamSource: vi.fn(() => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
        createAnalyser: vi.fn(() => analyser),
        resume: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
      requestFrame: (callback) => {
        frame = callback
        return 1
      },
      cancelFrame: vi.fn(),
      reducedMotion: false,
    })
    meter.attach({} as MediaStream)
    frame?.(50)
    const peak = meter.getSnapshot().at(-1)!
    loud = false
    frame?.(100)
    expect(meter.getSnapshot().at(-1)).toBeLessThan(peak * 0.6)
    meter.dispose()
  })

  it("resumes a suspended AudioContext while the record gesture is active", () => {
    const resume = vi.fn(async () => {})
    const context = {
      state: "suspended",
      createMediaStreamSource: vi.fn(),
      createAnalyser: vi.fn(),
      resume,
      close: vi.fn(async () => {}),
    }
    const meter = new MicLevelMeter({
      createContext: () => context,
      requestFrame: vi.fn(),
      cancelFrame: vi.fn(),
    })
    expect(resume).toHaveBeenCalledOnce()
    meter.dispose()
  })
})
