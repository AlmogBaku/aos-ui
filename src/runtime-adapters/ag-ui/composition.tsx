"use client"

import { HttpAgent } from "@ag-ui/client"
import { useMemo, useState } from "react"

import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
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
  const agent = useMemo(() => new HttpAgent({ url: runUrl }), [runUrl])
  const workspaceTransport = useMemo(
    () => createAgUiHttpWorkspaceTransport({ baseUrl: workspaceUrl }),
    [workspaceUrl]
  )
  const bundle = useAgUiRuntimeBundle({ agent, workspaceTransport })
  const artifactToolkit = useMemo(() => createAgUiArtifactToolkit(), [])
  const [now] = useState(() => new Date(nowIso))

  return (
    <AosUiWorkspace
      locale={locale}
      dictionary={dictionary}
      bundle={bundle}
      now={now}
      assistantInstructions={agUiProviderInstructions}
      assistantToolkit={artifactToolkit}
      activityCoverage="active-session"
      artifactHtmlAssetOrigins={artifactHtmlAssetOrigins}
      artifactMessageProjector={projectAgUiArtifactMessages}
    />
  )
}
