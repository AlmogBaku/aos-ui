import { StrictMode } from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AosAuthGate,
  AuthGateFailure,
  normalizeAosAuthReturnPath,
} from "./aos-auth-gate"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, "", "/")
})

const authenticated = { status: "authenticated" } as const

function renderGate({
  locale = "en",
  operatorAuth = vi.fn(async () => authenticated),
  runtimeAuth = vi.fn(async () => authenticated),
  startup,
  retry,
}: {
  locale?: "en" | "he"
  operatorAuth?: (signal: AbortSignal) => Promise<typeof authenticated | { status: "authentication-required" }>
  runtimeAuth?: (
    signal: AbortSignal
  ) => Promise<
    | typeof authenticated
    | { status: "authentication-required" }
    | { status: "unavailable" }
  >
  startup?: (signal: AbortSignal) => Promise<void>
  retry?: (signal: AbortSignal) => Promise<void>
} = {}) {
  return {
    operatorAuth,
    runtimeAuth,
    startup,
    retry,
    ...render(
      <AosAuthGate
        locale={locale}
        operatorAuth={operatorAuth}
        runtimeAuth={runtimeAuth}
        startup={startup}
        retry={retry}
      >
        <main>Authenticated workspace</main>
      </AosAuthGate>
    ),
  }
}

describe("AosAuthGate", () => {
  it("announces loading before rendering the workspace", () => {
    const operatorAuth = vi.fn(() => new Promise<typeof authenticated>(() => {}))

    renderGate({ operatorAuth })

    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting to AOS…"
    )
    expect(screen.queryByText("Authenticated workspace")).not.toBeInTheDocument()
  })

  it("offers same-origin AOS sign-in with the encoded current return route", async () => {
    window.history.replaceState({}, "", "/he/agent?tab=work#latest")
    renderGate({
      operatorAuth: vi.fn(async () => ({ status: "authentication-required" })),
    })

    const signIn = await screen.findByRole("link", { name: "Sign in to AOS" })
    expect(signIn).toHaveAttribute(
      "href",
      "/api/aos/v1/auth/operator/start?return=%2Fhe%2Fagent%3Ftab%3Dwork%23latest"
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sign in to AOS to continue."
    )
  })

  it("offers runtime authentication only after AOS authentication succeeds", async () => {
    const operatorAuth = vi.fn(async () => authenticated)
    const runtimeAuth = vi.fn(async () => ({ status: "authentication-required" } as const))

    renderGate({ operatorAuth, runtimeAuth })

    expect(await screen.findByRole("link", { name: "Connect runtime" })).toHaveAttribute(
      "href",
      expect.stringContaining("/api/aos/v1/auth/runtime/start?return=")
    )
    expect(operatorAuth).toHaveBeenCalledTimes(1)
    expect(runtimeAuth).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["provider-unavailable", new AuthGateFailure("provider-unavailable"), "Runtime provider temporarily unavailable", "Try again"],
    ["connection-interrupted", new AuthGateFailure("connection-interrupted"), "Connection interrupted", "Reconnect"],
    [
      "proxy-failure",
      new Error("private transport detail"),
      "AOS could not safely load the runtime",
      "Try again",
    ],
  ] as const)("renders a distinct safe %s state", async (_kind, failure, message, action) => {
    renderGate({ operatorAuth: vi.fn(async () => Promise.reject(failure)) })

    expect(await screen.findByRole("alert")).toHaveTextContent(message)
    expect(screen.getByRole("button", { name: action })).toBeEnabled()
    expect(screen.queryByText("private transport detail")).not.toBeInTheDocument()
  })

  it("runs a fresh complete sequence only when the user retries", async () => {
    const operatorAuth = vi
      .fn<() => Promise<typeof authenticated>>()
      .mockRejectedValueOnce(new AuthGateFailure("connection-interrupted"))
      .mockResolvedValue(authenticated)
    const runtimeAuth = vi.fn(async () => authenticated)
    const startup = vi.fn(async () => undefined)
    const retry = vi.fn(async () => undefined)
    const user = userEvent.setup()

    renderGate({ operatorAuth, runtimeAuth, startup, retry })
    await user.click(await screen.findByRole("button", { name: "Reconnect" }))

    await screen.findByText("Authenticated workspace")
    expect(operatorAuth).toHaveBeenCalledTimes(2)
    expect(runtimeAuth).toHaveBeenCalledTimes(1)
    expect(startup).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("does not publish stale or unmounted startup results", async () => {
    let resolveFirst: ((value: typeof authenticated) => void) | undefined
    const first = new Promise<typeof authenticated>((resolve) => {
      resolveFirst = resolve
    })
    const operatorAuth = vi.fn(() => first)
    const { unmount } = renderGate({ operatorAuth })

    unmount()
    resolveFirst?.(authenticated)
    await Promise.resolve()

    expect(screen.queryByText("Authenticated workspace")).not.toBeInTheDocument()
  })

  it("rejects the superseded Strict Mode startup result", async () => {
    const resolvers: Array<(value: typeof authenticated) => void> = []
    const operatorAuth = vi.fn(
      () =>
        new Promise<typeof authenticated>((resolve) => {
          resolvers.push(resolve)
        })
    )

    render(
      <StrictMode>
        <AosAuthGate
          locale="en"
          operatorAuth={operatorAuth}
          runtimeAuth={vi.fn(async () => authenticated)}
        >
          <main>Authenticated workspace</main>
        </AosAuthGate>
      </StrictMode>
    )
    await waitFor(() => expect(operatorAuth).toHaveBeenCalledTimes(2))

    resolvers[1]?.(authenticated)
    await screen.findByText("Authenticated workspace")
    resolvers[0]?.(authenticated)
    await Promise.resolve()

    expect(screen.getByText("Authenticated workspace")).toBeVisible()
  })

  it("uses Hebrew copy and RTL direction", async () => {
    renderGate({
      locale: "he",
      operatorAuth: vi.fn(async () => ({ status: "authentication-required" })),
    })

    expect(await screen.findByRole("link", { name: "כניסה ל-AOS" })).toBeVisible()
    expect(screen.getByRole("alert")).toHaveAttribute("dir", "rtl")
  })
})

describe("normalizeAosAuthReturnPath", () => {
  it("retains only a valid same-origin path, search, and hash", () => {
    expect(
      normalizeAosAuthReturnPath({
        pathname: "/agent/session",
        search: "?view=plan",
        hash: "#run",
      })
    ).toBe("/agent/session?view=plan#run")
    expect(
      normalizeAosAuthReturnPath({
        pathname: "//outside.example",
        search: "?next=1",
        hash: "#x",
      })
    ).toBe("/")
  })
})
