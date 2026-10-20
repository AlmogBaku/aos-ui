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

/** The client infers these from its reads rather than naming them. */
type ClientAgentSummary = Awaited<
  ReturnType<Client.AcpWorkspaceClient["listAgents"]>
>[number]
type ClientAgentCatalogEntry = Awaited<
  ReturnType<Client.AcpWorkspaceClient["listAgentCatalog"]>
>[number]

/**
 * The aos adapter reads the client's `_meta` into `role` and
 * `creatorSessionId` and reports created Agents itself
 * (`aos/aos-agent-creation.ts`); everything else is the client's.
 */
type AdapterActivity = Extract<
  Contract.WorkspaceActivityEvent,
  { type: "agent-ready" | "agent-activation-failed" }
>

export type ClientMatchesContract = [
  Assert<Same<Client.AgentVisibility, Contract.AgentVisibility>>,
  Assert<Same<Client.AgentUpdate, Contract.AgentUpdate>>,
  Assert<
    Same<
      Omit<ClientAgentSummary, "_meta">,
      Omit<Contract.AgentSummary, "role" | "creatorSessionId">
    >
  >,
  Assert<Same<ClientAgentCatalogEntry["summary"], ClientAgentSummary>>,
  Assert<
    Same<
      Omit<ClientAgentCatalogEntry, "summary">,
      Omit<Contract.AgentCatalogEntry, "summary">
    >
  >,
  Assert<Same<Client.SessionStatus, Contract.SessionStatus>>,
  Assert<Same<Client.ActivityBase, Contract.ActivityBase>>,
  Assert<
    Same<
      Client.WorkspaceActivityEvent,
      Exclude<Contract.WorkspaceActivityEvent, AdapterActivity>
    >
  >,
  Assert<Same<Client.SessionMetadata, Contract.SessionMetadata>>,
  Assert<
    Same<Client.SessionActionCapabilities, Contract.SessionActionCapabilities>
  >,
  Assert<Same<Client.TodoStatus, Contract.TodoStatus>>,
  Assert<Same<Client.TodoItem, Contract.TodoItem>>,
  Assert<Same<Client.SessionCreationOptions, Contract.SessionCreationOptions>>,
  Assert<Same<Client.SessionSearchResult, Contract.SessionSearchResult>>,
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
