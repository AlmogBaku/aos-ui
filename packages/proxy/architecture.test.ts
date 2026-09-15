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
  it("keeps Hermes native code out of common proxy and browser modules", async () => {
    const proxyRoot = import.meta.dirname
    const repositoryRoot = join(proxyRoot, "../..")
    const commonProxyFiles = (
      await Promise.all(
        ["auth", "core", "events", "guest", "routes"].map((directory) =>
          productionFiles(join(proxyRoot, directory))
        )
      )
    ).flat()
    const browserFiles = await productionFiles(
      join(repositoryRoot, "src/runtime-adapters/aos")
    )

    for (const path of [...commonProxyFiles, ...browserFiles]) {
      const source = await readFile(path, "utf8")
      expect(source, path).not.toMatch(
        /(?:from\s+|import\s*\()["'][^"']*hermes[^"']*["']/iu
      )
      expect(source, path).not.toMatch(/\bHermes(?:Rpc|Http|Server|Session)/u)
    }
  })

  it("selects the V1 adapter in exactly one production module", async () => {
    const proxyRoot = import.meta.dirname
    const files = await productionFiles(proxyRoot)
    const selectors: string[] = []

    for (const path of files) {
      const source = await readFile(path, "utf8")
      if (/case\s+["']hermes["']/u.test(source)) selectors.push(path)
    }

    expect(selectors).toEqual([join(proxyRoot, "adapters/create-runtime.ts")])
  })
})
