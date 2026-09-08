import { describe, expect, it } from "vitest"
import { resolveRuntimeConfiguration } from "../src/lib/runtime-config"
import * as config from "./runtime-config"

describe("Hermes runtime configuration", () => {
  it("accepts an explicit native Hermes endpoint without exposing credentials", () => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "hermes",
        AOS_UI_HERMES_BASE_URL: "http://127.0.0.1:8643",
      })
    ).toEqual({
      status: "ready",
      mode: "hermes",
      baseUrl: "http://127.0.0.1:8643",
    })
  })
  it("does not fall back when Hermes endpoint is missing", () => {
    expect(
      resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "hermes" })
    ).toEqual({ status: "unavailable", reason: "missing-hermes-base-url" })
  })
})

describe("public configuration", () => {
  it("requires the external OpenCode directory and preserves it for SDK scoping", () => {
    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "opencode",
        baseUrl: "http://127.0.0.1:4096",
      }).status
    ).toBe("unavailable")
    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "opencode",
        baseUrl: "http://127.0.0.1:4096",
        directory: "/external/agents",
      })
    ).toMatchObject({ status: "ready", directory: "/external/agents" })
    expect(
      resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "opencode" })
    ).toEqual({ status: "unavailable", reason: "missing-opencode-directory" })
  })
  it("rejects embedded credentials for every public harness endpoint", () => {
    for (const mode of ["opencode", "ag-ui"] as const) {
      const secretUrl = "https://user:secret@example.test"
      const input =
        mode === "opencode"
          ? { mode, baseUrl: secretUrl }
          : { mode, runUrl: secretUrl, workspaceUrl: "https://example.test" }
      expect(config.parsePublicRuntimeConfiguration(input).status).toBe(
        "unavailable"
      )
    }
  })
  it("exports a strict public parser", () => {
    expect(config).toHaveProperty("parsePublicRuntimeConfiguration")
  })
  it("rejects secret fields and missing deployment configuration", () => {
    for (const input of [
      undefined,
      {},
      { mode: "hermes", baseUrl: "/api/hermes", apiKey: "secret" },
    ]) {
      expect(config.parsePublicRuntimeConfiguration(input)).toEqual({
        status: "unavailable",
        reason: "invalid-public-config",
      })
    }
  })
  it("accepts same-origin Hermes proxy prefixes", () => {
    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "hermes",
        baseUrl: "/api/hermes",
      })
    ).toEqual({ status: "ready", mode: "hermes", baseUrl: "/api/hermes" })
  })
  it("rejects credentials or query strings in Hermes URLs", () => {
    for (const baseUrl of [
      "//evil.test",
      "https://user:secret@example.test",
      "https://example.test?key=secret",
    ]) {
      expect(
        config.parsePublicRuntimeConfiguration({ mode: "hermes", baseUrl })
          .status
      ).toBe("unavailable")
    }
  })
})
