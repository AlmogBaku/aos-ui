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
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: true,
      },
    })
  })
  it("does not fall back when Hermes endpoint is missing", () => {
    expect(
      resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "hermes" })
    ).toEqual({ status: "unavailable", reason: "missing-hermes-base-url" })
  })
})

describe("public configuration", () => {
  it("accepts only credential-free HTTPS origins for artifact HTML assets", () => {
    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "fixture",
        artifactHtmlAssetOrigins: [
          "https://cdn.example.test",
          "https://fonts.example.test",
        ],
      })
    ).toMatchObject({
      status: "ready",
      mode: "fixture",
      artifactHtmlAssetOrigins: [
        "https://cdn.example.test",
        "https://fonts.example.test",
      ],
    })

    for (const origin of [
      "http://cdn.example.test",
      "https://user:secret@cdn.example.test",
      "https://cdn.example.test/assets",
      "https://cdn.example.test?token=secret",
    ]) {
      expect(
        config.parsePublicRuntimeConfiguration({
          mode: "fixture",
          artifactHtmlAssetOrigins: [origin],
        })
      ).toEqual({
        status: "unavailable",
        reason: "invalid-public-config",
      })
    }
  })

  it.each([
    {
      AOS_UI_RUNTIME_MODE: "fixture",
      AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED: "false",
    },
    {
      AOS_UI_RUNTIME_MODE: "hermes",
      AOS_UI_HERMES_BASE_URL: "/hermes",
      AOS_UI_COMPOSER_CONTEXT_ENABLED: "false",
    },
    {
      AOS_UI_RUNTIME_MODE: "opencode",
      AOS_UI_OPENCODE_WORKTREE: "/workspace",
    },
    {
      AOS_UI_RUNTIME_MODE: "ag-ui",
      AOS_UI_AG_UI_URL: "https://agents.example/run",
      AOS_UI_AG_UI_WORKSPACE_URL: "https://agents.example/workspace",
    },
    {
      AOS_UI_RUNTIME_MODE: "openclaw",
      AOS_UI_OPENCLAW_BASE_URL: "/openclaw",
    },
  ] as const)(
    "round-trips environment-derived %s config through the public boundary",
    (environment) => {
      const resolved = resolveRuntimeConfiguration(environment)
      const serialize = (
        config as unknown as {
          serializePublicRuntimeConfiguration: (
            value: ReturnType<typeof resolveRuntimeConfiguration>
          ) => unknown
        }
      ).serializePublicRuntimeConfiguration

      const body = JSON.stringify(serialize(resolved))

      expect(config.parsePublicRuntimeConfiguration(JSON.parse(body))).toEqual(
        resolved
      )
    }
  )

  it("defaults both composer features on and accepts independent public opt-outs", () => {
    expect(
      config.parsePublicRuntimeConfiguration({ mode: "fixture" })
    ).toMatchObject({
      status: "ready",
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: true,
      },
    })

    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "fixture",
        composerModelSelectorEnabled: false,
      })
    ).toMatchObject({
      status: "ready",
      composerFeatures: {
        modelSelectorEnabled: false,
        contextEnabled: true,
      },
    })

    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "fixture",
        composerContextEnabled: false,
      })
    ).toMatchObject({
      status: "ready",
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: false,
      },
    })
  })

  it("omits default-enabled composer fields from the public fixture payload", () => {
    const serialize = (
      config as unknown as {
        serializePublicRuntimeConfiguration: (
          value: ReturnType<typeof resolveRuntimeConfiguration>
        ) => unknown
      }
    ).serializePublicRuntimeConfiguration

    expect(
      serialize(resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "fixture" }))
    ).toEqual({ mode: "fixture" })
  })

  it("resolves independent composer feature environment flags", () => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "fixture",
        AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED: "false",
      })
    ).toMatchObject({
      composerFeatures: {
        modelSelectorEnabled: false,
        contextEnabled: true,
      },
    })
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "fixture",
        AOS_UI_COMPOSER_CONTEXT_ENABLED: "false",
      })
    ).toMatchObject({
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: false,
      },
    })
  })

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
  it("recognizes the isolated guest surface without treating it as a runtime", () => {
    expect(
      config.parsePublicApplicationConfiguration({ surface: "guest" })
    ).toEqual({
      status: "ready",
      surface: "guest",
    })
    expect(
      config.parsePublicApplicationConfiguration({
        surface: "guest",
        mode: "hermes",
      })
    ).toEqual({ status: "unavailable", reason: "invalid-public-config" })
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
    ).toEqual({
      status: "ready",
      mode: "hermes",
      baseUrl: "/api/hermes",
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: true,
      },
    })
  })
  it("accepts a same-origin OpenCode proxy prefix", () => {
    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "opencode",
        baseUrl: "/opencode",
        directory: "/external/agents",
      })
    ).toEqual({
      status: "ready",
      mode: "opencode",
      baseUrl: "/opencode",
      directory: "/external/agents",
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: true,
      },
    })
  })
  it("accepts a credential-free OpenClaw WebSocket proxy and rejects secrets", () => {
    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "openclaw",
        baseUrl: "/openclaw",
        creatorAgentId: "creator",
      })
    ).toEqual({
      status: "ready",
      mode: "openclaw",
      baseUrl: "/openclaw",
      creatorAgentId: "creator",
      composerFeatures: {
        modelSelectorEnabled: true,
        contextEnabled: true,
      },
    })
    expect(
      config.parsePublicRuntimeConfiguration({
        mode: "openclaw",
        baseUrl: "/openclaw",
        token: "secret",
      })
    ).toEqual({ status: "unavailable", reason: "invalid-public-config" })
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
