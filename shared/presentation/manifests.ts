import {
  buildAosUiHarnessPrompt,
  buildMontyInstructions,
  type HarnessCapabilities,
} from "./harness-prompt"

export const openCodeHarnessCapabilities = {
  mermaid: true,
  richUiTools: [
    { kind: "chart", name: "render_chart" },
    { kind: "map", name: "render_map" },
    { kind: "stats", name: "render_stats" },
    { kind: "plan", name: "present_plan" },
  ],
  askUserQuestionTool: "question",
  nativePermissions: true,
  providerTodos: true,
  providerSubagents: true,
  artifactPublicationTool: "present_artifact",
} as const satisfies HarnessCapabilities

export const hermesHarnessCapabilities = {
  mermaid: true,
  richUiTools: [
    { kind: "chart", name: "render_chart" },
    { kind: "map", name: "render_map" },
    { kind: "stats", name: "render_stats" },
    { kind: "plan", name: "present_plan" },
  ],
  askUserQuestionTool: "clarify",
  nativePermissions: true,
  providerTodos: true,
  providerSubagents: true,
  artifactPublicationTool: "present_artifact",
} as const satisfies HarnessCapabilities

export const fixtureHarnessCapabilities = {
  mermaid: true,
  richUiTools: [
    { kind: "chart", name: "render_chart" },
    { kind: "map", name: "render_map" },
    { kind: "stats", name: "render_stats" },
    { kind: "plan", name: "present_plan" },
  ],
  askUserQuestionTool: "ask_user_question",
  nativePermissions: true,
  providerTodos: true,
  providerSubagents: true,
} as const satisfies HarnessCapabilities

// An unconfigured generic AG-UI endpoint promises only streamed Markdown.
export const agUiHarnessCapabilities = {
  mermaid: true,
  artifactPublicationTool: "present_artifact",
  nativePermissions: false,
  providerTodos: false,
  providerSubagents: false,
} as const satisfies HarnessCapabilities

export const agentBuilderHarnessCapabilities = {
  mermaid: true,
  askUserQuestionTool: "question",
  nativePermissions: false,
  providerTodos: false,
  providerSubagents: false,
} as const satisfies HarnessCapabilities

export const openCodeMontyToolNames = ["monty_search", "monty_execute"] as const

export function buildProviderInstructions(
  capabilities: HarnessCapabilities,
  montyToolNames: readonly string[] = []
) {
  return [
    buildAosUiHarnessPrompt(capabilities),
    buildMontyInstructions(montyToolNames),
  ]
    .filter(Boolean)
    .join("\n\n")
}

export const openCodeProviderInstructions = buildProviderInstructions(
  openCodeHarnessCapabilities
)

export const fixtureProviderInstructions = buildProviderInstructions(
  fixtureHarnessCapabilities
)

export const agUiProviderInstructions = buildProviderInstructions(
  agUiHarnessCapabilities
)

export const agentBuilderProviderInstructions = buildProviderInstructions(
  agentBuilderHarnessCapabilities
)
