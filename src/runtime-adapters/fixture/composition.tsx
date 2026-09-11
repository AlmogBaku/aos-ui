"use client"

import { useEffect, useState } from "react"

import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { fixtureProviderInstructions } from "@shared/presentation/manifests"
import {
  DEFAULT_COMPOSER_FEATURE_CONFIG,
  type ComposerFeatureConfig,
} from "@shared/runtime-config"
import { useFixtureComposerFeatures } from "./fixture-composer-features"
import { useFixtureRuntimeBundle } from "./fixture-runtime"
import { FIXTURE_NOW } from "./fixture-workspace"
import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "@/runtime-adapters/definition"

export function FixtureAosUiApp({
  locale,
  dictionary,
  composerFeatures = DEFAULT_COMPOSER_FEATURE_CONFIG,
  artifactHtmlAssetOrigins,
}: {
  locale: Locale
  dictionary: Dictionary
  composerFeatures?: ComposerFeatureConfig
  artifactHtmlAssetOrigins?: readonly string[]
}) {
  return (
    <FixtureRuntimeProvider
      locale={locale}
      config={{
        status: "ready",
        mode: "fixture",
        composerFeatures,
        artifactHtmlAssetOrigins: artifactHtmlAssetOrigins
          ? [...artifactHtmlAssetOrigins]
          : undefined,
      }}
    >
      {(runtime) => (
        <AosUiWorkspace
          locale={locale}
          dictionary={dictionary}
          runtime={runtime}
          now={FIXTURE_NOW}
          readNow={() => FIXTURE_NOW}
        />
      )}
    </FixtureRuntimeProvider>
  )
}

function FixtureRuntimeProvider({
  config,
  locale,
  children,
}: RuntimeAdapterProps<"fixture">) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const bundle = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
    enableAgentCreator: false,
  })
  const composerFeatureViewModel = useFixtureComposerFeatures({
    threadId,
    config: config.composerFeatures,
    runtime: bundle.assistantRuntime,
  })

  useEffect(() => {
    if (import.meta.env.VITE_AOS_UI_E2E !== "1") return
    window.__AOS_UI_FIXTURE_WORKSPACE__ = bundle.workspace
    return () => {
      if (window.__AOS_UI_FIXTURE_WORKSPACE__ === bundle.workspace) {
        delete window.__AOS_UI_FIXTURE_WORKSPACE__
      }
    }
  }, [bundle.workspace])

  return children({
    assistantRuntime: bundle.assistantRuntime,
    workspace: bundle.workspace,
    composer: composerFeatureViewModel,
    activityCoverage: "workspace",
    assistantConfig: { instructions: fixtureProviderInstructions },
    environmentLabel: locale === "he" ? "סביבת הדגמה" : "Demo workspace",
    artifacts: {
      resolver: bundle.artifacts,
      htmlAssetOrigins: config.artifactHtmlAssetOrigins,
    },
  })
}

export const runtimeAdapter: RuntimeAdapterDefinition<"fixture"> = {
  mode: "fixture",
  Provider: FixtureRuntimeProvider,
}
