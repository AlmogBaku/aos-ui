"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"

export type AuthGateFailureKind =
  | "aos-auth-required"
  | "runtime-auth-required"
  | "connection-interrupted"
  | "provider-unavailable"
  | "proxy-failure"

type AuthGateState =
  | "loading"
  | "ready"
  | "aos-auth-required"
  | "runtime-auth-required"
  | AuthGateFailureKind

export class AuthGateFailure extends Error {
  constructor(readonly kind: AuthGateFailureKind) {
    super("Authentication gate request failed")
    this.name = "AuthGateFailure"
  }
}

export type OperatorAuthResult = {
  status: "authenticated" | "authentication-required"
}

export type RuntimeAuthResult = {
  status: "authenticated" | "authentication-required" | "unavailable"
}

export type AuthGateProbe = (signal: AbortSignal) => Promise<void>

export type AosAuthGateProps = {
  locale: Locale
  operatorAuth: (signal: AbortSignal) => Promise<OperatorAuthResult>
  runtimeAuth: (signal: AbortSignal) => Promise<RuntimeAuthResult>
  /** Runs only after both authentication checks succeed. */
  startup?: AuthGateProbe
  /** Runs only after the user explicitly requests a retry or reconnect. */
  retry?: AuthGateProbe
  children: ReactNode
}

const copy = {
  en: {
    loading: "Connecting to AOS…",
    "aos-auth-required": "Sign in to AOS to continue.",
    "runtime-auth-required": "Connect the configured runtime to continue.",
    "provider-unavailable": "Runtime provider temporarily unavailable.",
    "connection-interrupted": "Connection interrupted.",
    "proxy-failure": "AOS could not safely load the runtime.",
    operatorAction: "Sign in to AOS",
    runtimeAction: "Connect runtime",
    retry: "Try again",
    reconnect: "Reconnect",
  },
  he: {
    loading: "מתבצע חיבור ל-AOS…",
    "aos-auth-required": "יש להיכנס ל-AOS כדי להמשיך.",
    "runtime-auth-required": "יש לחבר את סביבת הריצה שהוגדרה כדי להמשיך.",
    "provider-unavailable": "ספק סביבת הריצה אינו זמין כרגע.",
    "connection-interrupted": "החיבור נותק.",
    "proxy-failure": "לא ניתן לטעון את סביבת הריצה של AOS באופן בטוח.",
    operatorAction: "כניסה ל-AOS",
    runtimeAction: "חיבור סביבת הריצה",
    retry: "ניסיון נוסף",
    reconnect: "חיבור מחדש",
  },
} as const

const failureKinds = new Set<AuthGateFailureKind>([
  "aos-auth-required",
  "runtime-auth-required",
  "connection-interrupted",
  "provider-unavailable",
  "proxy-failure",
])

function failureKind(error: unknown): AuthGateFailureKind {
  if (error instanceof AuthGateFailure) return error.kind
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    typeof error.kind === "string" &&
    failureKinds.has(error.kind as AuthGateFailureKind)
  )
    return error.kind as AuthGateFailureKind
  return "proxy-failure"
}

export function normalizeAosAuthReturnPath({
  pathname,
  search,
  hash,
}: Pick<Location, "pathname" | "search" | "hash">): string {
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\")
  )
    return "/"
  const normalizedSearch = search.startsWith("?") ? search : ""
  const normalizedHash = hash.startsWith("#") ? hash : ""
  return `${pathname}${normalizedSearch}${normalizedHash}`
}

function authStartUrl(kind: "operator" | "runtime") {
  const returnPath = normalizeAosAuthReturnPath(window.location)
  return `/api/aos/v1/auth/${kind}/start?${new URLSearchParams({ return: returnPath })}`
}

export function AosAuthGate({
  locale,
  operatorAuth,
  runtimeAuth,
  startup,
  retry,
  children,
}: AosAuthGateProps) {
  const [state, setState] = useState<AuthGateState>("loading")
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const stateRef = useRef<HTMLElement>(null)

  const rerun = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    const currentGeneration = ++generation.current
    const publish = (next: AuthGateState) => {
      if (!controller.signal.aborted && generation.current === currentGeneration)
        setState(next)
    }
    const run = async () => {
      publish("loading")
      try {
        if (attempt > 0 && retry) await retry(controller.signal)
        const operator = await operatorAuth(controller.signal)
        if (operator.status !== "authenticated") {
          publish("aos-auth-required")
          return
        }
        const runtime = await runtimeAuth(controller.signal)
        if (runtime.status === "authentication-required") {
          publish("runtime-auth-required")
          return
        }
        if (runtime.status === "unavailable") {
          publish("provider-unavailable")
          return
        }
        await startup?.(controller.signal)
        publish("ready")
      } catch (error) {
        if (!controller.signal.aborted) publish(failureKind(error))
      }
    }
    void run()
    return () => {
      controller.abort()
    }
  }, [attempt, operatorAuth, retry, runtimeAuth, startup])

  useEffect(() => {
    if (state !== "loading" && state !== "ready") stateRef.current?.focus()
  }, [state])

  if (state === "ready") return <>{children}</>
  const labels = copy[locale]
  if (state === "loading")
    return (
      <main
        dir={locale === "he" ? "rtl" : "ltr"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
      >
        {labels.loading}
      </main>
    )

  const authKind =
    state === "aos-auth-required"
      ? "operator"
      : state === "runtime-auth-required"
        ? "runtime"
        : undefined
  const action =
    state === "connection-interrupted" ? labels.reconnect : labels.retry

  return (
    <main
      ref={stateRef}
      tabIndex={-1}
      dir={locale === "he" ? "rtl" : "ltr"}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className="flex h-full items-center justify-center p-6"
    >
      <div className="max-w-md space-y-4 text-center">
        <p className="text-sm text-muted-foreground">{labels[state]}</p>
        {authKind ? (
          <a className={buttonVariants()} href={authStartUrl(authKind)}>
            {authKind === "operator"
              ? labels.operatorAction
              : labels.runtimeAction}
          </a>
        ) : (
          <Button type="button" onClick={rerun}>
            {action}
          </Button>
        )}
      </div>
    </main>
  )
}
