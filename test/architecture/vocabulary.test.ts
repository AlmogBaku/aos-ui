// @vitest-environment node

import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

/** The non-test TypeScript files in `root`, and below it when `recursive`. */
async function productionFiles(
  root: string,
  recursive: boolean
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (
    await Promise.all(
      entries.flatMap((entry) => {
        const path = join(root, entry.name)
        if (entry.isDirectory())
          return recursive ? [productionFiles(path, true)] : []
        return entry.isFile() &&
          /\.tsx?$/u.test(entry.name) &&
          !/\.test\.tsx?$/u.test(entry.name)
          ? [Promise.resolve([path])]
          : []
      })
    )
  ).flat()
}

describe("vocabulary", () => {
  const sessionId = {
    retired: /\bthreadId\b/u,
    reason:
      "the public Session id is `sessionId`, from the wire to the adapters",
  }
  /** A scope is `directory/*`, its own files, or `directory/**`, every depth. */
  const retiredNames: ReadonlyArray<{
    retired: RegExp
    scope: string
    reason: string
  }> = [
    // `src/runtime-adapters/fixture` is left out: it hands Assistant UI the
    // Session through Assistant UI's own `threadId` option.
    ...[
      "src/*",
      "src/app/**",
      "src/artifacts/**",
      "src/components/**",
      "src/hooks/**",
      "src/lib/**",
      "src/sw/**",
      "src/runtime-adapters/*",
      "src/runtime-adapters/aos/**",
      "src/runtime-adapters/queue/**",
    ].map((scope) => ({ ...sessionId, scope })),
    {
      retired: /"attached-(?:active-)?session"|"session-not-attached"/u,
      scope: "src/**",
      reason:
        "a Session this connection has resumed is scoped `session` or `active-session`; one it has not is `session-not-resumed`",
    },
    {
      retired:
        /\bonSessionUpdate\b|\bonSessionReplay\b|\bonPendingRequest\b|\bonAosNotification\b|\bonPermissionChange\b/u,
      scope: "src/**",
      reason:
        "our own listening function is `subscribe…` and returns its unsubscribe function",
    },
    {
      retired:
        /\battachSession\b|\bresumeAttached\b|\battachedSessions?\b|\battachedSessionId\b|\breattached\b/u,
      scope: "src/**",
      reason:
        "a Session a connection follows is resumed, and a new transport rejoins it; an attachment is a file",
    },
  ]

  it("keeps retired names out of the browser", async () => {
    const repositoryRoot = join(import.meta.dirname, "../..")
    for (const { retired, scope, reason } of retiredNames) {
      const directory = join(repositoryRoot, scope.replace(/\/\*\*?$/u, ""))
      const recursive = scope.endsWith("/**")
      for (const path of await productionFiles(directory, recursive)) {
        const source = await readFile(path, "utf8")
        expect(
          source.match(retired)?.[0],
          `${relative(repositoryRoot, path)}: ${reason}`
        ).toBeUndefined()
      }
    }
  })
})
