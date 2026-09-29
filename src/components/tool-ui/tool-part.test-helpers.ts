import { vi } from "vitest"

import { withAosToolArtifact, type AosToolArtifact } from "@/lib/tool-artifact"
import type { RichToolPart } from "./types"

/** A completed tool call named `toolName`, optionally carrying an AOS artifact. */
export function toolPart(
  overrides: Partial<RichToolPart> & Pick<RichToolPart, "toolName">,
  artifact?: AosToolArtifact
): RichToolPart {
  const args = overrides.args ?? {}
  return {
    type: "tool-call",
    toolCallId: `test-${overrides.toolName}`,
    args,
    argsText: JSON.stringify(args),
    status: { type: "complete" },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn().mockResolvedValue(undefined),
    ...(artifact ? { artifact: withAosToolArtifact(undefined, artifact) } : {}),
    ...overrides,
  }
}
