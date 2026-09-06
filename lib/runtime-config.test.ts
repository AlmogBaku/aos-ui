import { describe, expect, it } from "vitest"

import { resolveRuntimeConfiguration } from "./runtime-config"

describe("resolveRuntimeConfiguration", () => {
  it.each([
    "https://manager.test?token=secret",
    "https://manager.test?",
    "https://manager.test#visibility",
    "https://manager.test#",
    "https://user:secret@manager.test",
    "https://user@manager.test",
  ])("rejects unsupported management URL components: %s", (managementUrl) => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_OPENCODE_MANAGEMENT_URL: managementUrl,
      })
    ).toEqual({
      status: "unavailable",
      reason: "invalid-opencode-management-url",
    })
  })

  it("preserves management path prefixes and normalizes trailing slashes", () => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_OPENCODE_MANAGEMENT_URL: "https://manager.test/management///",
      })
    ).toMatchObject({ managementUrl: "https://manager.test/management" })
  })

  it("accepts an optional management URL and leaves external providers read-only by default", () => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_OPENCODE_BASE_URL: "https://provider.test",
      })
    ).not.toHaveProperty("managementUrl")
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_OPENCODE_MANAGEMENT_URL: "http://localhost:4097/",
      })
    ).toMatchObject({ managementUrl: "http://localhost:4097" })
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_OPENCODE_MANAGEMENT_URL: "file:///tmp/agents",
      })
    ).toEqual({
      status: "unavailable",
      reason: "invalid-opencode-management-url",
    })
  })
  it("lets OpenCode select its model when no override is configured", () => {
    expect(resolveRuntimeConfiguration({})).toEqual({
      status: "ready",
      mode: "opencode",
      baseUrl: "http://127.0.0.1:4096",
    })
  })

  it.each(["fixture", "opencode"] as const)(
    "recognizes the exact %s runtime mode",
    (mode) => {
      expect(
        resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: mode })
      ).toMatchObject({ status: "ready", mode })
    }
  )

  it("normalizes the OpenCode host and uses a complete trimmed model override", () => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "opencode",
        AOS_UI_OPENCODE_BASE_URL: "http://localhost:5000/",
        AOS_UI_OPENCODE_PROVIDER_ID: " amazon-bedrock ",
        AOS_UI_OPENCODE_MODEL_ID: " anthropic.claude-haiku-4-5-20251001-v1:0 ",
      })
    ).toEqual({
      status: "ready",
      mode: "opencode",
      baseUrl: "http://localhost:5000",
      defaultModel: {
        providerID: "amazon-bedrock",
        modelID: "anthropic.claude-haiku-4-5-20251001-v1:0",
      },
    })
  })

  it.each([
    { AOS_UI_OPENCODE_PROVIDER_ID: "amazon-bedrock" },
    { AOS_UI_OPENCODE_MODEL_ID: "anthropic.claude-haiku-4-5-20251001-v1:0" },
    {
      AOS_UI_OPENCODE_PROVIDER_ID: "   ",
      AOS_UI_OPENCODE_MODEL_ID: "anthropic.claude-haiku-4-5-20251001-v1:0",
    },
    {
      AOS_UI_OPENCODE_PROVIDER_ID: "amazon-bedrock",
      AOS_UI_OPENCODE_MODEL_ID: "   ",
    },
  ])("rejects an incomplete OpenCode model override", (environment) => {
    expect(resolveRuntimeConfiguration(environment)).toEqual({
      status: "unavailable",
      reason: "incomplete-opencode-model-override",
    })
  })

  it("does not silently ignore an invalid OpenCode host", () => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "opencode",
        AOS_UI_OPENCODE_BASE_URL: "file:///tmp/opencode",
      })
    ).toEqual({ status: "unavailable", reason: "invalid-opencode-base-url" })
  })

  it("recognizes AG-UI when both protocol and workspace hosts are configured", () => {
    expect(
      resolveRuntimeConfiguration({
        AOS_UI_RUNTIME_MODE: "ag-ui",
        AOS_UI_AG_UI_URL: "https://agents.example/run",
        AOS_UI_AG_UI_WORKSPACE_URL: "https://agents.example/workspace/",
      })
    ).toEqual({
      status: "ready",
      mode: "ag-ui",
      runUrl: "https://agents.example/run",
      workspaceUrl: "https://agents.example/workspace",
    })
  })

  it("does not silently route a mistyped mode to fixtures", () => {
    expect(
      resolveRuntimeConfiguration({ AOS_UI_RUNTIME_MODE: "AG-UI" })
    ).toEqual({ status: "unavailable", reason: "invalid-runtime-mode" })
  })

  it.each([
    [{ AOS_UI_RUNTIME_MODE: "ag-ui" }, "missing-ag-ui-run-url"],
    [
      {
        AOS_UI_RUNTIME_MODE: "ag-ui",
        AOS_UI_AG_UI_URL: "https://agents.example/run",
      },
      "missing-ag-ui-workspace-url",
    ],
    [
      {
        AOS_UI_RUNTIME_MODE: "ag-ui",
        AOS_UI_AG_UI_URL: "file:///tmp/agent",
        AOS_UI_AG_UI_WORKSPACE_URL: "https://agents.example/workspace",
      },
      "invalid-ag-ui-run-url",
    ],
    [
      {
        AOS_UI_RUNTIME_MODE: "ag-ui",
        AOS_UI_AG_UI_URL: "https://agents.example/run",
        AOS_UI_AG_UI_WORKSPACE_URL: "agents.example/workspace",
      },
      "invalid-ag-ui-workspace-url",
    ],
  ] as const)(
    "reports incomplete AG-UI configuration",
    (environment, reason) => {
      expect(resolveRuntimeConfiguration(environment)).toEqual({
        status: "unavailable",
        reason,
      })
    }
  )
})
