"use client"

import { useEffect, useState } from "react"

import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { fixtureProviderInstructions } from "@shared/presentation/manifests"
import { useFixtureRuntimeBundle } from "./fixture-runtime"
import { FIXTURE_NOW } from "./fixture-workspace"

export function FixtureAosUiApp({
  locale,
  dictionary,
}: {
  locale: Locale
  dictionary: Dictionary
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    "thread-aster-market"
  )
  const bundle = useFixtureRuntimeBundle({
    threadId,
    onThreadIdChange: setThreadId,
    enableAgentCreator: false,
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

  return (
    <AosUiWorkspace
      locale={locale}
      dictionary={dictionary}
      bundle={bundle}
      now={FIXTURE_NOW}
      readNow={() => FIXTURE_NOW}
      environmentLabel={dictionary.workspace.fixtureLabel}
      assistantInstructions={fixtureProviderInstructions}
    />
  )
}
