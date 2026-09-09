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
import { RuntimeQuestionComposer } from "@/components/runtime-interactions/question-composer"
import { Button, buttonVariants } from "@/components/ui/button"
import { ErrorToast } from "@/components/ui/error-toast"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import { useHermesComposerFeatures } from "./use-hermes-composer-features"
import type { RuntimeQuestionRequest } from "@/runtime-adapters/contracts"
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

function HermesInteractionComposer({
  fallback,
  locale,
  client,
  runtime,
  interactions,
}: {
  fallback: ReactNode
  locale: Locale
  client: HermesNativeClient
  runtime: ReturnType<typeof useHermesRuntimeBundle>["assistantRuntime"]
  interactions: ReturnType<typeof useHermesRuntimeBundle>["interactions"]
}) {
  const threadId = useSyncExternalStore(
    runtime.threads.subscribe,
    () => selectedRemoteThreadId(runtime),
    () => selectedRemoteThreadId(runtime)
  )
  const session = useSyncExternalStore(
    client.subscribe,
    () => (threadId ? client.session(threadId) : undefined),
    () => (threadId ? client.session(threadId) : undefined)
  )
  if (!session || !interactions) return fallback
  if (session.clarification) {
    const request: RuntimeQuestionRequest = {
      kind: "question",
      requestId: session.clarification.requestId,
      sessionId: session.threadId,
      questions: session.clarification.questions.map((question, index) => ({
        ...(question.id ? { id: question.id } : {}),
        header: locale === "he" ? `שאלה ${index + 1}` : `Question ${index + 1}`,
        prompt: question.question,
        options: (question.choices ?? []).map((choice) => ({ label: choice })),
        multiple: question.multiple,
        custom: true,
      })),
    }
    return (
      <RuntimeQuestionComposer
        locale={locale}
        request={request}
        interactions={interactions}
        onDismissExpired={() => undefined}
        onResponsePending={() => undefined}
        onResolved={() => undefined}
      />
    )
  }
  return fallback
}

export function HermesAosUiApp({
  locale,
  dictionary,
  baseUrl,
  nowIso,
  composerFeatures: composerConfig,
}: {
  locale: Locale
  dictionary: Dictionary
  baseUrl: string
  nowIso: string
  composerFeatures?: ComposerFeatureConfig
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
  const composerFeatures = useHermesComposerFeatures(
    bundle.client,
    bundle.assistantRuntime,
    composerConfig,
    onError
  )
  const [now] = useState(() => new Date(nowIso))
  const authenticationRequired = runtimeError?.message.includes(
    "authentication failed (401)"
  )
  const loginUrl = `${baseUrl.replace(/\/$/, "")}/login`
  const composer = useMemo(
    () =>
      function Composer({ fallback }: { fallback: ReactNode }) {
        return (
          <HermesInteractionComposer
            fallback={fallback}
            locale={locale}
            client={bundle.client}
            runtime={bundle.assistantRuntime}
            interactions={bundle.interactions}
          />
        )
      },
    [bundle.assistantRuntime, bundle.client, bundle.interactions, locale]
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
          composerFeatures={composerFeatures}
          onWorkspaceError={onError}
          onStopRun={() => stopCurrentHermesRun(bundle.assistantRuntime)}
          activityCoverage="active-session"
        />
      </VoiceMediaProvider>
    </div>
  )
}
