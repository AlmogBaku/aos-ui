import { z } from "zod"

/**
 * What a tool call carries beyond its args and result, on assistant-ui's
 * `ToolCallMessagePart.artifact` as `{ aos: AosToolArtifact }`. The shapes
 * follow ACP v2 tool-call content: a kind, the locations it touched, diffs,
 * embedded terminals, and subagent metadata.
 */

const toolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
])

const locationSchema = z.object({
  path: z.string(),
  line: z.number().optional(),
})

const diffChangeSchema = z.object({
  kind: z.enum(["add", "delete", "modify", "move", "copy"]),
  path: z.string(),
  oldPath: z.string().optional(),
})

const diffSchema = z.object({
  changes: z.array(diffChangeSchema),
  /** Git patch text. */
  patch: z.string().optional(),
})

const terminalSchema = z.object({
  terminalId: z.string(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  output: z.string(),
  running: z.boolean(),
  exitCode: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
})

const subagentSchema = z.object({
  id: z.string(),
  goal: z.string().optional(),
  model: z.string().optional(),
  depth: z.number().optional(),
  status: z.string().optional(),
  tokens: z.number().optional(),
  filesRead: z.array(z.string()).optional(),
  filesWritten: z.array(z.string()).optional(),
  durationMs: z.number().optional(),
  childSessionId: z.string().optional(),
})

const toolArtifactSchema = z.object({
  kind: toolKindSchema.optional(),
  locations: z.array(locationSchema).optional(),
  diffs: z.array(diffSchema).optional(),
  terminals: z.array(terminalSchema).optional(),
  subagent: subagentSchema.optional(),
})

export type AosToolKind = z.infer<typeof toolKindSchema>
export type AosToolLocation = z.infer<typeof locationSchema>
export type AosDiffChange = z.infer<typeof diffChangeSchema>
export type AosDiff = z.infer<typeof diffSchema>
export type AosTerminal = z.infer<typeof terminalSchema>
export type AosSubagent = z.infer<typeof subagentSchema>
export type AosToolArtifact = z.infer<typeof toolArtifactSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The validated `aos` entry of a tool-call artifact, or nothing. */
export function readAosToolArtifact(
  artifact: unknown
): AosToolArtifact | undefined {
  if (!isRecord(artifact)) return undefined
  const parsed = toolArtifactSchema.safeParse(artifact.aos)
  return parsed.success ? parsed.data : undefined
}

/**
 * Merges `patch` into the artifact's `aos` entry field by field; a field in
 * `patch` replaces the previous one. Other artifact keys are preserved.
 */
export function withAosToolArtifact(
  artifact: unknown,
  patch: AosToolArtifact
): Record<string, unknown> & { aos: AosToolArtifact } {
  const base = isRecord(artifact) ? artifact : {}
  return { ...base, aos: { ...readAosToolArtifact(base), ...patch } }
}

export type AosDiffStats = {
  files: number
  additions: number
  deletions: number
}

/** Changed files and the +/− line counts of every patch. */
export function diffStats(diffs: readonly AosDiff[]): AosDiffStats {
  const stats: AosDiffStats = { files: 0, additions: 0, deletions: 0 }
  for (const diff of diffs) {
    stats.files += diff.changes.length
    for (const line of diff.patch?.split("\n") ?? []) {
      if (line.startsWith("+") && !line.startsWith("+++")) stats.additions++
      else if (line.startsWith("-") && !line.startsWith("---"))
        stats.deletions++
    }
  }
  return stats
}
