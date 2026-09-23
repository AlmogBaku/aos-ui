import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentContext,
  type ResumeSessionRequest,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  SESSION_CATALOG_MAX_WINDOW,
  SessionHistoryResponseSchema,
  type SessionHistoryResponse,
} from "../../protocol"
import {
  ACP_PROTOCOL_VERSION,
  AOS_AUTH_METHOD_INVITE,
  AOS_EXTENSION_VERSION,
  AOS_METHODS,
  AOS_META_KEY,
  AosFocusNotificationSchema,
  AosLoginMetaSchema,
  AosPromptMetaSchema,
  AosSessionListMetaSchema,
  AosSessionNewMetaSchema,
  AosSessionResumeMetaSchema,
  AosSessionUpdateRequestSchema,
  AosSetVisibilityRequestSchema,
  AosSteerRequestSchema,
  type AosExtensions,
} from "../../protocol/acp"
import type { PromptTurnInput } from "../core/events"
import {
  ServerTurnConflictError,
  type ServerRuntime,
  type SessionScope,
} from "../core/runtime"
import type { SessionExecutionState } from "../core/session-coordinator"
import type { PresenceReport } from "../push/presence"
import { redactForLog } from "../redaction"
import {
  commandsUpdate,
  createSessions,
  executionMeta,
  overlaidStatus,
  sessionInfoMeta,
  sessionInfoOf,
  sessionInfoUpdate,
  decodeCursor,
  encodeCursor,
} from "./agent-sessions"
import { isPromptBlock, promptText } from "./prompt-content"
import type { SessionMember } from "./session-member"
import type { RoomTurn } from "./session-rooms"
import { isCorrection } from "./translate/history"
import type {
  AcpConnectionContext,
  AosAcpAgentFactory,
  GuestGrant,
  GuestPolicy,
} from "./types"
import {
  authenticationRequired,
  invalidRequest,
  notFound,
  parseMeta,
  turnInProgress,
} from "./validation"

/**
 * The per-connection ACP v2 agent that fronts the coordinator and the runtime.
 * One handler per method: it validates `_meta.aos`, calls the same normalized
 * operations the HTTP routes call, and leaves the turn stream itself to the
 * Session attachment.
 */

/** The bounded history one `replayFrom: { type: "start" }` resume replays. */
const HISTORY_REPLAY_LIMIT = 500
/** One `session/list` page; the cursor carries the next offset. */
const SESSION_LIST_LIMIT = 50

/** Extension methods with no params still need a parser for the SDK. */
const withoutParams = () => undefined

/**
 * The operator lane's extensions. The proxy implements each of them itself,
 * except the provider catalog invalidation a runtime may not signal.
 */
function operatorExtensions(runtime: ServerRuntime): AosExtensions {
  return {
    steer: true,
    rewind: true,
    composerPrefill: true,
    agents: true,
    invalidation: runtime.subscribeCatalogChanges !== undefined,
    activity: true,
    readState: true,
    focus: true,
    guestProjection: false,
  }
}

/** What a redeemed invitation may call; every other method is unavailable. */
const GUEST_METHODS = new Set<string>([
  methods.agent.session.resume,
  methods.agent.session.prompt,
  methods.agent.session.cancel,
  methods.agent.session.close,
  AOS_METHODS.session.focus,
])

/**
 * The guest lane streams one invited conversation and manages no workspace: it
 * owns no roster, no read state, no catalog, and no turn control beyond Stop.
 */
const GUEST_EXTENSIONS = {
  steer: false,
  rewind: false,
  composerPrefill: false,
  agents: false,
  invalidation: false,
  activity: false,
  readState: false,
  focus: false,
  guestProjection: true,
} satisfies AosExtensions

const INVITE_AUTH_METHOD = {
  type: "agent",
  methodId: AOS_AUTH_METHOD_INVITE,
  name: "Invitation",
} as const

/**
 * Whether a resume already shows the live turn's prompt: its cursor sits inside
 * that turn, or the page it replayed ends on that prompt. A correction is a
 * steer inside the turn, so the prompt is the last user message before them.
 */
function showsPrompt(
  turn: RoomTurn | undefined,
  meta: { turnId?: string },
  history?: SessionHistoryResponse
) {
  if (!turn) return false
  if (meta.turnId === turn.turnId) return true
  const prompt = history?.messages.findLast(
    (message) => message.role === "user" && !isCorrection(message)
  )
  if (!prompt || !Array.isArray(prompt.content)) return false
  const text = prompt.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
  return text.trim() === promptText(turn.content).trim()
}

/**
 * Runs work once the response for the current request has been written. The
 * caller must have settled every await its response needs before calling this:
 * the task fires on the next turn of the loop, so anything still pending in the
 * handler lets these notifications reach the client before the response does.
 */
function afterResponse(member: SessionMember, task: () => Promise<void>) {
  setTimeout(() => {
    void task().catch((cause: unknown) => member.report(cause))
  }, 0)
}

/** One authorized guest request: its connection policy and redeemed grant. */
type GuestRequest = { policy: GuestPolicy; grant: GuestGrant }

/** True when a focus report repeats the exposure the connection last sent. */
function sameExposure(
  previous: PresenceReport | undefined,
  next: PresenceReport
) {
  return (
    previous !== undefined &&
    previous.sessionId === next.sessionId &&
    previous.foreground === next.foreground &&
    previous.idle === next.idle
  )
}

export const createAosAcpAgent = ((context: AcpConnectionContext): AgentApp => {
  const { lane, translators } = context
  const { runtime, sessions: coordinator } = context.runtimeInstance
  const sessions = createSessions(context)
  const { workspace } = sessions

  const app = agent({ name: "aos-proxy" })

  /**
   * The exposure this connection last acknowledged. A foreground browser
   * re-sends its focus report every heartbeat, and re-acknowledging an
   * unchanged one would write the watermark for a Session nobody just opened.
   */
  let exposure: PresenceReport | undefined

  /** One structured, redacted line per connection-level ACP event. */
  const log = (event: string, fields?: Record<string, unknown>) => {
    context.logger?.info(
      redactForLog({
        event,
        connectionId: context.connectionId,
        lane,
        ...fields,
      })
    )
  }

  /**
   * Gates one method on the guest lane and returns what its handler runs under.
   * An operator connection has no grant and passes straight through.
   */
  function guestFor(method: string): GuestRequest | undefined {
    const policy = context.guest
    if (!policy) return undefined
    const grant = policy.grant()
    if (!grant) throw authenticationRequired()
    if (!GUEST_METHODS.has(method)) throw RequestError.methodNotFound(method)
    return { policy, grant }
  }

  /**
   * The invited Session as a coordinator scope. A guest addresses its one
   * conversation by reference alone, so no other Session is reachable, and
   * `undefined` means the runtime has not created this one yet.
   */
  async function invitedScope(
    grant: GuestGrant,
    publicSessionId: string,
    create?: { firstTurnInstruction?: string }
  ): Promise<SessionScope | undefined> {
    if (publicSessionId !== grant.ref) throw notFound()
    const resolved = await workspace.invited(grant.agentId, grant.ref, create)
    return resolved
      ? {
          agentId: grant.agentId,
          sessionId: resolved.sessionId,
          threadId: grant.ref,
        }
      : undefined
  }

  /** A guest sees the invited Session's live state, not the operator's row. */
  function invitedSessionMeta(grant: GuestGrant, state: SessionExecutionState) {
    return {
      agentId: grant.agentId,
      status: overlaidStatus(state, "idle"),
      archived: false,
    }
  }

  /** Subscribes to the live turn, reporting a cursor that cannot position it. */
  async function followPositioned(
    member: SessionMember,
    scope: SessionScope,
    meta: { turnId?: string; after?: number },
    replayedCorrections = 0
  ) {
    const positioned =
      meta.turnId === undefined ||
      meta.turnId === coordinator.snapshot(scope).turnId
    try {
      await member.follow(
        positioned ? meta.after : undefined,
        replayedCorrections
      )
      return positioned ? {} : { resync: true }
    } catch {
      return { resync: true }
    }
  }

  /**
   * The invited conversation as the guest lane resumes it. A fresh invitation
   * has no Session yet: resuming it creates nothing and replays nothing, the
   * way the guest history route serves an empty page, and the first Send
   * resolves it.
   */
  async function resumeInvited(
    guest: GuestRequest,
    params: ResumeSessionRequest,
    client: AgentContext
  ) {
    const { grant, policy } = guest
    const meta = parseMeta(AosSessionResumeMetaSchema, params._meta)
    const scope = await invitedScope(grant, params.sessionId)
    const capabilities = policy.project.capabilities(
      await workspace.capabilities({
        agentId: grant.agentId,
        threadId: grant.ref,
      })
    )
    if (!scope)
      return {
        _meta: {
          [AOS_META_KEY]: {
            session: invitedSessionMeta(grant, "idle"),
            execution: { status: "idle" as const },
            capabilities,
          },
        },
      }
    if (coordinator.state(scope) === "waiting-for-input")
      await workspace.discover(scope)
    const member = sessions.join(client, scope)
    // Counted on the authoritative page, before the guest projection rebuilds
    // its messages: that projection keeps no user-turn metadata.
    let corrections = 0
    let history: SessionHistoryResponse | undefined
    if (params.replayFrom?.type === "start") {
      history = SessionHistoryResponseSchema.parse(
        await workspace.history(scope, HISTORY_REPLAY_LIMIT)
      )
      corrections = translators.persistedCorrections(history)
      for (const outbound of translators.translateHistory(
        policy.project.history(history),
        lane
      ))
        await member.send(outbound)
    }
    // Seated after its history and before its follow, so the room's prompt
    // lands between them; checked on the authoritative page, as corrections are.
    member.enterRoom(
      showsPrompt(context.rooms.current(scope), meta, history),
      history !== undefined
    )
    const resync = await followPositioned(member, scope, meta, corrections)
    const execution = coordinator.snapshot(scope)
    afterResponse(member, async () => {
      await member.reportExecution()
      if (coordinator.state(scope) === "waiting-for-input")
        await member.reissuePending()
    })
    return {
      _meta: {
        [AOS_META_KEY]: {
          session: invitedSessionMeta(grant, execution.state),
          execution: executionMeta(execution),
          capabilities,
          ...resync,
        },
      },
    }
  }

  /**
   * The invited Session one guest turn runs in. Rewind stays operator-only,
   * exactly as the guest turn route refuses one, and the invitation's setup text
   * reaches the runtime only when this Send creates the Session.
   */
  async function promptInvited(
    { grant }: GuestRequest,
    publicSessionId: string,
    meta: { rewindSourceId?: string }
  ) {
    if (meta.rewindSourceId !== undefined) throw invalidRequest()
    const scope = await invitedScope(grant, publicSessionId, {
      ...(grant.firstTurnInstruction === undefined
        ? {}
        : { firstTurnInstruction: grant.firstTurnInstruction }),
    })
    if (!scope) throw notFound()
    return scope
  }

  app.onRequest(methods.agent.initialize, async () => {
    // An unauthenticated guest learns nothing about the deployment it reached.
    const info = context.guest ? undefined : await workspace.info()
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: {
        name: "aos-proxy",
        ...(info ? { title: info.runtime.name } : {}),
        // The proxy versions the AOS extension contract, not a build.
        version: `${AOS_EXTENSION_VERSION}`,
      },
      capabilities: {
        session: {
          prompt: { image: {}, embeddedContext: {} },
          ...(context.guest ? {} : { delete: {} }),
        },
      },
      authMethods: context.guest ? [INVITE_AUTH_METHOD] : [],
      _meta: {
        [AOS_META_KEY]: {
          version: AOS_EXTENSION_VERSION,
          lane,
          extensions: context.guest
            ? GUEST_EXTENSIONS
            : operatorExtensions(runtime),
        },
      },
    }
  })

  // The operator lane authenticates its WebSocket upgrade instead.
  app.onRequest(methods.agent.auth.login, async ({ params }) => {
    const policy = context.guest
    if (!policy) throw RequestError.methodNotFound(methods.agent.auth.login)
    if (params.methodId !== AOS_AUTH_METHOD_INVITE)
      throw authenticationRequired()
    const { token } = parseMeta(AosLoginMetaSchema, params._meta)
    if (!(await policy.authenticate(token))) throw authenticationRequired()
    return {}
  })

  app.onRequest(methods.agent.session.new, async ({ params, client }) => {
    guestFor(methods.agent.session.new)
    const meta = parseMeta(AosSessionNewMetaSchema, params._meta)
    const publicSessionId = await workspace.create(meta.agentId, meta.title)
    const scope = workspace.scope(meta.agentId, publicSessionId)
    const row = await workspace.session(scope)
    sessions.remember([row])
    const capabilities = await workspace.capabilities(scope)
    const models = await workspace.models(scope)
    const member = sessions.join(client, scope)
    afterResponse(member, async () => {
      await member.update(commandsUpdate(capabilities))
      await member.reportUsage()
    })
    return {
      sessionId: publicSessionId,
      configOptions: translators.configOptionsOf(models),
      _meta: {
        [AOS_META_KEY]: {
          session: sessionInfoMeta(row, sessions.status(row)),
          capabilities,
        },
      },
    }
  })

  app.onRequest(methods.agent.session.list, async ({ params }) => {
    guestFor(methods.agent.session.list)
    const meta = parseMeta(AosSessionListMetaSchema, params._meta)
    const offset = decodeCursor(params.cursor)
    const page = await workspace.list(meta.agentId, SESSION_LIST_LIMIT, offset)
    sessions.remember(page.sessions)
    context.sessionRows.rememberList(page.sessions)
    const next = offset + page.sessions.length
    return {
      sessions: page.sessions.map((session) => {
        const row =
          context.sessionRows.get(session.agentId, session.id) ?? session
        return sessionInfoOf(row, sessions.status(row))
      }),
      // No cursor points past the catalog window, which no runtime serves.
      ...(next < Math.min(page.total, SESSION_CATALOG_MAX_WINDOW)
        ? { nextCursor: encodeCursor(next) }
        : {}),
    }
  })

  app.onRequest(methods.agent.session.resume, async ({ params, client }) => {
    const guest = guestFor(methods.agent.session.resume)
    if (guest) return await resumeInvited(guest, params, client)
    const meta = parseMeta(AosSessionResumeMetaSchema, params._meta)
    if (meta.agentId !== undefined)
      sessions.adopt(params.sessionId, meta.agentId)
    const scope = sessions.scope(params.sessionId)
    const row = await workspace.session(scope)
    // The same preamble the history route runs: only a wait or a Session the
    // provider still calls running can hide a recoverable execution.
    const state = coordinator.state(scope)
    if (
      state === "waiting-for-input" ||
      (state === "idle" && row.status === "running")
    )
      await workspace.discover(scope)
    const member = sessions.join(client, scope)
    // A correction the provider persisted the moment it accepted the steer is
    // already in this page, so the journal's acknowledgement of it is dropped.
    let corrections = 0
    let history: SessionHistoryResponse | undefined
    if (params.replayFrom?.type === "start") {
      history = await workspace.history(scope, HISTORY_REPLAY_LIMIT)
      corrections = translators.persistedCorrections(history)
      for (const outbound of translators.translateHistory(history, lane))
        await member.send(outbound)
    }
    // Seated after its history and before any other provider read, so a turn
    // another browser starts meanwhile reaches it, prompt first.
    member.enterRoom(
      showsPrompt(context.rooms.current(scope), meta, history),
      history !== undefined
    )
    // A cursor for another turn cannot position this one, and a cursor beyond
    // bounded replay cannot be served: both need a full reload.
    const resync = await followPositioned(member, scope, meta, corrections)
    const execution = coordinator.snapshot(scope)
    // Every provider read the response needs settles before the follow-up is
    // scheduled: `afterResponse` fires on the next task, so a read awaited
    // after it lets the notifications overtake the very response that tells
    // the browser to start listening for them.
    const models = await workspace.models(scope)
    const capabilities = await workspace.capabilities(scope)
    afterResponse(member, async () => {
      await member.reportExecution()
      // A resumed Session carries the window every earlier turn already grew;
      // only a report here keeps its composer from opening on an empty gauge.
      await member.reportUsage()
      if (coordinator.state(scope) === "waiting-for-input")
        await member.reissuePending()
    })
    return {
      configOptions: translators.configOptionsOf(models),
      _meta: {
        [AOS_META_KEY]: {
          session: sessionInfoMeta(row, sessions.status(row)),
          execution: executionMeta(execution),
          capabilities,
          ...resync,
        },
      },
    }
  })

  app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const guest = guestFor(methods.agent.session.prompt)
    const meta = parseMeta(AosPromptMetaSchema, params._meta)
    if (!params.prompt.every(isPromptBlock)) throw invalidRequest()
    const text = promptText(params.prompt)
    if (!text) throw invalidRequest()
    const scope = guest
      ? await promptInvited(guest, params.sessionId, meta)
      : sessions.scope(params.sessionId)
    await workspace.session(scope)
    if (coordinator.state(scope) !== "idle") throw turnInProgress()
    // Bytes were staged over REST; the prompt references the batch by id and
    // the stage appends its server-owned content to the user turn.
    const stage =
      meta.attachmentStageId === undefined
        ? undefined
        : context.attachmentStages.take(
            scope.agentId,
            scope.threadId,
            meta.attachmentStageId
          )
    if (meta.attachmentStageId !== undefined && !stage) throw invalidRequest()
    const messageId = crypto.randomUUID()
    const input: PromptTurnInput = {
      turnId: crypto.randomUUID(),
      messageId,
      prompt: stage ? await stage.appendTo(text) : text,
      ...(meta.rewindSourceId === undefined
        ? {}
        : { rewindSourceId: meta.rewindSourceId }),
    }
    const member = sessions.join(client, scope)
    afterResponse(member, async () => {
      // Seated before admission, so a turn that wins the race still reaches
      // this browser, and shown its own prompt as today.
      member.enterRoom()
      await member.update({
        sessionUpdate: "user_message",
        messageId,
        content: params.prompt,
      })
      try {
        await member.startTurn(input, stage)
      } catch (cause) {
        if (!(cause instanceof ServerTurnConflictError)) throw cause
        // Another browser's turn won: report the conflict, then follow it.
        await member.report(cause)
        await member.catchUp()
        return
      }
      await member.announce({
        turnId: input.turnId,
        messageId,
        content: params.prompt,
        at: Date.now(),
      })
    })
    return { _meta: { [AOS_META_KEY]: { messageId } } }
  })

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    log("acp.turn.cancel", { sessionId: params.sessionId })
    // Only a joined Session has a member, so an unauthenticated
    // guest reaches nothing here.
    const member = sessions.member(params.sessionId)
    if (!member) return
    await member.cancel().catch((cause: unknown) => member.report(cause))
  })

  app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    guestFor(methods.agent.session.setConfigOption)
    const scope = sessions.scope(params.sessionId)
    const write = translators.configWriteOf(params.configId, params.value)
    if (!write) throw invalidRequest()
    await workspace.updateModel(scope, write)
    const configOptions = translators.configOptionsOf(
      await workspace.models(scope)
    )
    // The window's size belongs to the model, so a switch restates the usage
    // the browser is holding against the model the Session has just left.
    const member = sessions.member(params.sessionId)
    if (member) afterResponse(member, () => member.reportUsage())
    return { configOptions }
  })

  app.onRequest(methods.agent.session.close, ({ params }) => {
    guestFor(methods.agent.session.close)
    sessions.leave(params.sessionId)
    return {}
  })

  app.onRequest(methods.agent.session.delete, async ({ params, client }) => {
    guestFor(methods.agent.session.delete)
    const scope = sessions.scope(params.sessionId)
    await workspace.delete(scope)
    sessions.forget(scope)
    await client.notify(AOS_METHODS.notify.catalogInvalidated)
    return {}
  })

  app.onRequest(
    AOS_METHODS.session.update,
    AosSessionUpdateRequestSchema,
    async ({ params, client }) => {
      guestFor(AOS_METHODS.session.update)
      const scope = sessions.scope(params.sessionId)
      if (params.unread === false) {
        await context.readState.markRead(scope.agentId, scope.threadId)
        return {}
      }
      await workspace.update(
        scope,
        params.title !== undefined
          ? { title: params.title }
          : params.archived !== undefined
            ? { archived: params.archived }
            : params.pinned !== undefined
              ? { pinned: params.pinned }
              : { unread: true }
      )
      const row = await workspace.session(scope)
      await sessions
        .join(client, scope)
        .update(sessionInfoUpdate(row, sessions.status(row)))
      // Archiving and pinning move the Session's membership and order in the
      // catalog, which only a relist settles; a provider's catalog watcher may
      // be debounced or absent. A rename or a read marker moves neither.
      if (params.archived !== undefined || params.pinned !== undefined)
        await client.notify(AOS_METHODS.notify.catalogInvalidated)
      return {}
    }
  )

  app.onRequest(
    AOS_METHODS.session.steer,
    AosSteerRequestSchema,
    async ({ params }) => {
      guestFor(AOS_METHODS.session.steer)
      const scope = sessions.scope(params.sessionId)
      const { turnId } = coordinator.snapshot(scope)
      if (turnId === undefined) throw turnInProgress()
      return await workspace.steer(scope, {
        requestId: params.requestId,
        expectedTurnId: turnId,
        text: params.text,
      })
    }
  )

  app.onNotification(
    AOS_METHODS.session.focus,
    AosFocusNotificationSchema,
    ({ params }) => {
      // Read state belongs to the operator; a guest's exposure moves nothing.
      if (context.guest) return
      const report: PresenceReport = {
        sessionId: params.sessionId,
        foreground: params.foreground ?? params.sessionId !== null,
        idle: params.idle ?? false,
      }
      context.presence?.set(context.principalId, context.connectionId, report)
      if (params.sessionId === null) {
        exposure = undefined
        return context.readState.blur()
      }
      // A heartbeat re-sends an exposure this connection already acknowledged.
      if (sameExposure(exposure, report)) return
      const agentId = sessions.owner(params.sessionId)
      if (agentId === undefined) return
      exposure = report
      context.readState.focus(agentId, params.sessionId)
    }
  )

  app.onRequest(AOS_METHODS.agents.list, withoutParams, () => {
    guestFor(AOS_METHODS.agents.list)
    return workspace.agents()
  })

  app.onRequest(
    AOS_METHODS.agents.setVisibility,
    AosSetVisibilityRequestSchema,
    ({ params }) => {
      guestFor(AOS_METHODS.agents.setVisibility)
      return workspace.setVisibility(
        params.agentId,
        params.visibility,
        params.revision
      )
    }
  )

  app.onConnect(async (connection) => {
    const { client } = connection
    try {
      await connection.initialized
    } catch {
      return
    }
    // A connection that never finished its handshake is not an open ACP
    // connection, so the opened and closed lines always pair.
    log("acp.connection.opened")
    const notify = (method: `_${string}`, params?: unknown) => {
      void client.notify(method, params).catch(() => undefined)
    }
    for (const event of context.activityFeed.snapshot())
      notify(AOS_METHODS.notify.activity, event)
    const stops = [
      context.activityFeed.subscribe((event) =>
        notify(AOS_METHODS.notify.activity, event)
      ),
      // A guest owns no roster and no catalog, and its connection ends with the
      // invitation it redeemed.
      ...(context.guest
        ? [context.guest.expire(() => connection.close())]
        : [
            context.sessionRows.subscribe((row) => {
              const member = sessions.member(row.id)
              if (member)
                void member
                  .update(sessionInfoUpdate(row, sessions.status(row)))
                  .catch(() => undefined)
            }),
            await runtime.subscribeCatalogChanges?.(() =>
              notify(AOS_METHODS.notify.catalogInvalidated)
            ),
          ]),
    ]
    await connection.closed
    log("acp.connection.closed")
    for (const stop of stops) stop?.()
    sessions.close()
    context.presence?.clear(context.principalId, context.connectionId)
    context.readState.close()
    context.activityFeed.close()
  })

  return app
}) satisfies AosAcpAgentFactory
