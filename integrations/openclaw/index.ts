import { randomUUID } from "node:crypto"

import { type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin"
import {
  Array as TypeArray,
  Enum,
  Object as TypeObject,
  Optional,
  String as TypeString,
  Unsafe,
} from "typebox"

import { createAgent } from "./create-agent.js"
import { presentArtifact } from "./present-artifact.js"
import { createPresentationTools } from "./presentation.js"
import { startSession } from "./start-session.js"

const artifactParameters = TypeObject(
  {
    path: TypeString({ minLength: 1, maxLength: 4_096 }),
    title: Optional(TypeString({ minLength: 1, maxLength: 160 })),
    mimeType: Optional(TypeString({ minLength: 1, maxLength: 255 })),
  },
  { additionalProperties: false }
)

const sessionParameters = TypeObject(
  {
    agentId: TypeString({ minLength: 1, maxLength: 64 }),
    title: Optional(TypeString({ minLength: 1, maxLength: 160 })),
    kickoff: Optional(TypeString({ minLength: 1, maxLength: 12_000 })),
  },
  { additionalProperties: false }
)

const creatorParameters = TypeObject(
  {
    agentId: TypeString({
      minLength: 1,
      maxLength: 48,
      pattern: "^[a-z0-9][a-z0-9_-]*$",
    }),
    name: TypeString({ minLength: 1, maxLength: 80 }),
    description: TypeString({ minLength: 1, maxLength: 500 }),
    instructions: TypeString({ minLength: 1, maxLength: 12_000 }),
    model: Optional(TypeString({ minLength: 1, maxLength: 255 })),
    allowedCapabilities: Optional(
      TypeArray(Enum(["structured-presentations", "session-handoff"]), {
        maxItems: 2,
        uniqueItems: true,
      })
    ),
  },
  { additionalProperties: false }
)

const configSchema = TypeObject(
  {
    creatorAgentId: Optional(
      TypeString({ minLength: 1, maxLength: 64, default: "agent-builder" })
    ),
  },
  { additionalProperties: false }
)

function configuredCreator(api: OpenClawPluginApi) {
  const configured = api.pluginConfig?.creatorAgentId
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : "agent-builder"
}

const plugin = defineToolPlugin({
  id: "aos-ui",
  name: "AOS UI native tools",
  description:
    "Structured presentation, safe artifacts, Session handoff, and Agent creator tools for AOS UI.",
  configSchema,
  tools: (tool) => [
    ...Object.values(createPresentationTools()).map((definition) =>
      tool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: Unsafe(definition.parameters as never),
        factory: () => definition as never,
      })
    ),
    tool({
      name: "present_artifact",
      label: "Present artifact",
      description:
        "Validate one existing regular file from this Agent workspace for AOS artifact publication. The current OpenClaw SDK has no native plugin registration API, so this returns an explicit text-only fallback and never fabricates download authority.",
      parameters: artifactParameters,
      factory: ({ toolContext }) => ({
        name: "present_artifact",
        label: "Present artifact",
        description:
          "Validate one existing regular file from this Agent workspace for AOS artifact publication. The current OpenClaw SDK has no native plugin registration API, so this returns an explicit text-only fallback and never fabricates download authority.",
        parameters: artifactParameters,
        execute: (_toolCallId, params) => {
          if (!toolContext.workspaceDir)
            throw new Error("OpenClaw did not provide an Agent workspace")
          return presentArtifact(toolContext.workspaceDir, params)
        },
      }),
    }),
    tool({
      name: "start_session",
      label: "Start Session",
      description:
        "Create an independent root Session owned by another available Agent. An optional kickoff is submitted once with creation and is never retried automatically.",
      parameters: sessionParameters,
      factory: ({ api, toolContext, config }) => ({
        name: "start_session",
        label: "Start Session",
        description:
          "Create an independent root Session owned by another available Agent. An optional kickoff is submitted once with creation and is never retried automatically.",
        parameters: sessionParameters,
        execute: (_toolCallId, params) =>
          startSession(
            api.runtime.gateway,
            toolContext,
            params,
            randomUUID,
            config.creatorAgentId ?? "agent-builder"
          ),
      }),
    }),
    tool({
      name: "create_agent",
      label: "Create Agent",
      description:
        "Create one native OpenClaw Agent without overwriting an existing Agent. Restricted to the configured Agent Builder and requires explicit approval.",
      parameters: creatorParameters,
      factory: ({ api, toolContext, config }) => ({
        name: "create_agent",
        label: "Create Agent",
        description:
          "Create one native OpenClaw Agent without overwriting an existing Agent. Restricted to the configured Agent Builder and requires explicit approval.",
        parameters: creatorParameters,
        execute: (_toolCallId, params) =>
          createAgent(
            api.runtime.gateway,
            toolContext,
            params,
            config.creatorAgentId ?? "agent-builder"
          ),
      }),
    }),
  ],
})

const registerTools = plugin.register
plugin.register = (api) => {
  const creatorAgentId = configuredCreator(api)
  api.on("before_tool_call", (event, context) => {
    if (event.toolName !== "create_agent") return
    if (context.agentId !== creatorAgentId) {
      return {
        block: true,
        blockReason: "Only the configured Agent Builder may create Agents",
      }
    }
    const requestedId =
      typeof event.params.agentId === "string"
        ? event.params.agentId
        : "the requested Agent"
    return {
      requireApproval: {
        title: `Create Agent ${requestedId}`,
        description:
          "This writes a new native OpenClaw Agent definition and bootstrap instructions. Existing Agents will not be overwritten.",
        severity: "critical",
        timeoutMs: 120_000,
        timeoutBehavior: "deny",
        timeoutReason: "Agent creation approval expired",
        allowedDecisions: ["allow-once", "deny"],
      },
    }
  })
  registerTools(api)
}

export default plugin
