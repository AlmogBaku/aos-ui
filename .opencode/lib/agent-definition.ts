import { lstat, mkdir, open, realpath } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

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

export type NormalizedAgentDefinition = Required<
  Omit<AgentDefinitionInput, "model" | "permissions">
> & {
  model?: string
  permissions: Partial<Record<AgentPermissionKey, AgentPermissionAction>>
}

const AGENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const RESERVED_IDS = new Set([
  "agent-builder",
  "build",
  "plan",
  "general",
  "explore",
  "en",
  "he",
])
const ACTIONS = new Set<AgentPermissionAction>(["allow", "ask", "deny"])
const PERMISSION_KEYS = new Set<string>(AGENT_PERMISSION_KEYS)

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  { multiline = false }: { multiline?: boolean } = {}
) {
  if (typeof value !== "string") throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  if (normalized.length > maximum) {
    throw new Error(`${label} must be at most ${maximum} characters`)
  }
  if (!multiline && /[\r\n\u2028\u2029]/u.test(normalized)) {
    throw new Error(`${label} must be a single line`)
  }
  if (/\0/u.test(normalized)) throw new Error(`${label} contains invalid text`)
  return normalized
}

export function normalizeAgentDefinition(
  input: AgentDefinitionInput
): NormalizedAgentDefinition {
  if (!input || typeof input !== "object") {
    throw new Error("Agent definition is required")
  }

  const agentId = boundedText(
    input.agentId,
    "Agent ID",
    AGENT_DEFINITION_LIMITS.id
  )
  if (!AGENT_ID.test(agentId) || RESERVED_IDS.has(agentId)) {
    throw new Error(
      "Agent ID must be a non-reserved lowercase slug beginning with a letter"
    )
  }

  const permissions: Partial<
    Record<AgentPermissionKey, AgentPermissionAction>
  > = {}
  for (const [key, action] of Object.entries(input.permissions ?? {})) {
    if (!PERMISSION_KEYS.has(key)) {
      throw new Error(`Unsupported Agent permission: ${key}`)
    }
    if (!ACTIONS.has(action as AgentPermissionAction)) {
      throw new Error(`Unsupported permission action for ${key}`)
    }
    permissions[key as AgentPermissionKey] = action as AgentPermissionAction
  }

  const model =
    input.model === undefined
      ? undefined
      : boundedText(input.model, "Model", AGENT_DEFINITION_LIMITS.model)

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
      {
        multiline: true,
      }
    ),
    ...(model ? { model } : {}),
    permissions,
  }
}

function yamlString(value: string) {
  return JSON.stringify(value)
}

function hasErrorCode(error: unknown, code: string) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  )
}

async function ensureAgentDirectoryComponent(
  parentDirectory: string,
  component: string
) {
  const directory = join(parentDirectory, component)
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
  }

  const stats = await lstat(directory)
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Agent directory component is a symbolic link: ${component}`
    )
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Agent directory component is not a directory: ${component}`
    )
  }
  return directory
}

export function serializeAgentDefinition(input: NormalizedAgentDefinition) {
  const lines = [
    "---",
    `description: ${yamlString(input.description)}`,
    "mode: primary",
    "aos_ui_managed: true",
    `aos_ui_name: ${yamlString(input.name)}`,
  ]
  if (input.model) lines.push(`model: ${yamlString(input.model)}`)
  const permissions = Object.entries(input.permissions).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  if (permissions.length > 0) {
    lines.push("permission:")
    for (const [key, action] of permissions) lines.push(`  ${key}: ${action}`)
  }
  lines.push("---", "", input.prompt, "")
  return lines.join("\n")
}

export async function writeAgentDefinition(
  worktree: string,
  input: AgentDefinitionInput
) {
  const definition = normalizeAgentDefinition(input)
  const worktreeDirectory = await realpath(resolve(worktree))
  const openCodeDirectory = await ensureAgentDirectoryComponent(
    worktreeDirectory,
    ".opencode"
  )
  const agentsDirectory = await ensureAgentDirectoryComponent(
    openCodeDirectory,
    "agents"
  )
  const realAgentsDirectory = await realpath(agentsDirectory)
  if (realAgentsDirectory !== agentsDirectory) {
    throw new Error("Agent directory resolves outside the project worktree")
  }
  const filePath = resolve(agentsDirectory, `${definition.agentId}.md`)
  const pathFromAgents = relative(agentsDirectory, filePath)
  if (
    !pathFromAgents ||
    pathFromAgents.startsWith(`..${sep}`) ||
    pathFromAgents === ".." ||
    pathFromAgents.includes(sep)
  ) {
    throw new Error("Agent path escapes the project Agent directory")
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, "wx", 0o600)
    await handle.writeFile(serializeAgentDefinition(definition), "utf8")
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(`Agent already exists: ${definition.agentId}`)
    }
    throw error
  } finally {
    await handle?.close()
  }

  return {
    definition,
    filePath: join(".opencode", "agents", `${definition.agentId}.md`),
  }
}
