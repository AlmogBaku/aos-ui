import type { z } from "zod"

import type {
  Session,
  SessionContextResponse,
  SessionHistoryResponse,
  SessionModelsResponse,
  SessionWorkspaceCapabilitiesResponseSchema,
} from "../../protocol"
import type { PendingRequest, TurnEvent } from "./events"
import type { SessionExecutionState } from "./session-coordinator"
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

/** Who a member acts as. The coordinator knows its turns by `id`. */
export type Principal = {
  id: string
  role: "operator" | "guest"
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
    }
  | { kind: "usage"; usage: SessionContextResponse }
  | { kind: "model"; models: SessionModelsResponse }
  | { kind: "session-info"; row: SessionRow; status: Session["status"] }
  | { kind: "commands"; capabilities: WorkspaceCapabilities }
  /** The member's view is incomplete and must be rebuilt from history. */
  | { kind: "invalidated" }
  /** A failure that has no request to answer. */
  | { kind: "error"; cause: unknown }

/** One Session event, addressed by the Session's public id. */
export type MemberEvent = { sessionId: string } & SessionEvent

/** Where a member's events leave the Channel, implemented by the transport. */
export type MemberConnection = {
  /** Resolves once the event is written; rejects when it cannot be. */
  send(event: MemberEvent): Promise<void>
}

export type Member = {
  principal: Principal
  connection: MemberConnection
}
