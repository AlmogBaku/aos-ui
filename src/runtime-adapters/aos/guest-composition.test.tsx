import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchGuestRuntimeContext, GuestAosSurface } from "./guest-composition"

function opaqueInvitation(payload: unknown) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`
}

function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }))
}

describe("AOS guest browser composition", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("uses the gateway-verified context for the guest scope", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        runtimeId: "hermes-primary",
        agentId: "researcher",
        conversationRef: "guest_ref",
        ui: {
          lang: "en",
          name: "Research brand",
          logoUrl: "https://example.test/brand.png",
          accent: "#2563eb",
          title: "Research assistant",
          message: "Welcome!",
        },
        prefill: "Hello",
        capabilities: {
          agent: { transport: { streaming: true, resumable: true } },
          content: {
            attachments: { status: "available" },
            artifacts: { status: "available" },
            transcription: { status: "unavailable" },
            speech: { status: "unavailable" },
          },
          interactions: {
            questions: { status: "available" },
            approvals: { status: "available" },
          },
        },
        expiresAt: "2026-09-18T08:00:00.000Z",
      })
    )

    await expect(
      fetchGuestRuntimeContext(fetcher, "/api/guest/v1", "opaque.token")
    ).resolves.toMatchObject({
      scope: {
        workspaceId: "guest",
        agentId: "researcher",
        sessionId: "guest_ref",
      },
      ui: {
        lang: "en",
        name: "Research brand",
        logoUrl: "https://example.test/brand.png",
        accent: "#2563eb",
        title: "Research assistant",
        message: "Welcome!",
      },
      prefill: "Hello",
    })
    expect(fetcher).toHaveBeenCalledWith("/api/guest/v1/runtime", {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        authorization: "Bearer opaque.token",
      },
    })
  })

  it("mounts a verified guest conversation with history and presentation", async () => {
    stubMatchMedia()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "/api/guest/v1/runtime")
        return Response.json({
          runtimeId: "hermes-primary",
          agentId: "researcher",
          conversationRef: "guest_ref",
          session: { id: "guest_ref", created: false },
          ui: {
            lang: "en",
            name: "Research brand",
            logoUrl: "https://example.test/brand.png",
            accent: "#2563eb",
            title: "Research assistant",
            message: "Welcome to the conversation.",
          },
          prefill: "Hello from the invitation",
          capabilities: {
            agent: { transport: { streaming: true, resumable: true } },
            content: {
              attachments: { status: "available" },
              artifacts: { status: "available" },
              transcription: { status: "unavailable" },
              speech: { status: "unavailable" },
            },
            interactions: {
              questions: { status: "available" },
              approvals: { status: "available" },
            },
          },
          expiresAt: "2026-09-18T08:00:00.000Z",
        })
      if (url.includes("/history"))
        return Response.json({
          sessionId: "guest_ref",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: [{ type: "text", text: "Existing guest answer" }],
              createdAt: "2026-09-15T00:00:00.000Z",
            },
          ],
          total: 1,
          limit: 200,
          offset: 0,
          nextOffset: 1,
          execution: { status: "idle" },
        })
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal("fetch", fetcher)

    render(
      <GuestAosSurface
        config={{
          status: "ready",
          surface: "guest",
          basePath: "/api/guest/v1",
          lane: "guest",
        }}
        inviteToken="opaque.token"
        locale="he"
      />
    )

    expect(await screen.findByText("Research brand")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Research brand" })).toHaveAttribute(
      "src",
      "https://example.test/brand.png"
    )
    expect(await screen.findByText("Existing guest answer")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("Hello from the invitation")
    expect(document.documentElement).toHaveAttribute("lang", "en")
    expect(
      fetcher.mock.calls.some(([input]) => String(input).includes("/history"))
    ).toBe(true)
  })

  it("uses ui.message for the welcome and AOS for default branding", async () => {
    stubMatchMedia()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === "/api/guest/v1/runtime")
          return Response.json({
            runtimeId: "hermes-primary",
            agentId: "researcher",
            conversationRef: "guest_ref",
            ui: { message: "A personal note from your inviter." },
            prefill: "Draft reply",
            capabilities: {
              agent: { transport: { streaming: true, resumable: true } },
              content: {
                attachments: { status: "available" },
                artifacts: { status: "available" },
                transcription: { status: "unavailable" },
                speech: { status: "unavailable" },
              },
              interactions: {
                questions: { status: "available" },
                approvals: { status: "available" },
              },
            },
            expiresAt: "2026-09-18T08:00:00.000Z",
          })
        if (url.includes("/history"))
          return Response.json({
            sessionId: "guest_ref",
            messages: [],
            total: 0,
            limit: 200,
            offset: 0,
            nextOffset: 0,
            execution: { status: "idle" },
          })
        return new Response(null, { status: 404 })
      })
    )

    render(
      <GuestAosSurface
        config={{
          status: "ready",
          surface: "guest",
          basePath: "/api/guest/v1",
          lane: "guest",
        }}
        inviteToken="opaque.token"
        locale="en"
      />
    )

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("Draft reply")
    )
    expect(
      screen.getByRole("heading", {
        name: "A personal note from your inviter.",
      })
    ).toBeInTheDocument()
    expect(screen.getByText("AOS")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "AOS" })).toHaveAttribute(
      "src",
      "/logo-adaptive.svg"
    )
  })

  it("renders a calm unavailable state when verified context is rejected", async () => {
    stubMatchMedia()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 }))
    )

    render(
      <GuestAosSurface
        config={{
          status: "ready",
          surface: "guest",
          basePath: "/api/guest/v1",
          lane: "guest",
        }}
        inviteToken={opaqueInvitation({
          agent: "researcher",
          session: "guest_ref",
        })}
        locale="en"
      />
    )

    expect(
      await screen.findByText(
        "This invitation link is no longer active. Please ask the person who invited you to send a new one."
      )
    ).toBeInTheDocument()
  })

  it("offers retry for a temporary guest-context failure", async () => {
    stubMatchMedia()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    vi.stubGlobal("fetch", fetcher)

    render(
      <GuestAosSurface
        config={{
          status: "ready",
          surface: "guest",
          basePath: "/api/guest/v1",
          lane: "guest",
        }}
        inviteToken="opaque.token"
        locale="en"
      />
    )

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
    expect(
      await screen.findByText(
        "This invitation link is no longer active. Please ask the person who invited you to send a new one."
      )
    ).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
