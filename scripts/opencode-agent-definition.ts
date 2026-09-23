import { constants } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
  CREATOR_AGENT_ID,
  creatorAgentDefinition,
  creatorReferenceSource,
  creatorSkillSource,
} from "./opencode-creator-template"
import { inviteLinkSkill } from "./opencode-invite-link.generated"

function hasErrorCode(error: unknown, code: string) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  )
}

const DIRECTORY_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const EXCLUSIVE_WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW

function anchoredPath(parent: FileHandle, component: string) {
  if (process.platform !== "linux")
    throw new Error(
      "Secure OpenCode Agent installation requires Linux directory descriptors"
    )
  return join("/proc/self/fd", String(parent.fd), component)
}

async function safeDirectory(parent: FileHandle, component: string) {
  const directory = anchoredPath(parent, component)
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
  }
  const stats = await lstat(directory)
  if (stats.isSymbolicLink())
    throw new Error(
      `Agent directory component is a symbolic link: ${component}`
    )
  if (!stats.isDirectory())
    throw new Error(
      `Agent directory component is not a directory: ${component}`
    )
  return open(directory, DIRECTORY_OPEN_FLAGS)
}

async function writeExclusive(
  parent: FileHandle,
  fileName: string,
  source: string
) {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      anchoredPath(parent, fileName),
      EXCLUSIVE_WRITE_FLAGS,
      0o600
    )
    await handle.writeFile(source, "utf8")
  } finally {
    await handle?.close()
  }
}

async function assetDirectory(
  worktree: string,
  relativePath: readonly string[]
) {
  const root = await realpath(resolve(worktree))
  let parent = await open(root, DIRECTORY_OPEN_FLAGS)
  try {
    for (const component of relativePath.slice(0, -1)) {
      const child = await safeDirectory(parent, component)
      await parent.close()
      parent = child
    }
    return parent
  } catch (error) {
    await parent.close()
    throw error
  }
}

async function assertCurrentAsset(
  parent: FileHandle,
  fileName: string,
  source: string,
  conflictMessage: string
) {
  const file = anchoredPath(parent, fileName)
  const stats = await lstat(file)
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new Error(conflictMessage)
  let handle: FileHandle | undefined
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    if ((await handle.readFile("utf8")) !== source)
      throw new Error(conflictMessage)
  } finally {
    await handle?.close()
  }
}

async function installFixedAsset(
  worktree: string,
  relativePath: readonly string[],
  source: string,
  conflictMessage: string
) {
  const parent = await assetDirectory(worktree, relativePath)
  const fileName = relativePath.at(-1)!
  try {
    await writeExclusive(parent, fileName, source)
    return "installed" as const
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
    await assertCurrentAsset(parent, fileName, source, conflictMessage)
    return "current" as const
  } finally {
    await parent.close()
  }
}

async function preflightFixedAsset(
  worktree: string,
  relativePath: readonly string[],
  source: string,
  conflictMessage: string
) {
  const parent = await assetDirectory(worktree, relativePath)
  const fileName = relativePath.at(-1)!
  try {
    await assertCurrentAsset(parent, fileName, source, conflictMessage)
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return
    throw error
  } finally {
    await parent.close()
  }
}

const CREATOR_ASSETS = [
  {
    path: [".opencode", "agents", `${CREATOR_AGENT_ID}.md`],
    source: creatorAgentDefinition,
    conflict: "Conflicting Agent Builder definition; refusing to overwrite it.",
  },
  {
    path: [".opencode", "skills", "aos-agent-creator", "SKILL.md"],
    source: creatorSkillSource,
    conflict: "Conflicting AOS Agent creator skill; refusing to overwrite it.",
  },
  {
    path: [
      ".opencode",
      "skills",
      "aos-agent-creator",
      "reference",
      "harness-opencode.md",
    ],
    source: creatorReferenceSource,
    conflict:
      "Conflicting AOS Agent creator reference; refusing to overwrite it.",
  },
  {
    path: [".opencode", "skills", "aos-invite-link", "SKILL.md"],
    source: inviteLinkSkill,
    conflict: "Conflicting AOS invite-link skill; refusing to overwrite it.",
  },
] as const

export async function installCreatorDefinition(worktree: string) {
  for (const asset of CREATOR_ASSETS)
    await preflightFixedAsset(
      worktree,
      asset.path,
      asset.source,
      asset.conflict
    )
  const statuses = []
  for (const asset of CREATOR_ASSETS)
    statuses.push(
      await installFixedAsset(
        worktree,
        asset.path,
        asset.source,
        asset.conflict
      )
    )
  return { status: statuses[0]!, agentId: CREATOR_AGENT_ID }
}
