import { describe, expect, it } from "vitest"

import {
  diffStats,
  readAosToolArtifact,
  withAosToolArtifact,
  type AosToolArtifact,
} from "./tool-artifact"

const terminal = {
  terminalId: "term-1",
  command: "bun test",
  output: "ok\n",
  running: false,
  exitCode: 0,
}

describe("readAosToolArtifact", () => {
  it("reads a valid aos entry", () => {
    const aos: AosToolArtifact = {
      kind: "execute",
      locations: [{ path: "src/a.ts", line: 3 }],
      diffs: [{ changes: [{ kind: "modify", path: "src/a.ts" }] }],
      terminals: [terminal],
      subagent: { id: "sub-1", goal: "Review", filesRead: ["a.ts"] },
    }
    expect(readAosToolArtifact({ aos, other: true })).toEqual(aos)
  })

  it("accepts a running terminal without an exit code and a null signal", () => {
    const running = { ...terminal, running: true, exitCode: null, signal: null }
    expect(readAosToolArtifact({ aos: { terminals: [running] } })).toEqual({
      terminals: [running],
    })
  })

  it("rejects anything that is not a well-formed aos entry", () => {
    expect(readAosToolArtifact(undefined)).toBeUndefined()
    expect(readAosToolArtifact("aos")).toBeUndefined()
    expect(readAosToolArtifact([])).toBeUndefined()
    expect(readAosToolArtifact({})).toBeUndefined()
    expect(readAosToolArtifact({ aos: { kind: "teleport" } })).toBeUndefined()
    expect(
      readAosToolArtifact({ aos: { diffs: [{ changes: [{ path: "a" }] }] } })
    ).toBeUndefined()
    expect(
      readAosToolArtifact({ aos: { terminals: [{ terminalId: "t" }] } })
    ).toBeUndefined()
  })
})

describe("withAosToolArtifact", () => {
  it("starts an aos entry on an empty or foreign artifact", () => {
    expect(withAosToolArtifact(undefined, { kind: "read" })).toEqual({
      aos: { kind: "read" },
    })
    expect(withAosToolArtifact("text", { kind: "read" })).toEqual({
      aos: { kind: "read" },
    })
  })

  it("replaces patched fields and keeps the rest", () => {
    const artifact = {
      provider: { raw: 1 },
      aos: { kind: "execute", terminals: [terminal] },
    }
    const next = withAosToolArtifact(artifact, {
      terminals: [{ ...terminal, output: "ok\ndone\n" }],
    })
    expect(next).toEqual({
      provider: { raw: 1 },
      aos: {
        kind: "execute",
        terminals: [{ ...terminal, output: "ok\ndone\n" }],
      },
    })
    expect(artifact.aos.terminals[0]?.output).toBe("ok\n")
  })
})

describe("diffStats", () => {
  it("counts changed files and patch lines, ignoring file headers", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+added",
    ].join("\n")
    expect(
      diffStats([
        { changes: [{ kind: "modify", path: "a.ts" }], patch },
        {
          changes: [
            { kind: "add", path: "b.ts" },
            { kind: "move", path: "d.ts", oldPath: "c.ts" },
          ],
        },
      ])
    ).toEqual({ files: 3, additions: 2, deletions: 1 })
  })

  it("is zero for no diffs", () => {
    expect(diffStats([])).toEqual({ files: 0, additions: 0, deletions: 0 })
  })
})
