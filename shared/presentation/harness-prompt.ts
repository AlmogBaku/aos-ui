export type HarnessRichUiKind = "chart" | "map" | "stats"

export type HarnessRichUiTool = Readonly<{
  kind: HarnessRichUiKind
  name: string
}>

export type HarnessCapabilities = Readonly<{
  mermaid: boolean
  richUiTools?: readonly HarnessRichUiTool[]
  askUserQuestionTool?: string
  nativePermissions?: boolean
  providerTodos?: boolean
  providerSubagents?: boolean
  artifactPublicationTool?: string
}>

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

function assertToolName(name: string): string {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid advertised tool name: ${JSON.stringify(name)}`)
  }
  return name
}

const richToolGuidance: Record<HarnessRichUiKind, string> = {
  chart: "Use it for charts with structured series and labels.",
  map: "Use it for geographic locations with structured coordinates.",
  stats: "Use it for compact structured metrics and comparisons.",
}

export function buildAosUiHarnessPrompt(
  capabilities: HarnessCapabilities
): string {
  const sections = [
    "AOS presentation harness:",
    "- Write normal answers in clear Markdown. Preserve user content verbatim and never emit executable HTML, scripts, or browser-side code.",
  ]

  if (capabilities.mermaid) {
    sections.push(
      "- You may use fenced `mermaid` blocks for concise explanatory flows and relationships. Keep diagrams reasonably small, use Mermaid syntax only, and never put HTML, callbacks, or external resources in a diagram."
    )
  }

  const seenToolNames = new Set<string>()
  for (const tool of capabilities.richUiTools ?? []) {
    const name = assertToolName(tool.name)
    if (seenToolNames.has(name)) continue
    seenToolNames.add(name)
    sections.push(
      `- \`${name}\` is the advertised ${tool.kind} presentation tool. ${richToolGuidance[tool.kind]} Call the tool with structured arguments; do not imitate its UI in prose or tool-shaped JSON.`
    )
  }

  if (capabilities.artifactPublicationTool) {
    const artifactTool = assertToolName(capabilities.artifactPublicationTool)
    sections.push(
      `- Artifact delivery: Use \`${artifactTool}\` when a concrete file is part of the answer delivered to the user—whether as its source, subject, or output. A file qualifies only after it is selected for the final response; inspecting a candidate does not qualify. Publish each selected file after its final edit and before the final response.`
    )
  }

  if (capabilities.askUserQuestionTool) {
    const questionTool = assertToolName(capabilities.askUserQuestionTool)
    sections.push(
      `- Use \`${questionTool}\` when a real interactive answer is required. Ask one focused question, preserve the provider's available choices, allow free text only when its schema permits it, and wait for the recorded answer.`
    )
  } else {
    sections.push(
      "- Interactive questions are unavailable. Ask in ordinary prose and do not invent interactive controls."
    )
  }

  sections.push(
    capabilities.nativePermissions
      ? "- Permissions are provider-native controls attached to the guarded action. Never fabricate a permission card or an ‘always’ scope; wait for the provider-recorded decision."
      : "- Permission controls are unavailable. Do not claim that permission was requested or granted."
  )

  sections.push(
    capabilities.providerTodos
      ? "- Todos are session-scoped, provider-owned execution state. Update them only through the provider's native Todo mechanism; never derive a Todo from prose."
      : "- Todo controls are unavailable in this UI. Native Todo tools may still exist; use only actual native capabilities. Prose must not claim to create or update Todos."
  )

  sections.push(
    capabilities.providerSubagents
      ? "- Subagent delegation is provider-native activity. Use only the provider's native delegation control and wait for its actual result."
      : "- Subagent UI controls are unavailable. Native delegation may still exist; follow the harness's actual tool capabilities and never invent a delegated run or transcript."
  )

  return sections.join("\n")
}
