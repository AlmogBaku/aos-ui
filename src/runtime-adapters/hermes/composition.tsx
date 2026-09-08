"use client"

import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import { VoiceMediaProvider } from "@/components/assistant-ui/voice/voice-context"
import { Button, buttonVariants } from "@/components/ui/button"
import { ErrorToast } from "@/components/ui/error-toast"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import {
  stopCurrentHermesRun,
  useHermesRuntimeBundle,
  type HermesNativeClient,
} from "@/runtime-adapters/hermes"

function selectedRemoteThreadId(
  runtime: ReturnType<typeof useHermesRuntimeBundle>["assistantRuntime"]
) {
  const state = runtime.threads.getState()
  const item = state.threadItems[state.mainThreadId]
  return item?.remoteId ?? item?.externalId
}

function HermesApprovalComposer({
  fallback,
  locale,
  client,
  runtime,
}: {
  fallback: ReactNode
  locale: Locale
  client: HermesNativeClient
  runtime: ReturnType<typeof useHermesRuntimeBundle>["assistantRuntime"]
}) {
  const threadId = useSyncExternalStore(
    runtime.threads.subscribe,
    () => selectedRemoteThreadId(runtime),
    () => selectedRemoteThreadId(runtime)
  )
  const approval = useSyncExternalStore(
    client.subscribe,
    () => (threadId ? client.session(threadId)?.approval : undefined),
    () => (threadId ? client.session(threadId)?.approval : undefined)
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()

  if (!approval) return fallback

  const respond = async (decision: "once" | "deny") => {
    setPending(true)
    setError(undefined)
    try {
      await client.answerApproval(
        approval.threadId,
        approval.requestId,
        decision
      )
    } catch {
      setError(
        locale === "he"
          ? "לא ניתן לשלוח את ההחלטה. ייתכן שהבקשה כבר אינה בתוקף."
          : "The decision could not be sent; the request may no longer be current."
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="flex flex-col gap-2"
      role="group"
      aria-label={locale === "he" ? "בקשת הרשאה" : "Permission request"}
    >
      <p className="text-sm text-muted-foreground">{approval.message}</p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() => void respond("once")}
        >
          {locale === "he" ? "אישור פעם אחת" : "Allow once"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void respond("deny")}
        >
          {locale === "he" ? "דחייה" : "Deny"}
        </Button>
      </div>
    </div>
  )
}

export function HermesAosUiApp({
  locale,
  dictionary,
  baseUrl,
  nowIso,
}: {
  locale: Locale
  dictionary: Dictionary
  baseUrl: string
  nowIso: string
}) {
  const [runtimeError, setRuntimeError] = useState<{
    message: string
    dismissed: boolean
  }>()
  const onError = useCallback((error: Error) => {
    setRuntimeError((previous) =>
      previous?.message === error.message
        ? previous
        : { message: error.message, dismissed: false }
    )
  }, [])
  const onRecovered = useCallback(() => {
    setRuntimeError((previous) =>
      previous && /Hermes (?:authentication|WebSocket)/u.test(previous.message)
        ? undefined
        : previous
    )
  }, [])
  const bundle = useHermesRuntimeBundle({
    baseUrl,
    locale,
    onError,
    onRecovered,
  })
  const [now] = useState(() => new Date(nowIso))
  const authenticationRequired = runtimeError?.message.includes(
    "authentication failed (401)"
  )
  const loginUrl = `${baseUrl.replace(/\/$/, "")}/login`
  const composer = useMemo(
    () =>
      function Composer({ fallback }: { fallback: ReactNode }) {
        return (
          <HermesApprovalComposer
            fallback={fallback}
            locale={locale}
            client={bundle.client}
            runtime={bundle.assistantRuntime}
          />
        )
      },
    [bundle.assistantRuntime, bundle.client, locale]
  )

  return (
    <div className="relative h-full">
      {runtimeError && !runtimeError.dismissed ? (
        <ErrorToast
          locale={locale}
          title={locale === "he" ? "שגיאת Hermes" : "Hermes error"}
          message={runtimeError.message}
          onDismiss={() =>
            setRuntimeError((previous) =>
              previous ? { ...previous, dismissed: true } : previous
            )
          }
          actions={
            authenticationRequired ? (
              <>
                <a
                  className={buttonVariants({ size: "sm" })}
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {locale === "he" ? "כניסה ל-Hermes" : "Sign in to Hermes"}
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => window.location.reload()}
                >
                  {locale === "he" ? "ניסיון חוזר" : "Retry"}
                </Button>
              </>
            ) : undefined
          }
        />
      ) : null}
      <VoiceMediaProvider media={bundle.media} locale={locale}>
        <AosUiWorkspace
          locale={locale}
          dictionary={dictionary}
          bundle={bundle}
          now={now}
          composer={composer}
          onWorkspaceError={onError}
          onStopRun={() => stopCurrentHermesRun(bundle.assistantRuntime)}
          activityCoverage="active-session"
        />
      </VoiceMediaProvider>
    </div>
  )
}
