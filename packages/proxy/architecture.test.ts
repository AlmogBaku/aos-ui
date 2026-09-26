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

/**
 * D10: one name per concept and per id, ACP first, then IRC. Each row retires
 * a name from a directory once the rename that replaced it has landed.
 */
describe("vocabulary", () => {
  const retiredNames: ReadonlyArray<{
    retired: RegExp
    scope: string
    reason: string
  }> = [
    {
      retired: /\bthreadId\b/u,
      scope: "packages/proxy/**",
      reason:
        "the public Session id is `sessionId`, from the wire to the adapters",
    },
    {
      retired: /\bruntimeSessionId\b/u,
      scope: "packages/proxy/**",
      reason:
        "the provider's own Session id is `providerSessionId`, and it never leaves the proxy",
    },
    {
      // Any identifier holding either word, in any case and position. A match
      // after a comment opener on its line, or inside a dotted string, is
      // skipped: English prose and log event names are not identifiers.
      retired:
        /(?<!(?:\/\/|\/\*|^[ \t]*\*).*|["'`][\w.]*)\b\w*(?:[Rr]oom|[Ss]eat)\w*/mu,
      scope: "packages/proxy/**",
      reason:
        "a Session's shared presence is a `Channel`, one member's place in it a `Membership`, joined and parted",
    },
    {
      // The word alone and inside any identifier: `lane`, `guestLane`,
      // `ACP_LANE_CAPABILITIES`.
      retired: /\blanes?(?![a-z])|Lanes?(?![a-z])|(?<![A-Z])LANES?(?![A-Z])/u,
      scope: "packages/proxy/**",
      reason:
        "which kind of member it is is its `role` (`Principal.role`); where its socket arrives is a listener",
    },
    {
      retired: /\blanes?(?![a-z])|Lanes?(?![a-z])|(?<![A-Z])LANES?(?![A-Z])/u,
      scope: "packages/protocol/**",
      reason:
        "the wire names which kind of member a connection is its `role` (`_meta.aos.role`)",
    },
    {
      retired: /[cC]ontrollerIds?\b|[sS]ubscriberIds?\b/u,
      scope: "packages/proxy/**",
      reason:
        "the member's id on a turn is its `principalId`; one membership's key is its `membershipId`",
    },
    {
      retired: /\btype Principal\b/u,
      scope: "packages/proxy/push/**",
      reason:
        "one principal's connections, for push, are its `Presence`; `Principal` is the member's",
    },
    {
      retired: /"attached-(?:active-)?session"|"session-not-attached"/u,
      scope: "packages/proxy/**",
      reason:
        "a Session this connection has resumed is scoped `session` or `active-session`; one it has not is `session-not-resumed`",
    },
    {
      retired: /"attached-(?:active-)?session"|"session-not-attached"/u,
      scope: "packages/protocol/**",
      reason:
        "a Session this connection has resumed is scoped `session` or `active-session`; one it has not is `session-not-resumed`",
    },
    {
      retired:
        /\bServerTurnWatcher\b|\bobserveScope\b|\bonPendingRequest\b|\bonConnection\b|\bunobserve\b|\bunwatch\b/u,
      scope: "packages/proxy/**",
      reason:
        "our own listening function is `subscribe…` and returns its unsubscribe function",
    },
    {
      retired:
        /\bensureAttached\b|#requireAttachedSession\b|#attachedRunning\b/u,
      scope: "packages/proxy/**",
      reason:
        "a Session a connection follows is resumed, not attached; an attachment is a file",
    },
  ]

  it("keeps retired names out of the proxy and the protocol", async () => {
    const repositoryRoot = join(import.meta.dirname, "../..")
    for (const { retired, scope, reason } of retiredNames) {
      const directory = join(repositoryRoot, scope.replace(/\/\*\*$/u, ""))
      for (const path of await productionFiles(directory)) {
        const source = await readFile(path, "utf8")
        expect(
          source.match(retired)?.[0],
          `${relative(repositoryRoot, path)}: ${reason}`
        ).toBeUndefined()
      }
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

/**
 * A role compared, in either order; a chat message's `role` is another word.
 * The role stays the connection's identity, written to the browser's
 * `initialize` meta and to the member's principal, and nothing reads it back.
 * This is a heuristic that catches the comparisons one writes, not every way
 * to branch: the real gates are the per-file count of principal role reads and
 * the translators and encoder naming no role at all.
 */
const ROLE_BRANCH =
  /(?<!message\.)\brole\s*[!=]==|[!=]==\s*(?:[\w.]+\.)?(?<!message\.)role\b|\bcase\s+["'](?:guest|operator)["']/u

/** A member's role named at all, outside a chat message's `role`. */
const ROLE_NAMED = /(?<!message\.)\brole\b|\bRole\b/u

describe("member boundary", () => {
  const proxyRoot = import.meta.dirname

  /**
   * A1: the core and the guest rules speak members, never the ACP wire, and
   * the guest rules sit below every HTTP route rather than reaching into one.
   */
  it("keeps ACP and the routes out of the core and the guest middleware", async () => {
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
      expect(source, path).not.toMatch(importsFrom("routes"))
    }
  })

  /**
   * A2: the core and the ACP transport are role-blind. Nothing reads a
   * guest's grant, and a principal's role is read only where a membership
   * reports it for an adoption's preference for an operator.
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

    expect(roleReaders).toEqual([join(proxyRoot, "core/channel.ts")])
  })
  /**
   * A2: the ACP transport never branches on the role. The translators and
   * the member encoder never name it, and the files that carry it as the
   * connection's identity never compare it.
   */
  it("never branches the ACP transport on the role", async () => {
    for (const path of await productionFiles(join(proxyRoot, "acp"))) {
      const source = stripComments(await readFile(path, "utf8"))
      expect(source, path).not.toMatch(ROLE_BRANCH)
      const translates =
        relative(proxyRoot, path).startsWith("acp/translate/") ||
        path.endsWith("member-encoder.ts")
      if (translates) expect(source, path).not.toMatch(ROLE_NAMED)
    }
  })
})
