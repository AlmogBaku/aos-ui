import { describe, expect, it } from "vitest"

import { acceptedDomains, appliedMcpAppCsp, buildMcpAppCsp } from "./csp"

const directive = (policy: string, name: string) =>
  policy.split("; ").find((entry) => entry.startsWith(`${name} `))

describe("MCP App CSP", () => {
  it("accepts only https hosts and one leading wildcard label", () => {
    expect(
      acceptedDomains("resourceDomains", [
        "https://api.example.com",
        "https://*.Example.com",
        "http://api.example.com",
        "https://api.example.com:8443",
        "https://api.example.com/path",
        "https://user@example.com",
        "https://*",
        "*",
        "https://a.*.example.com",
        "'unsafe-eval'",
        "https://api.example.com; script-src *",
        "https://api.example.com",
      ])
    ).toEqual([
      "https://api.example.com",
      "https://*.example.com",
      "https://api.example.com:8443",
    ])
  })

  it.each([
    ["https://api.example.com", true],
    ["wss://live.example.com", true],
    ["wss://*.example.com", true],
    ["http://127.0.0.1", true],
    ["http://127.0.0.1:8080", true],
    ["ws://[::1]:9000", false],
    ["http://localhost:3000", true],
    ["ws://localhost", true],
    ["ws://app.localhost:5173", true],
    ["http://*.localhost", true],
    ["http://api.example.com", false],
    ["ws://live.example.com", false],
    ["wss://live.example.com:8443", true],
    ["http://127.0.0.2", false],
    ["http://localhost.example.com", false],
    ["http://127.0.0.1.example.com", false],
    ["ws://localhost:3000/path", false],
    ["http://user@localhost", false],
    ["ftp://localhost", false],
  ])("connections accept %s: %s", (value, admitted) => {
    expect(acceptedDomains("connectDomains", [value])).toEqual(
      admitted ? [value.toLowerCase()] : []
    )
  })

  it("keeps loaded resources and frames on https", () => {
    expect(
      acceptedDomains("frameDomains", [
        "wss://live.example.com",
        "http://localhost:3000",
      ])
    ).toEqual([])
  })

  it("defaults to the spec's closed policy", () => {
    const policy = buildMcpAppCsp(undefined)
    expect(directive(policy, "default-src")).toBe("default-src 'none'")
    expect(directive(policy, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline'"
    )
    expect(directive(policy, "connect-src")).toBe("connect-src 'none'")
    expect(directive(policy, "worker-src")).toBe("worker-src 'self' blob:")
    expect(directive(policy, "frame-src")).toBe("frame-src 'none'")
    expect(directive(policy, "base-uri")).toBe("base-uri 'none'")
    expect(directive(policy, "object-src")).toBe("object-src 'none'")
    expect(directive(policy, "form-action")).toBe("form-action 'none'")
  })

  it("widens each directive only by its declared domains", () => {
    const policy = buildMcpAppCsp({
      connectDomains: [
        "https://api.example.com",
        "wss://live.example.com",
        "http://localhost:3000",
        "http://insecure.example",
      ],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://*.maps.example"],
      baseUriDomains: ["https://base.example"],
    })
    expect(directive(policy, "connect-src")).toBe(
      "connect-src https://api.example.com wss://live.example.com http://localhost:3000"
    )
    for (const name of [
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "media-src",
    ])
      expect(directive(policy, name)).toContain("https://cdn.example.com")
    expect(directive(policy, "connect-src")).not.toContain("cdn.example.com")
    expect(directive(policy, "frame-src")).toBe(
      "frame-src https://*.maps.example"
    )
    expect(directive(policy, "base-uri")).toBe("base-uri https://base.example")
    expect(policy).not.toContain("insecure.example")
  })
})

describe("appliedMcpAppCsp", () => {
  it("reports only the domains the policy admits", () => {
    expect(
      appliedMcpAppCsp({
        connectDomains: ["https://API.example.com", "http://insecure.example"],
        resourceDomains: ["*"],
        frameDomains: ["https://frames.example.com"],
      })
    ).toEqual({
      connectDomains: ["https://api.example.com"],
      frameDomains: ["https://frames.example.com"],
    })
  })

  it("reports nothing when no declared domain is admitted", () => {
    expect(appliedMcpAppCsp({ connectDomains: ["*"] })).toBeUndefined()
    expect(appliedMcpAppCsp(undefined)).toBeUndefined()
  })
})
