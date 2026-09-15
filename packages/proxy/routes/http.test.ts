// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { boundedJson, errorResponse } from "./http"

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

describe("errorResponse", () => {
  it.each([
    ["unauthenticated", "Sign in to AOS to continue."],
    ["forbidden", "You do not have permission to do that."],
    ["invalid_request", "The request could not be processed."],
    ["not_found", "The requested item was not found."],
    ["revision_conflict", "This item changed. Refresh and try again."],
    ["run_conflict", "A run is already active for this session."],
    ["run_capacity_exceeded", "AOS is at capacity. Please try again shortly."],
    [
      "runtime_authentication_required",
      "The configured runtime credentials were rejected. Check the gateway configuration.",
    ],
    [
      "temporarily_unavailable",
      "The service is temporarily unavailable. Please try again.",
    ],
    [
      "connection_interrupted",
      "The connection was interrupted. AOS will reconcile before continuing.",
    ],
    [
      "uncertain_mutation",
      "The runtime may have accepted the request. Refresh to reconcile before trying again.",
    ],
    ["internal_error", "Something went wrong. Please try again."],
  ] as const)(
    "returns a safe friendly description for %s",
    async (code, description) => {
      const response = errorResponse(code, 503)

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: { code, description },
      })
    }
  )
})
