import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentContext,
  type ResumeSessionRequest,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  createOwner,
  defaultClock,
  ownerSetup,
  type Logger,
  type OwnerContext,
} from "../../lifecycle"
import { SessionCreateResponseSchema } from "../../protocol"
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
import type { Catalog } from "../core/catalog"
import { SILENT, unlessAborted } from "../core/channel"
import type { ServerAttachmentStage, SessionPatch } from "../core/runtime"
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
  type WorkspaceEvent,
} from "../core/member"
import { createMemberEncoder, type ClientReply } from "./member-encoder"
import { shownAnswers } from "./translate/requests"
import type { AcpConnectionContext, AosAcpAgentFactory } from "./types"
import {
  authenticationRequired,
  errorNotificationOf,
  invalidParams,
  notFound,
  parseMeta,
  publicRequestError,
  refusalError,
} from "./validation"

/**
 * The per-connection ACP v2 agent that fronts the catalog, the channels and
 * the coordinator.
 * One handler per method: it validates `_meta.aos`, runs its command through
 * the member stack, and leaves what reaches a Session's members to its
 * channel.
 */

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
function operatorExtensions(catalog: Catalog): AosExtensions {
  return {
    steer: true,
    rewind: true,
    composerPrefill: true,
    agents: true,
    invalidation: catalog.invalidation.signaled,
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

/** What moves a connection: its handshake landing, and its socket closing. */
type ConnectionSignal = { type: "initialized" } | { type: "closed" }

/**
 * One connection's lifetime: handshaking until `initialize` is answered, ready
 * while it serves its browser, and closed once its socket closes or its
 * handshake fails. What it holds is on its stack, so every exit releases it.
 */
function connectionMachine(logger: Logger) {
  return ownerSetup<OwnerContext, ConnectionSignal>(
    "connection",
    logger,
    defaultClock
  ).createMachine({
    context: { generation: 0 },
    initial: "handshaking",
    on: { closed: ".closed" },
    states: {
      handshaking: { on: { initialized: "ready" } },
      ready: {},
      closed: { type: "final" },
    },
  })
}

export const createAosAcpAgent = ((context: AcpConnectionContext): AgentApp => {
  const { role, translators, readState, activityFeed, catalog } = context
  const { runtime, sessions: coordinator } = context.runtimeInstance
  /** The extensions this connection is served, which `initialize` reports. */
  const extensions =
    context.authentication?.extensions ?? operatorExtensions(catalog)
  const sessions = createSessions(context, (client) =>
    createMemberEncoder({
      context,
      client,
      steerAck: runtime.translation?.steerAck,
      describe: (cause) => errorNotificationOf(runtime, cause),
      replied,
      report: (sessionId, cause) =>
        sessions.membership(sessionId)?.report(cause),
      // The upgrade's principal holds for the connection's whole life.
      live: () => context.authentication?.live() ?? true,
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

  /**
   * Decodes the client's reply to one request this connection was asked and
   * gives it through the stack. A request settled since, or never handed to
   * this member, is stale.
   */
  async function replied(
    sessionId: string,
    requestId: string,
    { kind, response }: ClientReply
  ) {
    const membership = sessions.membership(sessionId)
    if (!membership) return
    const request = membership.request(requestId)
    await perform(
      "answer",
      {
        sessionId,
        request,
        ...(kind === "permission"
          ? { reply: translators.replyFromPermission(request, response) }
          : {
              reply: translators.replyFromElicitation(request, response),
              answers: shownAnswers(request, response),
            }),
      },
      async ({ sessionId, ...answer }) => {
        await sessions
          .membership(sessionId)
          ?.answer(answer.request, answer.reply, answer.answers)
      }
    )
  }

  /** Whether this client reads older pages itself (`initialize`). */
  let clientPagesHistory = false

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
    return context.channels.olderPage(membership, {
      cursor,
      offset: decodeHistoryCursor(cursor),
    })
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
      command.fromStart ? { paged: clientPagesHistory } : undefined
    )
  }

  /**
   * Admits one user turn in a Session this connection reaches, answering once
   * the coordinator admitted or refused it; `signal` aborts the admission.
   * Only a first admission takes its stage, and a turn that never started
   * releases it: the client keeps its attachments and stages them anew.
   */
  async function send(
    command: MemberCommands["send"],
    client: AgentContext,
    signal: AbortSignal
  ): Promise<CommandResults["send"]> {
    const scope = command.scope ?? sessions.scope(command.sessionId)
    const { text, attachmentStageId, rewindSourceId } = command
    let stage: ServerAttachmentStage | undefined
    const membership = sessions.join(client, scope)
    try {
      return await membership.startTurn(
        {
          // A send without a client id is one no repeat names.
          clientId: command.clientId ?? crypto.randomUUID(),
          sent: { text, attachmentStageId, rewindSourceId },
          // Bytes were staged over REST; the prompt references the batch by
          // id and the stage appends its server-owned content to the turn.
          prepare: async () => {
            if (attachmentStageId !== undefined) {
              stage = context.attachmentStages.take(
                scope.agentId,
                scope.sessionId,
                attachmentStageId
              )
              if (!stage) throw invalidParams()
            }
            return {
              prompt: stage ? await stage.appendTo(text) : text,
              ...(rewindSourceId === undefined ? {} : { rewindSourceId }),
              ...(stage ? { stage } : {}),
            }
          },
        },
        () => echoedParts(command.content, stage?.artifactIds?.() ?? []),
        { quota: command.quota, signal }
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
      : await catalog.info().catch((cause: unknown) => {
          throw publicRequestError(runtime, cause)
        })
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: {
        name: "aos-proxy",
        ...(info ? { title: info.runtime.name } : {}),
        // The build the proxy serves, so a tab running another one reloads; a
        // proxy serving none versions the AOS extension contract instead.
        version: context.buildId ?? `${AOS_EXTENSION_VERSION}`,
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
        const page = await catalog.list(agentId, offset)
        sessions.remember(page.rows)
        return page
      }
    )
    return {
      sessions: listed.rows.map(sessionInfoOf),
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
      // A prompt its client cancelled is answered as cancelled, and its
      // admission is aborted: one the provider may have taken leaves its turn
      // uncertain until the coordinator settles it.
      const { messageId } = await unlessAborted(
        perform(
          "send",
          {
            sessionId: params.sessionId,
            content: promptParts(params.prompt),
            text,
            ...meta,
          },
          (command) => send(command, client, signal)
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
        return {
          models: await context.channels.switchModel(
            sessions.scope(command.sessionId),
            command.write,
            sessions.membership(command.sessionId)
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

  app.onRequest(methods.agent.session.delete, async ({ params }) => {
    admit(methods.agent.session.delete, "delete")
    await perform(
      "delete",
      { sessionId: params.sessionId },
      async (command) => {
        const scope = sessions.scope(command.sessionId)
        await catalog.delete(scope)
        sessions.forget(scope)
      }
    )
    return {}
  })

  app.onRequest(
    AOS_METHODS.session.update,
    undecoded,
    async ({ params: raw }) => {
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
        // The new row reaches each member of the Session; a connection that
        // is not one is not made one.
        (command) =>
          catalog.update(sessions.scope(command.sessionId), command.patch)
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
    return await perform("agents", {}, () => catalog.agents())
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
          catalog.setVisibility(
            command.agentId,
            command.visibility,
            command.revision
          )
      )
    }
  )

  app.onConnect(async (connection) => {
    const logger = context.ownerLogger ?? SILENT
    const owner = createOwner(connectionMachine(logger), {
      logger,
      clock: defaultClock,
      bindings: { connectionId: context.connectionId, role },
    })
    const { stack } = owner
    stack.defer(() => {
      sessions.close()
      context.presence?.clear(context.principalId, context.connectionId)
      readState?.close()
    })
    try {
      await connection.initialized
    } catch {
      // A handshake that failed, or a socket closed before it, opened nothing.
      owner.actor.send({ type: "closed" })
      return
    }
    owner.actor.send({ type: "initialized" })
    // A connection that never finished its handshake is not an open ACP
    // connection, so the opened and closed lines always pair.
    log("acp.connection.opened")
    // The workspace's events reach this connection as its stack shows them.
    const show = (event: WorkspaceEvent) =>
      sessions.show(connection.client, event)
    if (activityFeed)
      stack.defer(
        activityFeed.open((activity) => show({ kind: "activity", activity }))
      )
    stack.defer(
      catalog.invalidation.subscribe(() =>
        show({ kind: "catalog-invalidated" })
      )
    )
    // A connection that authenticated over ACP ends with its credential.
    const expiry = context.authentication?.expire(() => connection.close())
    if (expiry) stack.defer(expiry)
    await connection.closed
    log("acp.connection.closed")
    owner.actor.send({ type: "closed" })
  })

  return app
}) satisfies AosAcpAgentFactory
