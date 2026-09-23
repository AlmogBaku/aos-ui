import {
  readAosToolArtifact,
  withAosToolArtifact,
} from "@/components/tool-ui/tool-artifact"

/**
 * How a tool call that declares an MCP App view reaches the message surface:
 * the runtime sets `app` on the part's `artifact.aos`, which carries no view
 * data of its own. The view is fetched per tool call when it renders.
 */
export const MCP_APP_TOOL_ARTIFACT = withAosToolArtifact(undefined, { app: {} })

/**
 * The flag as a call progresses. A guest's call carries neither its arguments
 * nor its result, so `settled` is what tells it both are ready.
 */
export function mcpAppToolArtifact({
  input,
  settled,
  cancelled,
}: {
  input: boolean
  settled: boolean
  cancelled?: string
}) {
  return withAosToolArtifact(undefined, {
    app: {
      ...(input ? { input: true as const } : {}),
      ...(settled ? { settled: true as const } : {}),
      ...(cancelled === undefined ? {} : { cancelled }),
    },
  })
}

type AppToolPart = {
  readonly artifact?: unknown
  readonly result?: unknown
  readonly args?: Readonly<Record<string, unknown>>
}

function appOf(part: { readonly artifact?: unknown }) {
  return readAosToolArtifact(part.artifact)?.app
}

export function isMcpAppToolPart(part: { readonly artifact?: unknown }) {
  return appOf(part) !== undefined
}

/** The call has finished, whether or not its result reached this client. */
export function isSettledMcpAppToolPart(part: AppToolPart) {
  return part.result !== undefined || appOf(part)?.settled === true
}

/** The call's complete arguments, once this client holds them. */
export function mcpAppToolInput(part: AppToolPart) {
  return part.result !== undefined || appOf(part)?.input === true
    ? part.args
    : undefined
}

/**
 * Why the call ended without a result the view could show, or `undefined`
 * while it may still produce one.
 */
export function mcpAppToolCancellation(part: AppToolPart): string | undefined {
  return part.result === undefined ? appOf(part)?.cancelled : undefined
}
