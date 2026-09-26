import { backoffDelay, defaultClock, type Clock, type Logger } from "@aos/lifecycle"
import { tabAcpLogger } from "./log"

// Lazy logger for background error reporting.
let _clientLog: Logger | undefined
const clientLog = () => (_clientLog ??= tabAcpLogger())
import { AOS_METHODS, type AosSessionInfoMeta } from "@aos/protocol/acp"
import type {
  RuntimeInfo,
  SessionModelUpdateRequest,
  SessionModelUpdateResponse,
} from "@aos/protocol"

import type {
  AgentVisibility,
  SessionActionCapabilities,
  SessionCreationOptions,
} from "../../contracts"
import type { AosRemoteClient } from "../aos-client"
import { createAcpComposerStore } from "./acp-workspace-client-composer"
import { createAcpSessionStore, rowOf } from "./acp-workspace-client-sessions"
import type { AcpConnection } from "./types"

/**
 * The workspace surface over one ACP connection: Agent and Session ownership,
 * read state, focus, Todos, activity, and the composer's Session projection.
 * Bytes stay on REST, which the normalized client already owns.
 */

/**
 * A burst of native catalog changes costs one `session/list` page. Rows the
 * browser does not hold learn their `unread`, `status`, and title only from
 * a list, so an invalidation has to re-read one rather than patch a guess in.
 */
const CATALOG_RELIST_DEBOUNCE_MS = 300
/** Backoff for a failing session list read. */
const RELIST_BACKOFF = { baseMs: 250, capMs: 5_000 } as const

/** One runtime-declared operation, as the UI asks about it. */
function offers(capability: RuntimeInfo["capabilities"]["sessionTitle"]) {
  return capability.status === "available"
}

/** What the workspace still reads over REST, delegated to the AOS client. */
type AcpRestClient = Pick<
  AosRemoteClient,
  | "adoptSessionOwnership"
  | "readArtifact"
  | "runtimeInfo"
  | "speak"
  | "speakForAgent"
  | "stageAttachments"
  | "transcribe"
  | "transcribeForAgent"
>

export type AcpWorkspaceClientOptions = {
  connection: AcpConnection
  rest: AcpRestClient
  /** Ownership for a Session the row cache has not seen yet. */
  agentIdFor?: (sessionId: string) => string | undefined
  now?: () => number
  /** Runs the relist debounce and its retry backoff. */
  clock?: Clock
}

export function createAcpWorkspaceClient({
  connection,
  rest,
  agentIdFor,
  now,
  clock = defaultClock,
}: AcpWorkspaceClientOptions) {
  const store = createAcpSessionStore({
    connection,
    ...(now ? { now } : {}),
    onTurnFinished: (sessionId) => {
      reportCreatedAgents(sessionId).catch((err: unknown) =>
        clientLog().warn({ err }, "agent.report_created_failed")
      )
    },
  })
  const composer = createAcpComposerStore(connection)
  const revisions = new Map<string, string>()
  let creatorId: string | undefined
  let listedAgentIds: ReadonlySet<string> = new Set()
  /** The Agent ids each creator Session's catalog held when it opened. */
  const creatorBaselines = new Map<string, Set<string>>()
  let sessionActions: Promise<SessionActionCapabilities> | undefined

  function adopt(sessionId: string, agentId: string) {
    try {
      rest.adoptSessionOwnership(sessionId, agentId)
    } catch {
      // The proxy's row is authoritative; REST ownership is only a byte route.
    }
  }

  function remember(
    sessionId: string,
    info: AosSessionInfoMeta,
    updatedAt?: string | null
  ) {
    store.put(sessionId, info, updatedAt)
    adopt(sessionId, info.agentId)
  }

  function knownAgentOf(sessionId: string) {
    return store.agentIdOf(sessionId) ?? agentIdFor?.(sessionId)
  }

  function agentOf(sessionId: string) {
    const agentId = knownAgentOf(sessionId)
    if (!agentId) throw new Error("Session ownership is unknown")
    return agentId
  }

  async function catalog() {
    const response = await connection.listAgents()
    revisions.clear()
    for (const entry of response.agents)
      revisions.set(entry.summary.id, entry.revision)
    creatorId = response.agents.find(
      ({ summary }) => summary.role === "creator"
    )?.summary.id
    listedAgentIds = new Set(response.agents.map(({ summary }) => summary.id))
    return response
  }

  type SessionPage = Awaited<ReturnType<AcpConnection["listSessions"]>>
  const pageReads = new Map<string, Promise<SessionPage>>()
  let catalogScope: string | undefined

  /**
   * The one way a `session/list` page is read, by the thread list and the
   * workspace alike, so every page lands in the row cache once. A read already
   * in flight for the same page is shared rather than repeated.
   */
  function readSessionPage(
    meta: Parameters<AcpConnection["listSessions"]>[0],
    cursor?: string
  ) {
    const key = JSON.stringify([meta.agentId ?? null, cursor ?? null])
    const inFlight = pageReads.get(key)
    if (inFlight) return inFlight
    const read = connection
      .listSessions(meta, cursor)
      .then((page) => {
        for (const session of page.sessions) {
          const row = rowOf(session)
          remember(row.sessionId, row.info, row.updatedAt)
          if (row.title) store.setTitle(row.sessionId, row.title)
        }
        return page
      })
      .finally(() => pageReads.delete(key))
    pageReads.set(key, read)
    return read
  }

  function watchCreator(sessionId: string, agentId: string) {
    if (agentId === creatorId && !creatorBaselines.has(sessionId))
      creatorBaselines.set(sessionId, new Set(listedAgentIds))
  }

  /**
   * The creator makes Agents with its harness's own means, so creation is
   * observable only in the catalog: an Agent that was not listed when the
   * creator Session opened, and is listed once one of its turns stops. A
   * visible one is ready; a hidden one still needs its operator.
   */
  async function reportCreatedAgents(sessionId: string) {
    const baseline = creatorBaselines.get(sessionId)
    if (!baseline) return
    let agents
    try {
      agents = (await catalog()).agents
    } catch {
      return
    }
    for (const { summary, visibility } of agents) {
      if (baseline.has(summary.id)) continue
      baseline.add(summary.id)
      store.emitActivity({
        id: `${sessionId}:${summary.id}`,
        type:
          visibility === "hidden" ? "agent-activation-failed" : "agent-ready",
        agentId: summary.id,
        sessionId,
        occurredAt: new Date((now ?? Date.now)()).toISOString(),
      })
    }
  }

  async function listSessions(agentId?: string, cursor?: string) {
    const page = await readSessionPage(
      agentId === undefined ? {} : { agentId },
      cursor
    )
    return {
      sessions: store.rowsFor(page.sessions.map(({ sessionId }) => sessionId)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
  }

  let relistTimer: unknown
  /** The newest relist's backoff; a newer relist or `dispose` ends it early. */
  let retry: { timer: unknown; wake: () => void } | undefined
  /** Rises with every relist, so an older one stops retrying. */
  let relists = 0
  let disposed = false
  const stale = (generation: number) => disposed || generation !== relists

  function stopRetry() {
    if (!retry) return
    clock.clearTimeout(retry.timer)
    retry.wake()
    retry = undefined
  }

  function backOff(ms: number) {
    return new Promise<void>((wake) => {
      const timer = clock.setTimeout(() => {
        retry = undefined
        wake()
      }, ms)
      retry = { timer, wake }
    })
  }

  /**
   * Lists page one, retrying on backoff until it succeeds or is superseded by
   * a newer relist request. Used for the first load and for reconnect relists.
   */
  async function reliableListSessions() {
    stopRetry()
    const generation = ++relists
    let attempt = 0
    while (!stale(generation)) {
      try {
        await listSessions()
        return
      } catch {
        if (stale(generation)) return
        attempt += 1
        await backOff(backoffDelay(attempt, RELIST_BACKOFF))
      }
    }
  }

  /**
   * Every page the thread list reads already lands in the row cache, a
   * reloaded deep link included, so a Session still missing costs one read of
   * page one, never a walk of every Agent's catalog.
   */
  async function readRows(sessionIds: readonly string[]) {
    if (sessionIds.some((sessionId) => !store.knows(sessionId)))
      await reliableListSessions()
  }

  /**
   * Re-reads page one once a burst of invalidations settles. A read still in
   * flight answers for the burst, so nothing here overlaps or retries.
   */
  function scheduleSessionRelist() {
    if (relistTimer !== undefined) clock.clearTimeout(relistTimer)
    relistTimer = clock.setTimeout(() => {
      relistTimer = undefined
      reliableListSessions().catch((err: unknown) => clientLog().warn({ err }, "sessions.relist_failed"))
    }, CATALOG_RELIST_DEBOUNCE_MS)
  }

  const leaveCatalog = connection.subscribeNotification(
    AOS_METHODS.notify.catalogInvalidated,
    scheduleSessionRelist
  )

  // After a reconnect the session list may have changed while the socket was
  // down: re-read page one as soon as the connection is ready again.
  let connectionEverReady = connection.status === "ready"
  let connectionCurrentlyReady = connectionEverReady
  const leaveStatus = connection.subscribeStatus((status) => {
    if (status === "ready") {
      // A reconnect: was ever ready and had an interruption.
      if (connectionEverReady && !connectionCurrentlyReady)
        scheduleSessionRelist()
      connectionEverReady = true
      connectionCurrentlyReady = true
    } else {
      connectionCurrentlyReady = false
    }
  })

  /** Each held Session's hold count and what the last release lets go. */
  const holds = new Map<string, { count: number; release: () => void }>()

  /**
   * Holds a Session's status, Todos, row changes, and composer projection for
   * as long as something shows it. The stores fold what the Session streams,
   * so whatever replays it — the thread that binds it — fills them. Naming the
   * owning Agent lets a deep link resume before any list.
   */
  function subscribeSession(sessionId: string) {
    const held = holds.get(sessionId)
    if (held) held.count += 1
    else {
      const agentId = knownAgentOf(sessionId)
      const leaveRow = store.subscribe(sessionId, agentId)
      const leaveComposer = composer.subscribe(sessionId)
      holds.set(sessionId, {
        count: 1,
        release: () => {
          leaveRow()
          leaveComposer()
        },
      })
      if (agentId) {
        adopt(sessionId, agentId)
        watchCreator(sessionId, agentId)
      }
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const hold = holds.get(sessionId)
      if (!hold || --hold.count > 0) return
      holds.delete(sessionId)
      hold.release()
    }
  }

  const client = {
    // Agents
    async listAgents() {
      return (await catalog()).agents.map(({ summary }) => summary)
    },
    async refreshAgents() {
      return (await catalog()).agents.map(({ summary }) => summary)
    },
    async listAgentCatalog() {
      return (await catalog()).agents.map(
        ({ summary, visibility, selectable, editable }) => ({
          summary,
          visibility,
          selectable,
          editable,
        })
      )
    },
    async updateAgentVisibility(agentId: string, visibility: AgentVisibility) {
      const revision = revisions.get(agentId)
      if (!revision || revision === "unavailable")
        throw new Error("Agent visibility requires a fresh catalog revision")
      const result = await connection.setVisibility({
        agentId,
        visibility,
        revision,
      })
      revisions.set(agentId, result.agent.revision)
    },
    subscribeAgentCatalog: (listener: () => void) =>
      connection.subscribeNotification(
        AOS_METHODS.notify.catalogInvalidated,
        () => listener()
      ),

    // Sessions
    listSessions,
    readSessionPage,
    scopeSessionCatalog(agentId: string) {
      catalogScope = agentId
    },
    /** The Agent the thread list pages History for, once one is selected. */
    sessionCatalogScope: () => catalogScope,
    async getSessionMetadata(sessionIds: string[]) {
      await readRows(sessionIds)
      return store.rowsFor(sessionIds)
    },
    subscribeSessionMetadata: store.subscribeMetadata,
    async createSession(agentId: string, options?: SessionCreationOptions) {
      const created = await connection.newSession({
        agentId,
        clientId: crypto.randomUUID(),
        ...(options?.title ? { title: options.title } : {}),
      })
      adopt(created.sessionId, agentId)
      watchCreator(created.sessionId, agentId)
      return { sessionId: created.sessionId }
    },
    subscribeSession,
    async markSessionRead(sessionId: string) {
      store.setUnread(sessionId, false)
      await connection.updateSession({ sessionId, unread: false })
    },
    /** The row leads the write, so a refused pin has to be taken back. */
    async setSessionPinned(sessionId: string, pinned: boolean) {
      const [previous] = store.rowsFor([sessionId])
      store.setPinned(sessionId, pinned)
      try {
        await connection.updateSession({ sessionId, pinned })
      } catch (reason) {
        store.setPinned(sessionId, previous?.pinned)
        throw reason
      }
    },
    /**
     * The runtime's own report, read once. A failed read is not an answer, so
     * it is not remembered.
     */
    sessionActionCapabilities() {
      sessionActions ??= rest
        .runtimeInfo()
        .then(({ capabilities }) => ({
          rename: offers(capabilities.sessionTitle),
          archive: offers(capabilities.sessionArchival),
          delete: offers(capabilities.sessionDeletion),
          pin: offers(capabilities.sessionPin),
        }))
        .catch((reason: unknown) => {
          sessionActions = undefined
          throw reason
        })
      return sessionActions
    },
    reportFocus: (
      sessionId: string | null,
      presence: { foreground: boolean; idle: boolean }
    ) => connection.focus(sessionId, presence),
    sessionStatus: store.status,
    subscribeSessionStatus: store.subscribeStatus,
    subscribeSessionInvalidation: store.subscribeInvalidation,
    subscribeTodos: store.subscribeTodos,
    subscribeActivity: store.subscribeActivity,

    // Composer: synchronous reads of what a held Session has reported so far.
    workspaceCapabilities: composer.capabilities,
    models: composer.models,
    /** The newest usage the provider pushed. */
    context: composer.context,
    turnUsage: composer.turnUsage,
    /** Told of every change to what the composer reads for the Session. */
    subscribeComposer: composer.listen,
    /** The model the provider reports the Session on, as it changes. */
    modelFeed: composer.modelFeed,
    selectModel: composer.selectModel,
    selectEffort: composer.selectEffort,
    /** One provider write per half; the response settles what the Session runs. */
    async updateModel(
      sessionId: string,
      patch: SessionModelUpdateRequest
    ): Promise<SessionModelUpdateResponse> {
      let models =
        patch.selectedId === undefined
          ? composer.models(sessionId)
          : await composer.selectModel(sessionId, patch.selectedId)
      if (patch.effortId !== undefined)
        models = await composer.selectEffort(sessionId, patch.effortId)
      if (!models) throw new Error("The Session reports no models")
      return {
        selectedId: models.selectedId,
        ...(models.effortId === undefined ? {} : { effortId: models.effortId }),
      }
    },
    steerRun: (
      sessionId: string,
      request: { requestId: string; text: string }
    ) => connection.steer({ sessionId, ...request }),

    // Bytes and runtime metadata stay on REST.
    runtimeInfo: rest.runtimeInfo.bind(rest),
    stageAttachments: rest.stageAttachments.bind(rest),
    readArtifact: rest.readArtifact.bind(rest),
    transcribe: rest.transcribe.bind(rest),
    transcribeForAgent: rest.transcribeForAgent.bind(rest),
    speak: rest.speak.bind(rest),
    speakForAgent: rest.speakForAgent.bind(rest),
    /** REST authorizes byte reads per Agent, so ownership must be known. */
    agentIdOf: agentOf,
    /** Ownership for callers that can proceed without knowing it yet. */
    knownAgentIdOf: knownAgentOf,
    /** The provider's newest Session title, as a list or a held Session reports it. */
    sessionTitle: store.title,

    /** Stops the relist timers and releases every subscription and hold. */
    dispose() {
      disposed = true
      if (relistTimer !== undefined) clock.clearTimeout(relistTimer)
      relistTimer = undefined
      stopRetry()
      leaveCatalog()
      leaveStatus()
      store.dispose()
      for (const hold of holds.values()) hold.release()
      holds.clear()
    },
  }

  return client
}

export type AcpWorkspaceClient = ReturnType<typeof createAcpWorkspaceClient>
