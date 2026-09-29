import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentContext,
  type JsonRpcId,
  type ResumeSessionRequest,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  createOwner,
  defaultClock,
  ownerSetup,
  type Clock,
  type Logger,
  type OwnerContext,
} from "../../lifecycle"
import { SessionCreateResponseSchema } from "../../protocol"
import {
  ACP_PROTOCOL_VERSION,
  AOS_ACP_AGENTS_PATH,
  AOS_EXTENSION_VERSION,
  AOS_METHODS,
  AOS_META_KEY,
  AosFocusRequestSchema,
  AosLoginMetaSchema,
  AosPromptMetaSchema,
  AosAgentUpdateRequestSchema,
  AosClientCapabilitiesMetaSchema,
  AosReplayBeforeSchema,
  AosSessionListMetaSchema,
  AosSessionNewMetaSchema,
  AosSessionPartRequestSchema,
  AosSessionResumeMetaSchema,
  AosSessionUpdateRequestSchema,
  AosSteerRequestSchema,
  type AosExtensions,
} from "../../protocol/acp"
import type { Catalog } from "../core/catalog"
import { unlessAborted } from "../core/channel"
import type { PresenceReport } from "../push/presence"
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
  publicCodeOf,
  publicRequestError,
  refusalError,
} from "./validation"

/**
 * The per-connection ACP v2 agent that fronts the catalog and the channels.
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
export function connectionMachine(logger: Logger, clock: Clock) {
  return ownerSetup<OwnerContext, ConnectionSignal>(
    "connection",
    logger,
    clock
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
  /** The extensions this connection is served, which `initialize` reports. */
  const extensions =
    context.authentication?.extensions ?? operatorExtensions(catalog)
  const sessions = createSessions(context, (client) =>
    createMemberEncoder({
      context,
      client,
      steerAck: context.steerAck,
      describe: (cause) => errorNotificationOf(context.publicError, cause),
      replied,
      elicits: (mode) => elicitationModes.has(mode),
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

  /**
   * Runs one decoded command through the stack, its refusals as ACP errors. A
   * failed command writes one line, naming the request that sent it.
   */
  async function perform<K extends CommandKind>(
    kind: K,
    command: MemberCommands[K],
    execute: CommandNext<K>,
    requestId?: JsonRpcId
  ): Promise<CommandResults[K]> {
    try {
      return await runCommand(stack(), kind, command, execute)
    } catch (cause) {
      const error =
        cause instanceof CommandRefusedError
          ? refusalError(cause.refusal)
          : publicRequestError(context.publicError, cause)
      context.logger.warn(
        { command: kind, requestId, errorCode: publicCodeOf(error) },
        "connection.command.failed"
      )
      throw error
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

  /**
   * The Agent a request addresses: the connection's own, which a request may
   * name but not replace, or on the shared address the one it names.
   */
  function agentOf(named: string | undefined) {
    if (context.agentId === undefined) return named
    if (named !== undefined && named !== context.agentId) throw invalidParams()
    return context.agentId
  }

  /** Whether this client reads older pages itself (`initialize`). */
  let clientPagesHistory = false
  /** The elicitation modes this client declared it answers (`initialize`). */
  let elicitationModes = new Set<string>()

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
    return context.channels.resume(membership, command, {
      fromStart: command.fromStart,
      paged: clientPagesHistory,
    })
  }

  /**
   * Admits one user turn in a Session this connection reaches, answering once
   * the coordinator admitted or refused it; `signal` aborts the admission.
   * Only a first admission takes its stage, and the coordinator releases it
   * if the turn never starts: the client keeps its attachments and stages them
   * anew.
   */
  async function send(
    command: MemberCommands["send"],
    client: AgentContext,
    signal: AbortSignal
  ): Promise<CommandResults["send"]> {
    const scope = command.scope ?? sessions.scope(command.sessionId)
    const { text, attachmentStageId, rewindSourceId } = command
    let stage: ReturnType<typeof context.attachmentStages.take>
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
            let prompt = text
            try {
              if (stage) prompt = await stage.appendTo(text)
            } catch (cause) {
              // The coordinator never took the stage, so it is released here.
              await stage
                ?.cleanup()
                .catch((err: unknown) =>
                  context.logger.warn({ err }, "turn.stage.cleanup_failed")
                )
              throw cause
            }
            return {
              prompt,
              ...(rewindSourceId === undefined ? {} : { rewindSourceId }),
              ...(stage ? { stage } : {}),
            }
          },
        },
        () => echoedParts(command.content, stage?.artifactIds?.() ?? []),
        { quota: command.quota, signal }
      )
    } finally {
      membership.joined()
    }
  }

  app.onRequest(methods.agent.initialize, async ({ params }) => {
    const client = AosClientCapabilitiesMetaSchema.safeParse(
      params.capabilities?._meta?.[AOS_META_KEY] ?? {}
    )
    clientPagesHistory = client.success && client.data.historyPages
    const { elicitation } = params.capabilities ?? {}
    elicitationModes = new Set(
      (["form", "url"] as const).filter((mode) => elicitation?.[mode] != null)
    )
    // A connection still to authenticate learns nothing about the deployment
    // it reached.
    const { authentication } = context
    const info = authentication
      ? undefined
      : await catalog.info().catch((cause: unknown) => {
          throw publicRequestError(context.publicError, cause)
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
        // Text and resource links are every agent's baseline; no runtime port
        // takes an image or embedded context, so neither is advertised.
        session: authentication ? {} : { delete: {} },
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
    context.handshakeComplete?.()
    return {}
  })

  app.onRequest(
    methods.agent.session.new,
    async ({ params, client, requestId }) => {
      admit(methods.agent.session.new, "new")
      const meta = parseMeta(AosSessionNewMetaSchema, params._meta)
      const agentId = agentOf(meta.agentId)
      if (agentId === undefined)
        throw invalidParams(
          `name the Agent, or connect to ${AOS_ACP_AGENTS_PATH}/<agentId>`
        )
      const { sessionId } = await perform(
        "new",
        {
          agentId,
          ...(meta.title === undefined ? {} : { title: meta.title }),
          ...(meta.clientId === undefined ? {} : { clientId: meta.clientId }),
        },
        async ({ agentId, ...input }) => {
          // A repeat of a client id answers the Session its first create made.
          const created = SessionCreateResponseSchema.parse(
            await context.channels.createSession(
              agentId,
              input,
              context.principalId
            )
          )
          const sessionId = created.session.id
          sessions.remember([{ id: sessionId, agentId }])
          // The row, capabilities and model options follow the answer as
          // updates.
          sessions.join(client, sessions.scope(sessionId)).joined()
          return { sessionId }
        },
        requestId
      )
      return { sessionId }
    }
  )

  app.onRequest(methods.agent.session.list, async ({ params, requestId }) => {
    admit(methods.agent.session.list, "list")
    const meta = parseMeta(AosSessionListMetaSchema, params._meta)
    const agentId = agentOf(meta.agentId)
    const listed = await perform(
      "list",
      {
        ...(agentId === undefined ? {} : { agentId }),
        offset: decodeCursor(params.cursor),
      },
      async ({ agentId, offset }) => {
        const page = await catalog.list(agentId, offset)
        sessions.remember(page.rows)
        return page
      },
      requestId
    )
    return {
      sessions: listed.rows.map(sessionInfoOf),
      ...(listed.nextOffset === undefined
        ? {}
        : { nextCursor: encodeCursor(listed.nextOffset) }),
    }
  })

  app.onRequest(
    methods.agent.session.resume,
    async ({ params, client, requestId }) => {
      const method = methods.agent.session.resume
      stack()
      const cursor = olderPageCursor(params.replayFrom)
      if (cursor !== undefined) {
        admit(method, "older-page")
        const { page } = await perform(
          "older-page",
          { sessionId: params.sessionId, cursor },
          replayOlder,
          requestId
        )
        return { _meta: { [AOS_META_KEY]: { history: historyCursor(page) } } }
      }
      admit(method, "resume")
      const meta = parseMeta(AosSessionResumeMetaSchema, params._meta)
      const agentId = agentOf(meta.agentId)
      const resumed = await perform(
        "resume",
        {
          sessionId: params.sessionId,
          ...meta,
          ...(agentId === undefined ? {} : { agentId }),
          fromStart: params.replayFrom?.type === "start",
        },
        (command) => resume(command, client),
        requestId
      )
      const { history } = resumed
      return {
        _meta: {
          [AOS_META_KEY]: {
            ...(history === undefined
              ? {}
              : { history: historyCursor(history) }),
          },
        },
      }
    }
  )

  app.onRequest(
    methods.agent.session.prompt,
    async ({ params, client, signal, requestId }) => {
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
          (command) => send(command, client, signal),
          requestId
        ),
        signal
      )
      return { messageId }
    }
  )

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    context.logger.info({ sessionId: params.sessionId }, "acp.turn.cancel")
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

  app.onRequest(
    methods.agent.session.setConfigOption,
    async ({ params, requestId }) => {
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
        },
        requestId
      )
      return { configOptions: translators.configOptionsOf(models) }
    }
  )

  app.onRequest(methods.agent.session.close, async ({ params, requestId }) => {
    admit(methods.agent.session.close, "close")
    await perform(
      "close",
      { sessionId: params.sessionId },
      // As ACP closes a Session: its work stops, for every member, and then
      // this connection leaves it.
      async (command) => {
        const membership = sessions.membership(command.sessionId)
        if (!membership) throw notFound()
        try {
          await membership.cancel()
        } finally {
          sessions.part(command.sessionId)
        }
      },
      requestId
    )
    return {}
  })

  app.onRequest(methods.agent.session.delete, async ({ params, requestId }) => {
    admit(methods.agent.session.delete, "delete")
    await perform(
      "delete",
      { sessionId: params.sessionId },
      async (command) => {
        const agentId = sessions.owner(command.sessionId) ?? context.agentId
        const scope = agentId && catalog.scope(agentId, command.sessionId)
        // A Session nobody can find is already gone.
        if (scope) {
          try {
            await catalog.delete(scope)
          } catch (cause) {
            if (
              publicCodeOf(publicRequestError(context.publicError, cause)) !==
              "not_found"
            )
              throw cause
          }
        }
        sessions.forget(command.sessionId)
      },
      requestId
    )
    return {}
  })

  // Leaves a Session this connection joined, whose work goes on for the rest.
  app.onRequest(
    AOS_METHODS.session.part,
    undecoded,
    async ({ params: raw }) => {
      stack()
      const { sessionId } = AosSessionPartRequestSchema.parse(raw)
      sessions.part(sessionId)
      return {}
    }
  )

  app.onRequest(
    AOS_METHODS.session.update,
    undecoded,
    async ({ params: raw, requestId }) => {
      admit(AOS_METHODS.session.update, "update")
      const params = AosSessionUpdateRequestSchema.parse(raw)
      const patch: MemberCommands["update"]["patch"] =
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
          catalog.update(sessions.scope(command.sessionId), command.patch),
        requestId
      )
      return {}
    }
  )

  app.onRequest(
    AOS_METHODS.session.steer,
    undecoded,
    async ({ params: raw, requestId }) => {
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
        },
        requestId
      )
    }
  )

  app.onRequest(
    AOS_METHODS.session.focus,
    undecoded,
    async ({ params: raw, requestId }) => {
      admit(AOS_METHODS.session.focus, "focus")
      const { sessionId, foreground, idle } = AosFocusRequestSchema.parse(raw)
      // A report naming no Session changes nothing; its answer is what the
      // browser probes its link for.
      if (sessionId === undefined) return {}
      await perform(
        "focus",
        {
          sessionId,
          foreground: foreground ?? sessionId !== null,
          idle: idle ?? false,
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
        },
        requestId
      )
      return {}
    }
  )

  app.onRequest(
    AOS_METHODS.agents.list,
    withoutParams,
    async ({ requestId }) => {
      admit(AOS_METHODS.agents.list, "agents")
      return await perform("agents", {}, () => catalog.agents(), requestId)
    }
  )

  app.onRequest(
    AOS_METHODS.agents.update,
    undecoded,
    async ({ params: raw, requestId }) => {
      admit(AOS_METHODS.agents.update, "update-agent")
      const { agentId, revision, ...patch } =
        AosAgentUpdateRequestSchema.parse(raw)
      return await perform(
        "update-agent",
        { agentId, patch, revision },
        (command) =>
          catalog.updateAgent(command.agentId, command.patch, command.revision),
        requestId
      )
    }
  )

  app.onConnect(async (connection) => {
    const { logger } = context
    // The connection's logger already carries its `connectionId` and `role`.
    const owner = createOwner(
      connectionMachine(logger, context.clock ?? defaultClock),
      {
        logger,
        clock: context.clock ?? defaultClock,
        bindings: {},
      }
    )
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
    // A connection that authenticates over ACP completes it at its login.
    if (!context.authentication) context.handshakeComplete?.()
    owner.actor.send({ type: "initialized" })
    // A connection that never finished its handshake is not an open ACP
    // connection, so the opened and closed lines always pair.
    logger.info({}, "acp.connection.opened")
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
    logger.info({}, "acp.connection.closed")
    owner.actor.send({ type: "closed" })
  })

  return app
}) satisfies AosAcpAgentFactory
