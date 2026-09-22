import { isAbsolute, resolve } from "node:path"

import {
  tool,
  type Hooks,
  type Plugin,
  type PluginInput,
} from "@opencode-ai/plugin"

import {
  agUiProviderInstructions,
  agentBuilderProviderInstructions,
  openCodeProviderInstructions,
} from "../../shared/presentation/manifests"
import { presentationToolDefinitions } from "../../shared/presentation/tools"
import {
  AGENT_DEFINITION_LIMITS,
  AGENT_PERMISSION_KEYS,
} from "./agent-definition"
import { createAgent } from "./create-agent"
import { presentArtifact } from "./present-artifact"
import { startSession } from "./start-session"

type Environment = Readonly<Record<string, string | undefined>>

export function resolveConfiguredWorktree(environment: Environment) {
  const configured = environment.AOS_UI_OPENCODE_WORKTREE?.trim()
  if (!configured)
    throw new Error("AOS_UI_OPENCODE_WORKTREE must name the external worktree")
  if (!isAbsolute(configured))
    throw new Error("AOS_UI_OPENCODE_WORKTREE must be an absolute path")
  return resolve(configured)
}

function assertContextDirectory(configuredWorktree: string, directory: string) {
  if (resolve(directory) !== configuredWorktree)
    throw new Error(
      "Tool invocation does not belong to the configured worktree"
    )
}

function permissionAction() {
  return tool.schema.enum(["allow", "ask", "deny"]).optional()
}

const permissionShape = Object.fromEntries(
  AGENT_PERMISSION_KEYS.map((key) => [key, permissionAction()])
) as Record<
  (typeof AGENT_PERMISSION_KEYS)[number],
  ReturnType<typeof permissionAction>
>

function presentationTools(): Hooks["tool"] {
  return Object.fromEntries(
    Object.entries(presentationToolDefinitions).map(([name, definition]) => [
      name,
      tool({
        description: definition.description,
        // The pinned plugin carries its own Zod 4 minor. OpenCode consumes the
        // shared schema structurally, while execution parses with the canonical
        // shared instance so semantic refinements remain authoritative.
        args: definition.schema.shape as unknown as Record<
          string,
          ReturnType<typeof tool.schema.any>
        >,
        async execute(args) {
          const parsed = definition.schema.parse(args) as {
            title?: string
          }
          const label =
            name === "render_stats"
              ? (parsed.title ?? "metrics")
              : (parsed.title ?? "presentation")
          return `${label} is ready for display.`
        },
      }),
    ])
  )
}

export async function createAosUiPlugin(
  input: PluginInput,
  configuredWorktree = resolveConfiguredWorktree(process.env)
): Promise<Hooks> {
  if (resolve(input.directory) !== configuredWorktree)
    throw new Error(
      "OpenCode plugin directory does not match the configured worktree"
    )

  let reportedHealthy = false
  const report = async (
    level: "info" | "warn",
    message: string,
    extra: Record<string, unknown>
  ) => {
    try {
      await input.client.app.log({
        body: { service: "aos-ui-harness", level, message, extra },
        throwOnError: true,
      })
    } catch {
      // Observability must not make the native provider unusable.
    }
  }
  const tools: NonNullable<Hooks["tool"]> = {
    ...presentationTools(),
    present_artifact: tool({
      description:
        "Publish one existing worktree file as an AOS artifact and return its presentation receipt.",
      args: {
        path: tool.schema.string().min(1).max(4_096),
        title: tool.schema.string().min(1).max(160).optional(),
        mimeType: tool.schema.string().min(1).max(255).optional(),
      },
      async execute(args, context) {
        assertContextDirectory(configuredWorktree, context.directory)
        return presentArtifact(configuredWorktree, args)
      },
    }),
    start_session: tool({
      description:
        "Start an independent root Session owned by another available Agent. An optional kickoff is submitted once; an uncertain acceptance is reported and never retried automatically.",
      args: {
        agentId: tool.schema.string().min(1).max(48),
        title: tool.schema.string().min(1).max(160).optional(),
        kickoff: tool.schema.string().min(1).max(12_000).optional(),
      },
      async execute(args, context) {
        assertContextDirectory(configuredWorktree, context.directory)
        const receipt = await startSession(
          input.client as never,
          configuredWorktree,
          context.sessionID,
          args
        )
        return {
          title: `Started ${receipt.agentId}`,
          output:
            receipt.kickoff === "unknown"
              ? `Session ${receipt.sessionId} was created, but kickoff acceptance is unknown. Inspect it before retrying.`
              : `Session ${receipt.sessionId} was created for ${receipt.agentId}.`,
          metadata: { aos_ui: receipt },
        }
      },
    }),
    create_agent: tool({
      description:
        "Save one native Agent after explicit user confirmation, then report whether OpenCode confirms it as ready. Restricted to the Agent Builder.",
      args: {
        agentId: tool.schema.string().min(1).max(AGENT_DEFINITION_LIMITS.id),
        name: tool.schema.string().min(1).max(AGENT_DEFINITION_LIMITS.name),
        description: tool.schema
          .string()
          .min(1)
          .max(AGENT_DEFINITION_LIMITS.description),
        prompt: tool.schema.string().min(1).max(AGENT_DEFINITION_LIMITS.prompt),
        model: tool.schema
          .string()
          .min(1)
          .max(AGENT_DEFINITION_LIMITS.model)
          .optional(),
        permissions: tool.schema.object(permissionShape).optional(),
      },
      async execute(args, context) {
        assertContextDirectory(configuredWorktree, context.directory)
        const receipt = await createAgent(
          input.client as never,
          configuredWorktree,
          context.agent,
          args
        )
        return {
          title: `Saved ${receipt.agentId}`,
          output:
            receipt.status === "ready"
              ? `Agent ${receipt.agentId} is ready.`
              : `Agent ${receipt.agentId} was saved but still needs OpenCode setup or reload before use.`,
          metadata: { aos_ui: receipt },
        }
      },
    }),
  }

  return {
    tool: tools,
    "chat.params": async (_hookInput, output) => {
      delete output.options.aos_ui_managed
      delete output.options.aos_ui_name
      delete output.options.aos_ui_role
    },
    "experimental.chat.system.transform": async (hookInput, output) => {
      let instructions = openCodeProviderInstructions
      let manifest = "opencode"
      let resolutionError: unknown
      if (hookInput.sessionID) {
        try {
          const response = await input.client.session.get({
            path: { id: hookInput.sessionID },
            query: { directory: configuredWorktree },
            throwOnError: true,
          })
          const owner = (response.data as { agent?: unknown } | undefined)
            ?.agent
          const agents = await input.client.app.agents({
            query: { directory: configuredWorktree },
            throwOnError: true,
          })
          const creator = (agents.data ?? []).some((candidate) => {
            if (!candidate || typeof candidate !== "object") return false
            const agent = candidate as Record<string, unknown>
            const options =
              agent.options && typeof agent.options === "object"
                ? (agent.options as Record<string, unknown>)
                : {}
            return agent.name === owner && options.aos_ui_role === "creator"
          })
          if (creator) {
            instructions = agentBuilderProviderInstructions
            manifest = "agent-builder"
          }
        } catch (reason) {
          instructions = agUiProviderInstructions
          manifest = "ag-ui-fallback"
          resolutionError = reason
        }
      }
      if (
        !output.system.some((entry) =>
          entry.includes("AOS presentation harness:")
        )
      )
        output.system.push(instructions)

      const session = hookInput.sessionID
        ? { sessionID: hookInput.sessionID }
        : {}
      if (resolutionError !== undefined) {
        await report(
          "warn",
          "AOS harness could not resolve Session ownership; conservative guidance was injected",
          {
            error:
              resolutionError instanceof Error
                ? resolutionError.message
                : String(resolutionError),
            manifest,
            ...session,
          }
        )
      } else if (!reportedHealthy) {
        reportedHealthy = true
        await report("info", "AOS presentation harness is active", {
          manifest,
          ...session,
        })
      }
    },
  }
}

const AosUiPlugin: Plugin = async (input) => createAosUiPlugin(input)

export default AosUiPlugin
