"use client"

import { HttpAgent } from "@ag-ui/client"
import { useMemo, useState } from "react"

import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { agUiProviderInstructions } from "@/lib/harness/manifests"
import {
  createAgUiHttpWorkspaceTransport,
  useAgUiRuntimeBundle,
} from "@/lib/runtime-adapters/ag-ui"

export function AgUiAosUiApp({
  locale,
  dictionary,
  runUrl,
  workspaceUrl,
  nowIso,
}: {
  locale: Locale
  dictionary: Dictionary
  runUrl: string
  workspaceUrl: string
  nowIso: string
}) {
  const agent = useMemo(() => new HttpAgent({ url: runUrl }), [runUrl])
  const workspaceTransport = useMemo(
    () => createAgUiHttpWorkspaceTransport({ baseUrl: workspaceUrl }),
    [workspaceUrl]
  )
  const bundle = useAgUiRuntimeBundle({ agent, workspaceTransport })
  const [now] = useState(() => new Date(nowIso))

  return (
    <AosUiWorkspace
      locale={locale}
      dictionary={dictionary}
      bundle={bundle}
      now={now}
      assistantInstructions={agUiProviderInstructions}
      activityCoverage="active-session"
    />
  )
}
