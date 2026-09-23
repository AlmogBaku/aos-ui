import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CONVERSATION_SEARCH_EVENT,
  ConversationSearch,
} from "./conversation-search"

const messages = [
  {
    id: "first",
    content: [{ type: "text", text: "A **search** result and SEARCH notes" }],
  },
  { id: "second", content: [{ type: "text", text: "Another Search result" }] },
  { id: "third", content: [{ type: "text", text: "Unrelated" }] },
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document
    .querySelectorAll("[data-message-id]")
    .forEach((node) => node.remove())
})

class TestHighlight {
  readonly ranges: AbstractRange[]

  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges
  }
}

const highlightRegistry = new Map<string, TestHighlight>()

beforeEach(() => {
  highlightRegistry.clear()
  vi.stubGlobal("Highlight", TestHighlight)
  vi.stubGlobal("CSS", {
    escape: (value: string) => value,
    highlights: highlightRegistry,
  })
})

describe("ConversationSearch", () => {
  it("searches only supplied messages, cycles matches, and restores focus on Escape", async () => {
    const user = userEvent.setup()
    const trigger = document.createElement("button")
    document.body.append(trigger)
    trigger.focus()
    const viewport = document.createElement("div")
    viewport.style.overflowY = "scroll"
    Object.defineProperties(viewport, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_200 },
      scrollTop: { value: 600, writable: true },
    })
    viewport.getBoundingClientRect = () => ({ top: 0, height: 400 }) as DOMRect
    const first = document.createElement("article")
    first.dataset.messageId = "first"
    first.innerHTML =
      "<div data-searchable-message-text>A <strong>search</strong> result and SEARCH notes</div>"
    const firstText = first.firstElementChild as HTMLElement
    firstText.getBoundingClientRect = () =>
      ({ top: 120 - viewport.scrollTop, height: 80 }) as DOMRect
    first.scrollIntoView = vi.fn()
    first.getBoundingClientRect = () =>
      ({ top: 120 - viewport.scrollTop, height: 80 }) as DOMRect
    const second = document.createElement("article")
    second.dataset.messageId = "second"
    second.innerHTML =
      "<div data-searchable-message-text>Another Search result</div>"
    const secondText = second.firstElementChild as HTMLElement
    secondText.getBoundingClientRect = () =>
      ({ top: 300 - viewport.scrollTop, height: 80 }) as DOMRect
    second.scrollIntoView = vi.fn()
    second.getBoundingClientRect = () =>
      ({ top: 300 - viewport.scrollTop, height: 80 }) as DOMRect
    viewport.append(first, second)
    document.body.append(viewport)

    render(<ConversationSearch messages={messages} />)
    window.dispatchEvent(new Event(CONVERSATION_SEARCH_EVENT))

    const input = await screen.findByRole("searchbox", {
      name: "Search in conversation",
    })
    await user.type(input, "search")
    // Every prefix of the term matches the same three places, so "1 of 3" is
    // already true while the query is still "sear". The highlighted text is the
    // only signal that highlighting has caught up with the typing.
    await waitFor(() =>
      expect(
        highlightRegistry
          .get("aos-conversation-search-active")
          ?.ranges.map((range) => range.toString())
      ).toEqual(["search"])
    )
    expect(screen.getByText("1 of 3")).toBeVisible()
    expect(
      highlightRegistry.get("aos-conversation-search-match")?.ranges
    ).toHaveLength(3)

    await user.keyboard("{Enter}")
    expect(screen.getByText("2 of 3")).toBeVisible()
    expect(
      highlightRegistry
        .get("aos-conversation-search-active")
        ?.ranges.map((range) => range.toString())
    ).toEqual(["SEARCH"])

    await user.keyboard("{Enter}")
    expect(screen.getByText("3 of 3")).toBeVisible()
    expect(
      highlightRegistry
        .get("aos-conversation-search-active")
        ?.ranges.map((range) => range.toString())
    ).toEqual(["Search"])

    await user.keyboard("{ArrowUp}")
    expect(screen.getByText("2 of 3")).toBeVisible()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByText("3 of 3")).toBeVisible()

    fireEvent.keyDown(input, { key: "F3" })
    expect(screen.getByText("1 of 3")).toBeVisible()
    fireEvent.keyDown(input, { key: "F3", shiftKey: true })
    expect(screen.getByText("3 of 3")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Previous result" }))
    expect(screen.getByText("2 of 3")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Next result" }))
    expect(screen.getByText("3 of 3")).toBeVisible()

    const selectedScrollTop = viewport.scrollTop
    fireEvent.keyDown(input, { key: "Escape" })
    viewport.scrollTop = 0
    expect(screen.queryByRole("searchbox")).toBeNull()
    await waitFor(() => expect(highlightRegistry.size).toBe(0))
    await waitFor(() => expect(viewport.scrollTop).toBe(selectedScrollTop))
    await waitFor(() => expect(trigger).toHaveFocus())
    trigger.remove()
    viewport.remove()
  })

  it("counts matches in messages that are not mounted and reveals one before highlighting it", async () => {
    const user = userEvent.setup()
    const far = document.createElement("article")
    far.dataset.messageId = "far"
    far.innerHTML = "<div data-searchable-message-text>The distant beacon</div>"
    const revealMessage = vi.fn((messageId: string) => {
      if (document.querySelector(`[data-message-id="${messageId}"]`))
        return true
      document.body.append(far)
      return false
    })

    render(
      <ConversationSearch
        messages={[
          { id: "near", content: [{ type: "text", text: "Nearby notes" }] },
          {
            id: "far",
            content: [{ type: "text", text: "The distant beacon" }],
          },
        ]}
        revealMessage={revealMessage}
      />
    )
    window.dispatchEvent(new Event(CONVERSATION_SEARCH_EVENT))
    const input = await screen.findByRole("searchbox", {
      name: "Search in conversation",
    })
    await user.type(input, "beacon")

    expect(await screen.findByText("1 of 1")).toBeVisible()
    await waitFor(() =>
      expect(
        highlightRegistry
          .get("aos-conversation-search-active")
          ?.ranges.map((range) => range.toString())
      ).toEqual(["beacon"])
    )
    expect(revealMessage).toHaveBeenCalledWith("far")
  })

  it("uses the supplied RTL direction and localized search controls", async () => {
    render(
      <ConversationSearch
        messages={messages}
        direction="rtl"
        labels={{
          search: "חיפוש בשיחה",
          placeholder: "חיפוש בשיחה…",
          previous: "התוצאה הקודמת",
          next: "התוצאה הבאה",
          close: "סגירת החיפוש",
          results: (index, count) => `${index} מתוך ${count}`,
        }}
      />
    )

    window.dispatchEvent(new Event(CONVERSATION_SEARCH_EVENT))

    const search = await screen.findByRole("search", { name: "חיפוש בשיחה" })
    expect(search).toHaveAttribute("dir", "rtl")
    expect(
      screen.getByRole("button", { name: "התוצאה הקודמת" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "התוצאה הבאה" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "סגירת החיפוש" })
    ).toBeInTheDocument()
  })
})
