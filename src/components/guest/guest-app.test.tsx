import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { GuestBootstrap } from "@shared/guest"
import { GuestApp } from "./guest-app"

const bootstrap: GuestBootstrap = {
  conversation: "welcome-conversation",
  expiresAt: Math.floor(Date.now() / 1_000) + 60,
  state: "existing",
  ui: {
    lang: "he",
    name: "Northwind",
    title: "Project brief",
    message: "Welcome aboard",
  },
  capabilities: {
    attachments: false,
    edit: false,
    regenerate: false,
    branches: false,
    questions: false,
    transcription: false,
    speech: false,
  },
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.cookie = "aos-ui-locale=; Max-Age=0; Path=/"
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("GuestApp", () => {
  it("uses the AOS identity and shared navigation-free workspace shell when branding is omitted", () => {
    const { container } = render(
      <GuestApp initialBootstrap={{ ...bootstrap, ui: { lang: "en" } }} />
    )

    expect(screen.getByText("AOS")).toBeVisible()
    expect(
      container.querySelector('header img[src="/logo-adaptive.svg"]')
    ).toBeTruthy()
    expect(
      container.querySelector('section[data-navigation-hidden="true"]')
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open Agents" })).toBeNull()
    expect(
      container.querySelector('[data-slot="guest-surface"]')
    ).not.toHaveClass("h-dvh")
  })

  it("shows a published artifact in the invited transcript", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input) === "/api/guest/history") {
        return Promise.resolve(
          Response.json({
            messages: [
              {
                id: "artifact-message",
                role: "assistant",
                content: [
                  {
                    type: "artifact",
                    artifact: {
                      id: "artifact-1",
                      filename: "Interview brief.pdf",
                      mimeType: "application/pdf",
                      sizeBytes: 42,
                      source: { type: "provider", reference: "artifact-1" },
                    },
                  },
                ],
              },
            ],
            running: false,
          })
        )
      }
      return Promise.resolve(new Response())
    })
    vi.stubGlobal("fetch", fetcher)

    render(<GuestApp initialBootstrap={{ ...bootstrap, ui: { lang: "en" } }} />)

    expect(await screen.findByText("Interview brief.pdf")).toBeVisible()
  })

  it("aligns the shared read-aloud action with the message action row", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        String(input) === "/api/guest/history"
          ? Response.json({
              messages: [
                {
                  id: "spoken-answer",
                  role: "assistant",
                  content: [{ type: "text", text: "Spoken answer" }],
                },
              ],
              running: false,
            })
          : new Response()
      )
    )
    vi.stubGlobal("fetch", fetcher)
    render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          ui: { lang: "en" },
          capabilities: { ...bootstrap.capabilities, speech: true },
        }}
      />
    )
    const message = (await screen.findByText("Spoken answer")).closest(
      '[data-role="assistant"]'
    )!
    fireEvent.mouseEnter(message)
    const speak = within(message as HTMLElement).getByRole("button", {
      name: "Read aloud",
    })

    expect(speak.parentElement).toHaveClass("items-center")
    expect(screen.queryByRole("button", { name: /Record:/ })).toBeNull()
  })

  it("retries a failed redemption with the invite removed from the URL", async () => {
    history.replaceState({}, "", "/#invite=retry-secret")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...bootstrap, ui: { lang: "en" } }), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [], running: false }), {
          headers: { "content-type": "application/json" },
        })
      )
    vi.stubGlobal("fetch", fetcher)
    const user = userEvent.setup()

    render(<GuestApp />)
    await user.click(await screen.findByRole("button", { name: "Try again" }))
    await screen.findByRole("textbox", { name: "Message input" })

    expect(location.hash).toBe("")
    const redemptionCalls = fetcher.mock.calls.filter(
      ([url]) => String(url) === "/api/guest/redeem"
    )
    expect(redemptionCalls).toHaveLength(2)
    expect(redemptionCalls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ token: "retry-secret" }),
      JSON.stringify({ token: "retry-secret" }),
    ])
  })

  it("puts a new-conversation prefill in the editable composer without sending it", async () => {
    document.cookie = "aos-ui-locale=en; Path=/"
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input)
      if (url === "/api/guest/history") {
        return Promise.resolve(
          new Response(JSON.stringify({ messages: [], running: false }), {
            headers: { "content-type": "application/json" },
          })
        )
      }
      return Promise.resolve(new Response(null))
    })
    vi.stubGlobal("fetch", fetcher)
    const first = render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          state: "new",
          prefill: "Help me get started",
          ui: { lang: "en" },
        }}
      />
    )

    const composer = await screen.findByRole(
      "textbox",
      { name: "Message input" },
      { timeout: 5_000 }
    )
    expect(composer).toHaveValue("Help me get started")
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(
      "/api/guest/send"
    )

    fireEvent.change(composer, { target: { value: "My edited message" } })
    first.unmount()
    render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          state: "new",
          prefill: "Help me get started",
          ui: { lang: "en" },
        }}
      />
    )
    expect(composer).toHaveValue("My edited message")
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(
      "/api/guest/send"
    )
  }, 10_000)

  it("uses an explicit browser locale over the invitation default", () => {
    document.cookie = "aos-ui-locale=en; Path=/"
    render(<GuestApp initialBootstrap={bootstrap} />)
    expect(document.documentElement.dir).toBe("ltr")
    expect(
      screen.getByRole("button", { name: "Continue to chat" })
    ).toBeVisible()
  })

  it("remembers welcome dismissal for this conversation and keeps it reopenable", async () => {
    document.cookie = "aos-ui-locale=en; Path=/"
    localStorage.setItem(
      "aos.guest.welcome.v1.welcome-conversation",
      "dismissed"
    )
    const user = userEvent.setup()
    render(<GuestApp initialBootstrap={bootstrap} />)
    expect(
      screen.queryByRole("button", { name: "Continue to chat" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Welcome note/ }))
    expect(
      screen.getByRole("button", { name: "Continue to chat" })
    ).toBeVisible()
  })

  it("uses the invitation's Hebrew RTL default when no browser preference exists", async () => {
    render(<GuestApp initialBootstrap={bootstrap} />)
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"))
    expect(document.documentElement.lang).toBe("he")
  })

  it("gives compact welcome controls localized accessible names", async () => {
    localStorage.setItem(
      "aos.guest.welcome.v1.welcome-conversation",
      "dismissed"
    )
    const user = userEvent.setup()
    render(<GuestApp initialBootstrap={bootstrap} />)

    const welcome = screen.getByRole("button", { name: "הודעת פתיחה" })
    expect(welcome).toHaveAttribute("aria-label", "הודעת פתיחה")
    await user.click(welcome)
    expect(screen.getByRole("button", { name: "סגירה" })).toBeVisible()
  })

  it("keeps invitation accent buttons readable", () => {
    localStorage.setItem(
      "aos.guest.welcome.v1.welcome-conversation",
      "dismissed"
    )
    const first = render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          ui: { ...bootstrap.ui, accent: "#ffffff" },
        }}
      />
    )
    const surface = document.querySelector<HTMLElement>(
      '[data-slot="guest-surface"]'
    )
    expect(surface?.style.getPropertyValue("--primary")).toBe("#ffffff")
    expect(surface?.style.getPropertyValue("--primary-foreground")).toBe(
      "#000000"
    )

    first.unmount()
    render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          ui: { ...bootstrap.ui, accent: "#000000" },
        }}
      />
    )
    const darkSurface = document.querySelector<HTMLElement>(
      '[data-slot="guest-surface"]'
    )
    expect(darkSurface?.style.getPropertyValue("--primary-foreground")).toBe(
      "#ffffff"
    )
  })

  it("localizes Hebrew attachment controls", () => {
    localStorage.setItem(
      "aos.guest.welcome.v1.welcome-conversation",
      "dismissed"
    )
    render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          capabilities: { ...bootstrap.capabilities, attachments: true },
        }}
      />
    )

    expect(
      screen.getByRole("button", { name: "הוספת קובץ מצורף" })
    ).toBeVisible()
  })

  it("blocks the composer and submits ordered batched question answers", async () => {
    document.cookie = "aos-ui-locale=en; Path=/"
    let answered = false
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input)
      if (url === "/api/guest/history") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [
                {
                  id: "assistant-before-question",
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "Please answer these before we continue.",
                    },
                  ],
                },
              ],
              pendingQuestions: answered
                ? []
                : [
                    {
                      id: "opaque-question-1",
                      questions: [
                        {
                          header: "Style",
                          question: "How should I work?",
                          options: [
                            { label: "Fast", description: "Move quickly" },
                            {
                              label: "Thorough",
                              description: "Check every detail",
                            },
                          ],
                          multiple: true,
                          custom: false,
                        },
                        {
                          header: "Details",
                          question: "Anything else?",
                          options: [],
                          custom: true,
                        },
                      ],
                    },
                  ],
              running: false,
            }),
            { headers: { "content-type": "application/json" } }
          )
        )
      }
      if (url === "/api/guest/question/reply") {
        answered = true
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 202 })
        )
      }
      return Promise.resolve(new Response(null))
    })
    vi.stubGlobal("fetch", fetcher)
    const user = userEvent.setup()

    render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          ui: { lang: "en" },
          capabilities: { ...bootstrap.capabilities, questions: true },
        }}
      />
    )

    expect(await screen.findByText("How should I work?")).toBeVisible()
    expect(
      screen.getByText("Please answer these before we continue.")
    ).toBeVisible()
    expect(
      screen.queryByRole("textbox", { name: "Message input" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("option", { name: /Fast/ }))
    await user.click(screen.getByRole("option", { name: /Thorough/ }))
    await user.click(screen.getByRole("button", { name: "Next" }))
    await user.click(screen.getByRole("button", { name: "Type an answer" }))
    await user.type(
      screen.getByRole("textbox", { name: "Your answer for Details" }),
      "Please summarize at the end"
    )
    await user.click(screen.getByRole("button", { name: "Send answer" }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/guest/question/reply" &&
            JSON.stringify(JSON.parse(String(init?.body))) ===
              JSON.stringify({
                questionId: "opaque-question-1",
                answers: [
                  ["Fast", "Thorough"],
                  ["Please summarize at the end"],
                ],
              })
        )
      ).toBe(true)
    )
  }, 15_000)

  it("lets the guest reject a pending question", async () => {
    document.cookie = "aos-ui-locale=en; Path=/"
    let rejected = false
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input)
      if (url === "/api/guest/history") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [],
              pendingQuestions: rejected
                ? []
                : [
                    {
                      id: "opaque-question-2",
                      questions: [
                        {
                          header: "Direction",
                          question: "Continue?",
                          options: [{ label: "Yes", description: "Continue" }],
                          custom: false,
                        },
                      ],
                    },
                  ],
              running: false,
            }),
            { headers: { "content-type": "application/json" } }
          )
        )
      }
      if (url === "/api/guest/question/reject") {
        rejected = true
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 202 })
        )
      }
      return Promise.resolve(new Response(null))
    })
    vi.stubGlobal("fetch", fetcher)
    const user = userEvent.setup()

    render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          ui: { lang: "en" },
          capabilities: { ...bootstrap.capabilities, questions: true },
        }}
      />
    )

    expect(await screen.findByText("Continue?")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/guest/question/reject" &&
            JSON.parse(String(init?.body)).questionId === "opaque-question-2"
        )
      ).toBe(true)
    )
  }, 15_000)

  it("preserves an image attachment MIME type through the guest send", async () => {
    document.cookie = "aos-ui-locale=en; Path=/"
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input)
      if (url === "/api/guest/history") {
        return Promise.resolve(
          new Response(JSON.stringify({ messages: [], running: false }), {
            headers: { "content-type": "application/json" },
          })
        )
      }
      if (url === "/api/guest/send") {
        return Promise.resolve(new Response(null, { status: 202 }))
      }
      return Promise.resolve(
        new Response("", { headers: { "content-type": "text/event-stream" } })
      )
    })
    vi.stubGlobal("fetch", fetcher)
    const user = userEvent.setup()
    const openChooser = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined)
    render(
      <GuestApp
        initialBootstrap={{
          ...bootstrap,
          ui: { lang: "en" },
          capabilities: { ...bootstrap.capabilities, attachments: true },
        }}
      />
    )

    await user.click(screen.getByRole("button", { name: "Add attachment" }))
    const chooser = openChooser.mock.instances[0] as
      HTMLInputElement | undefined
    expect(chooser).toBeDefined()
    const file = new File([new Uint8Array([137, 80, 78, 71])], "photo.png", {
      type: "image/png",
    })
    Object.defineProperty(chooser!, "files", { value: [file] })
    fireEvent.change(chooser!)
    await user.type(
      screen.getByRole("textbox", { name: "Message input" }),
      "See attached"
    )
    await user.click(screen.getByRole("button", { name: "Send message" }))

    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([url]) => String(url) === "/api/guest/send")
      ).toBe(true)
    )
    const send = fetcher.mock.calls.find(
      ([url]) => String(url) === "/api/guest/send"
    )
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({
      content: [
        { type: "text", text: "See attached" },
        { type: "image", filename: "photo.png", mime: "image/png" },
      ],
    })
  }, 30_000)

  it("releases the queue when a native reply completes between observations", async () => {
    document.cookie = "aos-ui-locale=en; Path=/"
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input)
      if (url === "/api/guest/history") {
        return Promise.resolve(
          new Response(JSON.stringify({ messages: [], running: false }), {
            headers: { "content-type": "application/json" },
          })
        )
      }
      if (url === "/api/guest/send") {
        return Promise.resolve(new Response(null, { status: 202 }))
      }
      return Promise.resolve(
        new Response("", { headers: { "content-type": "text/event-stream" } })
      )
    })
    vi.stubGlobal("fetch", fetcher)
    const user = userEvent.setup()
    render(<GuestApp initialBootstrap={{ ...bootstrap, ui: { lang: "en" } }} />)
    const composer = await screen.findByRole("textbox", {
      name: "Message input",
    })

    for (const text of ["First", "Second"]) {
      await user.type(composer, text)
      await user.click(screen.getByRole("button", { name: "Send message" }))
      await waitFor(() =>
        expect(
          fetcher.mock.calls.filter(
            ([url]) => String(url) === "/api/guest/send"
          )
        ).toHaveLength(text === "First" ? 1 : 2)
      )
    }
  }, 30_000)
})
