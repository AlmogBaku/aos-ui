// @vitest-environment node

import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

import { CANONICAL_TOOL_NAMES } from "./adapters/hermes/tool-data"
import { OPENCODE_CANONICAL_TOOL_NAMES } from "./adapters/opencode/tool-names"

const COMMON_PROXY_DIRECTORIES = [
  "acp",
  "auth",
  "cli",
  "core",
  "guest",
  "mcp-apps",
  "routes",
  "voice",
]

/** Block comments, and line comments that start a line or follow whitespace. */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|\s)\/\/.*$/gmu, "$1")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

const RUNTIME_NAME_LITERAL =
  /["'`][^"'`\n]*(?:hermes|openclaw|opencode)[^"'`\n]*["'`]/iu

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
  it("keeps runtime vocabulary out of browser, protocol, and common proxy modules", async () => {
    const proxyRoot = import.meta.dirname
    const repositoryRoot = join(proxyRoot, "../..")
    const fixtureRoot = join(repositoryRoot, "src/runtime-adapters/fixture")
    const nativeNames = [
      ...CANONICAL_TOOL_NAMES.keys(),
      ...OPENCODE_CANONICAL_TOOL_NAMES.keys(),
    ]
    const nativeLiteral = new RegExp(
      `["'\`](?:${nativeNames.map(escapeRegExp).join("|")})["'\`]`,
      "u"
    )
    const files = [
      ...(await productionFiles(join(repositoryRoot, "src"))).filter(
        (path) => !path.startsWith(fixtureRoot)
      ),
      ...(await productionFiles(join(repositoryRoot, "packages/protocol"))),
      ...(
        await Promise.all(
          COMMON_PROXY_DIRECTORIES.map((directory) =>
            productionFiles(join(proxyRoot, directory))
          )
        )
      ).flat(),
    ]

    for (const path of files) {
      const source = stripComments(await readFile(path, "utf8"))
      expect(
        source.match(RUNTIME_NAME_LITERAL)?.[0],
        `${path} names a runtime`
      ).toBeUndefined()
      expect(
        source.match(nativeLiteral)?.[0],
        `${path} uses a native tool name an adapter renames`
      ).toBeUndefined()
    }
  })

  it("keeps provider-native code out of common proxy and browser modules", async () => {
    const proxyRoot = import.meta.dirname
    const repositoryRoot = join(proxyRoot, "../..")
    const commonProxyFiles = (
      await Promise.all(
        ["acp", "auth", "core", "guest", "mcp-apps", "routes", "voice"].map(
          (directory) => productionFiles(join(proxyRoot, directory))
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

  it("keeps AG-UI out of the proxy", async () => {
    const files = await productionFiles(import.meta.dirname)

    for (const path of files) {
      const source = await readFile(path, "utf8")
      expect(source, path).not.toMatch(/(?:from\s+|import\s*\()["']@ag-ui\//u)
    }
  })

  /** Adapters speak the proxy's turn vocabulary; only the translator knows ACP. */
  it("keeps the ACP wire out of the server adapters", async () => {
    const files = await productionFiles(join(import.meta.dirname, "adapters"))

    for (const path of files) {
      const source = await readFile(path, "utf8")
      expect(source, path).not.toMatch(
        /(?:from\s+|import\s*\()["'](?:@agentclientprotocol\/|[^"']*protocol\/acp(?:\.ts)?["'])/u
      )
    }
  })

  /**
   * Raw zod issues can quote operator input, so only the loader that formats
   * them safely may reach the schema; every other caller uses `parseProxyConfig`.
   */
  it("keeps the configuration schema behind the configuration loader", async () => {
    const proxyRoot = import.meta.dirname
    const files = await productionFiles(proxyRoot)
    const importers: string[] = []

    for (const path of files) {
      if (path === join(proxyRoot, "config.ts")) continue
      const source = await readFile(path, "utf8")
      const specifiers = source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']\.\/config["']/gu
      )
      for (const [, names] of specifiers)
        if (/\bProxyConfigSchema\b/u.test(names)) importers.push(path)
    }

    expect(importers).toEqual([join(proxyRoot, "config-file.ts")])
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

const ACP_IMPORT =
  /(?:from\s+|import\s*\()["'](?:@agentclientprotocol\/|[^"']*protocol\/acp(?:\.ts)?["'])/u

/** A relative import of `directory`, however deep the importer sits. */
function importsFrom(directory: string) {
  return new RegExp(
    `(?:from\\s+|import\\s*\\()["'](?:\\.\\.?\\/)+${directory}(?:\\/|["'])`,
    "u"
  )
}

/** The `lane` reads left in `acp/`, each a guest branch still to remove. */
const ACP_LANE_READS: Record<string, number> = {
  "acp/agent-sessions.ts": 1,
  "acp/agent.ts": 3,
  "acp/member-encoder.ts": 8,
  "acp/operator.ts": 3,
  "acp/service.ts": 4,
  "acp/translate/history.ts": 4,
  "acp/translate/requests.ts": 25,
  "acp/translate/turn-events.ts": 1,
  "acp/types.ts": 6,
}

describe("member boundary", () => {
  const proxyRoot = import.meta.dirname

  /** A1: the core and the guest rules speak members, never the ACP wire. */
  it("keeps ACP out of the core and the guest middleware", async () => {
    const core = await productionFiles(join(proxyRoot, "core"))
    const middleware = await productionFiles(
      join(proxyRoot, "guest/middleware")
    )

    for (const path of [...core, ...middleware]) {
      const source = stripComments(await readFile(path, "utf8"))
      expect(source, path).not.toMatch(ACP_IMPORT)
    }
    for (const path of middleware) {
      const source = stripComments(await readFile(path, "utf8"))
      expect(source, path).not.toMatch(importsFrom("acp"))
    }
  })

  /**
   * A2: the core and the ACP transport are lane-blind. Nothing reads a
   * guest's grant, and a principal's role is read only where the Channel
   * reports a lane: the coordinator's capacity cap and an adoption's
   * preference for an operator.
   */
  it("keeps guest code out of the core and the ACP transport", async () => {
    const files = [
      ...(await productionFiles(join(proxyRoot, "acp"))),
      ...(await productionFiles(join(proxyRoot, "core"))),
    ]
    const roleReaders: string[] = []

    for (const path of files) {
      const source = stripComments(await readFile(path, "utf8"))
      expect(source, path).not.toMatch(importsFrom("guest"))
      expect(source, path).not.toMatch(importsFrom("auth\\/guest-[\\w-]+"))
      expect(source, path).not.toMatch(/\bGuestPolicy\b|\bcontext\.guest\b/u)
      expect(source, path).not.toMatch(/\.grant\b/u)
      const reads = source.match(/\bprincipal\.role\b/gu) ?? []
      roleReaders.push(...reads.map(() => path))
    }

    expect(roleReaders).toEqual([
      join(proxyRoot, "core/channel.ts"),
      join(proxyRoot, "core/channel.ts"),
    ])
  })
  /**
   * A2: every `lane` the ACP transport still reads, per file. The guest
   * branches leave task by task, so a new one fails here; the count may only
   * shrink.
   */
  it("reads the lane in the ACP transport only where it is allowed", async () => {
    const counts: Record<string, number> = {}
    for (const path of await productionFiles(join(proxyRoot, "acp"))) {
      if (path.endsWith("test-harness.ts")) continue
      const source = stripComments(await readFile(path, "utf8"))
      const reads = source.match(/\blane\b/gu)?.length ?? 0
      if (reads > 0) counts[relative(proxyRoot, path)] = reads
    }

    expect(counts).toEqual(ACP_LANE_READS)
  })
})
