"use client"

import {
  AssistantRuntimeProvider,
  useAuiState,
  type AssistantState,
} from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"
import { useEffect, useMemo } from "react"

import type { ArtifactMessage } from "@/artifacts/artifacts"
import {
  ArtifactDataUI,
  ArtifactViewerContent,
  ArtifactWorkspaceProvider,
  createArtifactMessageStabilizer,
  useArtifactWorkspace,
} from "@/components/artifacts"
import { Thread } from "@/components/assistant-ui/elements/thread.aui"
import { threadLabels } from "@/components/assistant-ui/thread-labels"
import { DocumentLocale } from "@/components/document-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { AosToolPresentation, ToolUiLocaleProvider } from "@/components/tool-ui"
import { WorkspaceConversationShell } from "@/components/workspace"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type { Locale } from "@/lib/i18n/config"
import type { GuestSurfaceConfiguration } from "@shared/runtime-config"

import { AosArtifactAdapter } from "./aos-artifacts"
import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import {
  AosReconciler,
  type AosEventScope,
  type AosEventSocket,
} from "./aos-reconciliation"
import { AosThreadListAdapter } from "./aos-thread-list"

const dictionaries = { en, he } as const

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function decodeClaims(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) return undefined
  try {
    const normalized = segment.replaceAll("-", "+").replaceAll("_", "/")
    const decoded = atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    )
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(decoded, (character) => character.charCodeAt(0))
      )
    ) as unknown
  } catch {
    return undefined
  }
}

/** Claims select the request path only; the guest listener verifies the JWT. */
export function parseGuestInvitationScope(
  token: string,
  lane: "guest"
): AosEventScope | undefined {
  if (token.length > 4_096) return undefined
  const segments = token.split(".")
  if (segments.length !== 3) return undefined
  const claims = decodeClaims(segments[1]!)
  if (!claims || typeof claims !== "object" || Array.isArray(claims))
    return undefined
  const { agent, session } = claims as Record<string, unknown>
  return boundedIdentifier(agent, 256) && boundedIdentifier(session, 1_024)
    ? { workspaceId: lane, agentId: agent, sessionId: session }
    : undefined
}

function eventUrl(basePath: string, scope: AosEventScope, authorize = false) {
  const parameters = new URLSearchParams({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
  })
  return `${basePath}/events${authorize ? "/authorize" : ""}?${parameters}`
}

export async function authorizeGuestEvents(
  fetcher: typeof fetch,
  basePath: string,
  authorization: string,
  scope: AosEventScope
) {
  const response = await fetcher(eventUrl(basePath, scope, true), {
    method: "POST",
    credentials: "same-origin",
    headers: { authorization },
  })
  if (!response.ok) throw new Error("Guest event authorization failed")
}

export function guestEventSocket(
  basePath: string,
  scope: AosEventScope
): AosEventSocket {
  const url = new URL(eventUrl(basePath, scope), window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return new WebSocket(url) as unknown as AosEventSocket
}

function GuestArtifactShell({
  locale,
  agentId,
  sessionId,
  artifacts,
}: {
  locale: Locale
  agentId: string
  sessionId: string
  artifacts: AosArtifactAdapter
}) {
  const stabilize = useMemo(() => createArtifactMessageStabilizer(), [])
  const messages = useAuiState((state: AssistantState) =>
    stabilize(state.thread.messages as readonly ArtifactMessage[])
  )
  return (
    <ArtifactWorkspaceProvider
      locale={locale}
      adapter={artifacts}
      agentId={agentId}
      threadId={sessionId}
      messages={messages}
    >
      <GuestConversationShell locale={locale} agentId={agentId} />
    </ArtifactWorkspaceProvider>
  )
}

function GuestConversationShell({
  locale,
  agentId,
}: {
  locale: Locale
  agentId: string
}) {
  const { closeArtifact, labels, selectedArtifact } = useArtifactWorkspace()
  return (
    <WorkspaceConversationShell
      locale={locale}
      dictionary={dictionaries[locale]}
      header={
        <header className="flex min-h-16 items-center border-b border-border/70 px-4 sm:px-6">
          <h1 className="truncate text-sm font-semibold" dir="auto">
            {agentId}
          </h1>
        </header>
      }
      artifactViewer={<ArtifactViewerContent />}
      artifactViewerOpen={selectedArtifact !== null}
      artifactViewerLabel={labels.viewerLabel}
      onCloseArtifactViewer={closeArtifact}
    >
      <ArtifactDataUI />
      <ToolUiLocaleProvider locale={locale}>
        <Thread
          autoFocus={false}
          labels={threadLabels[locale]}
          components={{ ToolFallback: AosToolPresentation }}
        />
      </ToolUiLocaleProvider>
    </WorkspaceConversationShell>
  )
}

function ReadyGuestAosSurface({
  config,
  inviteToken,
  locale,
  scope,
}: {
  config: GuestSurfaceConfiguration
  inviteToken: string
  locale: Locale
  scope: AosEventScope
}) {
  const authorization = useMemo(() => `Bearer ${inviteToken}`, [inviteToken])
  const reconciler = useMemo(
    () =>
      new AosReconciler({
        authorizeSocket: (target) =>
          authorizeGuestEvents(fetch, config.basePath, authorization, target),
        socketFactory: (target) => guestEventSocket(config.basePath, target),
      }),
    [authorization, config.basePath]
  )
  useEffect(() => () => reconciler.close(), [reconciler])
  const client = useMemo(
    () =>
      new AosRemoteClient({
        basePath: config.basePath,
        authorization,
        reconciler,
        scope,
      }),
    [authorization, config.basePath, reconciler, scope]
  )
  const history = useMemo(
    () => new AosThreadListAdapter(client).historyFor(scope.sessionId),
    [client, scope.sessionId]
  )
  const agent = useMemo(
    () =>
      createAosRunAgent({
        agentId: scope.agentId,
        threadId: scope.sessionId,
        basePath: config.basePath,
        authorization,
      }),
    [authorization, config.basePath, scope.agentId, scope.sessionId]
  )
  const artifacts = useMemo(() => new AosArtifactAdapter(client), [client])
  const runtime = useAgUiRuntime({
    agent,
    adapters: { history },
    onCancel: () => void client.stopRun(scope.sessionId).catch(() => undefined),
  })

  return (
    <ThemeProvider>
      <DocumentLocale locale={locale} />
      <AssistantRuntimeProvider runtime={runtime}>
        <GuestArtifactShell
          locale={locale}
          agentId={scope.agentId}
          sessionId={scope.sessionId}
          artifacts={artifacts}
        />
      </AssistantRuntimeProvider>
    </ThemeProvider>
  )
}

export function GuestAosSurface({
  config,
  inviteToken,
  locale,
}: {
  config: GuestSurfaceConfiguration
  inviteToken?: string
  locale: Locale
}) {
  const scope = inviteToken
    ? parseGuestInvitationScope(inviteToken, config.lane)
    : undefined
  if (!inviteToken || !scope)
    return (
      <main role="alert" className="grid min-h-dvh place-items-center p-6">
        {locale === "he"
          ? "השיחה הזו אינה זמינה עוד."
          : "This conversation is no longer available."}
      </main>
    )
  return (
    <ReadyGuestAosSurface
      config={config}
      inviteToken={inviteToken}
      locale={locale}
      scope={scope}
    />
  )
}
