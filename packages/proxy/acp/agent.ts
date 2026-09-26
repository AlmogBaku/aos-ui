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
  SessionCreateResponseSchema,
  type SessionHistoryResponse,
} from "../../protocol"
import {
  ACP_PROTOCOL_VERSION,
  AOS_EXTENSION_VERSION,
  AOS_METHODS,
  AOS_META_KEY,
  AosFocusNotificationSchema,
  AosLoginMetaSchema,
  AosPromptMetaSchema,
  AosClientCapabilitiesMetaSchema,
  AosReplayBeforeSchema,
  AosSessionListMetaSchema,
  AosSessionNewMetaSchema,
  AosSessionResumeMetaSchema,
  AosSessionUpdateRequestSchema,
  AosSetVisibilityRequestSchema,
  AosSteerRequestSchema,
  type AosExtensions,
} from "../../protocol/acp"
import { unlessAborted } from "../core/channel"
import {
  type ServerRuntime,
  type SessionPatch,
  type SessionScope,
} from "../core/runtime"
import type { PresenceReport } from "../push/presence"
import { redactForLog } from "../redaction"
import {
  createSessions,
  sessionInfoOf,
  decodeCursor,
  decodeHistoryCursor,
  encodeCursor,
  historyCursor,
} from "./agent-sessions"
import {
  echoedParts,
  isPromptBlock,
  promptParts,
  promptText,
} from "./prompt-content"
import {
  admits,
  CommandRefusedError,
  runCommand,
  type CommandKind,
  type CommandNext,
  type CommandResults,
  type Middleware,
  type MemberCommands,
} from "../core/member"
import { createMemberEncoder } from "./member-encoder"
import type { AcpConnectionContext, AosAcpAgentFactory } from "./types"
import {
  authenticationRequired,
  invalidParams,
  notFound,
  parseMeta,
  publicRequestError,
  refusalError,
} from "./validation"

/**
 * The per-connection ACP v2 agent that fronts the coordinator and the runtime.
 * One handler per method: it validates `_meta.aos`, runs its command through
 * the member stack, and leaves what reaches a Session's members to its
 * channel.
 */

/** The bounded history one `replayFrom: { type: "start" }` resume replays. */
const HISTORY_REPLAY_LIMIT = 500
/** One `session/list` page; the cursor carries the next offset. */
const SESSION_LIST_LIMIT = 50

/** Extension methods with no params still need a parser for the SDK. */
const withoutParams = () => undefined

/**
 * Hands an extension method its params undecoded, so its handler refuses a
 * method the stack does not admit before it parses them.
 */
const undecoded = (params: unknown) => params

/**
 * The operator listener's extensions. The proxy implements each of them itself,
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
    historyPages: true,
  }
}

/**
 * The `_aos/before` cursor a resume names, or `undefined` for no replay or
 * `start`. ACP asks a receiver to refuse a cursor it does not understand
 * rather than guess where to replay from, so every other one is refused.
 */
function olderPageCursor(replayFrom: ResumeSessionRequest["replayFrom"]) {
  if (!replayFrom || replayFrom.type === "start") return undefined
  const parsed = AosReplayBeforeSchema.safeParse(replayFrom)
  if (!parsed.success) throw invalidParams()
  return parsed.data.cursor
}

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
  const { role, translators, readState, activityFeed } = context
  const { runtime, sessions: coordinator } = context.runtimeInstance
  /**
   * The extensions this connection is served: it signals catalog changes only
   * when they include invalidation.
   */
  const extensions =
    context.authentication?.extensions ?? operatorExtensions(runtime)
  const sessions = createSessions(context, (client) =>
    createMemberEncoder({
      context,
      client,
      membership: (sessionId) => sessions.membership(sessionId),
      answer: (command) =>
        perform("answer", command, async ({ sessionId, ...answer }) => {
          await sessions
            .membership(sessionId)
            ?.answer(answer.request, answer.reply, answer.answers)
        }),
    })
  )
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
        role,
        ...fields,
      })
    )
  }

  /**
   * This connection's member stack. A guest that has not redeemed an
   * invitation reaches nothing.
   */
  function stack(): readonly Middleware[] {
    const identity = sessions.identity()
    if (!identity) throw authenticationRequired()
    return identity.middleware
  }

  /**
   * Refuses a method the stack does not admit, before its params are decoded,
   * so a refused method is unavailable however its params are spelled.
   */
  function admit(method: string, kind: CommandKind) {
    if (!admits(stack(), kind)) throw RequestError.methodNotFound(method)
  }

  /** Runs one decoded command through the stack, its refusals as ACP errors. */
  async function perform<K extends CommandKind>(
    kind: K,
    command: MemberCommands[K],
    execute: CommandNext<K>
  ): Promise<CommandResults[K]> {
    try {
      return await runCommand(stack(), kind, command, execute)
    } catch (cause) {
      throw cause instanceof CommandRefusedError
        ? refusalError(cause.refusal)
        : publicRequestError(runtime, cause)
    }
  }

  /** One history page, `offset` rows back from the newest. */
  function readHistory(scope: SessionScope, offset = 0) {
    return runtime.history(
      scope.agentId,
      scope.providerSessionId,
      HISTORY_REPLAY_LIMIT,
      offset
    )
  }

  /** Whether this client reads older pages itself (`initialize`). */
  let clientPagesHistory = false

  /**
   * The history a from-start resume replays. ACP replays all retained
   * history; a client that pages older history itself gets the newest page
   * and the cursor before it. Either way the reach bounds the reading.
   */
  async function readReplay(scope: SessionScope) {
    const newest = await readHistory(scope)
    if (clientPagesHistory) return newest
    const older: SessionHistoryResponse["messages"][] = []
    // A turn stored between two reads shifts the offsets, so the same message
    // can come back on the next older page.
    const seen = new Set(newest.messages.map(({ id }) => id))
    let page = newest
    while (historyCursor(page).nextCursor !== undefined) {
      page = await readHistory(scope, page.nextOffset)
      older.unshift(page.messages.filter(({ id }) => !seen.has(id)))
      for (const { id } of page.messages) seen.add(id)
    }
    return {
      ...newest,
      messages: [...older.flat(), ...newest.messages],
      nextOffset: page.nextOffset,
      truncated: page.truncated,
    }
  }

  /** The Sessions this connection is reading an older page of. */
  const paging = new Set<string>()

  /**
   * One older page of a Session this connection resumed, however it did, as
   * tagged updates ahead of the reply.
   */
  async function replayOlder({
    sessionId,
    cursor,
  }: MemberCommands["older-page"]): Promise<CommandResults["older-page"]> {
    const membership = sessions.membership(sessionId)
    if (!membership) throw notFound()
    const offset = decodeHistoryCursor(cursor)
    if (paging.has(sessionId)) throw invalidParams()
    paging.add(sessionId)
    try {
      const page = await readHistory(membership.scope, offset)
      // A cursor past this Session's history was never issued for it. One at
      // its end was: a runtime that estimates `total` learns the start only
      // by reading an empty page there.
      if (offset > page.total) throw invalidParams()
      await membership.showOlderPage(page, { cursor, offset })
      return { page }
    } finally {
      paging.delete(sessionId)
    }
  }

  /**
   * Resumes one Session on this connection and follows it. A command that
   * names its `scope` addresses a Session outside this connection's catalog,
   * and adopts nothing.
   */
  async function resume(
    command: MemberCommands["resume"],
    client: AgentContext
  ): Promise<CommandResults["resume"]> {
    if (!command.scope && command.agentId !== undefined)
      sessions.adopt(command.sessionId, command.agentId)
    const membership = sessions.join(
      client,
      command.scope ?? sessions.scope(command.sessionId)
    )
    return context.channels.resume(
      membership,
      command,
      command.fromStart ? () => readReplay(membership.scope) : undefined
    )
  }

  /**
   * Admits one user turn in a Session this connection reaches, answering once
   * the coordinator admitted or refused it. A turn that never started
   * releases its stage: the client keeps its attachments and stages them anew.
   */
  async function send(
    command: MemberCommands["send"],
    client: AgentContext
  ): Promise<CommandResults["send"]> {
    const scope = command.scope ?? sessions.scope(command.sessionId)
    // Bytes were staged over REST; the prompt references the batch by id and
    // the stage appends its server-owned content to the user turn.
    const { attachmentStageId, clientId } = command
    const stage =
      attachmentStageId === undefined
        ? undefined
        : context.attachmentStages.take(
            scope.agentId,
            scope.sessionId,
            attachmentStageId
          )
    if (attachmentStageId !== undefined && !stage) throw invalidParams()
    const membership = sessions.join(client, scope)
    try {
      const prompt = {
        prompt: stage ? await stage.appendTo(command.text) : command.text,
        ...(command.rewindSourceId === undefined
          ? {}
          : { rewindSourceId: command.rewindSourceId }),
      }
      return await membership.startTurn(
        clientId === undefined
          ? {
              turnId: crypto.randomUUID(),
              messageId: crypto.randomUUID(),
              ...prompt,
            }
          : { clientId, ...prompt },
        echoedParts(command.content, stage?.artifactIds?.() ?? []),
        { stage, quota: command.quota }
      )
    } catch (cause) {
      await stage?.cleanup().catch(() => undefined)
      throw cause
    } finally {
      membership.joined()
    }
  }

  app.onRequest(methods.agent.initialize, async ({ params }) => {
    const client = AosClientCapabilitiesMetaSchema.safeParse(
      params.capabilities?._meta?.[AOS_META_KEY] ?? {}
    )
    clientPagesHistory = client.success && client.data.historyPages
    // A connection still to authenticate learns nothing about the deployment
    // it reached.
    const { authentication } = context
    const info = authentication
      ? undefined
      : await runtime.runtimeInfo().catch((cause: unknown) => {
          throw publicRequestError(runtime, cause)
        })
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
          ...(authentication ? {} : { delete: {} }),
        },
      },
      authMethods: authentication ? [...authentication.authMethods] : [],
      _meta: {
        [AOS_META_KEY]: {
          version: AOS_EXTENSION_VERSION,
          role,
          extensions,
        },
      },
    }
  })

  // The operator listener authenticates its WebSocket upgrade instead.
  app.onRequest(methods.agent.auth.login, async ({ params }) => {
    const { authentication } = context
    if (!authentication)
      throw RequestError.methodNotFound(methods.agent.auth.login)
    if (
      !authentication.authMethods.some(
        ({ methodId }) => methodId === params.methodId
      )
    )
      throw authenticationRequired()
    const { token } = parseMeta(AosLoginMetaSchema, params._meta)
    if (!(await authentication.authenticate(token)))
      throw authenticationRequired()
    return {}
  })

  app.onRequest(methods.agent.session.new, async ({ params, client }) => {
    admit(methods.agent.session.new, "new")
    const meta = parseMeta(AosSessionNewMetaSchema, params._meta)
    const { sessionId } = await perform(
      "new",
      {
        agentId: meta.agentId,
        ...(meta.title === undefined ? {} : { title: meta.title }),
        ...(meta.clientId === undefined ? {} : { clientId: meta.clientId }),
      },
      async ({ agentId, ...input }) => {
        // A repeat of a client id answers the Session its first create made.
        const created = SessionCreateResponseSchema.parse(
          await coordinator.createSession(agentId, input, context.principalId)
        )
        const sessionId = created.session.id
        sessions.remember([{ id: sessionId, agentId }])
        // The row, capabilities and model options follow the answer as
        // updates.
        sessions.join(client, sessions.scope(sessionId)).joined()
        return { sessionId }
      }
    )
    return { sessionId }
  })

  app.onRequest(methods.agent.session.list, async ({ params }) => {
    admit(methods.agent.session.list, "list")
    const meta = parseMeta(AosSessionListMetaSchema, params._meta)
    const listed = await perform(
      "list",
      {
        ...(meta.agentId === undefined ? {} : { agentId: meta.agentId }),
        offset: decodeCursor(params.cursor),
      },
      async ({ agentId, offset }) => {
        const page = await (agentId === undefined
          ? runtime.listAllSessions(SESSION_LIST_LIMIT, offset)
          : runtime.listSessions(agentId, SESSION_LIST_LIMIT, offset))
        sessions.remember(page.sessions)
        context.sessionRows.rememberList(page.sessions)
        const next = offset + page.sessions.length
        return {
          rows: page.sessions.map(
            (session) =>
              context.sessionRows.get(session.agentId, session.id) ?? session
          ),
          // No cursor points past the catalog window, which no runtime serves.
          ...(next < Math.min(page.total, SESSION_CATALOG_MAX_WINDOW)
            ? { nextOffset: next }
            : {}),
        }
      }
    )
    return {
      sessions: listed.rows.map((row) =>
        sessionInfoOf(row, sessions.status(row))
      ),
      ...(listed.nextOffset === undefined
        ? {}
        : { nextCursor: encodeCursor(listed.nextOffset) }),
    }
  })

  app.onRequest(methods.agent.session.resume, async ({ params, client }) => {
    const method = methods.agent.session.resume
    stack()
    const cursor = olderPageCursor(params.replayFrom)
    if (cursor !== undefined) {
      admit(method, "older-page")
      const { page } = await perform(
        "older-page",
        { sessionId: params.sessionId, cursor },
        replayOlder
      )
      return { _meta: { [AOS_META_KEY]: { history: historyCursor(page) } } }
    }
    admit(method, "resume")
    const meta = parseMeta(AosSessionResumeMetaSchema, params._meta)
    const resumed = await perform(
      "resume",
      {
        sessionId: params.sessionId,
        ...meta,
        fromStart: params.replayFrom?.type === "start",
      },
      (command) => resume(command, client)
    )
    const { history } = resumed
    return {
      _meta: {
        [AOS_META_KEY]: {
          ...(resumed.resync ? { resync: true } : {}),
          ...(history === undefined ? {} : { history: historyCursor(history) }),
        },
      },
    }
  })

  app.onRequest(
    methods.agent.session.prompt,
    async ({ params, client, signal }) => {
      admit(methods.agent.session.prompt, "send")
      const meta = parseMeta(AosPromptMetaSchema, params._meta)
      if (!params.prompt.every(isPromptBlock)) throw invalidParams()
      const text = promptText(params.prompt)
      // A turn of attachments alone carries no text: its stage supplies the turn,
      // or, for a rewind, the turn it replaces.
      if (
        !text &&
        meta.attachmentStageId === undefined &&
        meta.rewindSourceId === undefined
      )
        throw invalidParams()
      // A prompt its client cancelled is answered as cancelled. Its admission
      // runs on: a turn admitted meanwhile streams, and a repeat of its client
      // id finds it.
      const { messageId } = await unlessAborted(
        perform(
          "send",
          {
            sessionId: params.sessionId,
            content: promptParts(params.prompt),
            text,
            ...meta,
          },
          (command) => send(command, client)
        ),
        signal
      )
      return { _meta: { [AOS_META_KEY]: { messageId } } }
    }
  )

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    log("acp.turn.cancel", { sessionId: params.sessionId })
    // An unauthenticated guest reaches nothing here.
    if (!sessions.identity()) return
    admit(methods.agent.session.cancel, "stop")
    await perform("stop", { sessionId: params.sessionId }, async (command) => {
      // Only a joined Session has a member.
      const membership = sessions.membership(command.sessionId)
      if (!membership) return
      await membership
        .cancel()
        .catch((cause: unknown) => membership.report(cause))
    })
  })

  app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    admit(methods.agent.session.setConfigOption, "set-config")
    const write = translators.configWriteOf(params.configId, params.value)
    const { models } = await perform(
      "set-config",
      { sessionId: params.sessionId, ...(write ? { write } : {}) },
      async (command) => {
        if (!command.write) throw invalidParams()
        // Every member hears the switch: this connection, if it is one, once
        // the answer is written.
        const membership = sessions.membership(command.sessionId)
        return {
          models: await coordinator.switchModel(
            sessions.scope(command.sessionId),
            command.write,
            membership &&
              ((report) => membership.afterResponse(async () => report()))
          ),
        }
      }
    )
    return { configOptions: translators.configOptionsOf(models) }
  })

  app.onRequest(methods.agent.session.close, async ({ params }) => {
    admit(methods.agent.session.close, "close")
    await perform("close", { sessionId: params.sessionId }, async (command) => {
      sessions.part(command.sessionId)
    })
    return {}
  })

  app.onRequest(methods.agent.session.delete, async ({ params, client }) => {
    admit(methods.agent.session.delete, "delete")
    await perform(
      "delete",
      { sessionId: params.sessionId },
      async (command) => {
        const scope = sessions.scope(command.sessionId)
        await runtime.deleteSession(scope.agentId, scope.providerSessionId)
        sessions.forget(scope)
        await client.notify(AOS_METHODS.notify.catalogInvalidated)
      }
    )
    return {}
  })

  app.onRequest(
    AOS_METHODS.session.update,
    undecoded,
    async ({ params: raw, client }) => {
      admit(AOS_METHODS.session.update, "update")
      const params = AosSessionUpdateRequestSchema.parse(raw)
      const patch: SessionPatch =
        params.unread === false
          ? { unread: false }
          : params.title !== undefined
            ? { title: params.title }
            : params.archived !== undefined
              ? { archived: params.archived }
              : params.pinned !== undefined
                ? { pinned: params.pinned }
                : { unread: true }
      await perform(
        "update",
        { sessionId: params.sessionId, patch },
        async (command) => {
          const scope = sessions.scope(command.sessionId)
          if ("unread" in command.patch && !command.patch.unread) {
            await readState?.markRead(scope.agentId, scope.sessionId)
            return
          }
          await runtime.updateSession(
            scope.agentId,
            scope.providerSessionId,
            command.patch
          )
          // The new row reaches each member of the Session; a connection that
          // is not one is not made one.
          await sessions.readRow(scope)
          // Archiving and pinning move the Session's membership and order in
          // the catalog, which only a relist settles; a provider's catalog
          // watcher may be debounced or absent. A rename or a read marker
          // moves neither.
          if ("archived" in command.patch || "pinned" in command.patch)
            await client.notify(AOS_METHODS.notify.catalogInvalidated)
        }
      )
      return {}
    }
  )

  app.onRequest(
    AOS_METHODS.session.steer,
    undecoded,
    async ({ params: raw }) => {
      admit(AOS_METHODS.session.steer, "steer")
      const params = AosSteerRequestSchema.parse(raw)
      return await perform(
        "steer",
        {
          sessionId: params.sessionId,
          requestId: params.requestId,
          text: params.text,
        },
        async (command) => {
          // A connection steers only a Session it joined, as it stops one.
          const membership = sessions.membership(command.sessionId)
          if (!membership) throw notFound()
          return await membership.steer(command.requestId, command.text)
        }
      )
    }
  )

  app.onNotification(
    AOS_METHODS.session.focus,
    undecoded,
    async ({ params: raw }) => {
      if (!sessions.identity()) return
      admit(AOS_METHODS.session.focus, "focus")
      const params = AosFocusNotificationSchema.parse(raw)
      await perform(
        "focus",
        {
          sessionId: params.sessionId,
          foreground: params.foreground ?? params.sessionId !== null,
          idle: params.idle ?? false,
        },
        async (report: PresenceReport) => {
          context.presence?.set(
            context.principalId,
            context.connectionId,
            report
          )
          if (report.sessionId === null) {
            exposure = undefined
            return readState?.blur()
          }
          // A heartbeat re-sends an exposure this connection already
          // acknowledged.
          if (sameExposure(exposure, report)) return
          const agentId = sessions.owner(report.sessionId)
          if (agentId === undefined) return
          exposure = report
          readState?.focus(agentId, report.sessionId)
        }
      )
    }
  )

  app.onRequest(AOS_METHODS.agents.list, withoutParams, async () => {
    admit(AOS_METHODS.agents.list, "agents")
    return await perform("agents", {}, () => runtime.listAgents())
  })

  app.onRequest(
    AOS_METHODS.agents.setVisibility,
    undecoded,
    async ({ params: raw }) => {
      admit(AOS_METHODS.agents.setVisibility, "set-visibility")
      const params = AosSetVisibilityRequestSchema.parse(raw)
      return await perform(
        "set-visibility",
        {
          agentId: params.agentId,
          visibility: params.visibility,
          revision: params.revision,
        },
        (command) =>
          runtime.updateAgentVisibility(
            command.agentId,
            command.visibility,
            command.revision
          )
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
    for (const event of activityFeed?.snapshot() ?? [])
      notify(AOS_METHODS.notify.activity, event)
    const stops = [
      activityFeed?.subscribe((event) =>
        notify(AOS_METHODS.notify.activity, event)
      ),
      extensions.invalidation
        ? await runtime.subscribeCatalogChanges?.(() =>
            notify(AOS_METHODS.notify.catalogInvalidated)
          )
        : undefined,
      // A connection that authenticated over ACP ends with its credential.
      context.authentication?.expire(() => connection.close()),
    ]
    await connection.closed
    log("acp.connection.closed")
    for (const stop of stops) stop?.()
    sessions.close()
    context.presence?.clear(context.principalId, context.connectionId)
    readState?.close()
    activityFeed?.close()
  })

  return app
}) satisfies AosAcpAgentFactory
