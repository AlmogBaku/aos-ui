import { createRuntimeExtras } from "@assistant-ui/core/react"

/**
 * What a runtime lets a subagent's card do to the child Session behind it. A
 * child's permission requests are its own, so they are answered on the child,
 * and a child that offers to be stopped alone stops while its parent runs on.
 */
export type ChildSessionControls = {
  /** Answers a permission request one of the thread's child Sessions asked. */
  readonly respondToApproval: (
    approvalId: string,
    optionId: string,
    approved: boolean
  ) => Promise<void>
  /** Stops the child's current work, where the child offers that. */
  readonly cancel: (childSessionId: string) => void
}

export type ChildSessionExtras = {
  /** Absent on a runtime whose subagents have no Session of their own. */
  readonly childSessions?: ChildSessionControls
}

/**
 * The provider-neutral channel a runtime offers its child Sessions' controls
 * through, stamped on the same extras object as its own channel.
 */
export const childSessionExtras =
  createRuntimeExtras<ChildSessionExtras>("childSessions")

/**
 * `childSessionExtras.use` under a hook name: React Compiler takes only a
 * `use`-prefixed call for a hook, and would cache a member `.use` call as a
 * plain value.
 */
export const useChildSessionExtras = childSessionExtras.use
