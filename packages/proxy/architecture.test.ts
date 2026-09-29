// @vitest-environment node

import { readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

import { productionSources } from "../../test/support/production-sources"
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

/** A module only tests may import, by its path under the proxy. */
const TEST_ONLY_MODULE =
  /(?:^|\/)(?:test-harness|test-faults|runtime-contract|wire-contract)\.ts$|(?:^|\/)test-utils\//u
const TEST_ONLY_IMPORT =
  /(?:from\s+|import\s*\()["'][^"']*\/(?:test-harness|test-faults|runtime-contract|wire-contract|test-utils\/)/u

const RUNTIME_NAME_LITERAL =
  /["'`][^"'`\n]*(?:hermes|openclaw|opencode)[^"'`\n]*["'`]/iu

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
      ...(await productionSources(join(repositoryRoot, "src"))).filter(
        ([path]) => !path.startsWith(fixtureRoot)
      ),
      ...(await productionSources(join(repositoryRoot, "packages/protocol"))),
      ...(
        await Promise.all(
          COMMON_PROXY_DIRECTORIES.map((directory) =>
            productionSources(join(proxyRoot, directory))
          )
        )
      ).flat(),
    ]

    for (const [path, text] of files) {
      const source = stripComments(text)
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
          (directory) => productionSources(join(proxyRoot, directory))
        )
      )
    ).flat()
    const browserFiles = await productionSources(join(repositoryRoot, "src"))

    for (const [path, source] of [...commonProxyFiles, ...browserFiles]) {
      expect(source, path).not.toMatch(
        /(?:from\s+|import\s*\()["'][^"']*(?:hermes|@opencode-ai\/sdk|@openclaw\/gateway-)[^"']*["']/iu
      )
      expect(source, path).not.toMatch(/\bHermes(?:Rpc|Http|Server|Session)/u)
    }
  })

  it("keeps AG-UI out of the proxy", async () => {
    const files = await productionSources(import.meta.dirname)

    for (const [path, source] of files) {
      expect(source, path).not.toMatch(/(?:from\s+|import\s*\()["']@ag-ui\//u)
    }
  })

  /** Adapters speak the proxy's turn vocabulary; only the translator knows ACP. */
  it("keeps the ACP wire out of the server adapters", async () => {
    const files = await productionSources(join(import.meta.dirname, "adapters"))

    for (const [path, source] of files) {
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
    const files = await productionSources(proxyRoot)
    const importers: string[] = []

    for (const [path, source] of files) {
      if (path === join(proxyRoot, "config.ts")) continue
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
    const files = await productionSources(proxyRoot)
    const selector = join(proxyRoot, "adapters/create-runtime.ts")

    for (const provider of ["hermes", "opencode", "openclaw"]) {
      const selectors: string[] = []
      for (const [path, source] of files) {
        if (new RegExp(`case\\s+["']${provider}["']`, "u").test(source))
          selectors.push(path)
      }
      expect(selectors, provider).toEqual([selector])
    }
  })

  /**
   * The harness, the fault wrapper, the contract suite and the adapters' test
   * fixtures stand in for a provider, so only a test may reach one.
   */
  it("keeps the test-only modules out of production code", async () => {
    const proxyRoot = import.meta.dirname
    const importers: string[] = []

    for (const [path, text] of await productionSources(proxyRoot)) {
      const file = relative(proxyRoot, path)
      if (TEST_ONLY_MODULE.test(file)) continue
      const source = stripComments(text)
      if (TEST_ONLY_IMPORT.test(source)) importers.push(file)
    }

    expect(importers).toEqual([])
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
      // skipped: English prose and log event names are not identifiers. The
      // lookahead only admits candidate words to the costly lookbehind.
      retired:
        /\b(?=\w*(?:[Rr]oom|[Ss]eat))(?<!(?:\/\/|\/\*|^[ \t]*\*).*|["'`][\w.]*)\w*(?:[Rr]oom|[Ss]eat)\w*/mu,
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
      for (const [path, source] of await productionSources(directory)) {
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
    const core = await productionSources(join(proxyRoot, "core"))
    const middleware = await productionSources(
      join(proxyRoot, "guest/middleware")
    )

    for (const [path, text] of [...core, ...middleware]) {
      const source = stripComments(text)
      expect(source, path).not.toMatch(ACP_IMPORT)
    }
    for (const [path, text] of middleware) {
      const source = stripComments(text)
      expect(source, path).not.toMatch(importsFrom("acp"))
      expect(source, path).not.toMatch(importsFrom("routes"))
    }
  })

  /**
   * A2: the core and the ACP transport are role-blind. Nothing reads a
   * guest's grant or a principal's role.
   */
  it("keeps guest code out of the core and the ACP transport", async () => {
    const files = [
      ...(await productionSources(join(proxyRoot, "acp"))),
      ...(await productionSources(join(proxyRoot, "core"))),
    ]
    const roleReaders: string[] = []

    for (const [path, text] of files) {
      const source = stripComments(text)
      expect(source, path).not.toMatch(importsFrom("guest"))
      expect(source, path).not.toMatch(importsFrom("auth\\/guest-[\\w-]+"))
      expect(source, path).not.toMatch(/\bGuestPolicy\b|\bcontext\.guest\b/u)
      expect(source, path).not.toMatch(/\.grant\b/u)
      const reads = source.match(/\bprincipal\.role\b/gu) ?? []
      roleReaders.push(...reads.map(() => path))
    }

    expect(roleReaders).toEqual([])
  })

  /**
   * The coordinator owns a turn's states; a channel reads them and moves
   * none. The one machine the channel sets up is its membership's.
   */
  it("leaves every turn-state transition to the coordinator", async () => {
    const source = stripComments(
      await readFile(join(proxyRoot, "core/channel.ts"), "utf8")
    )
    const machines = [
      ...source.matchAll(/\bownerSetup\b[^(]*\(\s*["'`]([\w-]+)["'`]/gu),
    ].map(([, kind]) => kind)

    expect(machines).toEqual(["membership"])
    expect(source).not.toMatch(
      /\bstate\s*(?::|=(?!=))\s*["'`](?:idle|running|stopping|waiting-for-input|uncertain)["'`]/u
    )
  })
  /**
   * The connection reaches a provider through the channels and the catalog
   * alone: its context carries neither the runtime nor the coordinator, only
   * the runtime's error classifier and its static translation hint, and its
   * agent imports nothing of either.
   */
  it("keeps the runtime and the coordinator off the connection", async () => {
    for (const file of ["acp/agent.ts", "acp/agent-sessions.ts"]) {
      const source = stripComments(
        await readFile(join(proxyRoot, file), "utf8")
      )
      expect(source, file).not.toMatch(
        importsFrom("core\\/(?:runtime|session-coordinator)")
      )
    }
    const context = stripComments(
      await readFile(join(proxyRoot, "acp/types.ts"), "utf8")
    )
    expect(context).not.toMatch(
      /\b(?:RuntimeInstance|ServerRuntime|SessionCoordinator)\b|\bruntimeInstance\b/u
    )
  })

  /**
   * The member encoder alone turns member events into ACP updates and
   * notifications, from the event it is given: it reaches neither a
   * membership nor the runtime. The translators the encoder writes with are
   * its own pure helpers, the test harness stands in for a provider, and the
   * wire suite for a client.
   */
  it("builds every ACP update in the member encoder alone", async () => {
    const encoder = stripComments(
      await readFile(join(proxyRoot, "acp/member-encoder.ts"), "utf8")
    )
    expect(encoder).not.toMatch(importsFrom("core\\/(?:channel|runtime)"))
    expect(encoder).not.toMatch(/\bServerRuntime\b|\bruntimeInstance\b/u)

    const builders: string[] = []
    const notifiers: string[] = []
    for (const [path, text] of await productionSources(proxyRoot)) {
      const file = relative(proxyRoot, path)
      if (
        file.startsWith("acp/translate/") ||
        /\/(?:test-[\w-]+|wire-contract)\.ts$/u.test(file)
      )
        continue
      const source = stripComments(text)
      if (/\bsessionUpdate\s*:/u.test(source)) builders.push(file)
      if (/\.notify\s*\(/u.test(source)) notifiers.push(file)
    }
    expect(builders).toEqual(["acp/member-encoder.ts"])
    expect(notifiers).toEqual(["acp/member-encoder.ts"])
  })

  /**
   * A2: the ACP transport never branches on the role. The translators and
   * the member encoder never name it, and the files that carry it as the
   * connection's identity never compare it.
   */
  it("never branches the ACP transport on the role", async () => {
    for (const [path, text] of await productionSources(
      join(proxyRoot, "acp")
    )) {
      const source = stripComments(text)
      expect(source, path).not.toMatch(ROLE_BRANCH)
      const translates =
        relative(proxyRoot, path).startsWith("acp/translate/") ||
        path.endsWith("member-encoder.ts")
      if (translates) expect(source, path).not.toMatch(ROLE_NAMED)
    }
  })
})

describe("logging", () => {
  const proxyRoot = import.meta.dirname

  /** D13: the redacting root is the only way a proxy line reaches stdout. */
  it("writes every proxy line through the injected logger", async () => {
    const writers: string[] = []

    for (const [path, text] of await productionSources(proxyRoot)) {
      const source = stripComments(text)
      if (/\bconsole\.\w+/u.test(source))
        writers.push(relative(proxyRoot, path))
    }

    expect(writers).toEqual([])
  })

  /** Core names each event after the owner that writes it, never the wire. */
  it("names no core event after ACP", async () => {
    const named: string[] = []

    for (const [path, text] of await productionSources(
      join(proxyRoot, "core")
    )) {
      const source = stripComments(text)
      if (/["'`]acp\./u.test(source)) named.push(relative(proxyRoot, path))
    }

    expect(named).toEqual([])
  })
})

describe("ServerRuntime interface", () => {
  /**
   * D8: the proxy calls neither `authState` nor `subscribeSessionInvalidation`;
   * each adapter retains its own implementation but the interface exposes
   * neither.
   */
  it("exposes neither authState nor subscribeSessionInvalidation", async () => {
    const source = stripComments(
      await readFile(join(import.meta.dirname, "core/runtime.ts"), "utf8")
    )
    const members = /export interface ServerRuntime \{([\s\S]*?)\n\}/u.exec(
      source
    )?.[1]

    expect(members).toBeDefined()
    expect(members).not.toMatch(
      /\b(?:authState|subscribeSessionInvalidation)\b/u
    )
  })
})
