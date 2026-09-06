export type WorkspaceSelection = {
  agentId: string | null
  sessionId: string | null
}

export function parseWorkspacePathname(
  pathname: string
): WorkspaceSelection | null {
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length > 2) return null

  try {
    return {
      agentId: segments[0] ? decodeURIComponent(segments[0]) : null,
      sessionId: segments[1] ? decodeURIComponent(segments[1]) : null,
    }
  } catch {
    return null
  }
}

export function buildWorkspacePathname({
  agentId,
  sessionId,
}: WorkspaceSelection): string {
  if (!agentId) return "/"
  const agentPath = `/${encodeURIComponent(agentId)}`
  return sessionId ? `${agentPath}/${encodeURIComponent(sessionId)}` : agentPath
}

export function workspaceHref(
  currentHref: string,
  selection: WorkspaceSelection
): string {
  const url = new URL(currentHref)
  url.pathname = buildWorkspacePathname(selection)
  return `${url.pathname}${url.search}${url.hash}`
}
