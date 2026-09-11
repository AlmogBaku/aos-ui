"use client"

import { useCallback, useState } from "react"
import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "@/runtime-adapters/definition"
import { RuntimeErrorContext } from "@/runtime-adapters/runtime-error-context"
import { Button, buttonVariants } from "@/components/ui/button"
import { ErrorToast } from "@/components/ui/error-toast"
import { useHermesComposerFeatures } from "./use-hermes-composer-features"
import { useHermesRuntimeBundle } from "@/runtime-adapters/hermes"

function HermesRuntimeProvider({
  config,
  locale,
  children,
}: RuntimeAdapterProps<"hermes">) {
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
    baseUrl: config.baseUrl,
    locale,
    onError,
    onRecovered,
  })
  const composer = useHermesComposerFeatures(
    bundle.client,
    bundle.assistantRuntime,
    config.composerFeatures,
    onError
  )
  const authenticationRequired = runtimeError?.message.includes(
    "authentication failed (401)"
  )
  const loginUrl = `${config.baseUrl.replace(/\/$/, "")}/login`

  return (
    <RuntimeErrorContext.Provider value={onError}>
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
        {children({
          assistantRuntime: bundle.assistantRuntime,
          workspace: bundle.workspace,
          interactions: bundle.interactions,
          composer,
          media: bundle.media,
          activityCoverage: "active-session",
          artifacts: bundle.artifacts
            ? {
                resolver: bundle.artifacts,
                htmlAssetOrigins: config.artifactHtmlAssetOrigins,
              }
            : undefined,
        })}
      </div>
    </RuntimeErrorContext.Provider>
  )
}

export const runtimeAdapter: RuntimeAdapterDefinition<"hermes"> = {
  mode: "hermes",
  Provider: HermesRuntimeProvider,
}
