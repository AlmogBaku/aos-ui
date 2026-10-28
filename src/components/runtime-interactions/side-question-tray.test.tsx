import type { AssistantRuntime, ThreadMessageLike } from "@assistant-ui/react"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  INITIAL_MESSAGES,
  LocalThread,
} from "@/components/assistant-ui/elements/thread.aui.test-helpers"
import { en } from "@/lib/i18n/dictionaries/en"
import type { SideQuestionSnapshot } from "@/runtime-adapters/contracts"

import { SideQuestionStore } from "./side-question-store"
import { SessionSideQuestions } from "./side-question-tray"

const copy = en.sideQuestions
const QUESTION = "Which competitor did it start with?"
/** The Agent answers in markdown, as it writes a message. */
const ANSWER =
  "**Contoso**: its pricing page changed last week, and it's the one the board asked about."

/** A side question the test answers by hand. */
function fakeQuestion() {
  const listeners = new Set<() => void>()
  let snapshot: SideQuestionSnapshot = { state: "asking" }
  return {
    handle: {
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      snapshot: () => snapshot,
      dismiss: vi.fn(async () => undefined),
      keep: vi.fn(async () => ({ sessionId: "fork-1" })),
    },
    /** How many listeners still follow the question. */
    followers: () => listeners.size,
    publish(next: SideQuestionSnapshot) {
      snapshot = next
      act(() => {
        for (const listener of listeners) listener()
      })
    },
  }
}

/**
 * One question asked about the Session the tray already shows, above a real
 * composer, as the thread places it.
 */
function renderTray({
  initialMessages = [],
  exposeRuntime,
}: {
  initialMessages?: readonly ThreadMessageLike[]
  exposeRuntime?: (runtime: AssistantRuntime) => void
} = {}) {
  const question = fakeQuestion()
  const store = new SideQuestionStore()
  const openSession = vi.fn(async () => undefined)
  const workspace = { store, dictionary: en, openSession, reportError: vi.fn() }
  const Tray = () => (
    <SessionSideQuestions workspace={workspace} sessionId="session-1" />
  )
  render(
    <LocalThread
      initialMessages={initialMessages}
      exposeRuntime={exposeRuntime}
      beforeComposer={Tray}
    />
  )
  act(() =>
    store.ask(question.handle, {
      agentId: "agent-1",
      sessionId: "session-1",
      question: QUESTION,
    })
  )
  return { question, openSession }
}

describe("side-question tray", () => {
  afterEach(cleanup)

  it("shows the answer once it arrives, and Continue opens the kept fork", async () => {
    const { question, openSession } = renderTray()
    const tray = screen.getByRole("region", { name: copy.one })
    expect(within(tray).getByText(copy.asking)).toBeVisible()

    question.publish({ state: "answered", answer: ANSWER, sessionId: "fork-1" })
    // Rendered as markdown: the emphasis, never the asterisks.
    expect(
      await within(tray).findByText("Contoso", { selector: "strong" })
    ).toBeVisible()
    expect(within(tray).getByRole("status")).not.toHaveTextContent("**")

    await userEvent.click(screen.getByRole("button", { name: copy.continue }))
    expect(question.handle.keep).toHaveBeenCalledOnce()
    expect(openSession).toHaveBeenCalledWith("fork-1", "agent-1")
    expect(question.handle.dismiss).not.toHaveBeenCalled()
    expect(screen.queryByRole("region", { name: copy.one })).toBeNull()
  })

  it.each([
    [
      "its Dismiss button",
      () => userEvent.click(screen.getByText(copy.dismiss)),
    ],
    [
      "Escape",
      async () => {
        screen.getByText(copy.dismiss).focus()
        await userEvent.keyboard("{Escape}")
      },
    ],
  ])("dismisses a question with %s", async (_, dismiss) => {
    const { question } = renderTray()

    await dismiss()

    expect(question.handle.dismiss).toHaveBeenCalledOnce()
    expect(question.handle.keep).not.toHaveBeenCalled()
    expect(screen.queryByRole("region", { name: copy.one })).toBeNull()
    expect(question.followers()).toBe(0)
    // The last row gone, focus goes to the composer, never the page.
    expect(screen.getByRole("textbox", { name: "Message input" })).toHaveFocus()
  })

  it("gives focus to an open edit once the last question is dismissed", async () => {
    let runtime: AssistantRuntime | undefined
    renderTray({
      initialMessages: INITIAL_MESSAGES,
      exposeRuntime: (value) => {
        runtime = value
      },
    })
    act(() => {
      runtime!.thread.getMessageById("message-user").composer.beginEdit()
    })
    const editor = await screen.findByRole("textbox", {
      name: "Editing message",
    })

    screen.getByText(copy.dismiss).focus()
    await userEvent.keyboard("{Escape}")

    expect(editor).toHaveFocus()
  })
})
