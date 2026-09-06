import { constants } from "node:fs"
import { lstat, open, realpath, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { isMap, isScalar, parseDocument } from "yaml"
import {
  hasManagedAgentMetadata,
  isManagedAgentId,
} from "../../lib/runtime-adapters/opencode/agent-catalog"
import type { AgentVisibility } from "../../lib/runtime-adapters/contracts"

const MAX_DEFINITION_BYTES = 64 * 1024

async function safeDirectory(worktree: string) {
  const root = await realpath(resolve(worktree))
  for (const directory of [
    join(root, ".opencode"),
    join(root, ".opencode", "agents"),
  ]) {
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    ) {
      throw new Error("Unsafe Agent directory")
    }
  }
  return join(root, ".opencode", "agents")
}

function replaceVisibility(source: string, visibility: AgentVisibility) {
  const match = /^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$))/m.exec(source)
  if (!match || match.index !== 0) throw new Error("Invalid Agent frontmatter")
  const header = match[2]
  const document = parseDocument(header, { uniqueKeys: true, strict: true })
  if (
    document.errors.length ||
    document.warnings.length ||
    !isMap(document.contents) ||
    document.contents.flow
  )
    throw new Error("Invalid Agent frontmatter")
  const metadata: unknown = document.toJS({ maxAliasCount: 0 })
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid Agent frontmatter")
  const values = metadata as Record<string, unknown>
  if (
    !hasManagedAgentMetadata(values) ||
    values.native === true ||
    (values.mode !== "primary" && values.mode !== "all")
  )
    throw new Error("Agent is not a managed primary definition")
  const hidden = document.get("hidden", true)
  if (
    hidden !== undefined &&
    (!isScalar(hidden) || typeof hidden.value !== "boolean" || !hidden.range)
  )
    throw new Error("Invalid Agent visibility field")
  const replacement = visibility === "hidden" ? "true" : "false"
  const nextHeader =
    isScalar(hidden) && hidden.range
      ? header.slice(0, hidden.range[0]) +
        replacement +
        header.slice(hidden.range[1])
      : header +
        `hidden: ${replacement}${match[1].includes("\r\n") ? "\r\n" : "\n"}`
  const validated = parseDocument(nextHeader, {
    uniqueKeys: true,
    strict: true,
  })
  if (
    validated.errors.length ||
    validated.warnings.length ||
    !isMap(validated.contents) ||
    validated.get("hidden") !== (visibility === "hidden")
  )
    throw new Error("Invalid updated Agent frontmatter")
  return match[1] + nextHeader + source.slice(match[1].length + header.length)
}

/** Locks cooperating writes; verifies inode/content immediately before atomic rename. */
export async function updateManagedAgentVisibility(
  worktree: string,
  agentId: string,
  visibility: AgentVisibility,
  beforeCommit?: () => Promise<void>
) {
  if (!isManagedAgentId(agentId) || !["visible", "hidden"].includes(visibility))
    throw new Error("Invalid managed Agent visibility request")
  const directory = await safeDirectory(worktree)
  const file = join(directory, `${agentId}.md`)
  const lockPath = join(directory, ".aos-ui-visibility.lock")
  const lock = await open(
    lockPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  )
  const temporary = join(directory, `.aos-ui-visibility-${randomUUID()}.tmp`)
  let temporaryCreated = false
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const original = await handle.stat()
    let source: string
    try {
      if (
        !original.isFile() ||
        original.nlink !== 1 ||
        original.size > MAX_DEFINITION_BYTES
      )
        throw new Error("Unsafe Agent definition")
      source = await handle.readFile("utf8")
    } finally {
      await handle.close()
    }
    const next = replaceVisibility(source, visibility)
    const pending = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600
    )
    temporaryCreated = true
    try {
      await pending.writeFile(next, "utf8")
      await pending.sync()
    } finally {
      await pending.close()
    }
    await beforeCommit?.()
    if ((await safeDirectory(worktree)) !== directory)
      throw new Error("Agent directory changed")
    const current = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await current.stat()
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.dev !== original.dev ||
        info.ino !== original.ino ||
        info.size !== original.size ||
        info.mtimeMs !== original.mtimeMs ||
        (await current.readFile("utf8")) !== source
      )
        throw new Error("Agent definition changed; retry")
    } finally {
      await current.close()
    }
    await rename(temporary, file)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => undefined)
    await lock.close()
    await unlink(lockPath)
  }
}
