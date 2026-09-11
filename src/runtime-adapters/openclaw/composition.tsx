import {
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { HarnessRuntime } from "@/runtime-adapters/contracts"
import type { Locale } from "@/lib/i18n/config"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import { Button } from "@/components/ui/button"
import { useOpenClawRuntime } from "./use-openclaw-runtime"
import { resolveOpenClawGatewayUrl } from "./gateway-url"

export type OpenClawRuntimeProviderProps = {
  config: {
    status: "ready"
    mode: "openclaw"
    baseUrl: string
    creatorAgentId?: string
    composerFeatures: ComposerFeatureConfig
    artifactHtmlAssetOrigins?: string[]
  }
  locale: Locale
  children: (runtime: HarnessRuntime) => ReactNode
}

export function OpenClawRuntimeProvider({
  config,
  locale,
  children,
}: OpenClawRuntimeProviderProps) {
  const [credentials, setCredentials] = useState<{
    token?: string
    password?: string
  }>({})
  const [token, setToken] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<Error>()
  const onError = useCallback((error: Error) => setError(error), [])
  const { runtime, client } = useOpenClawRuntime(
    {
      gatewayUrl: resolveOpenClawGatewayUrl(
        config.baseUrl,
        window.location.href
      ),
      creatorAgentId: config.creatorAgentId,
      ...credentials,
      onError,
    },
    locale,
    config.composerFeatures
  )
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot
  )
  const blocked =
    snapshot.connection === "blocked" ||
    (snapshot.connection !== "ready" && Boolean(error))
  return (
    <>
      {blocked ? (
        <form
          className="flex flex-wrap items-center gap-2 border-b p-3"
          onSubmit={(event) => {
            event.preventDefault()
            setError(undefined)
            const next = {
              token: token || credentials.token,
              password: password || credentials.password,
            }
            setCredentials(next)
            setToken("")
            setPassword("")
            if (
              next.token === credentials.token &&
              next.password === credentials.password
            ) {
              client.stop()
              void client.start().catch(onError)
            }
          }}
        >
          <p role="alert">
            {locale === "he"
              ? "החיבור ל-OpenClaw דורש טיפול"
              : "OpenClaw connection needs attention"}
            : {snapshot.error?.message ?? error?.message}
          </p>
          <label>
            {locale === "he" ? "אסימון Gateway" : "Gateway token"}
            <input
              className="rounded-md border px-2 py-1"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            {locale === "he" ? "סיסמת Gateway" : "Gateway password"}
            <input
              className="rounded-md border px-2 py-1"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <Button type="submit">
            {locale === "he" ? "חיבור מחדש" : "Reconnect"}
          </Button>
          {snapshot.connectionDetails ? (
            <pre className="max-w-full overflow-auto text-xs whitespace-pre-wrap">
              {JSON.stringify(snapshot.connectionDetails, null, 2)}
            </pre>
          ) : null}
        </form>
      ) : null}
      {error && !blocked ? (
        <div role="alert" className="flex items-center gap-2 border-b p-3">
          <p>{error.message}</p>
          <Button type="button" onClick={() => setError(undefined)}>
            {locale === "he" ? "סגירה" : "Dismiss"}
          </Button>
        </div>
      ) : null}
      {children({
        ...runtime,
        artifacts: runtime.artifacts
          ? {
              ...runtime.artifacts,
              htmlAssetOrigins: config.artifactHtmlAssetOrigins,
            }
          : undefined,
      })}
    </>
  )
}

export const runtimeAdapter = {
  mode: "openclaw" as const,
  Provider: OpenClawRuntimeProvider,
}
