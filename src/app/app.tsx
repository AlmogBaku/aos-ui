import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router"

import { DocumentLocale } from "@/components/document-locale"
import { RuntimeUnavailable } from "@/components/runtime-unavailable"
import { ThemeProvider } from "@/components/theme-provider"
import { defaultLocale, type Locale } from "@/lib/i18n/config"
import {
  localeChangeEvent,
  readPreferredLocale,
  setPreferredLocale,
} from "@/lib/i18n/client"
import { getDictionary } from "@/lib/i18n/get-dictionary"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { stripLocaleFromPathname } from "@/lib/i18n/routing"
import {
  parsePublicRuntimeConfiguration,
  type RuntimeConfiguration,
} from "@shared/runtime-config"

const FixtureAosUiApp = lazy(() =>
  import("@/runtime-adapters/fixture/composition").then(
    ({ FixtureAosUiApp }) => ({
      default: FixtureAosUiApp,
    })
  )
)
const OpenCodeAosUiApp = lazy(() =>
  import("@/runtime-adapters/opencode/composition").then(
    ({ OpenCodeAosUiApp }) => ({
      default: OpenCodeAosUiApp,
    })
  )
)
const AgUiAosUiApp = lazy(() =>
  import("@/runtime-adapters/ag-ui/composition").then(({ AgUiAosUiApp }) => ({
    default: AgUiAosUiApp,
  }))
)
const HermesAosUiApp = lazy(() =>
  import("@/runtime-adapters/hermes/composition").then(
    ({ HermesAosUiApp }) => ({
      default: HermesAosUiApp,
    })
  )
)

const invalidConfig: RuntimeConfiguration = {
  status: "unavailable",
  reason: "invalid-public-config",
}

async function loadRuntimeConfiguration(): Promise<RuntimeConfiguration> {
  try {
    const response = await fetch("/runtime-config.json", { cache: "no-store" })
    if (!response.ok) return invalidConfig
    return parsePublicRuntimeConfiguration(await response.json())
  } catch {
    return invalidConfig
  }
}

function LegacyLocaleRedirect({ locale }: { locale: Locale }) {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    setPreferredLocale(locale)
    void navigate(
      `${stripLocaleFromPathname(location.pathname)}${location.search}${location.hash}`,
      { replace: true }
    )
  }, [locale, location.hash, location.pathname, location.search, navigate])

  return null
}

function RuntimeApp({
  config,
  locale,
  dictionary,
  nowIso,
}: {
  config: RuntimeConfiguration
  locale: Locale
  dictionary: Dictionary
  nowIso: string
}) {
  if (config.status === "unavailable") {
    return <RuntimeUnavailable locale={locale} reason={config.reason} />
  }
  if (config.mode === "fixture") {
    return (
      <FixtureAosUiApp
        locale={locale}
        dictionary={dictionary}
        composerFeatures={config.composerFeatures}
      />
    )
  }
  if (config.mode === "opencode") {
    return (
      <OpenCodeAosUiApp
        locale={locale}
        dictionary={dictionary}
        baseUrl={config.baseUrl}
        directory={config.directory}
        defaultModel={config.defaultModel}
        nowIso={nowIso}
        composerFeatures={config.composerFeatures}
      />
    )
  }
  if (config.mode === "ag-ui") {
    return (
      <AgUiAosUiApp
        locale={locale}
        dictionary={dictionary}
        runUrl={config.runUrl}
        workspaceUrl={config.workspaceUrl}
        nowIso={nowIso}
        composerFeatures={config.composerFeatures}
      />
    )
  }

  return (
    <HermesAosUiApp
      locale={locale}
      dictionary={dictionary}
      baseUrl={config.baseUrl}
      nowIso={nowIso}
      composerFeatures={config.composerFeatures}
    />
  )
}

function LoadingWorkspace({ locale }: { locale: Locale }) {
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background text-sm text-muted-foreground"
      role="status"
      dir={locale === "he" ? "rtl" : "ltr"}
    >
      {locale === "he" ? "סביבת העבודה נטענת…" : "Loading workspace…"}
    </main>
  )
}

function RuntimeLoadFailure({ locale }: { locale: Locale }) {
  const copy =
    locale === "he"
      ? {
          title: "לא ניתן לטעון את סביבת ההרצה",
          body: "יש לטעון מחדש את הדף. אם התקלה נמשכת, יש לבדוק את פריסת קובצי היישום.",
          reload: "טעינה מחדש",
        }
      : {
          title: "The runtime could not be loaded",
          body: "Reload the page. If the problem continues, check the application asset deployment.",
          reload: "Reload",
        }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <section
        className="max-w-md rounded-3xl border border-border/80 bg-card p-7 shadow-xl"
        role="alert"
        dir={locale === "he" ? "rtl" : "ltr"}
      >
        <h1 className="text-lg font-semibold">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{copy.body}</p>
        <button
          className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          type="button"
          onClick={() => window.location.reload()}
        >
          {copy.reload}
        </button>
      </section>
    </main>
  )
}

export class RuntimeErrorBoundary extends Component<
  { children: ReactNode; locale: Locale },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return <RuntimeLoadFailure locale={this.props.locale} />
    }
    return this.props.children
  }
}

function WorkspaceRoute({
  config,
  locale,
  dictionary,
  nowIso,
}: {
  config: RuntimeConfiguration
  locale: Locale
  dictionary: Dictionary
  nowIso: string
}) {
  const location = useLocation()
  const segments = location.pathname.split("/").filter(Boolean)
  if (segments.length > 2) {
    return <RuntimeUnavailable locale={locale} reason="invalid-public-config" />
  }
  return (
    <RuntimeApp
      config={config}
      locale={locale}
      dictionary={dictionary}
      nowIso={nowIso}
    />
  )
}

function Application() {
  const [locale, setLocale] = useState<Locale>(
    () => readPreferredLocale() ?? defaultLocale
  )
  const [config, setConfig] = useState<RuntimeConfiguration | null>(null)
  const [dictionary, setDictionary] = useState<Dictionary | null>(null)
  const [nowIso] = useState(() => new Date().toISOString())

  useEffect(() => {
    const onLocaleChange = (event: Event) => {
      setLocale((event as CustomEvent<Locale>).detail)
    }
    window.addEventListener(localeChangeEvent, onLocaleChange)
    return () => window.removeEventListener(localeChangeEvent, onLocaleChange)
  }, [])

  useEffect(() => {
    let active = true
    void getDictionary(locale).then((value) => {
      if (active) setDictionary(value)
    })
    return () => {
      active = false
    }
  }, [locale])

  useEffect(() => {
    let active = true
    void loadRuntimeConfiguration().then((value) => {
      if (active) setConfig(value)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (dictionary) document.title = dictionary.productName
  }, [dictionary])

  if (!config || !dictionary) return <LoadingWorkspace locale={locale} />

  return (
    <ThemeProvider>
      <DocumentLocale locale={locale} />
      <RuntimeErrorBoundary locale={locale}>
        <Suspense fallback={<LoadingWorkspace locale={locale} />}>
          <Routes>
            <Route
              path="/en/*"
              element={<LegacyLocaleRedirect locale="en" />}
            />
            <Route
              path="/he/*"
              element={<LegacyLocaleRedirect locale="he" />}
            />
            <Route
              path="*"
              element={
                <WorkspaceRoute
                  config={config}
                  locale={locale}
                  dictionary={dictionary}
                  nowIso={nowIso}
                />
              }
            />
          </Routes>
        </Suspense>
      </RuntimeErrorBoundary>
    </ThemeProvider>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Application />
    </BrowserRouter>
  )
}
