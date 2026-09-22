import {
  buildAosUiHarnessPrompt,
  type HarnessCapabilities,
} from "./harness-prompt"

export const openCodeHarnessCapabilities = {
  mermaid: true,
  richUiTools: [
    { kind: "chart", name: "render_chart" },
    { kind: "map", name: "render_map" },
    { kind: "stats", name: "render_stats" },
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

export const openCodeProviderInstructions = buildAosUiHarnessPrompt(
  openCodeHarnessCapabilities
)

export const fixtureProviderInstructions = buildAosUiHarnessPrompt(
  fixtureHarnessCapabilities
)

export const agUiProviderInstructions = buildAosUiHarnessPrompt(
  agUiHarnessCapabilities
)

export const agentBuilderProviderInstructions = buildAosUiHarnessPrompt(
  agentBuilderHarnessCapabilities
)
