// @vitest-environment node

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

async function productionFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (
    await Promise.all(
      entries.flatMap((entry) => {
        const path = join(root, entry.name)
        if (entry.isDirectory()) return [productionFiles(path)]
        return entry.isFile() &&
          /\.tsx?$/u.test(entry.name) &&
          !/\.(?:test|bun-spec)\.tsx?$/u.test(entry.name)
          ? [Promise.resolve([path])]
          : []
      })
    )
  ).flat()
}

describe("runtime adapter boundary", () => {
  it("keeps provider-native code out of common proxy and browser modules", async () => {
    const proxyRoot = import.meta.dirname
    const repositoryRoot = join(proxyRoot, "../..")
    const commonProxyFiles = (
      await Promise.all(
        ["acp", "auth", "core", "events", "guest", "routes"].map((directory) =>
          productionFiles(join(proxyRoot, directory))
        )
      )
    ).flat()
    const browserFiles = await productionFiles(join(repositoryRoot, "src"))

    for (const path of [...commonProxyFiles, ...browserFiles]) {
      const source = await readFile(path, "utf8")
      expect(source, path).not.toMatch(
        /(?:from\s+|import\s*\()["'][^"']*(?:hermes|@opencode-ai\/sdk|@openclaw\/gateway-)[^"']*["']/iu
      )
      expect(source, path).not.toMatch(/\bHermes(?:Rpc|Http|Server|Session)/u)
    }
  })

  it("confines the AG-UI vocabulary to adapters and the alias layer", async () => {
    const proxyRoot = import.meta.dirname
    const allowed = [
      join(proxyRoot, "adapters"),
      join(proxyRoot, "core/events.ts"),
      // The AG-UI browser wire; deleted in Phase D of the ACP cutover.
      join(proxyRoot, "routes/runs.ts"),
      join(proxyRoot, "guest/routes/runs.ts"),
      join(proxyRoot, "auth/guest-runtime-projection.ts"),
    ]
    const files = await productionFiles(proxyRoot)

    for (const path of files) {
      if (allowed.some((prefix) => path.startsWith(prefix))) continue
      const source = await readFile(path, "utf8")
      expect(source, path).not.toMatch(/(?:from\s+|import\s*\()["']@ag-ui\//u)
    }
  })

  it("selects every server adapter in exactly one production module", async () => {
    const proxyRoot = import.meta.dirname
    const files = await productionFiles(proxyRoot)
    const selector = join(proxyRoot, "adapters/create-runtime.ts")

    for (const provider of ["hermes", "opencode", "openclaw"]) {
      const selectors: string[] = []
      for (const path of files) {
        const source = await readFile(path, "utf8")
        if (new RegExp(`case\\s+["']${provider}["']`, "u").test(source))
          selectors.push(path)
      }
      expect(selectors, provider).toEqual([selector])
    }
  })
})
