import { describe, expect, it, vi } from "vitest"

import {
  parsePushEndpoint,
  PushEndpointError,
  resolvePublicAddresses,
} from "./endpoint"

/** A lookup that answers with exactly these addresses. */
function lookup(...addresses: string[]) {
  return vi.fn(async () => addresses.map((address) => ({ address })))
}

describe("push endpoint validation", () => {
  it("accepts a public https endpoint on the default port", () => {
    const endpoint = parsePushEndpoint("https://push.example/abc")

    expect(endpoint.hostname).toBe("push.example")
    expect(endpoint.href).toBe("https://push.example/abc")
  })

  it.each([
    ["plain HTTP", "http://push.example/abc"],
    ["a non-default port", "https://push.example:8443/abc"],
    ["credentials", "https://user:pass@push.example/abc"],
    ["a query", "https://push.example/abc?q=1"],
    ["a fragment", "https://push.example/abc#f"],
    ["an IPv4 literal", "https://127.0.0.1/x"],
    ["an IPv6 literal", "https://[::1]/x"],
    ["localhost", "https://localhost/x"],
    ["an unqualified name", "https://host/x"],
    ["an mDNS name", "https://a.local/x"],
    ["nothing resembling a URL", "push.example/abc"],
  ])("refuses %s", (_label, value) => {
    expect(() => parsePushEndpoint(value)).toThrow(PushEndpointError)
  })

  it.each([
    ["private", "10.0.0.5"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["loopback", "127.0.0.1"],
    ["link-local", "169.254.1.1"],
    ["unique-local", "fd00::1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
  ])("refuses a host resolving to a %s address", async (_label, address) => {
    await expect(
      resolvePublicAddresses("push.example", lookup(address))
    ).rejects.toThrow(PushEndpointError)
  })

  it("accepts a host that resolves to public unicast addresses only", async () => {
    await expect(
      resolvePublicAddresses("push.example", lookup("8.8.8.8"))
    ).resolves.toEqual(["8.8.8.8"])
    await expect(
      resolvePublicAddresses("push.example", lookup("2606:4700::1111"))
    ).resolves.toEqual(["2606:4700::1111"])
  })

  it("refuses a host that mixes a public address with a private one", async () => {
    await expect(
      resolvePublicAddresses("push.example", lookup("8.8.8.8", "10.0.0.5"))
    ).rejects.toThrow(PushEndpointError)
  })

  it("refuses a host that resolves to nothing, or not at all", async () => {
    await expect(
      resolvePublicAddresses("push.example", lookup())
    ).rejects.toThrow(PushEndpointError)
    await expect(
      resolvePublicAddresses(
        "push.example",
        vi.fn(async () => {
          throw new Error("ENOTFOUND")
        })
      )
    ).rejects.toThrow(PushEndpointError)
  })
})
