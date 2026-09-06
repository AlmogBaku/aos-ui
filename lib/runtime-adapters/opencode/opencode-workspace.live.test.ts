import { createOpencodeClient } from "@assistant-ui/react-opencode"
import { describe, expect, it } from "vitest"

import { readLiveOpenCodeSmokeConfig } from "./live-smoke-config"
import { createOpenCodeWorkspace } from "./opencode-workspace"
import {
  createAgentScopedOpenCodeClient,
  OpenCodeSessionOwnership,
} from "./opencode-session-ownership"

const REQUEST_OPTIONS = { throwOnError: true } as const
const liveConfig = readLiveOpenCodeSmokeConfig(process.env)

describe.skipIf(!liveConfig.enabled)("OpenCode live Bedrock smoke", () => {
  it("preserves Agent ownership through a cheap provider round trip", async () => {
    if (!liveConfig.enabled) throw new Error("Live smoke is not configured")

    const client = createOpencodeClient({ baseUrl: liveConfig.baseUrl })
    const toolIds = await client.tool.ids({}, REQUEST_OPTIONS)
    expect(toolIds.data).toEqual(
      expect.arrayContaining([
        "render_chart",
        "render_map",
        "render_stats",
        "present_plan",
      ])
    )

    const providerResponse = await client.provider.list({}, REQUEST_OPTIONS)
    const provider = providerResponse.data?.all.find(
      (candidate) => candidate.id === liveConfig.providerID
    )

    expect(providerResponse.data?.connected).toContain(liveConfig.providerID)
    expect(provider, `${liveConfig.providerID} is not available`).toBeDefined()
    expect(
      provider?.models[liveConfig.modelID],
      `${liveConfig.modelID} is not available from ${liveConfig.providerID}`
    ).toBeDefined()

    const ownership = new OpenCodeSessionOwnership()
    const workspace = createOpenCodeWorkspace({ client, ownership })
    const scopedClient = createAgentScopedOpenCodeClient({ client, ownership })
    const agents = await workspace.listAgents()
    const selectedAgent = liveConfig.agentId
      ? agents.find((agent) => agent.id === liveConfig.agentId)
      : agents[0]
    expect(selectedAgent, "No matching primary OpenCode Agent").toBeDefined()

    let threadId: string | undefined
    try {
      const created = await workspace.createSession(selectedAgent!.id)
      threadId = created.threadId

      await expect(
        workspace.getSessionMetadata([threadId])
      ).resolves.toMatchObject([{ threadId, agentId: selectedAgent!.id }])

      const promptResponse = await scopedClient.session.prompt(
        {
          sessionID: threadId,
          model: {
            providerID: liveConfig.providerID,
            modelID: liveConfig.modelID,
          },
          system: "Do not use tools. Reply with only the word OK.",
          parts: [{ type: "text", text: "Reply with OK." }],
        },
        REQUEST_OPTIONS
      )
      const responseText = (promptResponse.data?.parts ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .trim()

      expect(responseText).toMatch(/^OK[.!]?$/i)
    } finally {
      if (threadId) {
        await client.session.delete({ sessionID: threadId }, REQUEST_OPTIONS)
      }
    }
  }, 120_000)

  it("keeps Mermaid in Markdown while invoking the installed chart tool", async () => {
    if (!liveConfig.enabled) throw new Error("Live smoke is not configured")

    const client = createOpencodeClient({ baseUrl: liveConfig.baseUrl })
    const ownership = new OpenCodeSessionOwnership()
    const workspace = createOpenCodeWorkspace({ client, ownership })
    const scopedClient = createAgentScopedOpenCodeClient({ client, ownership })
    const agents = await workspace.listAgents()
    const visualAgent = liveConfig.agentId
      ? agents.find((agent) => agent.id === liveConfig.agentId)
      : agents.find((agent) => agent.id !== "agent-builder")
    expect(
      visualAgent,
      "No primary Agent is available for visual tools"
    ).toBeDefined()

    let threadId: string | undefined

    try {
      const created = await workspace.createSession(visualAgent!.id)
      threadId = created.threadId

      const mermaidResponse = await scopedClient.session.prompt(
        {
          sessionID: threadId!,
          model: {
            providerID: liveConfig.providerID,
            modelID: liveConfig.modelID,
          },
          parts: [
            {
              type: "text",
              text: "Reply with only a fenced Mermaid flowchart from Request to Result. Do not use any tool.",
            },
          ],
        },
        REQUEST_OPTIONS
      )
      const mermaidText = (mermaidResponse.data?.parts ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
      expect(mermaidText).toMatch(/```mermaid\s+[\s\S]*```/i)
      expect(
        (mermaidResponse.data?.parts ?? []).filter(
          (part) => part.type === "tool"
        )
      ).toHaveLength(0)

      const historyAfterMermaid = await client.session.messages(
        { sessionID: threadId! },
        REQUEST_OPTIONS
      )
      expect(
        (historyAfterMermaid.data ?? [])
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool")
      ).toHaveLength(0)

      const response = await scopedClient.session.prompt(
        {
          sessionID: threadId!,
          model: {
            providerID: liveConfig.providerID,
            modelID: liveConfig.modelID,
          },
          parts: [
            {
              type: "text",
              text: "Use the render_chart tool exactly once to render a bar chart titled Monthly sessions with January 12 and February 18. Do not reply until it has completed.",
            },
          ],
        },
        REQUEST_OPTIONS
      )

      // OpenCode returns the final assistant turn from `prompt`; earlier
      // agentic turns (including the tool call) live in the session history.
      expect(response.data?.parts).toBeDefined()
      const messages = await client.session.messages(
        { sessionID: threadId! },
        REQUEST_OPTIONS
      )
      const chartToolParts = (messages.data ?? [])
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "render_chart")
      expect(chartToolParts).toHaveLength(1)
    } finally {
      if (threadId) {
        await client.session.delete({ sessionID: threadId }, REQUEST_OPTIONS)
      }
    }
  }, 120_000)
})
