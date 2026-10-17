import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LocalThread } from "@/components/assistant-ui/elements/thread.aui.test-helpers"
import { en } from "@/lib/i18n/dictionaries/en"
import type { SideQuestionSnapshot } from "@/runtime-adapters/contracts"

import { SideQuestionStore } from "./side-question-store"
import { SessionSideQuestions } from "./side-question-tray"

const copy = en.sideQuestions
const QUESTION = "Which competitor did it start with?"
const ANSWER =
  "Contoso: its pricing page changed last week, and it's the one the board asked about."

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
function renderTray() {
  const question = fakeQuestion()
  const store = new SideQuestionStore()
  const openSession = vi.fn(async () => undefined)
  const workspace = { store, dictionary: en, openSession, reportError: vi.fn() }
  const Tray = () => (
    <SessionSideQuestions workspace={workspace} sessionId="session-1" />
  )
  render(<LocalThread initialMessages={[]} beforeComposer={Tray} />)
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
    expect(within(tray).getByRole("status")).toHaveTextContent(ANSWER)

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
    // The last row gone, focus goes to the composer, never the page.
    expect(screen.getByRole("textbox", { name: "Message input" })).toHaveFocus()
  })
})
