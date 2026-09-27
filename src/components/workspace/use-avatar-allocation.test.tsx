import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  planAvatarSaves,
  type AgentAvatarInput,
} from "@/components/agent-icons/allocation"
import { AgentUpdateError } from "@/runtime-adapters/contracts"

import { useAvatarAllocation } from "./use-avatar-allocation"

const editable = (id: string, avatar?: string): AgentAvatarInput => ({
  id,
  avatar,
  avatarEditable: true,
})

const roster = [editable("agent-a"), editable("agent-b"), editable("agent-c")]

function renderAllocation(
  update: (agentId: string, patch: { avatar?: string | null }) => Promise<void>,
  initial: { agents?: readonly AgentAvatarInput[]; ready?: boolean } = {}
) {
  const workspace = { updateAgent: vi.fn(update) }
  const onConflict = vi.fn()
  const view = renderHook(
    ({ agents, ready }) =>
      useAvatarAllocation({ workspace, agents, ready, onConflict }),
    {
      initialProps: {
        agents: initial.agents ?? roster,
        ready: initial.ready ?? true,
      },
    }
  )
  return { ...view, update: workspace.updateAgent, onConflict }
}

const savedIds = (update: { mock: { calls: unknown[][] } }) =>
  update.mock.calls.map(([agentId]) => agentId)

describe("useAvatarAllocation", () => {
  it("saves the icon each Agent shows, one Agent at a time and each once", async () => {
    const pending: Array<() => void> = []
    const { update, rerender } = renderAllocation(
      () => new Promise<void>((resolve) => pending.push(resolve))
    )
    const plan = planAvatarSaves(roster, new Set())

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    for (let index = 0; index < plan.length; index += 1) {
      expect(update).toHaveBeenLastCalledWith(plan[index].agentId, {
        avatar: plan[index].avatar,
      })
      await act(async () => pending[index]())
    }
    expect(update).toHaveBeenCalledTimes(plan.length)

    rerender({ agents: [...roster], ready: true })
    await act(async () => {})
    expect(update).toHaveBeenCalledTimes(plan.length)
  })

  it("waits while the catalog is loading or errored", async () => {
    const { update, rerender } = renderAllocation(async () => undefined, {
      ready: false,
    })
    await act(async () => {})
    expect(update).not.toHaveBeenCalled()

    rerender({ agents: roster, ready: true })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(roster.length))
  })

  it("re-reads the catalog once on a conflict and never retries that Agent", async () => {
    const [first] = planAvatarSaves(roster, new Set())
    const { update, onConflict, rerender } = renderAllocation(
      async (agentId) => {
        if (agentId === first.agentId)
          throw new AgentUpdateError("conflict", "Stale revision")
      }
    )
    await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledTimes(1)

    rerender({ agents: [...roster], ready: true })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(roster.length))
    expect(savedIds(update).filter((id) => id === first.agentId)).toHaveLength(
      1
    )
    expect(onConflict).toHaveBeenCalledTimes(1)
  })

  it("keeps going without an error when one save fails", async () => {
    const [first] = planAvatarSaves(roster, new Set())
    const { update, onConflict } = renderAllocation(async (agentId) => {
      if (agentId === first.agentId) throw new Error("Provider unavailable")
    })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(roster.length))
    expect(onConflict).not.toHaveBeenCalled()
  })

  it("an Agent that is not avatarEditable is never sent, and later Agents still save", async () => {
    const agents = [
      { id: "agent-a" },
      { id: "agent-b", avatarEditable: false },
      editable("agent-c"),
      editable("agent-d"),
    ]
    const { update } = renderAllocation(async () => undefined, { agents })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(savedIds(update).sort()).toEqual(["agent-c", "agent-d"])
  })

  it("after an unsupported rejection nothing else is attempted", async () => {
    const { update, rerender } = renderAllocation(async () => {
      throw new AgentUpdateError("unsupported", "Avatars are not stored")
    })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))

    rerender({ agents: [...roster, editable("agent-d")], ready: true })
    await act(async () => {})
    expect(update).toHaveBeenCalledTimes(1)
  })
})
