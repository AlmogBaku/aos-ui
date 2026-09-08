type NativeClient = {
  app: { agents(input: unknown): Promise<{ data?: unknown[] }> }
  session: {
    create(input: unknown): Promise<{
      data?: {
        id?: unknown
        agent?: unknown
        parentID?: unknown
      }
    }>
    promptAsync(input: unknown): Promise<unknown>
  }
}

export type StartSessionInput = {
  agentId: string
  title?: string
  kickoff?: string
}

function requiredText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`)
  const result = value.trim()
  if (result.length > maximum)
    throw new Error(`${label} must be at most ${maximum} characters`)
  return result
}

export async function startSession(
  client: NativeClient,
  worktree: string,
  sourceSessionId: string,
  input: StartSessionInput
) {
  const agentId = requiredText(input.agentId, "Agent ID", 48)
  const agents = await client.app.agents({
    query: { directory: worktree },
    throwOnError: true,
  })
  const available = (agents.data ?? []).some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false
    const agent = candidate as Record<string, unknown>
    return (
      agent.name === agentId &&
      (agent.mode === "primary" || agent.mode === "all") &&
      agent.hidden !== true
    )
  })
  if (!available) throw new Error(`Agent is not available: ${agentId}`)

  const title = input.title?.trim()
  const createResponse = await client.session.create({
    query: { directory: worktree },
    body: {
      ...(title ? { title: requiredText(title, "Title", 160) } : {}),
      agent: agentId,
      metadata: {
        aos_ui: {
          version: 1,
          kind: "inbound-session",
          agentId,
          sourceSessionId,
        },
      },
    },
    throwOnError: true,
  })
  const created = createResponse.data
  if (typeof created?.id !== "string")
    throw new Error("OpenCode did not create a Session")
  if (created.parentID)
    throw new Error(
      "OpenCode created a child Session instead of a root Session"
    )
  if (created.agent !== agentId)
    throw new Error(
      `Session ownership mismatch: requested ${agentId}, received ${created.agent ?? "none"}`
    )

  let kickoff: "not-requested" | "accepted" | "unknown" = "not-requested"
  if (input.kickoff?.trim()) {
    try {
      await client.session.promptAsync({
        path: { id: created.id },
        query: { directory: worktree },
        body: {
          agent: agentId,
          parts: [
            {
              type: "text",
              text: requiredText(input.kickoff, "Kickoff", 12_000),
            },
          ],
        },
        throwOnError: true,
      })
      kickoff = "accepted"
    } catch {
      // The request may have reached OpenCode. Retain the Session and never
      // retry an ambiguous kickoff automatically.
      kickoff = "unknown"
    }
  }

  return {
    version: 1 as const,
    kind: "session-started" as const,
    sessionId: created.id,
    agentId,
    created: true as const,
    kickoff,
  }
}
