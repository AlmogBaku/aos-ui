import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { connection } from "next/server"

import { RuntimeUnavailable } from "@/components/runtime-unavailable"
import { defaultLocale, isLocale, localeRequestHeader } from "@/lib/i18n/config"
import { getDictionary } from "@/lib/i18n/get-dictionary"
import { resolveRuntimeConfiguration } from "@/lib/runtime-config"

type WorkspacePageProps = {
  params: Promise<{ workspace?: string[] }>
}

export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { workspace } = await params
  if ((workspace?.length ?? 0) > 2) notFound()

  const requestLocale = (await headers()).get(localeRequestHeader)
  const locale =
    requestLocale && isLocale(requestLocale) ? requestLocale : defaultLocale
  const dictionary = await getDictionary(locale)
  await connection()
  const runtime = resolveRuntimeConfiguration({
    AOS_UI_RUNTIME_MODE: process.env.AOS_UI_RUNTIME_MODE,
    AOS_UI_OPENCODE_BASE_URL: process.env.AOS_UI_OPENCODE_BASE_URL,
    AOS_UI_OPENCODE_MANAGEMENT_URL: process.env.AOS_UI_OPENCODE_MANAGEMENT_URL,
    AOS_UI_OPENCODE_PROVIDER_ID: process.env.AOS_UI_OPENCODE_PROVIDER_ID,
    AOS_UI_OPENCODE_MODEL_ID: process.env.AOS_UI_OPENCODE_MODEL_ID,
    AOS_UI_AG_UI_URL: process.env.AOS_UI_AG_UI_URL,
    AOS_UI_AG_UI_WORKSPACE_URL: process.env.AOS_UI_AG_UI_WORKSPACE_URL,
  })
  if (runtime.status === "unavailable") {
    return <RuntimeUnavailable locale={locale} reason={runtime.reason} />
  }

  if (runtime.mode === "opencode") {
    const { OpenCodeAosUiApp } =
      await import("@/components/aos-ui-opencode-app")
    return (
      <OpenCodeAosUiApp
        locale={locale}
        dictionary={dictionary}
        baseUrl={runtime.baseUrl}
        managementUrl={runtime.managementUrl}
        defaultModel={runtime.defaultModel}
        nowIso={new Date().toISOString()}
      />
    )
  }

  if (runtime.mode === "ag-ui") {
    const { AgUiAosUiApp } = await import("@/components/aos-ui-ag-ui-app")
    return (
      <AgUiAosUiApp
        locale={locale}
        dictionary={dictionary}
        runUrl={runtime.runUrl}
        workspaceUrl={runtime.workspaceUrl}
        nowIso={new Date().toISOString()}
      />
    )
  }

  const { FixtureAosUiApp } = await import("@/components/aos-ui-fixture-app")
  return <FixtureAosUiApp locale={locale} dictionary={dictionary} />
}
