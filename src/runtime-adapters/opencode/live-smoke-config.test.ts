import { describe, expect, it } from "vitest"

import { readLiveOpenCodeSmokeConfig } from "./live-smoke-config"

describe("OpenCode live smoke configuration", () => {
  it("stays disabled unless explicitly opted in", () => {
    expect(readLiveOpenCodeSmokeConfig({})).toEqual({ enabled: false })
    expect(readLiveOpenCodeSmokeConfig({ AOS_UI_LIVE_OPENCODE: "0" })).toEqual({
      enabled: false,
    })
  })

  it("uses the official Bedrock provider id without reading AWS credentials", () => {
    expect(
      readLiveOpenCodeSmokeConfig({
        AOS_UI_LIVE_OPENCODE: "1",
        AOS_UI_OPENCODE_MODEL_ID: "us.amazon.nova-micro-v1:0",
        AWS_ACCESS_KEY_ID: "must-not-be-copied",
        AWS_SECRET_ACCESS_KEY: "must-not-be-copied",
      })
    ).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:4096",
      providerID: "amazon-bedrock",
      modelID: "us.amazon.nova-micro-v1:0",
    })
  })

  it("supports an explicit server, provider, and Agent", () => {
    expect(
      readLiveOpenCodeSmokeConfig({
        AOS_UI_LIVE_OPENCODE: "1",
        AOS_UI_OPENCODE_BASE_URL: "http://localhost:5000/",
        AOS_UI_OPENCODE_PROVIDER_ID: "amazon-bedrock",
        AOS_UI_OPENCODE_MODEL_ID: "anthropic.claude-3-haiku",
        AOS_UI_OPENCODE_AGENT_ID: "build",
      })
    ).toEqual({
      enabled: true,
      baseUrl: "http://localhost:5000",
      providerID: "amazon-bedrock",
      modelID: "anthropic.claude-3-haiku",
      agentId: "build",
    })
  })

  it("rejects an enabled smoke without an explicit cheap model", () => {
    expect(() =>
      readLiveOpenCodeSmokeConfig({ AOS_UI_LIVE_OPENCODE: "1" })
    ).toThrow("AOS_UI_OPENCODE_MODEL_ID")
  })

  it("rejects models outside the explicitly cheap Haiku/Nova lane", () => {
    expect(() =>
      readLiveOpenCodeSmokeConfig({
        AOS_UI_LIVE_OPENCODE: "1",
        AOS_UI_OPENCODE_MODEL_ID: "anthropic.claude-sonnet-4",
      })
    ).toThrow("Haiku or Nova")
  })

  it("never runs the live provider smoke in CI", () => {
    expect(
      readLiveOpenCodeSmokeConfig({
        CI: "true",
        AOS_UI_LIVE_OPENCODE: "1",
        AOS_UI_OPENCODE_MODEL_ID: "us.amazon.nova-micro-v1:0",
      })
    ).toEqual({ enabled: false })
  })
})
