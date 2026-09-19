import {
  agent,
  methods,
  ContentBlock,
  RequestError,
  type AgentApp,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  ACP_PROTOCOL_VERSION,
  AOS_AUTH_METHOD_INVITE,
  AOS_EXTENSION_VERSION,
  AOS_METHODS,
  AOS_ATTACHMENT_URI_SCHEME,
  AOS_META_KEY,
  AosFocusNotificationSchema,
  AosPromptMetaSchema,
  AosSessionListMetaSchema,
  AosSessionNewMetaSchema,
  AosSessionResumeMetaSchema,
  AosSessionUpdateRequestSchema,
  AosSetVisibilityRequestSchema,
  AosSteerRequestSchema,
  type AosExtensions,
} from "../../protocol/acp"
import { buildNewTurnInput } from "../routes/runs"
import {
  commandsUpdate,
  createSessions,
  executionMeta,
  sessionInfoMeta,
  sessionInfoOf,
  sessionInfoUpdate,
  usageUpdate,
  decodeCursor,
  encodeCursor,
} from "./agent-sessions"
import type { SessionAttachment } from "./session-attachment"
import type { AcpConnectionContext, AosAcpAgentFactory } from "./types"
import { invalidRequest, parseMeta, runInProgress } from "./validation"

/**
 * The per-connection ACP v2 agent that fronts the coordinator and the runtime.
 * One handler per method: it validates `_meta.aos`, calls the same normalized
 * operations the HTTP routes call, and leaves the run stream itself to the
 * Session attachment.
 */

/** The bounded history one `replayFrom: { type: "start" }` resume replays. */
const HISTORY_REPLAY_LIMIT = 500
/** One `session/list` page; the cursor carries the next offset. */
const SESSION_LIST_LIMIT = 50

/** Extension methods with no params still need a parser for the SDK. */
const withoutParams = () => undefined

/** Every AOS extension is implemented; only the guest projection is a lane. */
const EXTENSIONS = {
  steer: true,
  rewind: true,
  artifacts: true,
  composerPrefill: true,
  agents: true,
  invalidation: true,
  activity: true,
  readState: true,
  focus: true,
} satisfies Omit<AosExtensions, "guestProjection">

const INVITE_AUTH_METHOD = {
  type: "agent",
  methodId: AOS_AUTH_METHOD_INVITE,
  name: "Invitation",
} as const

/** Text, or a link to a batch the browser staged over REST. */
function isPromptBlock(block: ContentBlock) {
  return (
    ContentBlock.isText(block) ||
    (block.type === "resource_link" &&
      typeof block.uri === "string" &&
      block.uri.startsWith(AOS_ATTACHMENT_URI_SCHEME))
  )
}

/** ACP text blocks joined the way the normalized wire carries a turn. */
function promptText(prompt: readonly ContentBlock[]) {
  return prompt
    .filter(ContentBlock.isText)
    .map(({ text }) => text)
    .join("\n")
}

/** Runs work once the response for the current request has been written. */
function afterResponse(
  attachment: SessionAttachment,
  task: () => Promise<void>
) {
  setTimeout(() => {
    void task().catch((cause: unknown) => attachment.report(cause))
  }, 0)
}

export const createAosAcpAgent = ((context: AcpConnectionContext): AgentApp => {
  const { lane, translators } = context
  const { runtime, sessions: coordinator } = context.runtimeInstance
  const sessions = createSessions(context)
  const { workspace } = sessions

  const app = agent({ name: "aos-proxy" })

  app.onRequest(methods.agent.initialize, async () => {
    const info = await workspace.info()
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      info: {
        name: "aos-proxy",
        title: info.runtime.name,
        // The proxy versions the AOS extension contract, not a build.
        version: `${AOS_EXTENSION_VERSION}`,
      },
      capabilities: {
        session: { prompt: { image: {}, embeddedContext: {} }, delete: {} },
      },
      authMethods: lane === "guest" ? [INVITE_AUTH_METHOD] : [],
      _meta: {
        [AOS_META_KEY]: {
          version: AOS_EXTENSION_VERSION,
          lane,
          extensions: { ...EXTENSIONS, guestProjection: lane === "guest" },
        },
      },
    }
  })

  // The operator lane authenticates the WebSocket upgrade, and the guest lane
  // redeems its invitation token in Phase C.
  app.onRequest(methods.agent.auth.login, () => {
    throw RequestError.methodNotFound(methods.agent.auth.login)
  })

  app.onRequest(methods.agent.session.new, async ({ params, client }) => {
    const meta = parseMeta(AosSessionNewMetaSchema, params._meta)
    const publicSessionId = await workspace.create(meta.agentId, meta.title)
    const scope = workspace.scope(meta.agentId, publicSessionId)
    const row = await workspace.session(scope)
    sessions.remember([row])
    const capabilities = await workspace.capabilities(scope)
    const models = await workspace.models(scope)
    const attachment = sessions.attach(client, scope)
    afterResponse(attachment, async () => {
      await attachment.update(commandsUpdate(capabilities))
      await attachment.update(usageUpdate(await workspace.usage(scope)))
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
      ...(next < page.total ? { nextCursor: encodeCursor(next) } : {}),
    }
  })

  app.onRequest(methods.agent.session.resume, async ({ params, client }) => {
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
    const attachment = sessions.attach(client, scope)
    if (params.replayFrom?.type === "start")
      for (const update of translators.translateHistory(
        await workspace.history(scope, HISTORY_REPLAY_LIMIT),
        lane
      ))
        await attachment.update(update)
    // A cursor for another run cannot position this one, and a cursor beyond
    // bounded replay cannot be served: both need a full reload.
    const live = coordinator.snapshot(scope)
    const positioned = meta.runId === undefined || meta.runId === live.runId
    let resync = !positioned
    try {
      await attachment.attach(positioned ? meta.after : undefined)
    } catch {
      resync = true
    }
    const execution = coordinator.snapshot(scope)
    afterResponse(attachment, async () => {
      await attachment.reportExecution()
      if (coordinator.state(scope) === "waiting-for-input")
        await attachment.reissuePending()
    })
    return {
      configOptions: translators.configOptionsOf(await workspace.models(scope)),
      _meta: {
        [AOS_META_KEY]: {
          session: sessionInfoMeta(row, sessions.status(row)),
          execution: executionMeta(execution),
          capabilities: await workspace.capabilities(scope),
          ...(resync ? { resync: true } : {}),
        },
      },
    }
  })

  app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const meta = parseMeta(AosPromptMetaSchema, params._meta)
    if (!params.prompt.every(isPromptBlock)) throw invalidRequest()
    const text = promptText(params.prompt)
    if (!text) throw invalidRequest()
    const scope = sessions.scope(params.sessionId)
    await workspace.session(scope)
    if (coordinator.state(scope) !== "idle") throw runInProgress()
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
    const input = buildNewTurnInput({
      threadId: scope.threadId,
      runId: crypto.randomUUID(),
      messageId,
      content: stage ? await stage.appendTo(text) : text,
      ...(meta.rewindSourceId === undefined
        ? {}
        : { rewindSourceId: meta.rewindSourceId }),
    })
    const attachment = sessions.attach(client, scope)
    afterResponse(attachment, async () => {
      await attachment.update({
        sessionUpdate: "user_message",
        messageId,
        content: params.prompt,
      })
      await attachment.startTurn(input, stage)
    })
    return { _meta: { [AOS_META_KEY]: { messageId } } }
  })

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    const attachment = sessions.attached(params.sessionId)
    if (!attachment) return
    await attachment
      .cancel()
      .catch((cause: unknown) => attachment.report(cause))
  })

  app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    const scope = sessions.scope(params.sessionId)
    const write = translators.configWriteOf(params.configId, params.value)
    if (!write) throw invalidRequest()
    await workspace.updateModel(scope, write)
    return {
      configOptions: translators.configOptionsOf(await workspace.models(scope)),
    }
  })

  app.onRequest(methods.agent.session.close, ({ params }) => {
    sessions.detach(params.sessionId)
    return {}
  })

  app.onRequest(methods.agent.session.delete, async ({ params, client }) => {
    const scope = sessions.scope(params.sessionId)
    await workspace.mutate(scope, "DELETE")
    sessions.forget(scope)
    await client.notify(AOS_METHODS.notify.catalogInvalidated)
    return {}
  })

  app.onRequest(
    AOS_METHODS.session.update,
    AosSessionUpdateRequestSchema,
    async ({ params, client }) => {
      const scope = sessions.scope(params.sessionId)
      if (params.unread === false) {
        await context.readState.markRead(scope.agentId, scope.threadId)
        return {}
      }
      await workspace.mutate(
        scope,
        "PATCH",
        params.title !== undefined
          ? { title: params.title }
          : params.archived !== undefined
            ? { archived: params.archived }
            : { unread: true }
      )
      const row = await workspace.session(scope)
      await sessions
        .attach(client, scope)
        .update(sessionInfoUpdate(row, sessions.status(row)))
      return {}
    }
  )

  app.onRequest(
    AOS_METHODS.session.steer,
    AosSteerRequestSchema,
    async ({ params }) => {
      const scope = sessions.scope(params.sessionId)
      const { runId } = coordinator.snapshot(scope)
      if (runId === undefined) throw runInProgress()
      return await workspace.steer(scope, {
        requestId: params.requestId,
        expectedRunId: runId,
        text: params.text,
      })
    }
  )

  app.onNotification(
    AOS_METHODS.session.focus,
    AosFocusNotificationSchema,
    ({ params }) => {
      if (params.sessionId === null) return context.readState.blur()
      const agentId = sessions.owner(params.sessionId)
      if (agentId !== undefined)
        context.readState.focus(agentId, params.sessionId)
    }
  )

  app.onRequest(AOS_METHODS.agents.list, withoutParams, () =>
    workspace.agents()
  )

  app.onRequest(
    AOS_METHODS.agents.setVisibility,
    AosSetVisibilityRequestSchema,
    ({ params }) =>
      workspace.setVisibility(
        params.agentId,
        params.visibility,
        params.revision
      )
  )

  app.onConnect(async (connection) => {
    const { client } = connection
    try {
      await connection.initialized
    } catch {
      return
    }
    const notify = (method: `_${string}`, params?: unknown) => {
      void client.notify(method, params).catch(() => undefined)
    }
    for (const event of context.activityFeed.snapshot())
      notify(AOS_METHODS.notify.activity, event)
    const stops = [
      context.activityFeed.subscribe((event) =>
        notify(AOS_METHODS.notify.activity, event)
      ),
      context.sessionRows.subscribe((row) => {
        const attachment = sessions.attached(row.id)
        if (attachment)
          void attachment
            .update(sessionInfoUpdate(row, sessions.status(row)))
            .catch(() => undefined)
      }),
      await runtime.subscribeCatalogChanges?.(() =>
        notify(AOS_METHODS.notify.catalogInvalidated)
      ),
    ]
    await connection.closed
    for (const stop of stops) stop?.()
    sessions.close()
    context.readState.close()
    context.activityFeed.close()
  })

  return app
}) satisfies AosAcpAgentFactory
