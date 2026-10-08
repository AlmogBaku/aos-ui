/**
 * The client declares its own types; this file proves at compile time that
 * each still matches the workspace contract it stands in for, so a change on
 * either side fails `typecheck` instead of drifting.
 */
import type * as Client from "@harness-gw/sdk"

import type * as Contract from "./contracts"

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

type Assert<T extends true> = T

export type ClientMatchesContract = [
  Assert<Same<Client.AgentVisibility, Contract.AgentVisibility>>,
  Assert<Same<Client.AgentUpdate, Contract.AgentUpdate>>,
  Assert<Same<Client.SessionStatus, Contract.SessionStatus>>,
  Assert<Same<Client.ActivityBase, Contract.ActivityBase>>,
  Assert<Same<Client.WorkspaceActivityEvent, Contract.WorkspaceActivityEvent>>,
  Assert<Same<Client.SessionMetadata, Contract.SessionMetadata>>,
  Assert<
    Same<Client.SessionActionCapabilities, Contract.SessionActionCapabilities>
  >,
  Assert<Same<Client.TodoStatus, Contract.TodoStatus>>,
  Assert<Same<Client.TodoItem, Contract.TodoItem>>,
  Assert<Same<Client.SessionCreationOptions, Contract.SessionCreationOptions>>,
  Assert<Same<Client.RuntimeQuestionOption, Contract.RuntimeQuestionOption>>,
  Assert<Same<Client.RuntimeQuestion, Contract.RuntimeQuestion>>,
  Assert<Same<Client.RuntimeQuestionRequest, Contract.RuntimeQuestionRequest>>,
  Assert<
    Same<Client.RuntimeQuestionResponse, Contract.RuntimeQuestionResponse>
  >,
  Assert<
    Same<Client.RuntimeInteractionAdapter, Contract.RuntimeInteractionAdapter>
  >,
  Assert<Same<Client.ComposerTurnUsage, Contract.ComposerTurnUsage>>,
  Assert<Same<Client.ComposerModelCurrent, Contract.ComposerModelCurrent>>,
  Assert<Same<Client.ComposerModelFeed, Contract.ComposerModelFeed>>,
]
