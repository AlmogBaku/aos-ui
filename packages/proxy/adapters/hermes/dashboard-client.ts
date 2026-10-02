import type { SessionPatch } from "../../core/runtime"

export type HermesDashboardHttp = (
  path: string,
  init?: { method?: string; body?: unknown; maxResponseBytes?: number }
) => Promise<unknown>

export type HermesNativeSessionPage = {
  sessions: unknown[]
  total?: unknown
  [key: string]: unknown
}

export type HermesNativeSession = Record<string, unknown>

export type HermesNativeMessagePage = {
  session_id: unknown
  messages: unknown[]
  pagination?: unknown
  [key: string]: unknown
}

/** Thin server-side wrapper for the Hermes dashboard HTTP routes AOS uses. */
export class HermesDashboardClient {
  constructor(private readonly http: HermesDashboardHttp) {}

  listSessions(profile: string, limit: number, offset: number) {
    const query = new URLSearchParams({
      profile,
      limit: String(limit),
      offset: String(offset),
      order: "recent",
      archived: "include",
      exclude_sources: "cron,tool,kanban",
    })
    return this.http(
      `/api/sessions?${query}`
    ) as Promise<HermesNativeSessionPage>
  }

  getSession(profile: string, storedId: string) {
    return this.http(
      `/api/sessions/${encodeURIComponent(storedId)}?profile=${encodeURIComponent(profile)}`
    ) as Promise<HermesNativeSession>
  }

  getSessionMessages(
    profile: string,
    storedId: string,
    limit: number,
    offset: number
  ) {
    const query = new URLSearchParams({
      profile,
      limit: String(limit),
      offset: String(offset),
      order: "latest",
      include_compacted: "true",
    })
    return this.http(
      `/api/sessions/${encodeURIComponent(storedId)}/messages?${query}`
    ) as Promise<HermesNativeMessagePage>
  }

  updateSession(profile: string, storedId: string, patch: SessionPatch) {
    return this.mutateSession(profile, storedId, "PATCH", {
      ...patch,
      profile,
    })
  }

  deleteSession(profile: string, storedId: string) {
    return this.mutateSession(profile, storedId, "DELETE")
  }

  readArtifactDataUrl(
    profile: string,
    storedId: string,
    path: string,
    maxResponseBytes: number
  ) {
    const query = new URLSearchParams({
      path,
      profile,
      session_id: storedId,
    })
    return this.http(`/api/fs/read-data-url?${query}`, { maxResponseBytes })
  }

  getAudioConfig(
    profile: string,
    kind: "stt" | "tts",
    maxResponseBytes: number
  ) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/tools/toolsets/${kind}/config?${query}`, {
      maxResponseBytes,
    })
  }

  transcribe(
    profile: string,
    request: { data_url: string; mime_type: string },
    maxResponseBytes: number
  ) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/audio/transcribe?${query}`, {
      method: "POST",
      body: request,
      maxResponseBytes,
    })
  }

  speak(profile: string, text: string, maxResponseBytes: number) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/audio/speak?${query}`, {
      method: "POST",
      body: { text },
      maxResponseBytes,
    })
  }

  /** The profile's configured MCP servers, credentials redacted by Hermes. */
  listMcpServers(profile: string) {
    const query = new URLSearchParams({ profile })
    return this.http(`/api/mcp/servers?${query}`)
  }

  /**
   * The live OAuth access token for `name`. Hermes stores it after a completed
   * OAuth flow and refreshes it automatically when it expires.
   *
   * Returns the raw JSON response for the caller to parse; throws
   * `HermesHttpError(404)` when no token is stored or the server is unknown.
   *
   * Hermes route: `GET /api/mcp/servers/{name}/token?profile={profile}`
   * Response: `{ "access_token": "<bearer>", "token_type": "Bearer" }`
   */
  getMcpOAuthToken(profile: string, name: string) {
    const query = new URLSearchParams({ profile })
    return this.http(
      `/api/mcp/servers/${encodeURIComponent(name)}/token?${query}`
    )
  }

  private mutateSession(
    profile: string,
    storedId: string,
    method: "PATCH" | "DELETE",
    body?: unknown
  ) {
    return this.http(
      `/api/sessions/${encodeURIComponent(storedId)}?profile=${encodeURIComponent(profile)}`,
      { method, body }
    )
  }
}
