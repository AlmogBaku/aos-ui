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
import type { PromptTurnInput } from "../core/events"
import {
  ServerTurnConflictError,
  type ServerRuntime,
  type SessionPatch,
  type SessionScope,
} from "../core/runtime"
import type { PresenceReport } from "../push/presence"
import { redactForLog } from "../redaction"
import {
  createSessions,
  executionMeta,
  overlaidStatus,
  sessionInfoMeta,
  sessionInfoOf,
  decodeCursor,
  decodeHistoryCursor,
  encodeCursor,
  historyCursor,
} from "./agent-sessions"
import { isPromptBlock, promptParts, promptText } from "./prompt-content"
import type { RoomTurn, Seat } from "../core/channel"
import {
  admits,
  CommandRefusedError,
  promptText as roomPromptText,
  runCommand,
  type CommandKind,
  type CommandNext,
  type CommandResults,
  type Middleware,
  type MemberCommands,
} from "../core/member"
import { createMemberEncoder } from "./member-encoder"
import { beforeLiveTurn, lastPromptIndex } from "./translate/history"
import type { AcpConnectionContext, AosAcpAgentFactory } from "./types"
import {
  authenticationRequired,
  invalidRequest,
  notFound,
  parseMeta,
  refusalError,
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
    historyPages: true,
  }
}

/**
 * Where a page shows the live turn's prompt, or `-1`. A correction is a steer
 * inside the turn, so the prompt is the last user message before them.
 */
function promptIndex(turn: RoomTurn, history: SessionHistoryResponse) {
  const index = lastPromptIndex(history)
  const prompt = history.messages[index]
  if (!prompt || !Array.isArray(prompt.content)) return -1
  const text = prompt.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
  // A prompt without text matches any other, so it never names the live one.
  const expected = roomPromptText(turn.content).trim()
  return expected && text.trim() === expected ? index : -1
}

/**
 * Whether a resume already shows the live turn's prompt: its cursor sits inside
 * that turn, or the page it replayed ends on that prompt.
 */
function showsPrompt(
  turn: RoomTurn | undefined,
  meta: { turnId?: string },
  history?: SessionHistoryResponse
) {
  if (!turn) return false
  if (meta.turnId === turn.turnId) return true
  return history !== undefined && promptIndex(turn, history) >= 0
}

/**
 * Runs work once the response for the current request has been written. The
 * caller must have settled every await its response needs before calling this:
 * the task fires on the next turn of the loop, so anything still pending in the
 * handler lets these notifications reach the client before the response does.
 */
function afterResponse(member: Seat, task: () => Promise<void>) {
  setTimeout(() => {
    void task().catch((cause: unknown) => member.report(cause))
  }, 0)
}

/**
 * The `_aos/before` cursor a resume names, or `undefined` for no replay or
 * `start`. ACP asks a receiver to refuse a cursor it does not understand
 * rather than guess where to replay from, so every other one is refused.
 */
function olderPageCursor(replayFrom: ResumeSessionRequest["replayFrom"]) {
  if (!replayFrom || replayFrom.type === "start") return undefined
  const parsed = AosReplayBeforeSchema.safeParse(replayFrom)
  if (!parsed.success) throw invalidRequest()
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
  const { lane, translators } = context
  const { runtime, sessions: coordinator } = context.runtimeInstance
  const sessions = createSessions(context, (client) =>
    createMemberEncoder({
      context,
      client,
      seat: (sessionId) => sessions.member(sessionId),
      answer: (command) =>
        perform("answer", command, async ({ sessionId, ...answer }) => {
          await sessions
            .member(sessionId)
            ?.answer(answer.request, answer.reply, answer.answers)
        }),
    })
  )
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
        : cause
    }
  }

  /** One history page, `offset` rows back from the newest. */
  function readHistory(scope: SessionScope, offset = 0) {
    return workspace.history(scope, HISTORY_REPLAY_LIMIT, offset)
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
   * An older page beside a live turn the view streams from its start. A turn
   * longer than the newest page leaves its first rows on older pages too, so a
   * page holding a row stored after the turn began is cut as the newest page
   * is. A page wholly before the turn is kept, so the clock skew the cut allows
   * never drops the end of the turn before it.
   */
  function beforeStreamedTurn(
    scope: SessionScope,
    history: SessionHistoryResponse
  ) {
    const at = coordinator.replayStart(scope)?.at
    const reached =
      at !== undefined &&
      history.messages.some(
        (message) =>
          message.role !== "activity" && Date.parse(message.createdAt) >= at
      )
    return reached ? (beforeLiveTurn(history, at) ?? history) : history
  }

  /**
   * One older page of a Session this connection attached, however it did, as
   * tagged updates ahead of the reply. A page re-attaches nothing: the view
   * keeps its room, its follow, and its reports, and learns only where the
   * next page starts.
   */
  async function replayOlder({
    sessionId,
    cursor,
  }: MemberCommands["older-page"]): Promise<CommandResults["older-page"]> {
    const member = sessions.member(sessionId)
    if (!member) throw notFound()
    const offset = decodeHistoryCursor(cursor)
    if (paging.has(sessionId)) throw invalidRequest()
    paging.add(sessionId)
    try {
      const page = await readHistory(member.scope, offset)
      // A cursor past this Session's history was never issued for it. One at
      // its end was: a runtime that estimates `total` learns the start only
      // by reading an empty page there.
      if (offset > page.total) throw invalidRequest()
      await member.showHistory(beforeStreamedTurn(member.scope, page), {
        cursor,
        offset,
      })
      return { page }
    } finally {
      paging.delete(sessionId)
    }
  }

  /**
   * The page a `replayFrom: { type: "start" }` resume replays. A running turn
   * the coordinator replays from its start is shown by that replay alone: the
   * stream the member held stops before the page is read, and the page is cut
   * where the turn began, so `restarted` names the turn the view then shows
   * only while its follow streams it. A page that cannot be cut there, or a
   * turn adopted without its native start, is kept whole and its follow
   * `reset`. Any other turn keeps the page: its start is
   * gone and a cursorless follow could only reset it. A turn that starts during
   * the read waits for the page and is replayed the same way.
   */
  async function replayPage(member: Seat, scope: SessionScope) {
    const liveTurn = () => {
      const { state, turnId } = coordinator.snapshot(scope)
      return state === "idle" ? undefined : turnId
    }
    const before = liveTurn()
    const started = () => {
      const after = liveTurn()
      return after !== undefined && after !== before
    }
    const restarted = coordinator.replayStart(scope)
    member.holdRoom()
    if (restarted) await member.restartStream()
    let history: SessionHistoryResponse
    try {
      history = await readReplay(scope)
    } catch (cause) {
      // A turn that started during the read was held back, so it streams the
      // same way a restarted one does once its reload failed.
      await recoverReplay(member, restarted?.turnId, started())
      throw cause
    }
    const held = started()
    const shown =
      restarted ?? (held ? coordinator.replayStart(scope) : undefined)
    if (!shown) return { history, held }
    const cut =
      shown.at === undefined ? undefined : beforeLiveTurn(history, shown.at)
    return {
      history: cut ?? history,
      held,
      restarted: shown.turnId,
      reset: cut === undefined,
    }
  }

  /**
   * Ends the hold of a from-start replay that failed before the view was
   * rebuilt. The stream stopped on `restarted` is gone: the view is asked to
   * reload, and once that failed too, it streams the turn from its prompt, as
   * it does a turn the hold kept `held` back.
   */
  async function recoverReplay(
    member: Seat,
    restarted: string | undefined,
    held: boolean
  ) {
    member.releaseRoom()
    if (restarted ? !(await member.reloadOnce(restarted)) : held) {
      member.enterRoom(false, true)
      await member.follow().catch(() => undefined)
    }
  }

  /**
   * Rebuilds the view from the page a from-start resume replays. A page that
   * cannot reach the view recovers as a failed read does, so the room's turns
   * still reach it.
   */
  async function replayHistory(member: Seat, scope: SessionScope) {
    const replay = await replayPage(member, scope)
    try {
      // Counted on the authoritative page, before a member's stack rebuilds
      // its messages: a guest's projection keeps no user-turn metadata.
      const corrections = translators.persistedCorrections(replay.history)
      await member.showHistory(replay.history)
      return { ...replay, corrections }
    } catch (cause) {
      await recoverReplay(member, replay.restarted, replay.held)
      throw cause
    }
  }

  /**
   * Subscribes to the live turn, reporting a cursor that cannot position it.
   * A view whose stream `restarted` on a turn shows it only while this follow
   * streams that turn; a view whose page could not be cut for it is `reset`.
   */
  async function followPositioned(
    member: Seat,
    scope: SessionScope,
    meta: { turnId?: string; after?: number },
    replay?: { corrections: number; restarted?: string; reset?: boolean }
  ) {
    const positioned =
      meta.turnId === undefined ||
      meta.turnId === coordinator.snapshot(scope).turnId
    const restarted = replay?.restarted
    const followed = await member
      .follow(
        replay?.reset ? "reset" : positioned ? meta.after : undefined,
        replay?.corrections
      )
      .catch(() => null)
    if (restarted !== undefined && followed !== restarted) {
      // A view rebuilt from the start does not act on `resync`, and this one
      // lacks the rest of its turn: have it rebuild again once this response
      // lands.
      afterResponse(member, async () => {
        await member.reloadOnce(restarted)
      })
      return { resync: true as const }
    }
    return positioned && followed !== null ? {} : { resync: true as const }
  }

  /**
   * Attaches this connection to one Session and follows it. A command that
   * names its `scope` addresses a Session outside this connection's catalog:
   * it adopts nothing and reads no row, models or usage, and only a wait can
   * hide a recoverable execution there.
   */
  async function resume(
    command: MemberCommands["resume"],
    client: AgentContext
  ): Promise<CommandResults["resume"]> {
    const addressed = command.scope
    if (!addressed && command.agentId !== undefined)
      sessions.adopt(command.sessionId, command.agentId)
    const scope = addressed ?? sessions.scope(command.sessionId)
    const row = addressed ? undefined : await workspace.session(scope)
    // The same preamble the history route runs: only a wait or a Session the
    // provider still calls running can hide a recoverable execution.
    const state = coordinator.state(scope)
    if (
      state === "waiting-for-input" ||
      (state === "idle" && row?.status === "running")
    )
      await workspace.discover(scope)
    const member = sessions.join(client, scope)
    // A correction the provider persisted the moment it accepted the steer is
    // already in this page, so the journal's acknowledgement of it is dropped.
    const replay = command.fromStart
      ? await replayHistory(member, scope)
      : undefined
    const history = replay?.history
    // Seated after its history and before any other provider read, so a turn
    // another browser starts meanwhile reaches it, prompt first.
    member.enterRoom(
      showsPrompt(context.rooms.current(scope), command, history),
      history !== undefined
    )
    // A cursor for another turn cannot position this one, and a cursor beyond
    // bounded replay cannot be served: both need a full reload. A view rebuilt
    // from history owns nothing of the turn, so it follows without a cursor.
    const resync = await followPositioned(
      member,
      scope,
      history === undefined ? command : {},
      replay
    )
    const execution = coordinator.snapshot(scope)
    // Every provider read the response needs settles before the follow-up is
    // scheduled: `afterResponse` fires on the next task, so a read awaited
    // after it lets the notifications overtake the very response that tells
    // the browser to start listening for them.
    const models = addressed ? undefined : await workspace.models(scope)
    const capabilities = await workspace.capabilities(scope)
    afterResponse(member, async () => {
      // A turn admitted since this response was built reports itself on its
      // own stream; restating it here would run ahead of that stream.
      if (coordinator.snapshot(scope).turnId === execution.turnId)
        await member.reportExecution()
      // A resumed Session carries the window every earlier turn already grew;
      // only a report here keeps its composer from opening on an empty gauge.
      if (!addressed) await member.reportUsage()
      if (coordinator.state(scope) === "waiting-for-input")
        member.reissuePending()
    })
    return {
      agentId: scope.agentId,
      ...(row ? { row } : {}),
      execution,
      capabilities,
      ...(models ? { models } : {}),
      ...resync,
      ...(history === undefined ? {} : { history }),
    }
  }

  /** Admits one user turn in a Session this connection reaches. */
  async function send(
    command: MemberCommands["send"],
    client: AgentContext
  ): Promise<CommandResults["send"]> {
    const scope = command.scope ?? sessions.scope(command.sessionId)
    await workspace.session(scope)
    if (coordinator.state(scope) !== "idle") throw turnInProgress()
    // Bytes were staged over REST; the prompt references the batch by id and
    // the stage appends its server-owned content to the user turn.
    const { attachmentStageId, content } = command
    const stage =
      attachmentStageId === undefined
        ? undefined
        : context.attachmentStages.take(
            scope.agentId,
            scope.threadId,
            attachmentStageId
          )
    if (attachmentStageId !== undefined && !stage) throw invalidRequest()
    const messageId = crypto.randomUUID()
    const input: PromptTurnInput = {
      turnId: crypto.randomUUID(),
      messageId,
      prompt: stage ? await stage.appendTo(command.text) : command.text,
      ...(command.rewindSourceId === undefined
        ? {}
        : { rewindSourceId: command.rewindSourceId }),
    }
    const member = sessions.join(client, scope)
    afterResponse(member, async () => {
      // Seated before admission, so a turn that wins the race still reaches
      // this browser, and shown its own prompt as today.
      member.enterRoom()
      await member.emit({ kind: "prompt", messageId, content, own: true })
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
        content,
        at: Date.now(),
      })
    })
    return { messageId }
  }

  app.onRequest(methods.agent.initialize, async ({ params }) => {
    const client = AosClientCapabilitiesMetaSchema.safeParse(
      params.capabilities?._meta?.[AOS_META_KEY] ?? {}
    )
    clientPagesHistory = client.success && client.data.historyPages
    // A connection still to authenticate learns nothing about the deployment
    // it reached.
    const { authentication } = context
    const info = authentication ? undefined : await workspace.info()
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
          lane,
          extensions: authentication
            ? authentication.extensions
            : operatorExtensions(runtime),
        },
      },
    }
  })

  // The operator lane authenticates its WebSocket upgrade instead.
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
    const created = await perform(
      "new",
      {
        agentId: meta.agentId,
        ...(meta.title === undefined ? {} : { title: meta.title }),
      },
      async ({ agentId, title }) => {
        const sessionId = await workspace.create(agentId, title)
        const scope = workspace.scope(agentId, sessionId)
        const row = await workspace.session(scope)
        sessions.remember([row])
        const capabilities = await workspace.capabilities(scope)
        const models = await workspace.models(scope)
        const member = sessions.join(client, scope)
        afterResponse(member, async () => {
          await member.emit({ kind: "commands", capabilities })
          await member.reportUsage()
        })
        return { sessionId, row, capabilities, models }
      }
    )
    return {
      sessionId: created.sessionId,
      configOptions: translators.configOptionsOf(created.models),
      _meta: {
        [AOS_META_KEY]: {
          session: sessionInfoMeta(created.row, sessions.status(created.row)),
          capabilities: created.capabilities,
        },
      },
    }
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
        const page = await workspace.list(agentId, SESSION_LIST_LIMIT, offset)
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
    const { row, execution, models, history } = resumed
    return {
      ...(models ? { configOptions: translators.configOptionsOf(models) } : {}),
      _meta: {
        [AOS_META_KEY]: {
          // A Session outside the catalog shows its live state, not a row.
          session: row
            ? sessionInfoMeta(row, sessions.status(row))
            : {
                agentId: resumed.agentId,
                status: overlaidStatus(execution.state, "idle"),
                archived: false,
              },
          execution: executionMeta(execution),
          capabilities: resumed.capabilities,
          ...(resumed.resync ? { resync: true } : {}),
          ...(history === undefined ? {} : { history: historyCursor(history) }),
        },
      },
    }
  })

  app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    admit(methods.agent.session.prompt, "send")
    const meta = parseMeta(AosPromptMetaSchema, params._meta)
    if (!params.prompt.every(isPromptBlock)) throw invalidRequest()
    const text = promptText(params.prompt)
    if (!text) throw invalidRequest()
    const { messageId } = await perform(
      "send",
      {
        sessionId: params.sessionId,
        content: promptParts(params.prompt),
        text,
        ...meta,
      },
      (command) => send(command, client)
    )
    return { _meta: { [AOS_META_KEY]: { messageId } } }
  })

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    log("acp.turn.cancel", { sessionId: params.sessionId })
    // An unauthenticated guest reaches nothing here.
    if (!sessions.identity()) return
    admit(methods.agent.session.cancel, "stop")
    await perform("stop", { sessionId: params.sessionId }, async (command) => {
      // Only a joined Session has a member.
      const member = sessions.member(command.sessionId)
      if (!member) return
      await member.cancel().catch((cause: unknown) => member.report(cause))
    })
  })

  app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    admit(methods.agent.session.setConfigOption, "set-config")
    const write = translators.configWriteOf(params.configId, params.value)
    const { models } = await perform(
      "set-config",
      { sessionId: params.sessionId, ...(write ? { write } : {}) },
      async (command) => {
        const scope = sessions.scope(command.sessionId)
        if (!command.write) throw invalidRequest()
        await workspace.updateModel(scope, command.write)
        const models = await workspace.models(scope)
        // The window's size belongs to the model, so a switch restates the
        // usage every browser on the Session holds against the model it has
        // just left.
        const member = sessions.member(command.sessionId)
        if (member) afterResponse(member, () => coordinator.reportUsage(scope))
        return { models }
      }
    )
    return { configOptions: translators.configOptionsOf(models) }
  })

  app.onRequest(methods.agent.session.close, async ({ params }) => {
    admit(methods.agent.session.close, "close")
    await perform("close", { sessionId: params.sessionId }, async (command) => {
      sessions.leave(command.sessionId)
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
        await workspace.delete(scope)
        sessions.forget(scope)
        await client.notify(AOS_METHODS.notify.catalogInvalidated)
      }
    )
    return {}
  })

  app.onRequest(
    AOS_METHODS.session.update,
    AosSessionUpdateRequestSchema,
    async ({ params, client }) => {
      admit(AOS_METHODS.session.update, "update")
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
            await context.readState.markRead(scope.agentId, scope.threadId)
            return
          }
          await workspace.update(scope, command.patch)
          const row = await workspace.session(scope)
          await sessions
            .join(client, scope)
            .emit({ kind: "session-info", row, status: sessions.status(row) })
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
    AosSteerRequestSchema,
    async ({ params }) => {
      admit(AOS_METHODS.session.steer, "steer")
      return await perform(
        "steer",
        {
          sessionId: params.sessionId,
          requestId: params.requestId,
          text: params.text,
        },
        async (command) => {
          const scope = sessions.scope(command.sessionId)
          const { turnId } = coordinator.snapshot(scope)
          if (turnId === undefined) throw turnInProgress()
          return await workspace.steer(scope, {
            requestId: command.requestId,
            expectedTurnId: turnId,
            text: command.text,
          })
        }
      )
    }
  )

  app.onNotification(
    AOS_METHODS.session.focus,
    AosFocusNotificationSchema,
    async ({ params }) => {
      if (!sessions.identity()) return
      admit(AOS_METHODS.session.focus, "focus")
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
            return context.readState.blur()
          }
          // A heartbeat re-sends an exposure this connection already
          // acknowledged.
          if (sameExposure(exposure, report)) return
          const agentId = sessions.owner(report.sessionId)
          if (agentId === undefined) return
          exposure = report
          context.readState.focus(agentId, report.sessionId)
        }
      )
    }
  )

  app.onRequest(AOS_METHODS.agents.list, withoutParams, async () => {
    admit(AOS_METHODS.agents.list, "agents")
    return await perform("agents", {}, () => workspace.agents())
  })

  app.onRequest(
    AOS_METHODS.agents.setVisibility,
    AosSetVisibilityRequestSchema,
    async ({ params }) => {
      admit(AOS_METHODS.agents.setVisibility, "set-visibility")
      return await perform(
        "set-visibility",
        {
          agentId: params.agentId,
          visibility: params.visibility,
          revision: params.revision,
        },
        (command) =>
          workspace.setVisibility(
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
    for (const event of context.activityFeed?.snapshot() ?? [])
      notify(AOS_METHODS.notify.activity, event)
    const stops = [
      context.activityFeed?.subscribe((event) =>
        notify(AOS_METHODS.notify.activity, event)
      ),
      // A connection that authenticated over ACP is shown no roster and no
      // catalog, and ends with the credential it redeemed.
      ...(context.authentication
        ? [context.authentication.expire(() => connection.close())]
        : [
            context.sessionRows.subscribe((row) => {
              const member = sessions.member(row.id)
              if (member)
                void member
                  .emit({
                    kind: "session-info",
                    row,
                    status: sessions.status(row),
                  })
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
    context.activityFeed?.close()
  })

  return app
}) satisfies AosAcpAgentFactory
