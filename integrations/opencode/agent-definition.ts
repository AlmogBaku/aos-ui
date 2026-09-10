import { constants } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
  CREATOR_AGENT_ID,
  creatorAgentDefinition,
  creatorSkillSource,
} from "./creator-template"
import { inviteLinkSkill } from "./invite-link.generated"

export const AGENT_DEFINITION_LIMITS = {
  id: 48,
  name: 80,
  description: 280,
  prompt: 12_000,
  model: 160,
} as const

export const AGENT_PERMISSION_KEYS = [
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "bash",
  "task",
  "question",
  "webfetch",
] as const

export type AgentPermissionKey = (typeof AGENT_PERMISSION_KEYS)[number]
export type AgentPermissionAction = "allow" | "ask" | "deny"
export type AgentDefinitionInput = {
  agentId: string
  name: string
  description: string
  prompt: string
  model?: string
  permissions?: Partial<Record<AgentPermissionKey, AgentPermissionAction>>
}

type NormalizedAgentDefinition = Omit<AgentDefinitionInput, "permissions"> & {
  permissions: Partial<Record<AgentPermissionKey, AgentPermissionAction>>
}

const AGENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const RESERVED_IDS = new Set([
  CREATOR_AGENT_ID,
  "build",
  "plan",
  "general",
  "explore",
  "en",
  "he",
])
const ACTIONS = new Set<AgentPermissionAction>(["allow", "ask", "deny"])
const PERMISSION_KEYS = new Set<string>(AGENT_PERMISSION_KEYS)

function hasErrorCode(error: unknown, code: string) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  )
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  multiline = false
) {
  if (typeof value !== "string") throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  if (normalized.length > maximum)
    throw new Error(`${label} must be at most ${maximum} characters`)
  if (!multiline && /[\r\n\u2028\u2029]/u.test(normalized))
    throw new Error(`${label} must be a single line`)
  if (/\0/u.test(normalized)) throw new Error(`${label} contains invalid text`)
  return normalized
}

export function normalizeAgentDefinition(
  input: AgentDefinitionInput
): NormalizedAgentDefinition {
  const agentId = boundedText(
    input.agentId,
    "Agent ID",
    AGENT_DEFINITION_LIMITS.id
  )
  if (!AGENT_ID.test(agentId) || RESERVED_IDS.has(agentId))
    throw new Error(
      "Agent ID must be a non-reserved lowercase slug beginning with a letter"
    )

  const permissions: Partial<
    Record<AgentPermissionKey, AgentPermissionAction>
  > = {}
  for (const [key, action] of Object.entries(input.permissions ?? {})) {
    if (!PERMISSION_KEYS.has(key))
      throw new Error(`Unsupported Agent permission: ${key}`)
    if (!ACTIONS.has(action as AgentPermissionAction))
      throw new Error(`Unsupported permission action for ${key}`)
    permissions[key as AgentPermissionKey] = action as AgentPermissionAction
  }

  return {
    agentId,
    name: boundedText(input.name, "Name", AGENT_DEFINITION_LIMITS.name),
    description: boundedText(
      input.description,
      "Description",
      AGENT_DEFINITION_LIMITS.description
    ),
    prompt: boundedText(
      input.prompt,
      "Prompt",
      AGENT_DEFINITION_LIMITS.prompt,
      true
    ),
    ...(input.model === undefined
      ? {}
      : {
          model: boundedText(
            input.model,
            "Model",
            AGENT_DEFINITION_LIMITS.model
          ),
        }),
    permissions,
  }
}

function serializeAgentDefinition(input: NormalizedAgentDefinition) {
  const lines = [
    "---",
    `description: ${JSON.stringify(input.description)}`,
    "mode: primary",
    "aos_ui_managed: true",
    `aos_ui_name: ${JSON.stringify(input.name)}`,
  ]
  if (input.model) lines.push(`model: ${JSON.stringify(input.model)}`)
  const permissions = Object.entries(input.permissions).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  if (permissions.length) {
    lines.push("permission:")
    for (const [key, action] of permissions) lines.push(`  ${key}: ${action}`)
  }
  lines.push("---", "", input.prompt, "")
  return lines.join("\n")
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

async function agentDirectory(worktree: string) {
  const root = await realpath(resolve(worktree))
  let parent = await open(root, DIRECTORY_OPEN_FLAGS)
  try {
    const openCode = await safeDirectory(parent, ".opencode")
    await parent.close()
    parent = openCode
    const agents = await safeDirectory(parent, "agents")
    await parent.close()
    return agents
  } catch (error) {
    await parent.close()
    throw error
  }
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

export async function writeAgentDefinition(
  worktree: string,
  input: AgentDefinitionInput
) {
  const definition = normalizeAgentDefinition(input)
  const agents = await agentDirectory(worktree)
  const fileName = `${definition.agentId}.md`
  try {
    await writeExclusive(agents, fileName, serializeAgentDefinition(definition))
  } catch (error) {
    if (hasErrorCode(error, "EEXIST"))
      throw new Error(`Agent already exists: ${definition.agentId}`)
    throw error
  } finally {
    await agents.close()
  }
  return {
    definition,
    filePath: join(".opencode", "agents", fileName),
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

export async function installCreatorDefinition(worktree: string) {
  await preflightFixedAsset(
    worktree,
    [".opencode", "agents", `${CREATOR_AGENT_ID}.md`],
    creatorAgentDefinition,
    "Conflicting Agent Builder definition; refusing to overwrite it."
  )
  await preflightFixedAsset(
    worktree,
    [".opencode", "skills", "aos-agent-creator", "SKILL.md"],
    creatorSkillSource,
    "Conflicting AOS Agent creator skill; refusing to overwrite it."
  )
  await preflightFixedAsset(
    worktree,
    [".opencode", "skills", "aos-invite-link", "SKILL.md"],
    inviteLinkSkill,
    "Conflicting AOS invite-link skill; refusing to overwrite it."
  )
  const status = await installFixedAsset(
    worktree,
    [".opencode", "agents", `${CREATOR_AGENT_ID}.md`],
    creatorAgentDefinition,
    "Conflicting Agent Builder definition; refusing to overwrite it."
  )
  await installFixedAsset(
    worktree,
    [".opencode", "skills", "aos-agent-creator", "SKILL.md"],
    creatorSkillSource,
    "Conflicting AOS Agent creator skill; refusing to overwrite it."
  )
  await installFixedAsset(
    worktree,
    [".opencode", "skills", "aos-invite-link", "SKILL.md"],
    inviteLinkSkill,
    "Conflicting AOS invite-link skill; refusing to overwrite it."
  )
  return { status, agentId: CREATOR_AGENT_ID }
}
