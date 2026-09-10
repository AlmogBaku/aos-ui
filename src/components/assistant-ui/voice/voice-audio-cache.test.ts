import { afterEach, expect, it, vi } from "vitest"
import { pruneExpiredAudio } from "./voice-audio-cache"

afterEach(() => vi.unstubAllGlobals())

it("shares one in-flight full-store pruning sweep", async () => {
  const request = new EventTarget() as IDBOpenDBRequest
  Object.defineProperty(request, "error", {
    configurable: true,
    value: new Error("IndexedDB unavailable"),
  })
  vi.stubGlobal("indexedDB", {
    open: vi.fn(() => request),
  })

  const first = pruneExpiredAudio(1)
  const overlapping = pruneExpiredAudio(2)

  expect(overlapping).toBe(first)
  request.dispatchEvent(new Event("error"))
  await expect(first).rejects.toThrow("IndexedDB unavailable")
})
