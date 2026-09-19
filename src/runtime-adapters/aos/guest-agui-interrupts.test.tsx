import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import {
  AssistantRuntimeProvider,
  type AssistantRuntime,
} from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"
import type { HttpAgent } from "@ag-ui/client"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { afterEach, expect, it, vi } from "vitest"

import {
  createAgUiInterruptRequest,
  AgUiInterruptComposer,
} from "./guest-agui-interrupts"

afterEach(cleanup)

it("projects every open AG-UI interrupt into one complete resume array", () => {
  const projected = createAgUiInterruptRequest([
    {
      id: "questions-1",
      reason: "input_required",
      message: "Choose a path",
      responseSchema: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            prefixItems: [
              {
                type: "array",
                title: "Path",
                items: { type: "string", enum: ["Safe", "Fast"] },
                maxItems: 1,
              },
            ],
          },
        },
      },
    },
    {
      id: "approval-1",
      reason: "confirmation",
      message: "May I continue?",
      responseSchema: { type: "string", enum: ["once", "deny"] },
    },
  ])

  expect(projected.request.questions).toMatchObject([
    { header: "Path", options: [{ label: "Safe" }, { label: "Fast" }] },
    { header: "Permission", options: [{ label: "once" }, { label: "deny" }] },
  ])
  expect(projected.resolve([["Safe"], ["once"]])).toEqual([
    {
      interruptId: "questions-1",
      status: "resolved",
      payload: { answers: [["Safe"]] },
    },
    { interruptId: "approval-1", status: "resolved", payload: "once" },
  ])
  expect(projected.cancel()).toEqual([
    { interruptId: "questions-1", status: "cancelled" },
    { interruptId: "approval-1", status: "cancelled" },
  ])
})

it("keeps a discarded AG-UI question visible until its empty resume segment settles", async () => {
  let settleDiscard: (() => void) | undefined
  const discardSettled = new Promise<void>((resolve) => {
    settleDiscard = resolve
  })
  const runAgent = vi.fn(
    async (
      input: unknown,
      subscriber: Record<string, ((payload: unknown) => void) | undefined>
    ) => {
      if (runAgent.mock.calls.length === 1) {
        subscriber.onRunFinishedEvent?.({
          event: {
            type: "RUN_FINISHED",
            threadId: "session-1",
            runId: "question-segment",
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: "question-1",
                  reason: "input_required",
                  message: "Still needed?",
                },
              ],
            },
          },
        })
      } else {
        await discardSettled
        subscriber.onRunFinishedEvent?.({
          event: {
            type: "RUN_FINISHED",
            threadId: "session-1",
            runId: "discard-segment",
            outcome: { type: "success" },
          },
        })
      }
      subscriber.onRunFinalized?.(undefined)
      void input
    }
  )
  const agent = { runAgent, abortRun: vi.fn() } as unknown as HttpAgent

  function Harness() {
    const runtime = useAgUiRuntime({ agent })
    useEffect(() => {
      void runtime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Start" }],
      })
    }, [runtime])
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <AgUiInterruptComposer locale="en" fallback={<p>Write a message</p>} />
      </AssistantRuntimeProvider>
    )
  }

  render(<Harness />)
  await screen.findByText("Still needed?")
  await userEvent.click(screen.getByRole("button", { name: "Discard" }))
  await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2))

  expect((runAgent.mock.calls[1]?.[0] as { resume?: unknown }).resume).toEqual([
    { interruptId: "question-1", status: "cancelled" },
  ])
  expect(screen.getByText("Discarding…")).toBeVisible()
  expect(screen.queryByText("Write a message")).not.toBeInTheDocument()

  await act(async () => settleDiscard?.())
  await screen.findByText("Write a message")
  expect(screen.queryByText("Still needed?")).not.toBeInTheDocument()
})

it("submits a public AG-UI resume and renders its final response", async () => {
  const runAgent = vi.fn(
    async (
      input: unknown,
      subscriber: Record<string, ((payload: unknown) => void) | undefined>
    ) => {
      if (runAgent.mock.calls.length === 1) {
        subscriber.onRunFinishedEvent?.({
          event: {
            type: "RUN_FINISHED",
            runId: "first-segment",
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: "approval-1",
                  reason: "confirmation",
                  message: "May I continue?",
                  responseSchema: { type: "string", enum: ["once", "deny"] },
                },
              ],
            },
          },
        })
      } else {
        subscriber.onTextMessageStartEvent?.({
          event: {
            type: "TEXT_MESSAGE_START",
            messageId: "final-answer",
            role: "assistant",
          },
        })
        subscriber.onTextMessageContentEvent?.({
          event: {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "final-answer",
            delta: "Finished without refresh.",
          },
        })
        subscriber.onTextMessageEndEvent?.({
          event: { type: "TEXT_MESSAGE_END", messageId: "final-answer" },
        })
        subscriber.onRunFinishedEvent?.({
          event: {
            type: "RUN_FINISHED",
            runId: "resume-segment",
            outcome: { type: "success" },
          },
        })
      }
      subscriber.onRunFinalized?.(undefined)
      void input
    }
  )
  const agent = { runAgent, abortRun: vi.fn() } as unknown as HttpAgent
  let runtime: AssistantRuntime | undefined
  function Harness() {
    runtime = useAgUiRuntime({ agent })
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <AgUiInterruptComposer locale="en" fallback={<p>Write a message</p>} />
      </AssistantRuntimeProvider>
    )
  }
  render(<Harness />)

  await act(async () => {
    await runtime!.thread.append({
      role: "user",
      content: [{ type: "text", text: "Start" }],
    })
  })
  await screen.findByText("May I continue?")
  const user = userEvent.setup()
  await user.click(screen.getByRole("option", { name: "once" }))
  await user.click(screen.getByRole("button", { name: "Send answer" }))

  await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2))
  expect((runAgent.mock.calls[1]?.[0] as { resume?: unknown }).resume).toEqual([
    { interruptId: "approval-1", status: "resolved", payload: "once" },
  ])
  await waitFor(() =>
    expect(
      runtime!.thread
        .getState()
        .messages.some((message) =>
          message.content.some(
            (part) =>
              part.type === "text" && part.text === "Finished without refresh."
          )
        )
    ).toBe(true)
  )
})
