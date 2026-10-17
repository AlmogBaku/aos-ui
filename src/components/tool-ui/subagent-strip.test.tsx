import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { withAosToolArtifact } from "@/lib/tool-artifact"

import { SubagentStrip } from "./subagent-strip"

afterEach(cleanup)

function StripOver({ messages }: { messages: readonly ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => {},
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SubagentStrip />
    </AssistantRuntimeProvider>
  )
}

/** A turn that spawned one subagent per status, each on its own entry. */
const turn = (id: string, statuses: readonly string[]): ThreadMessageLike => ({
  id,
  role: "assistant",
  content: statuses.map((status, index) => ({
    type: "tool-call",
    toolCallId: `aos-subagent-${id}-${index}`,
    toolName: "subagent",
    args: {},
    argsText: "{}",
    artifact: withAosToolArtifact(undefined, {
      subagent: {
        id: `${id}-${index}`,
        goal: "Reconcile September's supplier invoices",
        status,
      },
    }),
  })),
})

it("counts the running subagents of every turn, and leaves once the last one finishes", () => {
  const { rerender } = render(
    <StripOver
      messages={[
        turn("research", ["running", "completed"]),
        turn("invoices", ["running"]),
      ]}
    />
  )
  const strip = screen.getByRole("region", { name: "Running subagents" })
  expect(within(strip).getByText("2 running")).toBeInTheDocument()
  expect(within(strip).getByText("1 done")).toBeInTheDocument()

  rerender(
    <StripOver
      messages={[
        turn("research", ["completed", "completed"]),
        turn("invoices", ["completed"]),
      ]}
    />
  )
  expect(screen.queryByRole("region", { name: "Running subagents" })).toBeNull()
})
