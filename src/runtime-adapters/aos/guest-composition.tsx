"use client"

import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  type AssistantState,
} from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"
import {
  AgentCapabilitiesSchema as AgUiAgentCapabilitiesSchema,
  type AgentCapabilities,
} from "@ag-ui/core"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { z } from "zod"

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
import { VoiceMediaProvider } from "@/components/assistant-ui/voice/voice-context"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"
import { DocumentLocale } from "@/components/document-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { AosToolPresentation, ToolUiLocaleProvider } from "@/components/tool-ui"
import { WorkspaceConversationShell } from "@/components/workspace"
import { AgUiInterruptComposer } from "@/components/runtime-interactions/pending-composer"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type { Locale } from "@/lib/i18n/config"
import type { GuestSurfaceConfiguration } from "@shared/runtime-config"
import { AosAttachmentAdapter } from "./aos-attachment-adapter"
import { AosArtifactAdapter } from "./aos-artifacts"
import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import type { AosEventScope } from "./aos-reconciliation"
import { AosThreadListAdapter } from "./aos-thread-list"

const dictionaries = { en, he } as const

const GuestCapabilitiesSchema = z.strictObject({
  agent: z.custom<AgentCapabilities>(
    (value) => AgUiAgentCapabilitiesSchema.safeParse(value).success
  ),
  content: z.strictObject({
    attachments: z.unknown(),
    artifacts: z.unknown(),
    transcription: z.object({ status: z.enum(["available", "unavailable"]) }),
    speech: z.object({ status: z.enum(["available", "unavailable"]) }),
  }),
  interactions: z.unknown(),
})

const GuestRuntimeContextSchema = z.strictObject({
  runtimeId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  conversationRef: z.string().min(1).max(128),
  session: z
    .strictObject({
      id: z.string().min(1).max(128),
      created: z.boolean(),
    })
    .optional(),
  ui: z
    .strictObject({
      lang: z.enum(["en", "he"]).optional(),
      name: z.string().max(128).optional(),
      logoUrl: z.string().url().max(512).optional(),
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/u)
        .optional(),
      title: z.string().max(256).optional(),
      message: z.string().max(1_500).optional(),
    })
    .optional(),
  prefill: z.string().max(2_000).optional(),
  capabilities: GuestCapabilitiesSchema,
  expiresAt: z.string().datetime(),
})

type GuestRuntimeContext = z.infer<typeof GuestRuntimeContextSchema> & {
  scope: AosEventScope
}

class GuestRuntimeContextError extends Error {
  constructor(readonly kind: "inactive" | "unavailable") {
    super(kind)
  }
}

/** The gateway, not decoded bearer claims, selects the guest's public scope. */
export async function fetchGuestRuntimeContext(
  fetcher: typeof fetch,
  basePath: string,
  inviteToken: string
): Promise<GuestRuntimeContext> {
  const response = await fetcher(`${basePath}/runtime`, {
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${inviteToken}`,
    },
  })
  if (!response.ok)
    throw new GuestRuntimeContextError(
      response.status === 401 ? "inactive" : "unavailable"
    )
  const parsed = GuestRuntimeContextSchema.safeParse(
    await response.json().catch(() => undefined)
  )
  if (!parsed.success) throw new Error("Guest runtime context is invalid")
  return {
    ...parsed.data,
    scope: {
      workspaceId: "guest",
      agentId: parsed.data.agentId,
      sessionId: parsed.data.conversationRef,
    },
  }
}

function GuestArtifactShell({
  locale,
  agentId,
  sessionId,
  artifacts,
  title,
  message,
  brandName,
  logoUrl,
}: {
  locale: Locale
  agentId: string
  sessionId: string
  artifacts: AosArtifactAdapter
  title?: string
  message?: string
  brandName: string
  logoUrl: string
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
      <GuestConversationShell
        locale={locale}
        title={title}
        message={message}
        brandName={brandName}
        logoUrl={logoUrl}
      />
    </ArtifactWorkspaceProvider>
  )
}

function GuestConversationShell({
  locale,
  title,
  message,
  brandName,
  logoUrl,
}: {
  locale: Locale
  title?: string
  message?: string
  brandName: string
  logoUrl: string
}) {
  const { closeArtifact, labels, selectedArtifact } = useArtifactWorkspace()
  return (
    <WorkspaceConversationShell
      locale={locale}
      dictionary={dictionaries[locale]}
      header={
        <header className="flex min-h-16 items-center gap-3 border-b border-border/70 px-4 sm:px-6">
          <img
            src={logoUrl}
            alt={brandName}
            className="size-9 rounded-xl object-cover"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" dir="auto">
              {brandName}
            </p>
            {title ? (
              <h1 className="truncate text-sm text-muted-foreground" dir="auto">
                {title}
              </h1>
            ) : null}
          </div>
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
          labels={{
            ...threadLabels[locale],
            ...(message ? { welcome: message } : {}),
          }}
          messageRewind={false}
          components={{
            ToolFallback: AosToolPresentation,
            Composer: ({ fallback }: { fallback: ReactNode }) => (
              <AgUiInterruptComposer locale={locale} fallback={fallback} />
            ),
          }}
        />
      </ToolUiLocaleProvider>
    </WorkspaceConversationShell>
  )
}

function GuestPrefill({ value }: { value?: string }) {
  const aui = useAui()
  const text = useAuiState((state) => state.composer.text)
  const loading = useAuiState((state) => state.thread.isLoading)
  const historyStarted = useRef(false)
  const seeded = useRef(false)
  useEffect(() => {
    if (loading) {
      historyStarted.current = true
      return
    }
    if (
      historyStarted.current &&
      !seeded.current &&
      value &&
      text.length === 0
    ) {
      seeded.current = true
      aui.thread.composer().setText(value)
    }
  }, [aui, loading, text, value])
  return null
}

function invitationAccentStyle(accent?: string): CSSProperties | undefined {
  return accent ? ({ "--primary": accent } as CSSProperties) : undefined
}

function GuestVoiceState({
  media,
  scopeId,
  transcription,
  speech,
}: {
  media: VoiceMediaController
  scopeId: string
  transcription: boolean
  speech: boolean
}) {
  const running = useAuiState((state) => state.thread.isRunning)
  useEffect(() => {
    media.setScope(scopeId)
    media.setSafelyIdle(!running)
    media.setAvailability(scopeId, {
      transcription: transcription ? "unverified" : "unavailable",
      speech: speech ? "unverified" : "unavailable",
    })
  }, [media, running, scopeId, speech, transcription])
  return null
}

function ReadyGuestAosSurface({
  config,
  inviteToken,
  locale,
  context,
}: {
  config: GuestSurfaceConfiguration
  inviteToken: string
  locale: Locale
  context: GuestRuntimeContext
}) {
  const authorization = useMemo(() => `Bearer ${inviteToken}`, [inviteToken])
  const { scope } = context
  const selectedLocale = context.ui?.lang ?? locale
  const brandName = context.ui?.name ?? "AOS"
  const logoUrl = context.ui?.logoUrl ?? "/logo-adaptive.svg"
  const attachments = useMemo(() => new AosAttachmentAdapter(), [])
  const media = useMemo(() => new VoiceMediaController(), [])
  const client = useMemo(
    () =>
      new AosRemoteClient({
        basePath: config.basePath,
        authorization,
        scope,
      }),
    [authorization, config.basePath, scope]
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
        stageAttachments: client.stageAttachments.bind(client),
        getCapabilities: async () => context.capabilities.agent,
      }),
    [
      authorization,
      client,
      config.basePath,
      context.capabilities.agent,
      scope.agentId,
      scope.sessionId,
    ]
  )
  const artifacts = useMemo(() => new AosArtifactAdapter(client), [client])
  const transcription =
    context.capabilities.content.transcription.status === "available"
  const speech = context.capabilities.content.speech.status === "available"
  const mediaAdapters = useMemo(
    () =>
      media.createAdapters(scope.sessionId, {
        transcribe: (recording, signal) =>
          client.transcribe(scope.sessionId, recording, signal),
        synthesize: (text, signal) =>
          client.speak(scope.sessionId, text, signal),
        projectText: (text) => projectSpeechText(text, selectedLocale),
      }),
    [client, media, scope.sessionId, selectedLocale]
  )
  const runtime = useAgUiRuntime({
    agent,
    adapters: { history, attachments, ...mediaAdapters },
    onCancel: () => void client.stopRun(scope.sessionId).catch(() => undefined),
  })

  return (
    <ThemeProvider>
      <DocumentLocale locale={selectedLocale} />
      <div style={invitationAccentStyle(context.ui?.accent)}>
        <AssistantRuntimeProvider runtime={runtime}>
          <GuestPrefill value={context.prefill} />
          <GuestVoiceState
            media={media}
            scopeId={scope.sessionId}
            transcription={transcription}
            speech={speech}
          />
          <VoiceMediaProvider media={media} locale={selectedLocale}>
            <GuestArtifactShell
              locale={selectedLocale}
              agentId={scope.agentId}
              sessionId={scope.sessionId}
              artifacts={artifacts}
              title={context.ui?.title}
              message={context.ui?.message}
              brandName={brandName}
              logoUrl={logoUrl}
            />
          </VoiceMediaProvider>
        </AssistantRuntimeProvider>
      </div>
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
  const contextKey = `${config.basePath}\u0000${inviteToken ?? ""}`
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{
    key: string
    context?: GuestRuntimeContext
    failure?: "inactive" | "unavailable"
  }>(() => ({
    key: contextKey,
    failure: !inviteToken ? "inactive" : undefined,
  }))

  useEffect(() => {
    if (!inviteToken) return
    let disposed = false
    void fetchGuestRuntimeContext(fetch, config.basePath, inviteToken).then(
      (resolved) => {
        if (!disposed) setLoaded({ key: contextKey, context: resolved })
      },
      (cause) => {
        if (!disposed)
          setLoaded({
            key: contextKey,
            failure:
              cause instanceof GuestRuntimeContextError
                ? cause.kind
                : "unavailable",
          })
      }
    )
    return () => {
      disposed = true
    }
  }, [attempt, config.basePath, contextKey, inviteToken])

  const failure = loaded.key === contextKey ? loaded.failure : undefined
  if (!inviteToken || failure)
    return (
      <main
        role="alert"
        className="grid min-h-dvh place-items-center bg-background p-6 text-center"
        dir={locale === "he" ? "rtl" : "ltr"}
      >
        <div className="max-w-md">
          <p className="text-sm leading-6 text-muted-foreground">
            {failure === "unavailable"
              ? locale === "he"
                ? "לא הצלחנו להתחבר לשיחה כרגע. אפשר לנסות שוב."
                : "We couldn’t connect to the conversation right now. Please try again."
              : locale === "he"
                ? "קישור ההזמנה הזה כבר אינו פעיל. אפשר לבקש ממי שהזמין אתכם לשלוח קישור חדש."
                : "This invitation link is no longer active. Please ask the person who invited you to send a new one."}
          </p>
          {failure === "unavailable" ? (
            <button
              className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              type="button"
              onClick={() => {
                setLoaded({ key: contextKey })
                setAttempt((value) => value + 1)
              }}
            >
              {locale === "he" ? "ניסיון נוסף" : "Try again"}
            </button>
          ) : null}
        </div>
      </main>
    )
  const context = loaded.key === contextKey ? loaded.context : undefined
  if (!context)
    return (
      <main
        className="grid min-h-dvh place-items-center p-6 text-sm text-muted-foreground"
        role="status"
      >
        {locale === "he" ? "השיחה נטענת…" : "Loading conversation…"}
      </main>
    )
  return (
    <ReadyGuestAosSurface
      config={config}
      inviteToken={inviteToken}
      locale={locale}
      context={context}
    />
  )
}
