import { describe, expect, it, vi } from "vitest"

import { createGatewayLog } from "./factory"

describe("Hermes gateway log", () => {
  it("writes one redacted structured line per gateway event", () => {
    const write = vi.fn()
    const log = createGatewayLog(write)

    log.warn("hermes.gateway.dial_failed", {
      reason: "HermesUnavailableError",
      close_code: 4401,
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toEqual({
      event: "hermes.gateway.dial_failed",
      reason: "HermesUnavailableError",
      close_code: 4401,
    })
  })

  it("redacts a secret-bearing field a caller passes by mistake", () => {
    const write = vi.fn()
    const log = createGatewayLog(write)

    log.warn("hermes.gateway.frame_rejected", {
      token: "native-secret",
      url: "http://127.0.0.1:9119/api/ws?token=native-secret",
    })

    const line = write.mock.calls[0]![0] as string
    expect(line).not.toContain("native-secret")
    expect(JSON.parse(line)).toEqual({
      event: "hermes.gateway.frame_rejected",
      token: "[REDACTED]",
      url: "http://127.0.0.1:9119/api/ws",
    })
  })
})
