import { randomUUID } from "node:crypto"

import { z } from "zod"

import type { Gateway, ToolContext } from "./tool-contract.js"
import {
  objectValue,
  optionalText,
  requiredText,
  textResult,
} from "./tool-contract.js"

const agentsListSchema = z.object({
  agents: z.array(
    z
      .object({
        id: z.string(),
        kind: z.string().optional(),
      })
      .passthrough()
  ),
})

const createSessionSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
  sessionId: z.string(),
  runStarted: z.boolean().optional(),
  runError: z.unknown().optional(),
})

export async function startSession(
  gateway: Gateway,
  context: ToolContext,
  input: unknown,
  createId: () => string = randomUUID,
  creatorAgentId = "agent-builder"
) {
  const value = objectValue(input)
  const agentId = requiredText(value.agentId, "Agent ID", 64)
  const title = optionalText(value.title, "Title", 160)
  const kickoff = optionalText(value.kickoff, "Kickoff", 12_000)
  const sourceAgentId = requiredText(context.agentId, "Source Agent ID", 64)
  const sourceSessionKey = requiredText(
    context.sessionKey,
    "Source Session key",
    512
  )

  const listed = agentsListSchema.parse(
    await gateway.request("agents.list", {})
  )
  if (agentId === sourceAgentId)
    throw new Error("Session handoff requires another Agent")
  const available = listed.agents.some(
    (agent) =>
      agent.id === agentId &&
      agent.kind !== "system" &&
      agent.id !== "openclaw" &&
      agent.id !== "crestodian" &&
      agent.id !== creatorAgentId
  )
  if (!available) throw new Error(`Agent is not available: ${agentId}`)

  const operationId = createId()
  const response = createSessionSchema.parse(
    await gateway.request("sessions.create", {
      agentId,
      ...(title ? { displayName: title, titleSource: title } : {}),
      ...(kickoff ? { task: kickoff } : {}),
      idempotencyKey: operationId,
    })
  )
  if (!response.key.startsWith(`agent:${agentId}:`))
    throw new Error(
      "OpenClaw created a Session with mismatched Agent ownership"
    )

  const kickoffStatus = !kickoff
    ? "not-requested"
    : response.runStarted === true && response.runError === undefined
      ? "accepted"
      : "unknown"
  const session = {
    operationId,
    sessionId: response.sessionId,
    sessionKey: response.key,
    agentId,
    sourceAgentId,
    sourceSessionKey,
    created: true,
    kickoff: kickoffStatus,
  }
  const fallback =
    kickoffStatus === "unknown"
      ? `Created root Session ${response.key} for ${agentId}, but kickoff acceptance is unknown. Inspect it before retrying.`
      : `Created root Session ${response.key} for ${agentId}.`
  return textResult(fallback, {
    ok: true,
    type: "aos.session-started",
    session,
  })
}
