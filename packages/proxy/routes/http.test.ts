// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { boundedJson } from "./http"

function oversizedBody(maxBytes: number) {
  let pulls = 0
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(maxBytes))
          return
        }
        if (pulls === 2) {
          controller.enqueue(Uint8Array.of(1))
          return
        }
        controller.close()
      },
      cancel,
    },
    { highWaterMark: 0 }
  )
  return { body, cancel, pulls: () => pulls }
}

describe("boundedJson", () => {
  it.each([
    ["missing", undefined],
    ["spoofed", "1"],
  ])(
    "cancels a %s-content-length body as soon as it exceeds the byte limit",
    async (_name, contentLength) => {
      const stream = oversizedBody(8)
      const request = new Request("http://proxy.test/input", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(contentLength === undefined
            ? {}
            : { "content-length": contentLength }),
        },
        body: stream.body,
        duplex: "half",
      } as RequestInit & { duplex: "half" })

      const result = await boundedJson(request, 8)

      expect(result).toBeUndefined()
      expect(stream.cancel).toHaveBeenCalledOnce()
      expect(stream.pulls()).toBe(2)
    }
  )
})
