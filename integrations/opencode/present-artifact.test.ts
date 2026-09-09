// @vitest-environment node

import { mkdtemp, mkdir, symlink, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"

import { ARTIFACT_SIZE_LIMIT_BYTES, presentArtifact } from "./present-artifact"

async function worktree() {
  return mkdtemp(join(tmpdir(), "aos-present-artifact-"))
}

describe("presentArtifact", () => {
  it("publishes a worktree file as one explicitly classified native attachment", async () => {
    const root = await worktree()
    await mkdir(join(root, "reports"))
    await writeFile(join(root, "reports", "result.csv"), "name,value\nA,7\n")

    const result = await presentArtifact(root, {
      path: "reports/result.csv",
      title: "Experiment results",
      mimeType: "text/tab-separated-values",
    })

    expect(result).toEqual({
      title: "Published Experiment results",
      output: "Published Experiment results (15 bytes).",
      metadata: {
        aos_ui: {
          kind: "artifact",
          id: expect.any(String),
          filename: "Experiment results",
          mimeType: "text/tab-separated-values",
          sizeBytes: 15,
        },
      },
      attachments: [
        {
          type: "file",
          mime: "text/tab-separated-values",
          filename: "Experiment results",
          url: "data:text/tab-separated-values;base64,bmFtZSx2YWx1ZQpBLDcK",
        },
      ],
    })
  })

  it("infers a conservative MIME type from the filename", async () => {
    const root = await worktree()
    await writeFile(join(root, "notes.txt"), "hello")

    const result = await presentArtifact(root, { path: "notes.txt" })

    expect(result.attachments[0]?.mime).toBe("text/plain")
    expect(result.title).toBe("Published notes.txt")
  })

  it("rejects a malformed MIME override", async () => {
    const root = await worktree()
    await writeFile(join(root, "notes.txt"), "hello")

    await expect(
      presentArtifact(root, {
        path: "notes.txt",
        mimeType: "text/plain,malformed",
      })
    ).rejects.toThrow(/MIME/i)
  })

  it("rejects sensitive files and directories", async () => {
    const root = await worktree()
    await writeFile(join(root, ".env"), "TOKEN=secret")
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "config"), "credential = secret")

    await expect(presentArtifact(root, { path: ".env" })).rejects.toThrow(
      /sensitive/i
    )
    await expect(
      presentArtifact(root, { path: ".git/config" })
    ).rejects.toThrow(/sensitive/i)
  })

  it("rejects titles that cannot be used as display filenames", async () => {
    const root = await worktree()
    await writeFile(join(root, "notes.txt"), "hello")

    await expect(
      presentArtifact(root, { path: "notes.txt", title: "../notes.txt" })
    ).rejects.toThrow(/title/i)
  })

  it.each([
    ["an absolute path", "/etc/passwd", /relative/i],
    ["parent traversal", "../outside.txt", /worktree/i],
    ["an empty path", "", /path/i],
  ])("rejects %s", async (_label, path, expected) => {
    const root = await worktree()

    await expect(presentArtifact(root, { path })).rejects.toThrow(expected)
  })

  it("rejects missing files and directories", async () => {
    const root = await worktree()
    await mkdir(join(root, "folder"))

    await expect(
      presentArtifact(root, { path: "missing.txt" })
    ).rejects.toThrow(/exist/i)
    await expect(presentArtifact(root, { path: "folder" })).rejects.toThrow(
      /regular file/i
    )
  })

  it("rejects symlink targets and symlinked path components", async () => {
    const root = await worktree()
    const outside = await worktree()
    await writeFile(join(root, "target.txt"), "inside")
    await writeFile(join(outside, "outside.txt"), "outside")
    await symlink(join(root, "target.txt"), join(root, "linked.txt"))
    await symlink(outside, join(root, "linked-folder"))

    await expect(presentArtifact(root, { path: "linked.txt" })).rejects.toThrow(
      /symbolic link/i
    )
    await expect(
      presentArtifact(root, { path: "linked-folder/outside.txt" })
    ).rejects.toThrow(/symbolic link/i)
  })

  it("rejects files over the 25 MiB publication cap", async () => {
    const root = await worktree()
    const path = join(root, "too-large.bin")
    await writeFile(path, "")
    await truncate(path, ARTIFACT_SIZE_LIMIT_BYTES + 1)

    await expect(
      presentArtifact(root, { path: "too-large.bin" })
    ).rejects.toThrow(/25 MiB/i)
  })
})
