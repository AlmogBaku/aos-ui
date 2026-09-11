import { z } from "zod"

import type { Gateway, ToolContext } from "./tool-contract.js"
import { objectValue, requiredText, textResult } from "./tool-contract.js"

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const CAPABILITIES = ["structured-presentations", "session-handoff"] as const

const agentsListSchema = z.object({
  agents: z.array(z.object({ id: z.string() }).passthrough()),
})
const createResponseSchema = z.object({
  ok: z.literal(true),
  agentId: z.string(),
  name: z.string(),
  workspace: z.string(),
})
const fileResponseSchema = z.object({
  file: z.object({
    name: z.literal("AGENTS.md"),
    content: z.string(),
    hash: z.string().min(1),
  }),
})

function parseInput(input: unknown) {
  const value = objectValue(input)
  const agentId = requiredText(value.agentId, "Agent ID", 48)
  if (!AGENT_ID.test(agentId))
    throw new Error("Agent ID must be a lowercase native OpenClaw identifier")
  const capabilities = z
    .array(z.enum(CAPABILITIES))
    .max(CAPABILITIES.length)
    .default([])
    .parse(value.allowedCapabilities)
  return {
    agentId,
    name: requiredText(value.name, "Agent name", 80),
    description: requiredText(value.description, "Description", 500),
    instructions: requiredText(value.instructions, "Instructions", 12_000),
    model:
      value.model === undefined
        ? undefined
        : requiredText(value.model, "Model", 255),
    allowedCapabilities: [...new Set(capabilities)],
  }
}

function buildInstructions(
  input: ReturnType<typeof parseInput>,
  existing: string
) {
  const capabilities =
    input.allowedCapabilities.length > 0
      ? input.allowedCapabilities.join(", ")
      : "none"
  return `${existing.trimEnd()}\n\n## AOS Agent definition\n\nName: ${input.name}\n\nPurpose: ${input.description}\n\nAllowed AOS capabilities: ${capabilities}\n\n${input.instructions}\n`
}

export async function createAgent(
  gateway: Gateway,
  context: ToolContext,
  rawInput: unknown,
  creatorAgentId = "agent-builder"
) {
  if (context.agentId !== creatorAgentId)
    throw new Error("Only the configured Agent Builder may create Agents")
  const input = parseInput(rawInput)
  if (input.agentId === creatorAgentId)
    throw new Error("The Agent Builder already exists")

  const listed = agentsListSchema.parse(
    await gateway.request("agents.list", {})
  )
  if (!listed.agents.some((agent) => agent.id === creatorAgentId))
    throw new Error("The configured Agent Builder is unavailable")
  if (listed.agents.some((agent) => agent.id === input.agentId))
    throw new Error(`Agent already exists: ${input.agentId}`)

  // agents.create is OpenClaw's native, config-lock-protected no-overwrite path.
  const created = createResponseSchema.parse(
    await gateway.request("agents.create", {
      name: input.agentId,
      ...(input.model ? { model: input.model } : {}),
    })
  )
  if (created.agentId !== input.agentId)
    throw new Error(
      `OpenClaw normalized Agent ID to ${created.agentId}; setup must be reviewed manually`
    )

  let status: "ready" | "setup-needed" = "ready"
  try {
    const bootstrap = fileResponseSchema.parse(
      await gateway.request("agents.files.get", {
        agentId: input.agentId,
        name: "AGENTS.md",
      })
    )
    await gateway.request("agents.files.set", {
      agentId: input.agentId,
      name: "AGENTS.md",
      content: buildInstructions(input, bootstrap.file.content),
      expectedHash: bootstrap.file.hash,
    })
    await gateway.request("agents.update", {
      agentId: input.agentId,
      name: input.name,
    })
  } catch {
    // Native creation may already be durable. Never retry or delete implicitly;
    // surface the bounded recovery state instead.
    status = "setup-needed"
  }

  const agent = {
    agentId: input.agentId,
    name: input.name,
    description: input.description,
    saved: true,
    status,
  }
  return textResult(
    status === "ready"
      ? `Agent ${input.agentId} is ready.`
      : `Agent ${input.agentId} was created but its bootstrap setup needs review. Do not retry creation.`,
    { ok: true, type: "aos.agent-created", agent }
  )
}
