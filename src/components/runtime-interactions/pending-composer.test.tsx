import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import type {
  RuntimeInteractionAdapter,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import { PendingInteractionComposer } from "./pending-composer"

afterEach(cleanup)

it("discovers pending questions and isolates updates to their originating Session", () => {
  const pending = new Map<string, RuntimeQuestionRequest>()
  const listeners = new Map<string, Set<() => void>>()
  const interactions: RuntimeInteractionAdapter = {
    getPending: (id) => pending.get(id),
    subscribe: (id, listener) => {
      const set = listeners.get(id) ?? new Set()
      set.add(listener)
      listeners.set(id, set)
      return () => {
        set.delete(listener)
      }
    },
    respond: async () => {},
    reject: async () => {},
  }
  const question = (
    sessionId: string,
    prompt: string
  ): RuntimeQuestionRequest => ({
    kind: "question",
    sessionId,
    requestId: sessionId,
    questions: [{ header: "Choice", prompt, options: [{ label: "Proceed" }] }],
  })
  pending.set("a", question("a", "Approve A?"))
  const view = render(
    <PendingInteractionComposer
      locale="en"
      threadId="a"
      interactions={interactions}
      fallback={<p>Write a message</p>}
    />
  )
  expect(screen.getByText("Approve A?")).toBeVisible()
  view.rerender(
    <PendingInteractionComposer
      locale="en"
      threadId="b"
      interactions={interactions}
      fallback={<p>Write a message</p>}
    />
  )
  expect(screen.queryByText("Approve A?")).not.toBeInTheDocument()
  expect(screen.getByText("Write a message")).toBeVisible()
  act(() => {
    pending.set("b", question("a", "Stale A?"))
    listeners.get("b")?.forEach((listener) => listener())
  })
  expect(screen.queryByText("Stale A?")).not.toBeInTheDocument()
  act(() => {
    pending.set("b", question("b", "Approve B?"))
    listeners.get("b")?.forEach((listener) => listener())
  })
  expect(screen.getByText("Approve B?")).toBeVisible()
  view.unmount()
  expect([...listeners.values()].every((set) => set.size === 0)).toBe(true)
})
