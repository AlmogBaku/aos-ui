import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

export type ProductionSource = readonly [path: string, source: string]

// The architecture scans run dozens of patterns over overlapping trees, so each
// directory is walked, and each file read, once per test file.
const listings = new Map<string, Promise<string[]>>()
const contents = new Map<string, Promise<string>>()

function productionFiles(root: string, recursive: boolean): Promise<string[]> {
  const key = `${root}\0${recursive}`
  let listing = listings.get(key)
  if (!listing) {
    listing = readdir(root, { withFileTypes: true }).then(async (entries) =>
      (
        await Promise.all(
          entries.flatMap((entry) => {
            const path = join(root, entry.name)
            if (entry.isDirectory())
              return recursive ? [productionFiles(path, true)] : []
            return entry.isFile() &&
              /\.tsx?$/u.test(entry.name) &&
              !/\.(?:test|bun-spec)\.tsx?$/u.test(entry.name)
              ? [Promise.resolve([path])]
              : []
          })
        )
      ).flat()
    )
    listings.set(key, listing)
  }
  return listing
}

function source(path: string): Promise<string> {
  let content = contents.get(path)
  if (!content) {
    content = readFile(path, "utf8")
    contents.set(path, content)
  }
  return content
}

/**
 * The non-test TypeScript files in `root`, and below it unless `recursive` is
 * false, each with its source.
 */
export async function productionSources(
  root: string,
  { recursive = true }: { recursive?: boolean } = {}
): Promise<ProductionSource[]> {
  const files = await productionFiles(root, recursive)
  return Promise.all(
    files.map(async (path) => [path, await source(path)] as const)
  )
}
