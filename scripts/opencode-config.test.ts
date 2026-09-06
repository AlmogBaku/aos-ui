import { describe, expect, it } from "vitest"

import {
  buildOpenCodeConfigContent,
  createOpenCodeChildEnvironment,
  createOpenCodeServeArguments,
  parseCorsOrigins,
} from "./opencode-config"

describe("OpenCode startup configuration", () => {
  it("does not add a custom provider when none of its variables are configured", () => {
    expect(buildOpenCodeConfigContent({})).toBeUndefined()
  })

  it("forwards the common Gemini credential name under OpenCode's Google credential name", () => {
    expect(
      createOpenCodeChildEnvironment({ GEMINI_API_KEY: "gemini-key" })
    ).toMatchObject({
      GEMINI_API_KEY: "gemini-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "gemini-key",
    })
  })

  it("preserves an explicitly configured OpenCode Google credential", () => {
    expect(
      createOpenCodeChildEnvironment({
        GEMINI_API_KEY: "gemini-key",
        GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
      })
    ).toMatchObject({
      GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
    })
  })

  it("creates an OpenAI-compatible overlay from a complete provider configuration", () => {
    const content = buildOpenCodeConfigContent({
      AOS_UI_OPENAI_COMPATIBLE_BASE_URL: "https://models.example.test/v1",
      AOS_UI_OPENAI_COMPATIBLE_API_KEY: "private-api-key",
      AOS_UI_OPENAI_COMPATIBLE_MODEL_ID: "example-model",
    })

    expect(JSON.parse(content ?? "")).toEqual({
      provider: {
        "openai-compatible": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "{env:AOS_UI_OPENAI_COMPATIBLE_BASE_URL}",
            apiKey: "{env:AOS_UI_OPENAI_COMPATIBLE_API_KEY}",
          },
          models: {
            default: {
              id: "{env:AOS_UI_OPENAI_COMPATIBLE_MODEL_ID}",
            },
          },
        },
      },
    })
    expect(content).not.toContain("private-api-key")
  })

  it.each([
    { AOS_UI_OPENAI_COMPATIBLE_BASE_URL: "https://models.example.test/v1" },
    { AOS_UI_OPENAI_COMPATIBLE_API_KEY: "private-api-key" },
    { AOS_UI_OPENAI_COMPATIBLE_MODEL_ID: "example-model" },
  ])("rejects incomplete custom provider configuration: %o", (environment) => {
    expect(() => buildOpenCodeConfigContent(environment)).toThrow(
      /all three AOS_UI_OPENAI_COMPATIBLE_.* variables/i
    )
  })

  it("uses localhost CORS origins by default", () => {
    expect(parseCorsOrigins(undefined)).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ])
  })

  it("trims each configured CORS origin and supplies one flag pair per origin", () => {
    const origins = parseCorsOrigins(
      " https://app.example.test , http://localhost:3001 "
    )

    expect(origins).toEqual([
      "https://app.example.test",
      "http://localhost:3001",
    ])
    expect(createOpenCodeServeArguments("127.0.0.1", 4096, origins)).toEqual([
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4096",
      "--cors",
      "https://app.example.test",
      "--cors",
      "http://localhost:3001",
    ])
  })

  it.each([
    "   ",
    "https://app.example.test,",
    "ftp://app.example.test",
    "not a URL",
  ])("rejects an invalid configured CORS origin: %s", (origins) => {
    expect(() => parseCorsOrigins(origins)).toThrow(
      /AOS_UI_OPENCODE_CORS_ORIGINS.*http\(s\) origin|empty/i
    )
  })
})
