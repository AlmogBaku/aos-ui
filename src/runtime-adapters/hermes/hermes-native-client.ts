import type {
  AppendMessage,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react"

import { createBrowserId } from "@/lib/browser-id"
import { projectHermesArtifactReceipt } from "./hermes-artifacts"
import {
  HermesAttachmentStagingError,
  hermesImagePaths,
  stageHermesAttachments,
} from "./hermes-native-attachments"
import {
  readHermesContext,
  readHermesModels,
  type HermesComposerState,
} from "./hermes-composer-state"
import type { ComposerFeatureConfig } from "@shared/runtime-config"

import {
  AgentVisibilityUpdateError,
  type AgentVisibility,
  type ReadyAgentSummary,
  type SessionMetadata,
  type WorkspaceActivityEvent,
} from "../contracts"
import {
  absoluteUrl,
  canonicalHermesToolArgs,
  canonicalHermesToolName,
  decodeHermesThreadId,
  encodeHermesThreadId,
  isoTimestamp,
  isRecord,
  messageText,
  numberValue,
  projectHermesHistory,
  stringValue,
  websocketUrl,
  type JsonRecord,
} from "./hermes-native-codec"

export {
  decodeHermesThreadId,
  encodeHermesThreadId,
  projectHermesHistory,
} from "./hermes-native-codec"

export type HermesApproval = {
  threadId: string
  liveSessionId: string
  requestId: string
  message: string
  choices?: readonly HermesApprovalChoice[]
  allowPermanent?: boolean
}

export type HermesApprovalChoice = "once" | "session" | "always" | "deny"

export type HermesClarificationQuestion = {
  id?: string
  question: string
  choices: readonly string[] | null
  multiple: boolean
}

export type HermesClarification = {
  threadId: string
  liveSessionId: string
  requestId: string
  questions: readonly HermesClarificationQuestion[]
}

export type HermesSession = SessionMetadata & {
  profile: string
  storedSessionId: string
  title: string
  archived: boolean
  messages: readonly ThreadMessageLike[]
  running: boolean
  loading: boolean
  liveSessionId?: string
  approval?: HermesApproval
  composer?: HermesComposerState
  clarification?: HermesClarification
}

export type HermesNativeSnapshot = {
  agents: readonly ReadyAgentSummary[]
  sessions: readonly HermesSession[]
  revision: number
}

type RpcPending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type GatewayEvent = {
  type: string
  session_id?: string
  seq?: number
  payload?: unknown
}

type ProfileUiMetadata = {
  uiMeta: JsonRecord
  revisions: JsonRecord
}

type StagedTurn = {
  liveSessionId: string
  cleanup: (liveSessionId?: string) => Promise<void>
  settled: boolean
  cleanupRequired: boolean
  historyRequired: boolean
  idleConfirmation?: Promise<void>
}

export type HermesWebSocket = Pick<
  WebSocket,
  "readyState" | "send" | "close" | "addEventListener" | "removeEventListener"
>

export type HermesNativeClientOptions = {
  baseUrl: string
  fetcher?: typeof fetch
  socketFactory?: (url: string, protocols: string[]) => HermesWebSocket
  pollIntervalMs?: number
  reconnectDelayMs?: number
}

const WS_OPEN = 1
const SESSION_PAGE_SIZE = 100
const SESSION_FANOUT = 4

/** Desktop's activity windows: chat recency and native worker heartbeats. */
function profileActivity(raw: JsonRecord, now = Date.now()): "active" | "idle" {
  const recent = (value: unknown, windowSeconds: number) => {
    const timestamp = isRecord(value)
      ? numberValue(value.last_active)
      : undefined
    if (!timestamp || timestamp <= 0) return false
    const age = now / 1000 - timestamp
    return age >= 0 && age < windowSeconds
  }
  return recent(raw.last_session, 90) ||
    recent(raw.canonical_session, 90) ||
    recent(raw.worker_session, 150)
    ? "active"
    : "idle"
}

function liveSessionStatus(value: unknown): SessionMetadata["status"] {
  if (value === "waiting") return "waiting-for-input"
  if (value === "working" || value === "starting") return "running"
  if (value === "idle") return "idle"
  return "unknown"
}

export class HermesNativeClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #socketFactory: (url: string, protocols: string[]) => HermesWebSocket
  readonly #pollIntervalMs: number
  readonly #reconnectDelayMs: number
  readonly #listeners = new Set<() => void>()
  readonly #catalogListeners = new Set<() => void>()
  readonly #errors = new Set<(error: Error) => void>()
  readonly #recoveryListeners = new Set<() => void>()
  readonly #connectionListeners = new Set<() => void>()
  readonly #activityListeners = new Set<
    (event: WorkspaceActivityEvent) => void
  >()
  readonly #pending = new Map<string, RpcPending>()
  readonly #liveToThread = new Map<string, string>()
  readonly #watermarks = new Map<string, number>()
  readonly #profileUiMetadata = new Map<string, ProfileUiMetadata>()
  readonly #modelChanges = new Map<string, Promise<void>>()
  readonly #modelRevisions = new Map<string, number>()
  readonly #composerConfigs = new Map<string, ComposerFeatureConfig>()
  readonly #contextRevisions = new Map<string, number>()
  readonly #pendingSends = new Set<string>()
  readonly #stagedTurns = new Map<string, StagedTurn>()
  readonly #turnRecoveries = new Map<string, Promise<void>>()
  readonly #activeLifecycles = new Map<string, string>()
  #socket?: HermesWebSocket
  #socketGeneration = 0
  #authRejected = false
  #authRevision = 0
  #nextRequestId = 0
  #started = false
  #startPromise?: Promise<void>
  #stopped = false
  #catalogTimer?: ReturnType<typeof setInterval>
  #reconnectTimer?: ReturnType<typeof setTimeout>
  #releaseTimer?: ReturnType<typeof setTimeout>
  #retainers = 0
  #epoch?: string
  #catalogPromise?: Promise<void>
  #catalogSignature?: string
  #snapshot: HermesNativeSnapshot = { agents: [], sessions: [], revision: 0 }

  constructor({
    baseUrl,
    fetcher = globalThis.fetch.bind(globalThis),
    socketFactory = (url, protocols) => new WebSocket(url, protocols),
    pollIntervalMs = 5_000,
    reconnectDelayMs = 1_000,
  }: HermesNativeClientOptions) {
    this.#baseUrl = baseUrl
    this.#fetch = fetcher
    this.#socketFactory = socketFactory
    this.#pollIntervalMs = pollIntervalMs
    this.#reconnectDelayMs = reconnectDelayMs
  }

  getSnapshot = () => this.#snapshot

  get isConnected() {
    return (
      !this.#stopped &&
      !this.#authRejected &&
      this.#socket?.readyState === WS_OPEN
    )
  }

  subscribeConnection = (listener: () => void) => {
    this.#connectionListeners.add(listener)
    return () => this.#connectionListeners.delete(listener)
  }

  #connectionChanged() {
    for (const listener of this.#connectionListeners) listener()
  }

  #authenticationRejected() {
    this.#authRejected = true
    this.#authRevision += 1
    this.#connectionChanged()
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  subscribeCatalog(listener: () => void, onError?: (error: Error) => void) {
    this.#catalogListeners.add(listener)
    if (onError) this.#errors.add(onError)
    return () => {
      this.#catalogListeners.delete(listener)
      if (onError) this.#errors.delete(onError)
    }
  }

  subscribeRecovery(listener: () => void) {
    this.#recoveryListeners.add(listener)
    return () => {
      this.#recoveryListeners.delete(listener)
    }
  }

  subscribeActivity(
    listener: (event: WorkspaceActivityEvent) => void,
    onError?: (error: Error) => void
  ) {
    this.#activityListeners.add(listener)
    if (onError) this.#errors.add(onError)
    return () => {
      this.#activityListeners.delete(listener)
      if (onError) this.#errors.delete(onError)
    }
  }

  retain() {
    this.#retainers += 1
    if (this.#releaseTimer) clearTimeout(this.#releaseTimer)
    this.#releaseTimer = undefined
    return () => {
      this.#retainers = Math.max(0, this.#retainers - 1)
      if (this.#retainers > 0) return
      this.#releaseTimer = setTimeout(() => {
        this.#releaseTimer = undefined
        if (this.#retainers === 0) this.stop()
      }, 0)
    }
  }

  async start() {
    if (this.#startPromise) return this.#startPromise
    if (this.#started) return
    this.#started = true
    this.#stopped = false
    this.#startPromise = (async () => {
      try {
        await this.#connect()
        await this.refreshCatalog()
        for (const listener of this.#recoveryListeners) listener()
        this.#catalogTimer = setInterval(() => {
          if (
            typeof document !== "undefined" &&
            document.visibilityState === "hidden"
          )
            return
          void this.refreshCatalog().catch((reason) => this.#report(reason))
        }, this.#pollIntervalMs)
        if (typeof window !== "undefined")
          window.addEventListener("focus", this.#onFocus)
        if (typeof document !== "undefined")
          document.addEventListener("visibilitychange", this.#onVisibility)
      } catch (reason) {
        this.#started = false
        this.#stopped = true
        this.#socketGeneration += 1
        this.#socket?.close()
        this.#socket = undefined
        throw reason
      } finally {
        this.#startPromise = undefined
      }
    })()
    return this.#startPromise
  }

  stop() {
    this.#stopped = true
    this.#started = false
    this.#startPromise = undefined
    if (this.#catalogTimer) clearInterval(this.#catalogTimer)
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    if (this.#releaseTimer) clearTimeout(this.#releaseTimer)
    this.#catalogTimer = undefined
    this.#reconnectTimer = undefined
    this.#releaseTimer = undefined
    if (typeof window !== "undefined")
      window.removeEventListener("focus", this.#onFocus)
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.#onVisibility)
    this.#socket?.close()
    this.#socket = undefined
    this.#connectionChanged()
    this.#rejectPending(new Error("Hermes connection closed"))
  }

  readonly #onFocus = () => {
    void this.refreshCatalog().catch((reason) => this.#report(reason))
  }

  readonly #onVisibility = () => {
    if (document.visibilityState === "visible") this.#onFocus()
  }

  async #connect() {
    const response = await this.#fetch(
      absoluteUrl(this.#baseUrl, "/api/auth/ws-ticket"),
      {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json" },
      }
    )
    if (!response.ok)
      throw new Error(`Hermes authentication failed (${response.status})`)
    const ticketPayload: unknown = await response.json()
    const ticket = isRecord(ticketPayload) && stringValue(ticketPayload.ticket)
    if (!ticket) throw new Error("Hermes returned an invalid WebSocket ticket")

    const generation = ++this.#socketGeneration
    const socket = this.#socketFactory(websocketUrl(this.#baseUrl), [
      "hermes-gateway-v1",
      `hermes-gateway-ticket.${ticket}`,
    ])
    this.#socket = socket
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error("Hermes WebSocket connection failed"))
      }
      const cleanup = () => {
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("error", onError)
      }
      socket.addEventListener("open", onOpen)
      socket.addEventListener("error", onError)
    })
    this.#authRejected = false
    this.#connectionChanged()
    socket.addEventListener("message", (event) => {
      if (generation !== this.#socketGeneration) return
      this.#onMessage((event as MessageEvent).data)
    })
    socket.addEventListener("error", () => {
      if (generation === this.#socketGeneration && !this.#stopped)
        this.#connectionChanged()
    })
    socket.addEventListener("close", () => {
      if (generation !== this.#socketGeneration || this.#stopped) return
      this.#socket = undefined
      this.#connectionChanged()
      this.#rejectPending(new Error("Hermes WebSocket disconnected"))
      this.#invalidateActivity()
      this.#scheduleReconnect()
    })
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer) return
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.#reconnect().catch((reason) => {
        this.#report(reason)
        this.#scheduleReconnect()
      })
    }, this.#reconnectDelayMs)
  }

  async #reconnect() {
    if (this.#stopped) return
    await this.#connect()
    await this.#replayEvents()
    const attached = this.#snapshot.sessions.filter(
      (session) => session.liveSessionId
    )
    for (const session of attached) await this.attach(session.threadId)
    await this.refreshCatalog()
    for (const listener of this.#recoveryListeners) listener()
  }

  request<T>(method: string, params: JsonRecord = {}, timeoutMs = 120_000) {
    const socket = this.#socket
    if (!socket || socket.readyState !== WS_OPEN)
      return Promise.reject(new Error("Hermes WebSocket is not connected"))
    const id = `aos-${++this.#nextRequestId}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Hermes request timed out: ${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      } catch (reason) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }
    })
  }

  async refreshCatalog() {
    if (this.#catalogPromise) return this.#catalogPromise
    const authRevision = this.#authRevision
    const request = this.#refreshCatalog()
    this.#catalogPromise = request
    try {
      await request
      if (this.#authRejected && authRevision === this.#authRevision) {
        this.#authRejected = false
        this.#connectionChanged()
      }
    } catch (reason) {
      this.#invalidateActivity()
      throw reason
    } finally {
      if (this.#catalogPromise === request) this.#catalogPromise = undefined
    }
  }

  #invalidateActivity() {
    if (this.#snapshot.agents.every((agent) => agent.activity === "unknown"))
      return
    this.#catalogSignature = ""
    this.#setSnapshot({
      agents: this.#snapshot.agents.map((agent) => ({
        ...agent,
        activity: "unknown",
      })),
    })
    for (const listener of this.#catalogListeners) listener()
  }

  async #refreshCatalog() {
    const before = new Map(
      this.#snapshot.sessions.map((session) => [session.threadId, session])
    )
    const profileResult = await this.request<unknown>("profiles.list", {
      include_sessions: true,
    })
    if (!isRecord(profileResult) || !Array.isArray(profileResult.profiles))
      throw new Error("Hermes returned an invalid profile catalog")
    const profileUiMetadata = new Map<string, ProfileUiMetadata>()
    const agents = profileResult.profiles.map((raw): ReadyAgentSummary => {
      if (!isRecord(raw)) throw new Error("Hermes returned an invalid profile")
      const id = stringValue(raw.name)
      if (!id) throw new Error("Hermes profile is missing its canonical name")
      const uiMeta = isRecord(raw.ui_meta) ? raw.ui_meta : {}
      const bots = isRecord(uiMeta["hermes-bots"])
        ? (uiMeta["hermes-bots"] as JsonRecord)
        : {}
      const aos = isRecord(uiMeta.aos) ? uiMeta.aos : {}
      profileUiMetadata.set(id, {
        uiMeta,
        revisions: isRecord(raw.ui_meta_revisions) ? raw.ui_meta_revisions : {},
      })
      return {
        kind: "ready",
        id,
        name: stringValue(raw.display_name) ?? id,
        activity: profileActivity(raw),
        ...(stringValue(raw.description)
          ? { description: stringValue(raw.description) }
          : {}),
        visibility: bots.hidden === true ? "hidden" : "visible",
        ...(aos.role === "creator" ? { role: "creator" as const } : {}),
      }
    })
    if (new Set(agents.map(({ id }) => id)).size !== agents.length)
      throw new Error("Hermes returned duplicate canonical profile names")
    const sessions = await this.#listAllSessions(agents.map(({ id }) => id))
    let live: Map<string, unknown> | undefined
    if ([...before.values()].some((session) => session.liveSessionId)) {
      try {
        const result = await this.request<unknown>("session.active_list")
        if (!isRecord(result) || !Array.isArray(result.sessions))
          throw new Error("Hermes returned invalid live Session statuses")
        live = new Map()
        for (const row of result.sessions) {
          if (!isRecord(row) || !stringValue(row.id))
            throw new Error("Hermes returned invalid live Session status")
          live.set(String(row.id), row.status)
        }
      } catch (reason) {
        live = undefined
        this.#report(reason)
      }
      if (!live) {
        const affected = new Set(
          [...before.values()]
            .filter((session) => session.liveSessionId)
            .map((session) => session.agentId)
        )
        for (const agent of agents)
          if (affected.has(agent.id)) agent.activity = "unknown"
      }
    }
    const catalogSignature = JSON.stringify({
      agents,
      profiles: [...profileUiMetadata],
      sessions: sessions.map(
        ({
          threadId,
          agentId,
          profile,
          storedSessionId,
          title,
          updatedAt,
          status,
          archived,
        }) => ({
          threadId,
          agentId,
          profile,
          storedSessionId,
          title,
          updatedAt,
          status,
          archived,
        })
      ),
    })
    const previous = new Map(
      this.#snapshot.sessions.map((item) => [item.threadId, item])
    )
    const merged = sessions.map((session) => {
      const old = previous.get(session.threadId)
      if (!old) return session
      // Live events received during discovery take precedence over the poll.
      const unchanged = old === before.get(session.threadId)
      const status = !unchanged
        ? old.status
        : old.approval || old.clarification
          ? "waiting-for-input"
          : old.liveSessionId
            ? liveSessionStatus(live?.get(old.liveSessionId))
            : session.status
      return {
        ...session,
        messages: old.messages,
        running: status === "running" || status === "waiting-for-input",
        loading: old.loading,
        status,
        ...(old.approval ? { approval: old.approval } : {}),
        ...(old.clarification ? { clarification: old.clarification } : {}),
        ...(old.composer ? { composer: old.composer } : {}),
        ...(old.liveSessionId ? { liveSessionId: old.liveSessionId } : {}),
      }
    })
    for (const session of this.#snapshot.sessions) {
      if (
        !merged.some(({ threadId }) => threadId === session.threadId) &&
        session.liveSessionId
      )
        merged.push(session)
    }
    this.#profileUiMetadata.clear()
    for (const [profile, metadata] of profileUiMetadata)
      this.#profileUiMetadata.set(profile, metadata)
    const statusChanged = merged.some(
      (session) => session.status !== previous.get(session.threadId)?.status
    )
    if (catalogSignature === this.#catalogSignature) {
      if (statusChanged) this.#setSnapshot({ sessions: merged })
      return
    }
    this.#catalogSignature = catalogSignature
    this.#setSnapshot({ agents, sessions: merged })
    for (const listener of this.#catalogListeners) listener()
  }

  async updateProfileVisibility(profile: string, visibility: AgentVisibility) {
    await this.refreshCatalog()
    const agent = this.#snapshot.agents.find(({ id }) => id === profile)
    if (!agent) throw new Error(`Hermes profile not found: ${profile}`)
    if (agent.role === "creator")
      throw new Error("The Hermes creator profile cannot be managed")
    const described = await this.request<unknown>("profiles.describe", {
      name: profile,
    })
    if (!isRecord(described) || stringValue(described.name) !== profile)
      throw new Error("Hermes returned invalid profile editor data")
    const metadata = this.#profileUiMetadata.get(profile)
    if (!metadata) throw new Error("Hermes profile UI metadata is unavailable")
    const currentBots = isRecord(metadata.uiMeta["hermes-bots"])
      ? metadata.uiMeta["hermes-bots"]
      : {}
    const revision = numberValue(metadata.revisions["hermes-bots"]) ?? 0
    const result = await this.request<unknown>("profiles.configure", {
      name: profile,
      ui_meta: {
        "hermes-bots": {
          ...currentBots,
          hidden: visibility === "hidden",
        },
      },
      ui_meta_expected_revisions: { "hermes-bots": revision },
    })
    const applied =
      isRecord(result) && isRecord(result.applied) ? result.applied : undefined
    if (!applied || applied.ui_meta !== true) {
      if (applied && isRecord(applied.ui_meta_conflicts))
        throw new AgentVisibilityUpdateError(
          "pending-reload",
          "Hermes profile visibility changed elsewhere; reload and retry"
        )
      throw new Error("Hermes did not apply the profile visibility update")
    }
    await this.refreshCatalog()
  }

  async #listAllSessions(profiles: readonly string[]) {
    const output: HermesSession[] = []
    for (let start = 0; start < profiles.length; start += SESSION_FANOUT) {
      const pages = await Promise.all(
        profiles
          .slice(start, start + SESSION_FANOUT)
          .map((profile) => this.#listProfileSessions(profile))
      )
      output.push(...pages.flat())
    }
    return output
  }

  async #listProfileSessions(profile: string) {
    const output: HermesSession[] = []
    const seen = new Set<string>()
    let offset = 0
    while (true) {
      const query = new URLSearchParams({
        profile,
        limit: String(SESSION_PAGE_SIZE),
        offset: String(offset),
        order: "recent",
        archived: "include",
        exclude_sources: "cron,tool,kanban",
      })
      const response = await this.#fetch(
        absoluteUrl(this.#baseUrl, `/api/sessions?${query}`),
        { credentials: "include", headers: { accept: "application/json" } }
      )
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          this.#authenticationRejected()
        throw new Error(`Hermes Session catalog failed (${response.status})`)
      }
      const payload: unknown = await response.json()
      if (!isRecord(payload) || !Array.isArray(payload.sessions))
        throw new Error("Hermes returned invalid Session metadata")
      for (const raw of payload.sessions) {
        if (!isRecord(raw))
          throw new Error("Hermes returned invalid Session metadata")
        const storedSessionId = stringValue(raw.id)
        const owner = stringValue(raw.profile)
        if (!storedSessionId || owner !== profile)
          throw new Error("Hermes Session ownership mismatch")
        if (seen.has(storedSessionId))
          throw new Error(
            `Hermes returned a duplicate Session id for profile ${profile}`
          )
        seen.add(storedSessionId)
        output.push({
          threadId: encodeHermesThreadId(profile, storedSessionId),
          agentId: profile,
          profile,
          storedSessionId,
          title: stringValue(raw.title) ?? storedSessionId,
          archived: raw.archived === true,
          updatedAt: isoTimestamp(raw.last_active ?? raw.started_at),
          status:
            typeof raw.ended_at === "number" &&
            Number.isFinite(raw.ended_at) &&
            raw.ended_at > 0
              ? "idle"
              : "unknown",
          messages: [],
          running: false,
          loading: false,
        })
      }
      const total = numberValue(payload.total) ?? output.length
      offset += payload.sessions.length
      if (payload.sessions.length === 0 || offset >= total) break
    }
    return output
  }

  async createSession(profile: string, title: string) {
    const result = await this.request<unknown>("session.create", {
      profile,
      title,
      close_on_disconnect: false,
    })
    if (!isRecord(result))
      throw new Error("Hermes returned invalid Session creation data")
    const liveSessionId = stringValue(result.session_id)
    const storedSessionId = stringValue(result.stored_session_id)
    if (!liveSessionId || !storedSessionId)
      throw new Error("Hermes did not return both Session identities")
    const threadId = encodeHermesThreadId(profile, storedSessionId)
    this.#liveToThread.set(liveSessionId, threadId)
    const session: HermesSession & { liveSessionId: string } = {
      threadId,
      agentId: profile,
      profile,
      storedSessionId,
      liveSessionId,
      title,
      archived: false,
      updatedAt: new Date().toISOString(),
      status: "idle",
      messages: projectHermesHistory(
        Array.isArray(result.messages) ? result.messages : []
      ),
      running: false,
      loading: false,
    }
    this.#setSnapshot({ sessions: [...this.#snapshot.sessions, session] })
    return session
  }

  async renameSession(threadId: string, title: string) {
    if (!title.trim()) throw new Error("Hermes Session title cannot be empty")
    await this.#mutateStoredSession(threadId, "PATCH", { title: title.trim() })
    this.#patchSession(threadId, { title: title.trim() })
  }

  async archiveSession(threadId: string) {
    await this.#mutateStoredSession(threadId, "PATCH", { archived: true })
    this.#patchSession(threadId, { archived: true })
  }

  async unarchiveSession(threadId: string) {
    await this.#mutateStoredSession(threadId, "PATCH", { archived: false })
    this.#patchSession(threadId, { archived: false })
  }

  async deleteSession(threadId: string) {
    const session = this.#sessionForMutation(threadId)
    await this.#mutateStoredSession(threadId, "DELETE")
    if (session.liveSessionId) this.#liveToThread.delete(session.liveSessionId)
    this.#setSnapshot({
      sessions: this.#snapshot.sessions.filter(
        (item) => item.threadId !== threadId
      ),
    })
  }

  #sessionForMutation(threadId: string) {
    const identity = decodeHermesThreadId(threadId)
    const session = this.session(threadId)
    if (
      !identity ||
      !session ||
      identity.profile !== session.profile ||
      identity.storedSessionId !== session.storedSessionId
    )
      throw new Error(`Hermes Session not found: ${threadId}`)
    return session
  }

  async #mutateStoredSession(
    threadId: string,
    method: "PATCH" | "DELETE",
    body?: JsonRecord
  ) {
    const session = this.#sessionForMutation(threadId)
    const query = new URLSearchParams({ profile: session.profile })
    const response = await this.#fetch(
      absoluteUrl(
        this.#baseUrl,
        `/api/sessions/${encodeURIComponent(session.storedSessionId)}?${query}`
      ),
      {
        method,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }
    )
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        this.#authenticationRejected()
      throw new Error(
        `Hermes Session ${method.toLowerCase()} failed (${response.status})`
      )
    }
  }

  async loadHistory(threadId: string) {
    const identity = decodeHermesThreadId(threadId)
    if (!identity) throw new Error(`Invalid Hermes Session id: ${threadId}`)
    this.#patchSession(threadId, { loading: true })
    try {
      const messages: unknown[] = []
      const limit = 500
      for (let offset = 0; ; offset += limit) {
        const query = new URLSearchParams({
          profile: identity.profile,
          limit: String(limit),
          offset: String(offset),
          order: "oldest",
          include_compacted: "true",
        })
        const response = await this.#fetch(
          absoluteUrl(
            this.#baseUrl,
            `/api/sessions/${encodeURIComponent(identity.storedSessionId)}/messages?${query}`
          ),
          { credentials: "include", headers: { accept: "application/json" } }
        )
        if (!response.ok) {
          if (response.status === 401 || response.status === 403)
            this.#authenticationRejected()
          throw new Error(`Hermes history failed (${response.status})`)
        }
        const payload: unknown = await response.json()
        if (!isRecord(payload) || !Array.isArray(payload.messages))
          throw new Error("Hermes returned invalid Session history")
        messages.push(...payload.messages)
        const returned = isRecord(payload.pagination)
          ? (numberValue(payload.pagination.returned) ??
            payload.messages.length)
          : payload.messages.length
        if (returned < limit) break
      }
      const projected = projectHermesHistory(messages)
      this.#patchSession(threadId, {
        messages: projected,
        loading: false,
      })
      if (this.#composerConfigs.get(threadId)?.contextEnabled)
        void this.#refreshContext(threadId).catch((reason) =>
          this.#report(reason)
        )
    } catch (reason) {
      this.#patchSession(threadId, { loading: false })
      throw reason
    }
  }

  async attach(threadId: string) {
    const session = this.session(threadId)
    if (!session) throw new Error(`Hermes Session not found: ${threadId}`)
    const resumedTurn = this.#stagedTurns.get(threadId)
    const result = await this.request<unknown>("session.resume", {
      session_id: session.storedSessionId,
      profile: session.profile,
      omit_messages: true,
    })
    if (!isRecord(result))
      throw new Error("Hermes returned invalid resume data")
    const liveSessionId = stringValue(result.session_id)
    if (!liveSessionId)
      throw new Error("Hermes resume omitted its attachment id")
    const currentTurn = this.#stagedTurns.get(threadId)
    // An idle response requested for an older turn cannot retire a newer send.
    if (currentTurn && currentTurn !== resumedTurn)
      return currentTurn.liveSessionId
    if (session.liveSessionId) this.#liveToThread.delete(session.liveSessionId)
    this.#liveToThread.set(liveSessionId, threadId)
    const running = result.running === true
    const statusText = stringValue(result.status)
    const pendingApproval = isRecord(result.pending_approval)
      ? this.#approvalFrom(result.pending_approval, threadId, liveSessionId)
      : undefined
    const info = isRecord(result.info) ? result.info : undefined
    const selectedId =
      info && stringValue(info.provider) && stringValue(info.model)
        ? JSON.stringify([info.provider, info.model])
        : undefined
    const pendingClarification = isRecord(result.pending_clarify)
      ? this.#clarificationFrom(result.pending_clarify, threadId, liveSessionId)
      : undefined
    this.#patchSession(threadId, {
      liveSessionId,
      running,
      status:
        pendingApproval || pendingClarification
          ? "waiting-for-input"
          : running
            ? "running"
            : statusText === "idle"
              ? "idle"
              : "unknown",
      approval: pendingApproval,
      composer: {
        ...this.session(threadId)?.composer,
        ...(selectedId
          ? {
              model: {
                options: this.session(threadId)?.composer?.model?.options ?? [],
                selectedId,
              },
            }
          : {}),
        context: readHermesContext(info?.usage),
      },
      clarification: pendingClarification,
    })
    const turn = this.#stagedTurns.get(threadId)
    if (
      turn &&
      result.running === false &&
      !pendingApproval &&
      !pendingClarification
    ) {
      // Resume verifies ownership even if the gateway remints the live id.
      turn.liveSessionId = liveSessionId
      await this.#reconcileStagedTurn(threadId, turn, true)
    }
    return liveSessionId
  }

  async submit(threadId: string, message: AppendMessage) {
    return this.#submit(threadId, message)
  }

  async refreshComposer(threadId: string, config: ComposerFeatureConfig) {
    this.#composerConfigs.set(threadId, config)
    const session = this.session(threadId)
    if (!session?.liveSessionId) return
    const reads: Promise<void>[] = []
    if (config.modelSelectorEnabled) {
      reads.push(
        (async () => {
          const revision = this.#modelRevisions.get(threadId)
          const result = await this.request("model.options", {
            session_id: session.liveSessionId,
            profile: session.profile,
          })
          const model = readHermesModels(result)
          if (
            this.#modelRevisions.get(threadId) !== revision ||
            this.session(threadId)?.liveSessionId !== session.liveSessionId
          )
            return
          const current = this.session(threadId)?.composer
          this.#patchSession(threadId, {
            composer: {
              ...current,
              model: model
                ? {
                    ...model,
                    selectedId: current?.model?.selectedId ?? model.selectedId,
                  }
                : undefined,
            },
          })
        })()
      )
    }
    if (config.contextEnabled) reads.push(this.#refreshContext(threadId))
    const results = await Promise.allSettled(reads)
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  async #refreshContext(threadId: string) {
    const liveSessionId = this.session(threadId)?.liveSessionId
    if (!liveSessionId) return
    const revision = (this.#contextRevisions.get(threadId) ?? 0) + 1
    this.#contextRevisions.set(threadId, revision)
    this.#patchSession(threadId, {
      composer: { ...this.session(threadId)?.composer, context: undefined },
    })
    const result = await this.request("session.context_breakdown", {
      session_id: liveSessionId,
    })
    if (
      this.session(threadId)?.liveSessionId !== liveSessionId ||
      this.#contextRevisions.get(threadId) !== revision
    )
      return
    this.#patchSession(threadId, {
      composer: {
        ...this.session(threadId)?.composer,
        context: readHermesContext(result),
      },
    })
  }

  selectModel(threadId: string, id: string) {
    this.#modelRevisions.set(
      threadId,
      (this.#modelRevisions.get(threadId) ?? 0) + 1
    )
    const liveSessionId = this.session(threadId)?.liveSessionId
    const previous = this.#modelChanges.get(threadId) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          !liveSessionId ||
          this.session(threadId)?.liveSessionId !== liveSessionId
        )
          throw new Error(
            "Hermes Session changed before the model could be selected"
          )
        await this.#selectModel(threadId, id)
      })
    this.#modelChanges.set(threadId, operation)
    const release = () => {
      if (this.#modelChanges.get(threadId) === operation)
        this.#modelChanges.delete(threadId)
    }
    void operation.then(release, release)
    return operation
  }

  async #selectModel(threadId: string, id: string) {
    const session = this.session(threadId)
    const option = session?.composer?.model?.options.find(
      (item) => item.id === id
    )
    if (!session?.liveSessionId || !option)
      throw new Error("Hermes model is unavailable")
    const result = await this.request("config.set", {
      session_id: session.liveSessionId,
      key: "model",
      value: `${option.model} --provider ${option.provider} --session`,
    })
    if (
      !isRecord(result) ||
      result.key !== "model" ||
      result.scope !== "session" ||
      !stringValue(result.value)
    )
      throw new Error("Hermes did not confirm the Session model change")
    if (result.confirm_required === true)
      throw new Error(
        stringValue(result.confirm_message ?? result.warning) ??
          "Hermes requires confirmation for this model"
      )
    if (this.session(threadId)?.liveSessionId !== session.liveSessionId) return
    const current = this.session(threadId)?.composer
    if (current?.model)
      this.#patchSession(threadId, {
        composer: {
          ...current,
          model: {
            ...current.model,
            selectedId: JSON.stringify([option.provider, result.value]),
          },
        },
      })
    if (this.#composerConfigs.get(threadId)?.contextEnabled)
      await this.#refreshContext(threadId)
  }

  async edit(threadId: string, message: AppendMessage) {
    const session = this.session(threadId)
    if (!session || session.running)
      throw new Error("Hermes Session is unavailable for editing")
    const index = session.messages.findIndex(
      (item) => item.id === message.sourceId
    )
    const original = session.messages[index]
    if (index < 0 || !original?.id)
      throw new Error("The Hermes message is no longer available for editing")
    if (original.role !== "user")
      throw new Error("Hermes edits require a user message target")
    const row = /^hermes-row-(\d+)$/u.exec(original.id)
    if (!row && /^hermes-(?:history|user)-/u.test(original.id))
      throw new Error("Refresh Hermes history before editing this message")
    // References are the native durable attachment representation. A text edit
    // retains those references, even if a caller changes them in the draft.
    const references = /@(?:image|file):(?:`[^`]+`|"[^"]+"|'[^']+'|[^\s]+)/gu
    const originalText =
      typeof original.content === "string"
        ? original.content
        : original.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
    const text = [
      messageText(message).replace(references, "").trim(),
      ...(originalText.match(references) ?? []),
    ]
      .filter(Boolean)
      .join("\n")
    const images = Array.isArray(original.content)
      ? original.content.filter((part) => part.type === "image")
      : []
    await this.#submit(
      threadId,
      {
        ...message,
        content: [{ type: "text", text }, ...images],
        attachments: [],
      },
      {
        ...(row
          ? { truncate_before_row_id: Number(row[1]) }
          : { truncate_before_message_id: original.id }),
        confirm_truncate: true,
        ...(index === 0 ? { confirm_empty_truncate: true } : {}),
      },
      session.messages.slice(0, index),
      hermesImagePaths(originalText)
    )
  }

  async #submit(
    threadId: string,
    message: AppendMessage,
    truncate: JsonRecord = {},
    prefix?: readonly ThreadMessageLike[],
    preservedImagePaths: readonly string[] = []
  ) {
    if (this.#pendingSends.has(threadId))
      throw new Error("A Hermes send is already pending")
    this.#pendingSends.add(threadId)
    try {
      const turn = this.#stagedTurns.get(threadId)
      if (turn) {
        if (!turn.settled) await turn.idleConfirmation
        if (this.#stagedTurns.get(threadId) === turn) {
          if (!turn.settled)
            throw new Error("The previous Hermes turn is still pending")
          await this.#reconcileStagedTurn(threadId, turn)
        }
      }
      await this.#submitTurn(
        threadId,
        message,
        truncate,
        prefix,
        preservedImagePaths
      )
    } finally {
      this.#pendingSends.delete(threadId)
    }
  }

  async #submitTurn(
    threadId: string,
    message: AppendMessage,
    truncate: JsonRecord,
    prefix?: readonly ThreadMessageLike[],
    preservedImagePaths: readonly string[] = []
  ) {
    let text = messageText(message)
    const session = this.session(threadId)
    if (!session) throw new Error(`Hermes Session not found: ${threadId}`)
    const liveSessionId = session.liveSessionId ?? (await this.attach(threadId))
    const { images, references, cleanup } = await stageHermesAttachments(
      message,
      liveSessionId,
      (method, params) => this.request(method, params),
      preservedImagePaths
    ).catch(async (reason: unknown) => {
      if (!(reason instanceof HermesAttachmentStagingError)) throw reason
      const turn: StagedTurn = {
        liveSessionId,
        cleanup: reason.cleanup,
        settled: true,
        cleanupRequired: true,
        historyRequired: false,
      }
      this.#stagedTurns.set(threadId, turn)
      try {
        await this.#reconcileStagedTurn(threadId, turn)
      } catch (cleanupFailure) {
        throw new Error(
          `${reason.message}; staged images could not be detached: ${String(cleanupFailure)}`,
          { cause: reason.cause }
        )
      }
      throw reason.cause
    })
    text = [text, ...references].filter(Boolean).join("\n")
    if (!text && !images.length)
      throw new Error("Hermes requires text or an attachment")
    const optimisticUser: ThreadMessageLike = {
      id: `hermes-user-${createBrowserId()}`,
      role: "user",
      content: images.length ? [{ type: "text", text }, ...images] : text,
      createdAt: new Date(),
    }
    const turn: StagedTurn = {
      liveSessionId,
      cleanup,
      settled: false,
      cleanupRequired: false,
      historyRequired: false,
    }
    this.#stagedTurns.set(threadId, turn)
    this.#patchSession(threadId, {
      messages: [
        ...(prefix ?? this.session(threadId)!.messages),
        optimisticUser,
      ],
      running: true,
      status: "running",
      approval: undefined,
      clarification: undefined,
    })
    // Hermes appends directives for staged paths to durable history itself.
    // Keep the original display projection, but avoid duplicating its refs.
    const caption = preservedImagePaths.length
      ? text
          .replace(
            /@image:(?:`[^`]+`|"[^"]+"|'[^']+'|[^\s]+)/gu,
            (reference) =>
              hermesImagePaths(reference).some((path) =>
                preservedImagePaths.includes(path)
              )
                ? ""
                : reference
          )
          .trim()
      : text
    try {
      await this.request("prompt.submit", {
        session_id: liveSessionId,
        text: caption,
        ...truncate,
      })
    } catch (reason) {
      if (turn.settled) throw reason
      this.#patchSession(threadId, { running: false, status: "unknown" })
      try {
        await this.#reconcileStagedTurn(threadId, turn, true)
      } catch {
        throw new Error(
          `${reason instanceof Error ? reason.message : String(reason)}; Hermes attachment or history recovery failed`
        )
      }
      throw reason
    }
  }

  #confirmIdleTurn(threadId: string, turn: StagedTurn) {
    if (turn.settled) return this.#reconcileStagedTurn(threadId, turn)
    if (turn.idleConfirmation) return turn.idleConfirmation
    const liveSessionId = turn.liveSessionId
    const generation = this.#socketGeneration
    const operation = this.request<unknown>("session.active_list").then(
      async (result) => {
        if (
          this.#stagedTurns.get(threadId) !== turn ||
          turn.liveSessionId !== liveSessionId ||
          this.session(threadId)?.liveSessionId !== liveSessionId ||
          this.#socketGeneration !== generation
        )
          return
        if (!isRecord(result) || !Array.isArray(result.sessions))
          throw new Error("Hermes returned invalid live Session statuses")
        for (const row of result.sessions)
          if (!isRecord(row) || !stringValue(row.id))
            throw new Error("Hermes returned invalid live Session status")
        const live = result.sessions.find(
          (row) => isRecord(row) && row.id === liveSessionId
        )
        if (!isRecord(live) || liveSessionStatus(live.status) !== "idle") return
        const recovery = this.#reconcileStagedTurn(threadId, turn, true)
        this.#patchSession(threadId, { running: false, status: "idle" })
        await recovery
      }
    )
    turn.idleConfirmation = operation
    const clear = () => {
      if (turn.idleConfirmation === operation) turn.idleConfirmation = undefined
    }
    void operation.then(clear, clear)
    return operation
  }

  #reconcileStagedTurn(threadId: string, turn: StagedTurn, failed?: boolean) {
    if (this.#stagedTurns.get(threadId) !== turn) return Promise.resolve()
    if (!turn.settled && failed !== undefined) {
      turn.settled = true
      turn.cleanupRequired = failed
      turn.historyRequired = true
    }
    const pending = this.#turnRecoveries.get(threadId)
    if (pending) return pending
    const operation = (async () => {
      if (turn.cleanupRequired) {
        await turn.cleanup(turn.liveSessionId)
        turn.cleanupRequired = false
      }
      if (turn.historyRequired) {
        await this.loadHistory(threadId)
        turn.historyRequired = false
      }
      if (this.#stagedTurns.get(threadId) === turn)
        this.#stagedTurns.delete(threadId)
    })()
    this.#turnRecoveries.set(threadId, operation)
    const clear = () => {
      if (this.#turnRecoveries.get(threadId) === operation)
        this.#turnRecoveries.delete(threadId)
    }
    // Keep recovery intent on the turn, never a permanently rejected promise.
    void operation.then(clear, clear)
    return operation
  }

  async regenerate(threadId: string, parentId: string) {
    const target = this.#editableUserMessage(threadId, parentId)
    const text =
      typeof target.message.content === "string"
        ? target.message.content.trim()
        : Array.isArray(target.message.content)
          ? target.message.content
              .filter((part) => part.type === "text")
              .map((part) => String(part.text ?? ""))
              .join("\n")
              .trim()
          : ""
    if (!text) throw new Error("Hermes cannot regenerate an empty user message")
    await this.edit(threadId, {
      role: "user",
      content: [{ type: "text", text }],
      sourceId: parentId,
      parentId: null,
      attachments: [],
      createdAt: new Date(),
      metadata: { custom: {} },
      runConfig: undefined,
    })
  }

  async editMessage(threadId: string, sourceId: string, text: string) {
    const nextText = text.trim()
    if (!nextText) throw new Error("Hermes edited messages require text")
    await this.edit(threadId, {
      role: "user",
      content: [{ type: "text", text: nextText }],
      sourceId,
      parentId: null,
      attachments: [],
      createdAt: new Date(),
      metadata: { custom: {} },
      runConfig: undefined,
    })
  }

  #editableUserMessage(threadId: string, messageId: string) {
    if (messageId.startsWith("hermes-history-"))
      throw new Error("Hermes edits require a stable native message target")
    const session = this.session(threadId)
    const index =
      session?.messages.findIndex(({ id }) => id === messageId) ?? -1
    const message = index >= 0 ? session?.messages[index] : undefined
    if (!session || !message)
      throw new Error("Hermes message target is missing")
    if (message.role !== "user")
      throw new Error("Hermes edits require a user message target")
    return { session, message, id: messageId, index }
  }

  async stopRun(threadId: string) {
    const session = this.session(threadId)
    if (!session?.liveSessionId || !session.running) return
    await this.request("session.interrupt", {
      session_id: session.liveSessionId,
    })
    this.#patchSession(threadId, { running: false, status: "idle" })
  }

  async answerApproval(
    threadId: string,
    requestId: string,
    choice: HermesApprovalChoice
  ) {
    const session = this.session(threadId)
    const approval = session?.approval
    if (
      !session ||
      !approval ||
      approval.threadId !== threadId ||
      approval.requestId !== requestId ||
      approval.liveSessionId !== session.liveSessionId
    )
      throw new Error("This Hermes approval request is no longer current")
    if (!(approval.choices ?? ["once", "deny"]).includes(choice))
      throw new Error("This Hermes approval choice is not available")
    await this.request("approval.respond", {
      session_id: approval.liveSessionId,
      request_id: requestId,
      choice,
    })
    if (this.session(threadId)?.approval === approval)
      this.#patchSession(threadId, {
        approval: undefined,
        status: session.clarification ? "waiting-for-input" : "running",
      })
    this.#publishAttentionResolved(session, requestId)
  }

  async answerClarification(
    threadId: string,
    requestId: string,
    answers: readonly (readonly string[])[]
  ) {
    const session = this.session(threadId)
    const clarification = session?.clarification
    if (
      !session ||
      !clarification ||
      clarification.threadId !== threadId ||
      clarification.requestId !== requestId ||
      clarification.liveSessionId !== session.liveSessionId ||
      answers.length !== clarification.questions.length
    )
      throw new Error("This Hermes clarification request is no longer current")

    for (const [index, question] of clarification.questions.entries()) {
      const answer = answers[index] ?? []
      await this.request("clarify.respond", {
        session_id: clarification.liveSessionId,
        request_id: requestId,
        ...(question.id ? { question_id: question.id } : {}),
        answer: question.multiple ? JSON.stringify(answer) : (answer[0] ?? ""),
      })
    }
    if (this.session(threadId)?.clarification === clarification)
      this.#patchSession(threadId, {
        clarification: undefined,
        status: session.approval ? "waiting-for-input" : "running",
      })
    this.#publishAttentionResolved(session, requestId)
  }

  async rejectClarification(threadId: string, requestId: string) {
    const session = this.session(threadId)
    const clarification = session?.clarification
    if (
      !session ||
      !clarification ||
      clarification.threadId !== threadId ||
      clarification.requestId !== requestId ||
      clarification.liveSessionId !== session.liveSessionId
    )
      throw new Error("This Hermes clarification request is no longer current")
    await this.request("clarify.respond", {
      session_id: clarification.liveSessionId,
      request_id: requestId,
      answer: "",
    })
    if (this.session(threadId)?.clarification === clarification)
      this.#patchSession(threadId, {
        clarification: undefined,
        status: session.approval ? "waiting-for-input" : "running",
      })
    this.#publishAttentionResolved(session, requestId)
  }

  session(threadId: string) {
    return this.#snapshot.sessions.find((item) => item.threadId === threadId)
  }

  #onMessage(raw: unknown) {
    let frame: unknown
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw)) as unknown
    } catch {
      return
    }
    if (!isRecord(frame)) return
    if (frame.id !== undefined && frame.id !== null) {
      const id = String(frame.id)
      const pending = this.#pending.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      if (isRecord(frame.error))
        pending.reject(
          new Error(stringValue(frame.error.message) ?? "Hermes RPC failed")
        )
      else pending.resolve(frame.result)
      return
    }
    if (frame.method !== "event" || !isRecord(frame.params)) return
    const event = frame.params as GatewayEvent
    this.#handleEvent(event)
  }

  #handleEvent(event: GatewayEvent) {
    if (event.type === "gateway.ready") {
      const epoch = isRecord(event.payload)
        ? stringValue(event.payload.replay_epoch)
        : undefined
      const previousEpoch = this.#epoch
      this.#epoch = epoch
      if (epoch !== previousEpoch) this.#connectionChanged()
      if (previousEpoch && epoch !== previousEpoch) {
        this.#watermarks.clear()
        const active = this.#snapshot.sessions.filter(
          ({ liveSessionId }) => liveSessionId
        )
        for (const session of active)
          void this.loadHistory(session.threadId).catch((reason) =>
            this.#report(reason)
          )
      }
    }
    const liveSessionId = event.session_id
    if (!liveSessionId) return
    if (typeof event.seq === "number") {
      const previous = this.#watermarks.get(liveSessionId) ?? 0
      if (event.seq <= previous) return
      this.#watermarks.set(liveSessionId, event.seq)
    }
    const threadId = this.#liveToThread.get(liveSessionId)
    if (!threadId) return
    const payload = isRecord(event.payload) ? event.payload : {}
    if (event.type === "session.title") {
      const session = this.session(threadId)
      const storedSessionId = stringValue(payload.stored_session_id)
      const title = stringValue(payload.title)
      if (session && storedSessionId === session.storedSessionId && title)
        this.#patchSession(threadId, { title })
      return
    }
    if (event.type === "message.start") {
      const session = this.session(threadId)
      if (!session) return
      const assistant: ThreadMessageLike = {
        id: `hermes-assistant-${createBrowserId()}`,
        role: "assistant",
        content: "",
        createdAt: new Date(),
      }
      this.#patchSession(threadId, {
        messages: [...session.messages, assistant],
        running: true,
        status: "running",
      })
      this.#publishRunStarted(
        session,
        liveSessionId,
        stringValue(payload.message_id ?? payload.id) ??
          String(event.seq ?? "native")
      )
      return
    }
    if (
      event.type === "message.delta" ||
      event.type === "thinking.delta" ||
      event.type === "reasoning.delta"
    ) {
      this.#appendLiveText(
        threadId,
        String(payload.text ?? ""),
        event.type === "message.delta" ? "text" : "reasoning"
      )
      return
    }
    if (event.type === "tool.start" || event.type === "tool.progress") {
      this.#upsertLiveTool(threadId, payload, false)
      return
    }
    if (event.type === "tool.complete") {
      this.#upsertLiveTool(threadId, payload, true)
      return
    }
    if (event.type === "approval.request") {
      const session = this.session(threadId)
      const approval = this.#approvalFrom(payload, threadId, liveSessionId)
      if (approval)
        this.#patchSession(threadId, {
          approval,
          running: true,
          status: "waiting-for-input",
        })
      if (approval && session)
        this.#publishAttentionRequested(
          session,
          approval.requestId,
          "permission"
        )
      return
    }
    if (event.type === "clarify.request") {
      const session = this.session(threadId)
      const clarification = this.#clarificationFrom(
        payload,
        threadId,
        liveSessionId
      )
      if (clarification && session)
        this.#patchSession(threadId, {
          clarification,
          running: true,
          status: "waiting-for-input",
        })
      if (clarification && session)
        this.#publishAttentionRequested(
          session,
          clarification.requestId,
          "question"
        )
      return
    }
    if (event.type === "clarify.expire") {
      const requestId = stringValue(payload.request_id)
      const session = this.session(threadId)
      if (requestId && session?.clarification?.requestId === requestId)
        this.#patchSession(threadId, {
          clarification: undefined,
          status: session.approval ? "waiting-for-input" : "running",
        })
      if (requestId && session)
        this.#publishAttentionResolved(session, requestId)
      return
    }
    if (event.type === "message.complete" || event.type === "error") {
      const failed = event.type === "error" || payload.status === "error"
      const turn = this.#stagedTurns.get(threadId)
      const ownedTurn = turn?.liveSessionId === liveSessionId ? turn : undefined
      const operation = ownedTurn
        ? this.#reconcileStagedTurn(threadId, ownedTurn, failed)
        : event.type === "message.complete"
          ? this.loadHistory(threadId)
          : Promise.resolve()
      this.#finishLiveMessage(threadId, payload, failed)
      this.#publishRunTerminal(
        threadId,
        liveSessionId,
        failed ? "run-failed" : "run-finished"
      )
      void operation.catch((reason) => this.#report(reason))
      return
    }
    if (event.type === "session.info" || event.type === "session.usage") {
      const turn = this.#stagedTurns.get(threadId)
      const confirmIdle =
        event.type === "session.info" &&
        payload.running === false &&
        turn?.liveSessionId === liveSessionId
      this.#contextRevisions.set(
        threadId,
        (this.#contextRevisions.get(threadId) ?? 0) + 1
      )
      const current = this.session(threadId)?.composer
      const session = this.session(threadId)
      const selectedId =
        stringValue(payload.provider) && stringValue(payload.model)
          ? JSON.stringify([payload.provider, payload.model])
          : current?.model?.selectedId
      this.#patchSession(threadId, {
        ...(typeof payload.running === "boolean" && !confirmIdle
          ? {
              running: payload.running,
              status:
                session?.approval || session?.clarification
                  ? "waiting-for-input"
                  : payload.running
                    ? "running"
                    : "idle",
            }
          : {}),
        composer: {
          ...current,
          ...(selectedId
            ? { model: { options: current?.model?.options ?? [], selectedId } }
            : {}),
          context: readHermesContext(payload.usage),
        },
      })
      if (
        event.type === "session.info" &&
        payload.running === false &&
        stringValue(payload.model) &&
        !readHermesContext(payload.usage) &&
        this.#composerConfigs.get(threadId)?.contextEnabled
      )
        void this.#refreshContext(threadId).catch((reason) =>
          this.#report(reason)
        )
      if (confirmIdle && turn)
        void this.#confirmIdleTurn(threadId, turn).catch((reason) =>
          this.#report(reason)
        )
    }
  }

  #appendLiveText(threadId: string, delta: string, kind: "text" | "reasoning") {
    if (!delta) return
    this.#updateLastAssistant(threadId, (message) => {
      if (message.role !== "assistant") return message
      const content = Array.isArray(message.content) ? [...message.content] : []
      const index = content.findLastIndex((part) => part.type === kind)
      if (index >= 0) {
        const part = content[index]
        content[index] = { ...part, text: String(part.text ?? "") + delta }
      } else content.push({ type: kind, text: delta })
      return { ...message, content }
    })
  }

  #upsertLiveTool(threadId: string, payload: JsonRecord, complete: boolean) {
    const toolCallId = stringValue(payload.tool_id)
    if (!toolCallId) return
    this.#updateLastAssistant(threadId, (message) => {
      if (message.role !== "assistant") return message
      const content = Array.isArray(message.content) ? [...message.content] : []
      const index = content.findIndex(
        (part) => part.type === "tool-call" && part.toolCallId === toolCallId
      )
      const nativeToolName = stringValue(payload.name) ?? "tool"
      const args = isRecord(payload.args)
        ? canonicalHermesToolArgs(nativeToolName, payload.args)
        : {}
      const part = {
        type: "tool-call",
        toolCallId,
        toolName: canonicalHermesToolName(nativeToolName),
        args,
        argsText: JSON.stringify(args),
        ...(complete
          ? {
              result: payload.result,
              ...(payload.error ? { isError: true } : {}),
            }
          : {}),
      }
      if (index >= 0) content[index] = { ...content[index], ...part }
      else content.push(part)
      const artifact =
        complete && part.toolName === "present_artifact" && !payload.error
          ? projectHermesArtifactReceipt(payload.result)
          : undefined
      if (
        artifact &&
        !content.some(
          (item) =>
            item.type === "data" &&
            item.name === "aos.artifact" &&
            isRecord(item.data) &&
            item.data.id === artifact.data.id
        )
      )
        content.push(artifact)
      return { ...message, content }
    })
  }

  #finishLiveMessage(threadId: string, payload: JsonRecord, failed = false) {
    const finalText = stringValue(payload.text)
    if (finalText)
      this.#updateLastAssistant(threadId, (message) => {
        if (message.role !== "assistant") return message
        const content = Array.isArray(message.content)
          ? [...message.content]
          : []
        const index = content.findIndex((part) => part.type === "text")
        if (index >= 0) content[index] = { type: "text", text: finalText }
        else content.unshift({ type: "text", text: finalText })
        return {
          ...message,
          content,
          status: failed
            ? { type: "incomplete", reason: "error" }
            : { type: "complete", reason: "stop" },
        }
      })
    this.#patchSession(threadId, {
      running: false,
      status: failed ? "failed" : "idle",
      approval: undefined,
      clarification: undefined,
      updatedAt: new Date().toISOString(),
    })
  }

  #publishRunStarted(
    session: HermesSession,
    liveSessionId: string,
    nativeId: string
  ) {
    const lifecycleId = `hermes:run:${encodeURIComponent(session.threadId)}:${encodeURIComponent(nativeId)}`
    this.#activeLifecycles.set(liveSessionId, lifecycleId)
    this.#publishActivity({
      id: `${lifecycleId}:started`,
      agentId: session.agentId,
      threadId: session.threadId,
      occurredAt: new Date().toISOString(),
      type: "run-started",
      lifecycleId,
    })
  }

  #publishRunTerminal(
    threadId: string,
    liveSessionId: string,
    type: "run-finished" | "run-failed"
  ) {
    const session = this.session(threadId)
    const lifecycleId = this.#activeLifecycles.get(liveSessionId)
    if (!session || !lifecycleId) return
    this.#activeLifecycles.delete(liveSessionId)
    this.#publishActivity({
      id: `${lifecycleId}:${type === "run-finished" ? "finished" : "failed"}`,
      agentId: session.agentId,
      threadId,
      occurredAt: new Date().toISOString(),
      type,
      lifecycleId,
    })
  }

  #publishAttentionRequested(
    session: HermesSession,
    requestId: string,
    attentionKind: "question" | "permission"
  ) {
    this.#publishActivity({
      id: `hermes:attention:${encodeURIComponent(session.threadId)}:${encodeURIComponent(requestId)}:requested`,
      agentId: session.agentId,
      threadId: session.threadId,
      occurredAt: new Date().toISOString(),
      type: "attention-requested",
      attentionKind,
      requestId,
    })
  }

  #publishAttentionResolved(session: HermesSession, requestId: string) {
    this.#publishActivity({
      id: `hermes:attention:${encodeURIComponent(session.threadId)}:${encodeURIComponent(requestId)}:resolved`,
      agentId: session.agentId,
      threadId: session.threadId,
      occurredAt: new Date().toISOString(),
      type: "attention-resolved",
      requestId,
    })
  }

  #publishActivity(event: WorkspaceActivityEvent) {
    for (const listener of this.#activityListeners) {
      try {
        listener(structuredClone(event))
      } catch (reason) {
        this.#report(reason)
      }
    }
  }

  #updateLastAssistant(
    threadId: string,
    update: (message: ThreadMessage) => ThreadMessage
  ) {
    const session = this.session(threadId)
    if (!session) return
    const messages = [...session.messages]
    const index = messages.findLastIndex(
      (message) => message.role === "assistant"
    )
    if (index < 0) return
    messages[index] = update(messages[index] as ThreadMessage)
    this.#patchSession(threadId, { messages })
  }

  #approvalFrom(value: JsonRecord, threadId: string, liveSessionId: string) {
    const requestId = stringValue(value.request_id ?? value.id)
    if (!requestId) return undefined
    const allowPermanent = value.allow_permanent !== false
    const available: HermesApprovalChoice[] = Array.isArray(value.choices)
      ? value.choices.filter(
          (choice): choice is HermesApprovalChoice =>
            choice === "once" ||
            choice === "session" ||
            choice === "always" ||
            choice === "deny"
        )
      : value.smart_denied === true
        ? ["once", "deny"]
        : ["once", "session", "always", "deny"]
    return {
      threadId,
      liveSessionId,
      requestId,
      message:
        stringValue(value.message ?? value.command ?? value.description) ??
        "Hermes is requesting permission to continue.",
      choices: available.filter(
        (choice) => choice !== "always" || allowPermanent
      ),
      allowPermanent,
    }
  }

  #clarificationFrom(
    value: JsonRecord,
    threadId: string,
    liveSessionId: string
  ): HermesClarification | undefined {
    const requestId = stringValue(value.request_id)
    if (!requestId) return undefined
    const choices = (raw: unknown): readonly string[] | null | undefined => {
      if (raw === undefined || raw === null) return raw ?? null
      return Array.isArray(raw) &&
        raw.every((choice) => typeof choice === "string")
        ? raw
        : undefined
    }
    if (typeof value.question === "string") {
      const options = choices(value.choices)
      if (
        !value.question ||
        options === undefined ||
        (value.multi_select !== undefined &&
          typeof value.multi_select !== "boolean")
      )
        return undefined
      return {
        threadId,
        liveSessionId,
        requestId,
        questions: [
          {
            question: value.question,
            choices: options,
            multiple: value.multi_select === true,
          },
        ],
      }
    }
    if (!Array.isArray(value.questions) || value.questions.length === 0)
      return undefined
    const questions: HermesClarificationQuestion[] = []
    for (const raw of value.questions) {
      if (!isRecord(raw)) return undefined
      const id = stringValue(raw.qid)
      const question = stringValue(raw.question)
      const options = choices(raw.choices)
      if (
        !id ||
        !question ||
        options === undefined ||
        typeof raw.multi_select !== "boolean"
      )
        return undefined
      questions.push({
        id,
        question,
        choices: options,
        multiple: raw.multi_select === true,
      })
    }
    return { threadId, liveSessionId, requestId, questions }
  }

  async #replayEvents() {
    const entries = [...this.#watermarks]
    for (const [liveSessionId, lastSeen] of entries) {
      const result = await this.request<unknown>("session.events.since", {
        session_id: liveSessionId,
        last_seen: lastSeen,
      })
      if (!isRecord(result)) continue
      const epoch = stringValue(result.epoch)
      const threadId = this.#liveToThread.get(liveSessionId)
      if (result.truncated === true && threadId)
        await this.loadHistory(threadId)
      if (epoch && this.#epoch && epoch !== this.#epoch)
        this.#watermarks.delete(liveSessionId)
      if (epoch) this.#epoch = epoch
      if (Array.isArray(result.events))
        for (const event of result.events)
          if (isRecord(event)) this.#handleEvent(event as GatewayEvent)
    }
  }

  #patchSession(
    threadId: string,
    patch: Partial<HermesSession> & { liveSessionId?: string }
  ) {
    this.#setSnapshot({
      sessions: this.#snapshot.sessions.map((session) =>
        session.threadId === threadId ? { ...session, ...patch } : session
      ),
    })
  }

  #setSnapshot(patch: Partial<Omit<HermesNativeSnapshot, "revision">>) {
    this.#snapshot = {
      ...this.#snapshot,
      ...patch,
      revision: this.#snapshot.revision + 1,
    }
    for (const listener of this.#listeners) listener()
  }

  #rejectPending(error: Error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #report(reason: unknown) {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    for (const listener of this.#errors) listener(error)
  }
}
