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
import { captureInviteToken } from "@/lib/invite-fragment"
import { AosUiWorkspace } from "@/components/aos-ui-workspace"
import { HarnessRuntimeProvider } from "@/runtime-adapters/registry"
import { createRuntimeClock } from "@shared/runtime-modes"
import {
  parsePublicApplicationConfiguration,
  type ApplicationConfiguration,
  type RuntimeConfiguration,
} from "@shared/runtime-config"

const GuestAosSurface = lazy(() =>
  import("@/runtime-adapters/aos").then(({ GuestAosSurface }) => ({
    default: GuestAosSurface,
  }))
)

const invalidConfig: RuntimeConfiguration = {
  status: "unavailable",
  reason: "invalid-public-config",
}

async function loadRuntimeConfiguration(): Promise<ApplicationConfiguration> {
  try {
    const response = await fetch("/runtime-config.json", { cache: "no-store" })
    if (!response.ok) return invalidConfig
    return parsePublicApplicationConfiguration(await response.json())
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
  const [clock] = useState(() =>
    createRuntimeClock(
      config.status === "ready" ? config.mode : undefined,
      new Date(nowIso)
    )
  )
  if (config.status === "unavailable") {
    return <RuntimeUnavailable locale={locale} reason={config.reason} />
  }
  return (
    <HarnessRuntimeProvider config={config} locale={locale}>
      {(runtime) => (
        <AosUiWorkspace
          runtime={runtime}
          locale={locale}
          dictionary={dictionary}
          now={clock.now}
          readNow={clock.readNow}
        />
      )}
    </HarnessRuntimeProvider>
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
  const [config, setConfig] = useState<ApplicationConfiguration | null>(null)
  const [dictionary, setDictionary] = useState<Dictionary | null>(null)
  const [nowIso] = useState(() => new Date().toISOString())
  const [inviteToken] = useState(captureInviteToken)

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

  if (!config) return <LoadingWorkspace locale={locale} />

  if (config.status === "ready" && "surface" in config) {
    return (
      <RuntimeErrorBoundary locale={locale}>
        <Suspense fallback={<LoadingWorkspace locale={locale} />}>
          <GuestAosSurface
            config={config}
            inviteToken={inviteToken}
            locale={locale}
          />
        </Suspense>
      </RuntimeErrorBoundary>
    )
  }

  if (!dictionary) return <LoadingWorkspace locale={locale} />

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
