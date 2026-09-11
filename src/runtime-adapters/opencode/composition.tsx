"use client"

import {
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { OpencodeClient } from "@assistant-ui/react-opencode"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { Button } from "@/components/ui/button"
import { ErrorToast } from "@/components/ui/error-toast"
import type { Locale } from "@/lib/i18n/config"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "@/runtime-adapters/definition"
import {
  aosOpenCodeExtras,
  useAosOpenCodeSession,
} from "./opencode-runtime-extras"
import {
  useOpenCodeComposerFeatures,
  useOpenCodeComposerState,
} from "./use-opencode-composer-features"
import { useOpenCodeRuntimeBundle } from "./use-opencode-runtime-bundle"

function OpenCodeRuntimeProvider({
  config,
  locale,
  children,
}: RuntimeAdapterProps<"opencode">) {
  const [errors, setErrors] = useState<
    Record<string, { kind: "model" | "questions"; error: Error } | undefined>
  >({})
  const onInteractionError = useCallback(
    (error: Error | undefined, threadId: string) => {
      setErrors((previous) => ({
        ...previous,
        [threadId]: error
          ? { kind: "questions", error }
          : previous[threadId]?.kind === "questions"
            ? undefined
            : previous[threadId],
      }))
    },
    []
  )
  const bundle = useOpenCodeRuntimeBundle({ ...config, onInteractionError })
  const extras = useSyncExternalStore(
    bundle.assistantRuntime.thread.subscribe,
    () =>
      aosOpenCodeExtras.tryGet(
        bundle.assistantRuntime.thread.getState().extras
      ),
    () => undefined
  )
  const composer = useOpenCodeComposerState(
    bundle.client,
    extras,
    config.composerFeatures,
    (error, threadId) => {
      setErrors((previous) => ({
        ...previous,
        [threadId]: { kind: "model", error },
      }))
    }
  )
  const threadId = extras?.session?.id
  const failure = threadId ? errors[threadId] : undefined
  return (
    <>
      {children({
        assistantRuntime: bundle.assistantRuntime,
        workspace: bundle.workspace,
        interactions: bundle.interactions,
        composer,
        activityCoverage: "workspace",
        artifacts: bundle.artifacts
          ? {
              resolver: bundle.artifacts,
              htmlAssetOrigins: config.artifactHtmlAssetOrigins,
            }
          : undefined,
      })}
      {failure && threadId ? (
        <ErrorToast
          locale={locale}
          title={
            failure.kind === "model"
              ? locale === "he"
                ? "שינוי המודל נכשל"
                : "Model change failed"
              : locale === "he"
                ? "לא ניתן לטעון שאלות ממתינות מ-OpenCode."
                : "Pending OpenCode questions could not be loaded."
          }
          message={failure.error.message}
          onDismiss={() =>
            setErrors((previous) => ({ ...previous, [threadId]: undefined }))
          }
          actions={
            failure.kind === "questions" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setErrors((previous) => ({
                    ...previous,
                    [threadId]: undefined,
                  }))
                  bundle.interactions.retry(threadId)
                }}
              >
                {locale === "he" ? "ניסיון חוזר" : "Try again"}
              </Button>
            ) : undefined
          }
        />
      ) : null}
    </>
  )
}

export const runtimeAdapter: RuntimeAdapterDefinition<"opencode"> = {
  mode: "opencode",
  Provider: OpenCodeRuntimeProvider,
}

/** Composer binding for consumers already inside an Assistant UI runtime. */
export function OpenCodeComposerFeatures({
  client,
  config,
  locale,
  children,
}: {
  client: OpencodeClient
  config?: ComposerFeatureConfig | undefined
  locale: Locale
  children: (features: ComposerFeatureViewModel) => ReactNode
}) {
  const session = useAosOpenCodeSession()
  const [errors, setErrors] = useState<Record<string, Error | undefined>>({})
  const features = useOpenCodeComposerFeatures(
    client,
    config,
    (error, sessionId) => {
      setErrors((previous) => ({ ...previous, [sessionId]: error }))
    }
  )
  const sessionId = session?.id
  const error = sessionId ? errors[sessionId] : undefined
  return (
    <>
      {children(features)}
      {error && sessionId ? (
        <ErrorToast
          locale={locale}
          title={locale === "he" ? "שינוי המודל נכשל" : "Model change failed"}
          message={error.message}
          onDismiss={() =>
            setErrors((previous) => ({ ...previous, [sessionId]: undefined }))
          }
        />
      ) : null}
    </>
  )
}
