import { describe, expect, it } from "vitest"

import { safeArtifactPath, safeRelativeArtifactPath } from "./artifact-path"

const SENSITIVE_NAMES = [
  ".env",
  ".env.local",
  ".envrc",
  "auth.json",
  "auth.lock",
  "credentials",
  "config.yaml",
  ".anthropic_oauth.json",
  "google_token.json",
  "google_oauth_pending.json",
  "google_oauth.json",
  "webhook_subscriptions.json",
  "bws_cache.json",
  "bws_cache.enc.json",
  ".git-credentials",
  "Auth.JSON",
]

describe("safeArtifactPath", () => {
  it("accepts an absolute POSIX path unchanged", () => {
    expect(safeArtifactPath("/home/agent/out/report.pdf")).toBe(
      "/home/agent/out/report.pdf"
    )
  })

  it.each([
    ["a relative path", "out/report.pdf"],
    ["an empty path", ""],
    ["a drive-rooted path", "C:\\out\\report.pdf"],
    ["a traversing segment", "/home/agent/../etc/passwd"],
    ["a backslash traversal", "/home/agent/out\\..\\secret.txt"],
    ["a control character", "/home/agent/out/re\u0007port.pdf"],
    ["a newline", "/home/agent/out/report.pdf\n/etc/passwd"],
    ["an overlong path", `/${"a".repeat(4_096)}`],
  ])("rejects %s", (_label, path) => {
    expect(safeArtifactPath(path)).toBeUndefined()
  })

  it.each(SENSITIVE_NAMES)(
    "rejects %s as a file and as a directory",
    (name) => {
      expect(safeArtifactPath(`/home/agent/${name}`)).toBeUndefined()
      expect(safeArtifactPath(`/home/agent/${name}/report.pdf`)).toBeUndefined()
    }
  )

  it.each(["mcp-tokens", "pairing", "MCP-Tokens"])(
    "rejects anything under a %s directory",
    (name) => {
      expect(safeArtifactPath(`/home/agent/${name}/report.pdf`)).toBeUndefined()
    }
  )

  it("accepts names that only resemble a sensitive one", () => {
    expect(safeArtifactPath("/home/agent/credentials.txt")).toBeDefined()
    expect(safeArtifactPath("/home/agent/environment.md")).toBeDefined()
  })
})

describe("safeRelativeArtifactPath", () => {
  it("accepts a relative path unchanged", () => {
    expect(safeRelativeArtifactPath("reports/memo.pdf")).toBe(
      "reports/memo.pdf"
    )
  })

  it.each([
    "",
    "/home/agent/memo.pdf",
    "\\share\\memo.pdf",
    "C:memo.pdf",
    "reports/../../etc/passwd",
    ".env",
    "pairing/memo.pdf",
    "reports/me\u0000mo.pdf",
  ])("rejects %j", (path) => {
    expect(safeRelativeArtifactPath(path)).toBeUndefined()
  })
})
