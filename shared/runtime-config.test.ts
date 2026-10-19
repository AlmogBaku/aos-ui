import { describe, expect, it } from "vitest"

import {
  parsePublicApplicationConfiguration,
  parsePublicRuntimeConfiguration,
  resolveRuntimeConfiguration,
  serializePublicRuntimeConfiguration,
} from "./runtime-config"

describe("browser runtime configuration", () => {
  it("round-trips the gateway configuration without a provider URL", () => {
    const resolved = resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "aos" })
    expect(serializePublicRuntimeConfiguration(resolved)).toEqual({
      mode: "aos",
    })
    expect(parsePublicRuntimeConfiguration({ mode: "aos" })).toEqual(resolved)
  })

  it("keeps fixture explicit and composer capability switches independent", () => {
    expect(
      parsePublicRuntimeConfiguration({
        mode: "fixture",
        composerModelSelectorEnabled: false,
      })
    ).toMatchObject({
      status: "ready",
      mode: "fixture",
      composerFeatures: {
        modelSelectorEnabled: false,
        contextEnabled: true,
      },
    })
  })

  it("rejects provider settings and unrecognized public fields", () => {
    for (const input of [
      undefined,
      {},
      { mode: "hermes", baseUrl: "/hermes" },
      { mode: "aos", providerUrl: "http://127.0.0.1:9119" },
      { mode: "aos", apiKey: "secret" },
      // A lane origin is exact, as the web server writes it.
      {
        mode: "aos",
        publicOrigins: ["https://aos.example.test/"],
        mcpAppSandboxOrigin: "https://sandbox.example.test",
      },
      // And the stable origins are one wildcard origin.
      { mode: "aos", mcpAppStableOrigins: "https://mcp-apps.example.test" },
    ]) {
      expect(parsePublicRuntimeConfiguration(input)).toEqual({
        status: "unavailable",
        reason: "invalid-public-config",
      })
    }
  })

  it("recognizes the isolated guest listener and the deployment's origins without treating it as a runtime", () => {
    const origins = {
      publicOrigins: ["https://aos.example.test", "https://guest.example.test"],
      mcpAppSandboxOrigin: "https://sandbox.example.test",
      mcpAppStableOrigins: "https://*.mcp-apps.example.test",
    }
    expect(
      parsePublicApplicationConfiguration({
        surface: "guest",
        ...origins,
        buildId: "build-1",
      })
    ).toEqual({ status: "ready", surface: "guest", origins })
  })
})
