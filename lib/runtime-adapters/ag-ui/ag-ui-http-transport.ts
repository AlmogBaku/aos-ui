import { z } from "zod"

import type { SessionCreationOptions } from "../contracts"
import type {
  AgUiSessionMetadata,
  AgUiSessionSnapshot,
  AgUiWorkspaceTransport,
} from "./ag-ui-workspace"

const agentIconSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("symbol"),
    symbol: z.enum([
      "spark",
      "layers",
      "compass",
      "chart",
      "pen",
      "unassigned",
    ]),
    tone: z.enum(["indigo", "purple", "teal", "ochre", "slate"]),
  }),
  z.object({
    kind: z.literal("image"),
    src: z.string().min(1),
    alt: z.string().optional(),
  }),
])

const agentSchema = z
  .object({
    kind: z.literal("ready").optional(),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(["idle", "running", "attention"]).optional(),
    icon: agentIconSchema.optional(),
    visibility: z.enum(["visible", "hidden"]).optional(),
    selectable: z.boolean().optional(),
    editable: z.boolean().optional(),
  })
  .transform((agent) => ({ ...agent, kind: "ready" as const }))

const sessionSchema = z.object({
  threadId: z.string().min(1),
  agentId: z.string().min(1),
  updatedAt: z.iso.datetime(),
  status: z.enum(["idle", "running", "waiting-for-input", "failed"]),
  title: z.string().min(1).optional(),
})

const sessionSnapshotSchema = z.object({
  messages: z.array(z.unknown()),
  state: z.json().optional(),
  unstableResume: z.boolean().optional(),
})

type AgUiHttpWorkspaceTransportOptions = {
  baseUrl: string
  fetcher?: typeof fetch
  /** Explicit host opt-in to PATCH /agents/:id/visibility. */
  supportsVisibilityUpdates?: boolean
}

function pathUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}${path}`
}

function payloadError(kind: string) {
  return new Error(`AG-UI workspace returned invalid ${kind}`)
}

export function createAgUiHttpWorkspaceTransport({
  baseUrl,
  fetcher = fetch,
  supportsVisibilityUpdates = false,
}: AgUiHttpWorkspaceTransportOptions): AgUiWorkspaceTransport {
  async function request(path: string, init?: RequestInit) {
    const url = pathUrl(baseUrl, path)
    const response = init ? await fetcher(url, init) : await fetcher(url)
    if (!response.ok) {
      throw new Error(
        `AG-UI workspace request failed (${response.status}): ${path}`
      )
    }
    return response.json() as Promise<unknown>
  }

  return {
    ...(supportsVisibilityUpdates
      ? {
          updateAgentVisibility: async (
            agentId: string,
            visibility: "visible" | "hidden"
          ) => {
            const response = await fetcher(
              pathUrl(
                baseUrl,
                `/agents/${encodeURIComponent(agentId)}/visibility`
              ),
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ visibility }),
              }
            )
            if (!response.ok)
              throw new Error(
                `AG-UI visibility update failed (${response.status})`
              )
          },
        }
      : {}),
    async listAgents() {
      const result = z.array(agentSchema).safeParse(await request("/agents"))
      if (!result.success) throw payloadError("Agent catalog")
      return result.data
    },
    async listSessions(): Promise<AgUiSessionMetadata[]> {
      const result = z
        .array(sessionSchema)
        .safeParse(await request("/sessions"))
      if (!result.success) throw payloadError("Session metadata")
      return result.data
    },
    async createSession(
      agentId: string,
      options?: SessionCreationOptions
    ): Promise<AgUiSessionMetadata> {
      const result = sessionSchema.safeParse(
        await request("/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId,
            ...(options ? { title: options.title } : {}),
          }),
        })
      )
      if (!result.success) throw payloadError("created Session metadata")
      return result.data
    },
    async loadSession(threadId: string): Promise<AgUiSessionSnapshot> {
      const result = sessionSnapshotSchema.safeParse(
        await request(`/sessions/${encodeURIComponent(threadId)}`)
      )
      if (!result.success) throw payloadError("Session history")
      return result.data
    },
  }
}
