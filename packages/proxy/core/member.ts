import type { z } from "zod"

import type {
  AgentCatalogResponse,
  AgentUpdatePatch,
  AgentUpdateResponse,
  SessionContextResponse,
  SessionHistoryResponse,
  SessionModelsResponse,
  SessionModelUpdateRequest,
  SessionWorkspaceCapabilitiesResponseSchema,
  TurnSteerResponse,
} from "../../protocol"
import type { PendingRequest, RequestReply, TurnEvent } from "./events"
import type { ProviderSessionId } from "./ids"
import type { SessionPatch, SessionScope } from "./runtime"
import type { SessionExecutionState, TurnQuota } from "./session-coordinator"
import type { SessionRow } from "./session-rows"

/**
 * The typed seam between a transport and the Channel. Nothing here names a
 * wire: a transport decodes its frames into these types and encodes them back.
 */

/**
 * One part of a user prompt: text, or a link to an attachment batch the
 * browser staged. Only the fields a browser itself writes are kept, so nothing
 * else a sender put on a prompt reaches another member.
 */
export type PromptPart =
  | { kind: "text"; text: string }
  | { kind: "attachment"; uri: string; name: string; mimeType?: string }

/** A prompt's text parts joined the way the normalized wire carries a turn. */
export function promptText(prompt: readonly PromptPart[]) {
  return prompt
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n")
}

/** What one Session's workspace offers, as the normalized route reports it. */
export type WorkspaceCapabilities = z.infer<
  typeof SessionWorkspaceCapabilitiesResponseSchema
>

/** Which kind of member a principal is. */
export type Role = "operator" | "guest"

/** Who a member acts as. The coordinator knows its turns by `id`. */
export type Principal = {
  id: string
  role: Role
}

/**
 * One coordinator subscription as a member reads it. An encoder keys the
 * state it carries between the stream's events by this object, so a stream
 * still draining never mixes into the one after it. `dropped` turns true once
 * a restart replaced the stream, and nothing more of it is owed.
 */
export type TurnStream = {
  readonly turnId: string
  /** Steer acknowledgements the history this stream follows already carried. */
  readonly replayedCorrections: number
  readonly dropped: boolean
}

/**
 * Everything a member is shown of one Session. Every consumer switches over
 * `kind` exhaustively.
 */
export type SessionEvent =
  | {
      kind: "turn"
      stream: TurnStream
      sequence: number
      event: TurnEvent
      /** Stop was acknowledged for this stream and the provider has not settled. */
      stopping: boolean
      /**
       * Buffered before a view being rebuilt joined: its past state is no
       * longer the turn's, which the view is told once caught up.
       */
      replayed?: true
    }
  /** A user prompt: another member's, or this member's own echo. */
  | {
      kind: "prompt"
      messageId: string
      content: readonly PromptPart[]
      own: boolean
    }
  /**
   * A history page. A from-start replay carries the cursor this member has
   * reached; an `older` page is one the member asked for by its cursor.
   */
  | {
      kind: "history"
      page: SessionHistoryResponse
      sequence: number
      older?: { cursor: string; offset: number }
    }
  | { kind: "request-asked"; request: PendingRequest; startedBy?: string }
  | { kind: "request-withdrawn"; requestId: string }
  /** The answers this member just gave, as the member was shown them. */
  | { kind: "question-answered"; request: PendingRequest; answers: string[][] }
  /** The Session's execution, reported outside a turn stream. */
  | {
      kind: "execution"
      state: SessionExecutionState
      turnId?: string
      sequence: number
      /** The running turn waits on a prompt only Stop ends. */
      awaitingStop?: true
      /** When the live turn began, as its stream's first state dated it. */
      startedAt?: string
    }
  | { kind: "usage"; usage: SessionContextResponse }
  | { kind: "model"; models: SessionModelsResponse }
  /** The Session's row, whose status is the one its live execution overlays. */
  | { kind: "session-info"; row: SessionRow }
  | { kind: "commands"; capabilities: WorkspaceCapabilities }
  /** A failure that has no request to answer. */
  | { kind: "error"; cause: unknown }

/**
 * One content-free workspace event about a Session the member may observe:
 * a turn's start and end, a request for attention and its resolution, and a
 * change of read state.
 */
export type Activity = {
  agentId: string
  sessionId: string
  occurredAt: string
} & (
  | {
      type: "turn-started" | "turn-finished" | "turn-failed"
      turnId: string
    }
  | {
      type: "attention-requested"
      requestId: string
      attentionKind: "question" | "permission"
    }
  | { type: "attention-resolved"; requestId: string }
  | { type: "unread-changed"; unread: boolean }
)

/** What a member is shown of the workspace, outside any one Session. */
export type WorkspaceEvent =
  /** The Session list changed and must be read again. */
  { kind: "catalog-invalidated" } | { kind: "activity"; activity: Activity }

/**
 * One member event: a Session's, addressed by the Session's public id, or the
 * workspace's.
 */
export type MemberEvent =
  ({ sessionId: string } & SessionEvent) | WorkspaceEvent

/** Where a member's events leave the Channel, implemented by the transport. */
export type MemberConnection = {
  /** Resolves once the event is written; rejects when it cannot be. */
  send(event: MemberEvent): Promise<void>
  /** Whether the connection's credential still holds. */
  live(): boolean
}

/**
 * What a middleware may do beyond shaping an event. `decline` refuses one
 * request this member was asked, as the layer decided; the Channel runs it
 * once the request was delivered, while the Session still holds it.
 */
export type MemberAct = {
  decline(requestId: string): void
}

/**
 * The Session a member addresses. A fresh invitation names its Session before
 * the runtime holds one, so it has no provider Session until its first Send.
 */
export type MemberScope = Omit<SessionScope, "providerSessionId"> & {
  providerSessionId?: ProviderSessionId
}

export function hasSession(scope: MemberScope): scope is SessionScope {
  return scope.providerSessionId !== undefined
}

/**
 * Everything a member may ask of its Sessions, by kind. A `scope` names the
 * Session outside this connection's own catalog, as a middleware resolved it.
 */
export type MemberCommands = {
  resume: {
    sessionId: string
    agentId?: string
    scope?: MemberScope
    /** Replay the Session's history before following it. */
    fromStart: boolean
    /** Where the member's view already reaches in the live turn. */
    turnId?: string
    after?: number
  }
  "older-page": { sessionId: string; cursor: string }
  send: {
    sessionId: string
    scope?: SessionScope
    content: readonly PromptPart[]
    text: string
    /** The message an Edit or Retry replaces. */
    rewindSourceId?: string
    attachmentStageId?: string
    /** A client id names a send its client may repeat. */
    clientId?: string
    /** The cap a middleware counts this turn under, beside the global one. */
    quota?: TurnQuota
  }
  steer: {
    sessionId: string
    scope?: SessionScope
    requestId: string
    text: string
  }
  stop: { sessionId: string }
  close: { sessionId: string }
  /** One reply to a request the member was asked, with the answers it saw. */
  answer: {
    sessionId: string
    request: PendingRequest
    reply: RequestReply
    answers?: string[][]
  }
  focus: { sessionId: string | null; foreground: boolean; idle: boolean }
  list: { agentId?: string; offset: number }
  /** A client id names a create its client may repeat. */
  new: { agentId: string; title?: string; clientId?: string }
  delete: { sessionId: string }
  /** `{ unread: false }` marks the Session read. */
  update: { sessionId: string; patch: SessionPatch }
  /** `write` is absent when the option is not one the Session has. */
  "set-config": { sessionId: string; write?: SessionModelUpdateRequest }
  agents: Record<string, never>
  "update-agent": {
    agentId: string
    patch: AgentUpdatePatch
    revision: string
  }
}

export type CommandKind = keyof MemberCommands

/** What each command answers, before a transport encodes it. */
export type CommandResults = {
  resume: {
    /** The page the resume replayed, from its start or to rebuild the view. */
    history?: SessionHistoryResponse
  }
  "older-page": { page: SessionHistoryResponse }
  send: { messageId: string }
  steer: TurnSteerResponse
  stop: void
  close: void
  answer: void
  focus: void
  list: { rows: readonly SessionRow[]; nextOffset?: number }
  new: { sessionId: string }
  delete: void
  update: void
  "set-config": { models: SessionModelsResponse }
  agents: AgentCatalogResponse
  "update-agent": AgentUpdateResponse
}

/** Runs the command further down the stack, ending at its execution. */
export type CommandNext<K extends CommandKind> = (
  command: MemberCommands[K]
) => Promise<CommandResults[K]>

/** One middleware's handling of one command kind. */
export type CommandStep<K extends CommandKind> = (
  command: MemberCommands[K],
  next: CommandNext<K>
) => Promise<CommandResults[K]>

/**
 * One layer of a member's stack. Commands pass the stack in order and events
 * come back through it in reverse. A layer may refuse a command, rewrite it,
 * answer it itself, or pass it on; it returns an event, a rewritten one, or
 * nothing to hide it.
 */
export type Middleware = {
  /**
   * Whether the member may run this kind of command at all. Checked before a
   * transport decodes the frame, so a refused kind is refused however it is
   * spelled.
   */
  admits?(kind: CommandKind): boolean
  commands?: { [K in CommandKind]?: CommandStep<K> }
  event?(event: MemberEvent, act: MemberAct): MemberEvent | undefined
}

/**
 * Proves a switch named every kind: a kind added later fails to compile until
 * someone decides what it does. One that arrives anyway at run time is
 * dropped.
 */
export function unhandledKind(kind: never): undefined {
  void kind
  return undefined
}

/** Why a middleware refused a command, in words a transport maps to its wire. */
export type CommandRefusal = "invalid" | "not-found" | "authentication-required"

export class CommandRefusedError extends Error {
  constructor(readonly refusal: CommandRefusal) {
    super(`The command was refused: ${refusal}`)
    this.name = "CommandRefusedError"
  }
}

export function admits(stack: readonly Middleware[], kind: CommandKind) {
  return stack.every((layer) => layer.admits?.(kind) ?? true)
}

/** Runs one command down the stack to `execute`, its terminal step. */
export function runCommand<K extends CommandKind>(
  stack: readonly Middleware[],
  kind: K,
  command: MemberCommands[K],
  execute: CommandNext<K>
): Promise<CommandResults[K]> {
  const from =
    (index: number): CommandNext<K> =>
    (current) => {
      const layer = stack[index]
      if (!layer) return execute(current)
      const step = layer.commands?.[kind] as CommandStep<K> | undefined
      return step ? step(current, from(index + 1)) : from(index + 1)(current)
    }
  return from(0)(command)
}

/** Runs one event up the stack; `undefined` means a layer hid it. */
export function runEvents(
  stack: readonly Middleware[],
  event: MemberEvent,
  act: MemberAct
): MemberEvent | undefined {
  let shown: MemberEvent | undefined = event
  for (const layer of [...stack].reverse()) {
    if (!shown) return undefined
    if (layer.event) shown = layer.event(shown, act)
  }
  return shown
}

export type Member = {
  principal: Principal
  /** The member's stack, outermost first; the operator's is empty. */
  middleware: readonly Middleware[]
  connection: MemberConnection
}

/**
 * Shows a member one workspace event through its stack. A workspace event
 * names no Session, so it carries no request a layer could decline.
 */
export function showWorkspace(member: Member, event: WorkspaceEvent) {
  const shown = runEvents(member.middleware, event, {
    decline: () => undefined,
  })
  return shown ? member.connection.send(shown) : Promise.resolve()
}
