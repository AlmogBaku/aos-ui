import type { ThreadAssistantMessagePart } from "@assistant-ui/react"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { viewerFileResult } from "@harness-gw/sdk/protocol"
import type { AosUiToolName } from "@shared/presentation/tools"
import {
  FIXTURE_MCP_APP_FILES,
  FIXTURE_MCP_APP_FILES_PATH,
} from "@shared/presentation/views"
import { MCP_APP_TOOL_ARTIFACT } from "@/components/mcp-apps/tool-part"

type ToolCallPart = Extract<ThreadAssistantMessagePart, { type: "tool-call" }>

export type FixturePresentationCall = {
  toolName: AosUiToolName
  args: ToolCallPart["args"]
  /** Custom MCP tool result; if absent the adapter uses the default short `{ ok: true }`. */
  result?: CallToolResult
}

export type FixturePresentationCallId =
  | "fixture-initial-chart"
  | "fixture-render_chart"
  | "fixture-render_map"
  | "fixture-render_stats"
  | "fixture-present_artifact-pdf"
  | "fixture-present_artifact-png"
  | "fixture-present_artifact-html"
  | "fixture-present_artifact-audio"
  | "fixture-present_artifact-video"

/** Builds one present_artifact call entry: args + the full structured result. */
function artifactCall(
  key: keyof typeof FIXTURE_MCP_APP_FILES,
  mimeType: string
): FixturePresentationCall {
  const filename = FIXTURE_MCP_APP_FILES[key]
  const result = viewerFileResult({ filename, mimeType })
  return {
    toolName: "present_artifact",
    args: {
      path: `${FIXTURE_MCP_APP_FILES_PATH}/${filename}`,
      title: filename,
    },
    result: {
      ...result,
      structuredContent: {
        ok: true,
        type: "aos.presentation",
        kind: "present_artifact",
        ...result.structuredContent,
      },
    },
  }
}

/**
 * Every chart, map and stats call the preview makes, by tool call id. The
 * `aos-ui` server's own views draw them, so each is an App call.
 */
export const fixturePresentationCalls: Record<
  FixturePresentationCallId,
  FixturePresentationCall
> = {
  "fixture-initial-chart": {
    toolName: "render_chart",
    args: {
      title: "Investment is shifting into applied AI",
      type: "line",
      xKey: "quarter",
      series: [
        { key: "platform", label: "AI platforms" },
        { key: "applied", label: "Applied AI" },
        { key: "governance", label: "Governance" },
      ],
      data: [
        { quarter: "Q2 ’24", platform: 100, applied: 72, governance: 38 },
        { quarter: "Q3 ’24", platform: 108, applied: 84, governance: 46 },
        { quarter: "Q4 ’24", platform: 121, applied: 103, governance: 57 },
        { quarter: "Q1 ’25", platform: 136, applied: 128, governance: 71 },
      ],
    },
  },
  "fixture-render_chart": {
    toolName: "render_chart",
    args: {
      title: "Enterprise AI spend",
      type: "line",
      xKey: "quarter",
      series: [
        { key: "total", label: "Total AI spend" },
        { key: "genai", label: "GenAI spend" },
      ],
      data: [
        { quarter: "Q4’24", total: 300, genai: 220 },
        { quarter: "Q1’25", total: 365, genai: 275 },
      ],
    },
  },
  "fixture-render_map": {
    toolName: "render_map",
    args: {
      title: "Interview coverage",
      locations: [
        {
          id: "london",
          label: "London",
          latitude: 51.5072,
          longitude: -0.1276,
        },
        {
          id: "tel-aviv",
          label: "Tel Aviv",
          latitude: 32.0853,
          longitude: 34.7818,
        },
      ],
    },
  },
  "fixture-render_stats": {
    toolName: "render_stats",
    args: {
      title: "Launch metrics",
      description: "Illustrative execution metrics",
      stats: [
        {
          key: "sessions",
          label: "Sessions",
          value: 1284,
          format: { kind: "number", compact: true },
          diff: { value: 12.5, label: "vs. last week" },
          sparkline: { data: [880, 940, 1012, 1090, 1160, 1284] },
        },
        {
          key: "completion",
          label: "Completion",
          value: 0.74,
          format: { kind: "percent", decimals: 0 },
          diff: { value: 4.1 },
        },
      ],
    },
  },
  "fixture-present_artifact-pdf": artifactCall("pdf", "application/pdf"),
  "fixture-present_artifact-png": artifactCall("png", "image/png"),
  "fixture-present_artifact-html": artifactCall("html", "text/html"),
  "fixture-present_artifact-audio": artifactCall("audio", "audio/mpeg"),
  "fixture-present_artifact-video": artifactCall("video", "video/mp4"),
}

/** What the real server answers a presentation call with, in short. */
export const FIXTURE_PRESENTATION_RESULT = { ok: true } as const

export function fixturePresentationCall(
  toolCallId: string
): FixturePresentationCall | undefined {
  return Object.hasOwn(fixturePresentationCalls, toolCallId)
    ? fixturePresentationCalls[toolCallId as FixturePresentationCallId]
    : undefined
}

/** A settled presentation call, flagged for its App view. */
export function fixturePresentationPart(
  toolCallId: FixturePresentationCallId
): ToolCallPart {
  const { toolName, args, result } = fixturePresentationCalls[toolCallId]
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result: result ?? FIXTURE_PRESENTATION_RESULT,
    artifact: MCP_APP_TOOL_ARTIFACT,
  }
}
