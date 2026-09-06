// @vitest-environment node

import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { updateManagedAgentVisibility } from "./agent-visibility"

const source =
  '---\ndescription: "Keep: this"\nmode: primary\naos_ui_name: "Legacy Agent"\npermission:\n  bash: ask\n# Keep this comment\n---\n\nOriginal prompt.\n'

async function fixture(content = source) {
  const root = await mkdtemp(join(tmpdir(), "aos-ui-visibility-test-"))
  await mkdir(join(root, ".opencode", "agents"), { recursive: true })
  const file = join(root, ".opencode", "agents", "managed.md")
  await writeFile(file, content)
  return { root, file }
}

describe("managed Agent visibility persistence", () => {
  it.each([
    "---\n{mode: primary, aos_ui_managed: true}\n---\nPrompt.\n",
    "---\n{mode: primary, aos_ui_managed: true, hidden: false}\n---\nPrompt.\n",
    "---\nmode: primary\naos_ui_managed: true\n...\n---\nPrompt.\n",
  ])(
    "rejects unsupported layouts without changing the original bytes",
    async (content) => {
      const { root, file } = await fixture(content)
      await expect(
        updateManagedAgentVisibility(root, "managed", "hidden")
      ).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe(content)
    }
  )

  it("atomically adds visibility while preserving every unrelated byte", async () => {
    const { root, file } = await fixture()
    await updateManagedAgentVisibility(root, "managed", "hidden")
    expect(await readFile(file, "utf8")).toBe(
      source.replace(
        "# Keep this comment\n---",
        "# Keep this comment\nhidden: true\n---"
      )
    )
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await updateManagedAgentVisibility(root, "managed", "visible")
    expect(await readFile(file, "utf8")).toContain("hidden: false")
  })

  it("preserves CRLF, scalar comments, and explicit managed markers", async () => {
    const content = source
      .replace(
        'aos_ui_name: "Legacy Agent"',
        "aos_ui_managed: true\nhidden: false # retained"
      )
      .replaceAll("\n", "\r\n")
    const { root, file } = await fixture(content)
    await updateManagedAgentVisibility(root, "managed", "hidden")
    expect(await readFile(file, "utf8")).toBe(
      content.replace("hidden: false", "hidden: true")
    )
  })

  it.each([
    source.replace('aos_ui_name: "Legacy Agent"\n', ""),
    source.replace("mode: primary", "mode: subagent"),
    source.replace("mode: primary", "mode: primary\nnative: true"),
    source.replace(
      "mode: primary",
      "mode: primary\nhidden: true\nhidden: false"
    ),
    source.replace(
      'aos_ui_name: "Legacy Agent"',
      'prompt: |\n  aos_ui_name: "Not a marker"'
    ),
  ])(
    "rejects unmanaged, protected, or ambiguous frontmatter",
    async (content) => {
      const { root, file } = await fixture(content)
      await expect(
        updateManagedAgentVisibility(root, "managed", "hidden")
      ).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe(content)
    }
  )

  it.each(["agent-builder", "build", "../managed", "a/b", "__proto__"])(
    "rejects reserved or unsafe ID %s",
    async (id) => {
      const { root } = await fixture()
      await expect(
        updateManagedAgentVisibility(root, id, "hidden")
      ).rejects.toThrow()
    }
  )

  it("rejects symlinked definitions", async () => {
    const { root, file } = await fixture()
    await symlink(file, join(root, ".opencode", "agents", "linked.md"))
    await expect(
      updateManagedAgentVisibility(root, "linked", "hidden")
    ).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe(source)
  })

  it("rejects a concurrent writer without replacing their changes", async () => {
    const { root, file } = await fixture()
    await expect(
      updateManagedAgentVisibility(root, "managed", "hidden", async () => {
        await writeFile(file, source + "External edit.\n")
      })
    ).rejects.toThrow("changed")
    expect(await readFile(file, "utf8")).toBe(source + "External edit.\n")
  })
})
