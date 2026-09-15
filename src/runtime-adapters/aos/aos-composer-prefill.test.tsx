import { act, render, waitFor, cleanup } from "@testing-library/react"
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type AssistantRuntime,
} from "@assistant-ui/react"
import { useEffect } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { reconcileComposerPrefill } from "./aos-composer-prefill"

afterEach(cleanup)

async function setup(runFinished: Promise<void> = Promise.resolve()) {
  let runtime!: AssistantRuntime
  function Harness() {
    const current = useLocalRuntime(
      {
        run: async () => {
          await runFinished
          return { content: [] }
        },
      },
      {
        initialMessages: [
          { id: "removed", role: "user", content: "Undone question" },
        ],
      }
    )
    useEffect(() => {
      runtime = current
    }, [current])
    return <AssistantRuntimeProvider runtime={current} />
  }
  render(<Harness />)
  await waitFor(() =>
    expect(runtime.thread.getState().messages).toHaveLength(1)
  )
  return runtime
}

it("reconciles undo history and retains prefill in the originating thread after switching away and back", async () => {
  const runtime = await setup()
  const originId = runtime.threads.getState().mainThreadId
  await act(() => runtime.threads.switchToNewThread())
  act(() => runtime.thread.composer.setText("Other session draft"))
  // The terminal event arrives after the user has already left its thread.
  const origin = runtime.threads.getById(originId)
  let resolveHistory!: (value: { messages: [] }) => void
  const loadHistory = vi.fn(
    () =>
      new Promise<{ messages: [] }>((resolve) => {
        resolveHistory = resolve
      })
  )
  const completed = reconcileComposerPrefill(
    origin,
    loadHistory,
    "Undone question"
  )
  expect(loadHistory).toHaveBeenCalledOnce()
  await act(async () => {
    resolveHistory({ messages: [] })
    await completed
  })
  expect(runtime.thread.composer.getState().text).toBe("Other session draft")
  await act(() => runtime.threads.switchToThread(originId))
  await waitFor(() => expect(runtime.thread.getState().messages).toEqual([]))
  expect(runtime.thread.composer.getState().text).toBe("Undone question")
  expect(loadHistory).toHaveBeenCalledOnce()
})

it("preserves a newer draft while applying the provider-authoritative transcript", async () => {
  const thread = (await setup()).thread
  act(() => thread.composer.setText("Newer draft"))
  await act(() =>
    reconcileComposerPrefill(
      thread,
      async () => ({ messages: [] }),
      "Undone question"
    )
  )
  await waitFor(() => expect(thread.getState().messages).toEqual([]))
  expect(thread.composer.getState().text).toBe("Newer draft")
})

it("waits for the originating run to settle before replacing its transcript", async () => {
  let finish!: () => void
  const runtime = await setup(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const thread = runtime.threads.getById(
    runtime.threads.getState().mainThreadId
  )
  act(() => {
    thread.append({ role: "user", content: [{ type: "text", text: "/undo" }] })
  })
  await waitFor(() => expect(thread.getState().isRunning).toBe(true))
  await act(() =>
    reconcileComposerPrefill(
      thread,
      async () => ({ messages: [] }),
      "Undone question"
    )
  )
  expect(thread.getState().messages.length).toBeGreaterThan(0)
  act(() => finish())
  await waitFor(() => expect(thread.getState().messages).toEqual([]))
  expect(thread.composer.getState().text).toBe("Undone question")
})
