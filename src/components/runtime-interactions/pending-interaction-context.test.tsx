import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  PendingInteractionProvider,
  usePendingInteractionGate,
} from "./pending-interaction-context"

type Approval = {
  id: string
  options: { id: string; kind: "allow-once" }[]
  optionId?: string
  resolution?: "cancelled" | "expired"
}

function turn(approval: Approval): ThreadMessageLike {
  return {
    id: "assistant-1",
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pwd" },
        approval,
      },
    ],
  }
}

function Probe() {
  return <output>{usePendingInteractionGate() ? "pending" : "idle"}</output>
}

function Harness({ messages }: { messages: readonly ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    onNew: vi.fn(),
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PendingInteractionProvider>
        <Probe />
      </PendingInteractionProvider>
    </AssistantRuntimeProvider>
  )
}

const pending: Approval = {
  id: "approval-1",
  options: [{ id: "once", kind: "allow-once" }],
}

afterEach(cleanup)

describe("usePendingInteractionGate", () => {
  it("holds while the latest turn's tool approval awaits the operator", () => {
    render(<Harness messages={[turn(pending)]} />)
    expect(screen.getByRole("status")).toHaveTextContent("pending")
  })

  it("holds for an approval on an earlier turn than the latest", () => {
    render(
      <Harness
        messages={[
          turn(pending),
          {
            id: "user-2",
            role: "user",
            content: [{ type: "text", text: "Also check the logs" }],
          },
        ]}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent("pending")
  })

  it.each([
    ["answered", { ...pending, optionId: "once" }],
    ["cancelled", { ...pending, resolution: "cancelled" as const }],
    ["expired", { ...pending, resolution: "expired" as const }],
  ])("opens once the approval is %s", (_case, approval) => {
    render(<Harness messages={[turn(approval)]} />)
    expect(screen.getByRole("status")).toHaveTextContent("idle")
  })

  it("opens on a thread without approvals", () => {
    render(
      <Harness
        messages={[
          {
            id: "a",
            role: "assistant",
            content: [{ type: "text", text: "Hi" }],
          },
        ]}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent("idle")
  })
})
