"use client"

import { HttpAgent } from "@ag-ui/client"
import { useMemo, useState } from "react"

import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import { DEFAULT_COMPOSER_FEATURE_CONFIG } from "@shared/runtime-config"
import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "@/runtime-adapters/definition"
import { agUiProviderInstructions } from "@shared/presentation/manifests"
import { createAgUiHttpWorkspaceTransport } from "./ag-ui-http-transport"
import { useAgUiRuntimeBundle } from "./use-ag-ui-runtime-bundle"
import {
  createAgUiArtifactToolkit,
  projectAgUiArtifactMessages,
} from "./ag-ui-artifacts"

export function AgUiAosUiApp({
  locale,
  dictionary,
  runUrl,
  workspaceUrl,
  nowIso,
  composerFeatures = DEFAULT_COMPOSER_FEATURE_CONFIG,
  artifactHtmlAssetOrigins,
}: {
  locale: Locale
  dictionary: Dictionary
  runUrl: string
  workspaceUrl: string
  nowIso: string
  composerFeatures?: ComposerFeatureConfig
  artifactHtmlAssetOrigins?: readonly string[]
}) {
  const [now] = useState(() => new Date(nowIso))
  return (
    <AgUiRuntimeProvider
      locale={locale}
      config={{
        status: "ready",
        mode: "ag-ui",
        runUrl,
        workspaceUrl,
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
          now={now}
        />
      )}
    </AgUiRuntimeProvider>
  )
}

function AgUiRuntimeProvider({
  config,
  children,
}: RuntimeAdapterProps<"ag-ui">) {
  const { runUrl, workspaceUrl, artifactHtmlAssetOrigins } = config
  const agent = useMemo(() => new HttpAgent({ url: runUrl }), [runUrl])
  const workspaceTransport = useMemo(
    () => createAgUiHttpWorkspaceTransport({ baseUrl: workspaceUrl }),
    [workspaceUrl]
  )
  const bundle = useAgUiRuntimeBundle({ agent, workspaceTransport })
  const artifactToolkit = useMemo(() => createAgUiArtifactToolkit(), [])

  return children({
    assistantRuntime: bundle.assistantRuntime,
    workspace: bundle.workspace,
    activityCoverage: "active-session",
    assistantConfig: {
      instructions: agUiProviderInstructions,
      toolkit: artifactToolkit,
    },
    artifacts: bundle.artifacts
      ? {
          resolver: bundle.artifacts,
          projectMessages: projectAgUiArtifactMessages,
          htmlAssetOrigins: artifactHtmlAssetOrigins,
        }
      : undefined,
  })
}

export const runtimeAdapter: RuntimeAdapterDefinition<"ag-ui"> = {
  mode: "ag-ui",
  Provider: AgUiRuntimeProvider,
}
