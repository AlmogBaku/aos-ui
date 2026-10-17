"use client"

import { artifactPanelFailure } from "@/components/artifacts"
import {
  McpAppPipPanel,
  useMcpAppPip,
} from "@/components/mcp-apps/mcp-app-card"
import type { ToolUiLocale } from "@/components/tool-ui/locale"
import {
  SubagentTranscript,
  useSubagentTranscriptPip,
} from "@/components/tool-ui/subagent-transcript"

/**
 * What a side-panel slot shows, with its name and the way it closes: a
 * subagent's transcript, which reads the thread beside it, or an App view.
 * The workspace and the guest lane render their slots from it alike.
 */
export function useSidePanelView(locale: ToolUiLocale) {
  const app = useMcpAppPip(locale)
  const transcript = useSubagentTranscriptPip(locale)
  const shown = transcript ?? app
  if (!shown) return undefined
  return {
    ...shown,
    content: transcript ? (
      <SubagentTranscript locale={locale} />
    ) : (
      <McpAppPipPanel locale={locale} failureNotice={artifactPanelFailure} />
    ),
  }
}
