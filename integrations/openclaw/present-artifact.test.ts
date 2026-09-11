import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { presentArtifact } from "./present-artifact.js"
import {
  makeTemporaryDirectory,
  removeTemporaryDirectory,
} from "./test-files.js"

describe("presentArtifact", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await makeTemporaryDirectory()
    await mkdir(join(workspace, "reports"))
    await writeFile(join(workspace, "reports", "result.json"), '{"ok":true}')
  })

  afterEach(async () => removeTemporaryDirectory(workspace))

  it("validates a regular file without fabricating native download authority", async () => {
    const result = await presentArtifact(workspace, {
      path: "reports/result.json",
      title: "Run result",
    })

    expect(result.details).toEqual({
      ok: true,
      type: "aos.artifact-publication",
      published: false,
      candidate: {
        path: "reports/result.json",
        filename: "Run result",
        sizeBytes: 11,
        mimeType: "application/json",
      },
    })
    expect(result.content[0]?.text).toContain("reports/result.json")
    expect(result.content[0]?.text).toContain("not published")
  })

  it.each(["../secret", ".env", ".git/config"])(
    "rejects unsafe path %s",
    async (path) => {
      await expect(presentArtifact(workspace, { path })).rejects.toThrow()
    }
  )

  it("rejects symlinks even when their target is inside the workspace", async () => {
    await symlink("result.json", join(workspace, "reports", "alias.json"))
    await expect(
      presentArtifact(workspace, { path: "reports/alias.json" })
    ).rejects.toThrow(/symbolic link/i)
  })
})
