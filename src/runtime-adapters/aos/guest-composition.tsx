"use client"

import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  type AssistantRuntime,
  type AssistantState,
  type CompleteAttachment,
} from "@assistant-ui/react"
import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { z } from "zod"

import type { ArtifactMessage } from "@/artifacts/artifacts"
import {
  ArtifactDataUI,
  ArtifactWorkspaceProvider,
  artifactPanelFailure,
  createArtifactMessageStabilizer,
} from "@/components/artifacts"
import {
  Thread,
  type ThreadComponents,
} from "@/components/assistant-ui/elements/thread.aui"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { threadLabels } from "@/components/assistant-ui/thread-labels"
import { VoiceMediaProvider } from "@/components/assistant-ui/voice/voice-context"
import { VoiceMediaController } from "@/components/assistant-ui/voice/voice-media"
import { projectSpeechText } from "@/components/assistant-ui/voice/speech-text"
import { DocumentLocale } from "@/components/document-locale"
import { PendingInteractionComposer } from "@/components/runtime-interactions/pending-composer"
import { ThemeProvider } from "@/components/theme-provider"
import {
  McpAppPipPanel,
  useMcpAppPip,
} from "@/components/mcp-apps/mcp-app-card"
import { McpAppHostProvider } from "@/components/mcp-apps/mcp-app-host"
import { AosToolPresentation, ToolUiLocaleProvider } from "@/components/tool-ui"
import {
  WorkspaceConversationShell,
  WorkspaceStatusNotice,
} from "@/components/workspace"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type { Locale } from "@/lib/i18n/config"
import { runErrorMessage } from "@/lib/i18n/run-errors"
import {
  HGW_ACP_PATH,
  HGW_API_PREFIX,
  HgwAvailableCommandsMetaSchema,
} from "@harness-gw/sdk/protocol"
import {
  createAcpApprovals,
  createAcpInteractions,
  acpSocketUrl,
  createAcpConnection,
  isAuthenticationRequired,
  type AcpConnection,
} from "@harness-gw/sdk"
import {
  tabConnectionOptions,
  watchTabBuild,
} from "@/runtime-adapters/aos/acp/tab"
import { useAcpRuntime } from "./acp/use-acp-runtime"
import {
  AosAttachmentAdapter,
  stagedAttachmentOf,
} from "./aos-attachment-adapter"
import { AosArtifactAdapter } from "./aos-artifacts"
import { AosMcpAppAdapter } from "./aos-mcp-apps"
import {
  aosMessageRewind,
  applyComposerPrefill,
  rewindSource,
} from "./conversation-controls"
import { createGatewayClient } from "./gateway-client"
import {
  type ConnectionNotice,
  useConnectionOutage,
} from "./use-connection-outage"

/**
 * The invited guest surface: one ACP connection to the proxy's guest listener,
 * one Session — the invitation's conversation reference — and the same Thread,
 * interactions, and artifacts the operator workspace composes. REST carries
 * only the verified presentation context and bytes.
 */

const dictionaries = { en, he } as const

const CLIENT_INFO = { name: "aos-ui-guest", version: "1" }

/** What the invited Session reports it supports, beside its commands. */
type GuestSessionCapabilities = z.infer<
  typeof HgwAvailableCommandsMetaSchema
>["capabilities"]

/**
 * Only the presentation context the guest surface renders: the invited
 * Session's capabilities arrive over ACP once it is resumed, not on this read.
 */
const GuestRuntimeContextSchema = z.object({
  agentId: z.string().min(1).max(256),
  conversationRef: z.string().min(1).max(128),
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
})

type GuestRuntimeContext = z.infer<typeof GuestRuntimeContextSchema>

type GuestFailure = "inactive" | "unavailable"

class GuestRuntimeContextError extends Error {
  constructor(readonly kind: GuestFailure) {
    super(kind)
  }
}

/** An invitation the proxy refuses is finished; anything else may recover. */
function failureOf(cause: unknown): GuestFailure {
  if (cause instanceof GuestRuntimeContextError) return cause.kind
  return isAuthenticationRequired(cause) ? "inactive" : "unavailable"
}

/** The gateway, not decoded bearer claims, selects the guest's public scope. */
export async function fetchGuestRuntimeContext(
  fetcher: typeof fetch,
  inviteToken: string
): Promise<GuestRuntimeContext> {
  const response = await fetcher(`${HGW_API_PREFIX}/runtime`, {
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
  return parsed.data
}

function GuestArtifactShell({
  locale,
  agentId,
  sessionId,
  artifacts,
  mcpApps,
  title,
  message,
  brandName,
  logoUrl,
  composerFeatures,
  composer,
  connectionStatus,
}: {
  locale: Locale
  agentId: string
  sessionId: string
  artifacts: AosArtifactAdapter
  mcpApps: AosMcpAppAdapter
  title?: string
  message?: string
  brandName: string
  logoUrl: string
  composerFeatures: ComposerFeatureViewModel
  composer: ThreadComponents["Composer"]
  connectionStatus?: ConnectionNotice
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
      sessionId={sessionId}
      messages={messages}
    >
      <McpAppHostProvider
        adapter={mcpApps}
        agentId={agentId}
        sessionId={sessionId}
        connectionStatus={connectionStatus}
      >
        <GuestConversationShell
          locale={locale}
          title={title}
          message={message}
          brandName={brandName}
          logoUrl={logoUrl}
          composerFeatures={composerFeatures}
          composer={composer}
          connectionStatus={connectionStatus}
        />
      </McpAppHostProvider>
    </ArtifactWorkspaceProvider>
  )
}

function GuestConversationShell({
  locale,
  title,
  message,
  brandName,
  logoUrl,
  composerFeatures,
  composer,
  connectionStatus,
}: {
  locale: Locale
  title?: string
  message?: string
  brandName: string
  logoUrl: string
  composerFeatures: ComposerFeatureViewModel
  composer: ThreadComponents["Composer"]
  connectionStatus?: ConnectionNotice
}) {
  // The side panel holds the pip view when one is active.
  const pip = useMcpAppPip(locale)
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
      sidePanel={
        pip ? (
          <McpAppPipPanel
            locale={locale}
            failureNotice={artifactPanelFailure}
          />
        ) : null
      }
      sidePanelOpen={pip !== undefined}
      sidePanelLabel={pip?.title}
      onCloseSidePanel={pip?.leave}
    >
      <ArtifactDataUI />
      <WorkspaceStatusNotice
        locale={locale}
        connectionStatus={connectionStatus}
      >
        <ToolUiLocaleProvider locale={locale}>
          <Thread
            composerFeatures={composerFeatures}
            autoFocus={false}
            labels={{
              ...threadLabels[locale],
              ...(message ? { welcome: message } : {}),
            }}
            messageRewind={aosMessageRewind}
            components={{
              ToolFallback: AosToolPresentation,
              Composer: composer,
            }}
          />
        </ToolUiLocaleProvider>
      </WorkspaceStatusNotice>
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
  capabilities,
}: {
  media: VoiceMediaController
  scopeId: string
  capabilities: GuestSessionCapabilities | undefined
}) {
  const running = useAuiState((state) => state.thread.isRunning)
  useEffect(() => {
    media.setScope(scopeId)
    media.setSafelyIdle(!running)
    // Voice belongs to the resumed Session, so it waits for its capabilities.
    if (!capabilities) return
    media.setAvailability(scopeId, {
      transcription:
        capabilities.content.transcription.status === "available"
          ? "unverified"
          : "unavailable",
      speech:
        capabilities.content.speech.status === "available"
          ? "unverified"
          : "unavailable",
    })
  }, [capabilities, media, running, scopeId])
  return null
}

function ReadyGuestAosSurface({
  connection,
  context,
  inviteToken,
  locale,
}: {
  connection: AcpConnection
  context: GuestRuntimeContext
  inviteToken: string
  locale: Locale
}) {
  const { agentId } = context
  const sessionId = context.conversationRef
  const selectedLocale = context.ui?.lang ?? locale
  const connectionOutage = useConnectionOutage(connection)
  const brandName = context.ui?.name ?? "AOS"
  const logoUrl = context.ui?.logoUrl ?? "/logo-adaptive.svg"
  const rest = useMemo(() => {
    const client = createGatewayClient({
      authorization: `Bearer ${inviteToken}`,
    })
    // REST authorizes byte reads per Agent; the invitation names the owner.
    client.adoptSessionOwnership(sessionId, agentId)
    return client
  }, [agentId, inviteToken, sessionId])
  const attachments = useMemo(() => new AosAttachmentAdapter(), [])
  const artifacts = useMemo(() => new AosArtifactAdapter(rest), [rest])
  const mcpApps = useMemo(() => new AosMcpAppAdapter(rest), [rest])
  const interactions = useMemo(
    () => createAcpInteractions({ connection }),
    [connection]
  )
  const approvals = useMemo(
    () => createAcpApprovals({ connection }),
    [connection]
  )
  const media = useMemo(() => new VoiceMediaController(), [])
  // The invited Session reports what it supports only once it is resumed.
  const [capabilities, setCapabilities] = useState<GuestSessionCapabilities>()
  useEffect(
    () =>
      connection.subscribe(sessionId, {
        update: (update, meta) => {
          if (!SessionUpdate.isAvailableCommandsUpdate(update)) return
          const reported = HgwAvailableCommandsMetaSchema.safeParse(meta)
          if (reported.success) setCapabilities(reported.data.capabilities)
        },
      }),
    [connection, sessionId]
  )
  // The invited Session owns the batch, so its bytes are staged per turn and
  // the prompt links whatever the proxy accepted.
  const stageAttachments = useCallback(
    async (staged: string, composed: readonly CompleteAttachment[]) => {
      const { stageId } = await rest.stageAttachments(
        staged,
        composed.map(stagedAttachmentOf)
      )
      return {
        stageId,
        attachments: composed.map(({ id, name, contentType }) => ({
          id,
          name,
          ...(contentType === undefined ? {} : { contentType }),
        })),
      }
    },
    [rest]
  )
  const mediaAdapters = useMemo(
    () =>
      media.createAdapters(sessionId, {
        transcribe: (recording, signal) =>
          rest.transcribe(sessionId, recording, signal),
        synthesize: (text, signal) => rest.speak(sessionId, text, signal),
        projectText: (text) => projectSpeechText(text, selectedLocale),
      }),
    [media, rest, selectedLocale, sessionId]
  )
  const describeRunError = useCallback(
    (code: string | undefined, fallback: string) =>
      runErrorMessage(dictionaries[selectedLocale], code, fallback),
    [selectedLocale]
  )
  const threadRuntime = useRef<AssistantRuntime | undefined>(undefined)
  const onComposerPrefill = useCallback((text: string) => {
    const thread = threadRuntime.current?.thread
    if (thread) applyComposerPrefill(thread, text)
  }, [])
  const runtime = useAcpRuntime({
    connection,
    approvals,
    sessionId,
    agentId,
    stageAttachments,
    // An invitation exposes one conversation, so no turn queues behind a run.
    enableMessageQueue: false,
    adapters: { attachments, ...mediaAdapters },
    messageRewind: rewindSource,
    onComposerPrefill,
    describeRunError,
  })
  useEffect(() => {
    threadRuntime.current = runtime
  }, [runtime])
  // Guests get no slash commands; a run steers only when the Session allows it.
  const steeringAvailable =
    capabilities?.interactions.steering.status === "available"
  const composerFeatures = useMemo<ComposerFeatureViewModel>(
    () => ({
      steer: steeringAvailable
        ? (request: { requestId: string; text: string }) =>
            connection.steer({ sessionId, ...request })
        : undefined,
    }),
    [connection, sessionId, steeringAvailable]
  )
  const composer = useMemo<ThreadComponents["Composer"]>(
    () =>
      function GuestPendingComposer({ fallback }) {
        return (
          <PendingInteractionComposer
            locale={selectedLocale}
            sessionId={sessionId}
            interactions={interactions}
            fallback={fallback}
          />
        )
      },
    [interactions, selectedLocale, sessionId]
  )

  return (
    <ThemeProvider>
      <DocumentLocale locale={selectedLocale} />
      <div style={invitationAccentStyle(context.ui?.accent)}>
        <AssistantRuntimeProvider runtime={runtime}>
          <GuestPrefill value={context.prefill} />
          <GuestVoiceState
            media={media}
            scopeId={sessionId}
            capabilities={capabilities}
          />
          <VoiceMediaProvider media={media} locale={selectedLocale}>
            <GuestArtifactShell
              locale={selectedLocale}
              agentId={agentId}
              sessionId={sessionId}
              artifacts={artifacts}
              mcpApps={mcpApps}
              title={context.ui?.title}
              message={context.ui?.message}
              brandName={brandName}
              logoUrl={logoUrl}
              composerFeatures={composerFeatures}
              composer={composer}
              connectionStatus={connectionOutage}
            />
          </VoiceMediaProvider>
        </AssistantRuntimeProvider>
      </div>
    </ThemeProvider>
  )
}

function GuestNotice({
  locale,
  failure,
  onRetry,
}: {
  locale: Locale
  failure: GuestFailure
  onRetry?: () => void
}) {
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
        {onRetry && failure === "unavailable" ? (
          <button
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            type="button"
            onClick={onRetry}
          >
            {locale === "he" ? "ניסיון נוסף" : "Try again"}
          </button>
        ) : null}
      </div>
    </main>
  )
}

type GuestAttempt = { key: string } & (
  | { state: "loading" }
  | { state: "failed"; failure: GuestFailure }
  | { state: "ready"; context: GuestRuntimeContext; connection: AcpConnection }
)

export function GuestAosSurface({
  inviteToken,
  locale,
}: {
  inviteToken?: string
  locale: Locale
}) {
  const contextKey = inviteToken ?? ""
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<GuestAttempt>(() =>
    inviteToken
      ? { key: contextKey, state: "loading" }
      : { key: contextKey, state: "failed", failure: "inactive" }
  )

  useEffect(() => {
    if (!inviteToken) return
    let disposed = false
    const connection = createAcpConnection({
      url: acpSocketUrl(HGW_ACP_PATH, globalThis.location.href),
      clientInfo: CLIENT_INFO,
      ...tabConnectionOptions(),
    })
    connection.start()
    const unwatchBuild = watchTabBuild(connection)
    // The verified presentation context and the redeemed invitation together
    // make the conversation reachable; neither alone opens it.
    const open = async () => {
      const resolved = await fetchGuestRuntimeContext(fetch, inviteToken)
      await connection.initialized
      await connection.login(inviteToken)
      return resolved
    }
    open().then(
      (resolved) => {
        if (disposed) return
        setLoaded({
          key: contextKey,
          state: "ready",
          context: resolved,
          connection,
        })
      },
      (cause: unknown) => {
        connection.close()
        if (disposed) return
        setLoaded({
          key: contextKey,
          state: "failed",
          failure: failureOf(cause),
        })
      }
    )
    return () => {
      disposed = true
      unwatchBuild()
      connection.close()
    }
  }, [attempt, contextKey, inviteToken])

  if (!inviteToken) return <GuestNotice locale={locale} failure="inactive" />
  const current = loaded.key === contextKey ? loaded : undefined
  if (current?.state === "failed")
    return (
      <GuestNotice
        locale={locale}
        failure={current.failure}
        onRetry={() => {
          setLoaded({ key: contextKey, state: "loading" })
          setAttempt((value) => value + 1)
        }}
      />
    )
  if (current?.state !== "ready")
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
      connection={current.connection}
      context={current.context}
      inviteToken={inviteToken}
      locale={locale}
    />
  )
}
