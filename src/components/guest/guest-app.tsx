"use client"

import { AssistantRuntimeProvider, useAui } from "@assistant-ui/react"
import { InfoIcon } from "lucide-react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import {
  Thread,
  type ThreadComposerOverrideProps,
  type ThreadLabels,
} from "@/components/assistant-ui/elements/thread.aui"
import { PendingQuestionForm } from "@/components/assistant-ui/pending-question-form"
import {
  ArtifactDataUI,
  ArtifactViewerContent,
  ArtifactWorkspaceProvider,
  useArtifactWorkspace,
} from "@/components/artifacts"
import { threadLabels as sharedThreadLabels } from "@/components/assistant-ui/thread-labels"
import { VoiceMediaProvider } from "@/components/assistant-ui/voice/voice-context"
import { DocumentLocale } from "@/components/document-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { AosToolPresentation, ToolUiLocaleProvider } from "@/components/tool-ui"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { localeChangeEvent, readPreferredLocale } from "@/lib/i18n/client"
import type { Locale } from "@/lib/i18n/config"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { cn } from "@/lib/utils"
import { WorkspaceConversationShell } from "@/components/workspace"
import type { GuestBootstrap, GuestPendingQuestion } from "@shared/guest"
import {
  captureInviteToken,
  GuestClient,
  loadGuestBootstrap,
  useGuestRuntime,
} from "@/runtime-adapters/guest"

const copy = {
  en: {
    loading: "Opening your conversation…",
    unavailable: "This conversation is no longer available.",
    unavailableHint: "Ask the person who invited you for a new link.",
    retry: "Try again",
    continue: "Continue to chat",
    welcomeNote: "Welcome note",
    close: "Close",
    uncertain:
      "We could not confirm whether your message was accepted. History was refreshed; please check before sending again.",
    reconnecting: "Connection interrupted. Reconnecting…",
  },
  he: {
    loading: "השיחה שלך נפתחת…",
    unavailable: "השיחה הזו אינה זמינה עוד.",
    unavailableHint: "אפשר לבקש קישור חדש ממי ששלח לך את ההזמנה.",
    retry: "ניסיון חוזר",
    continue: "המשך לשיחה",
    welcomeNote: "הודעת פתיחה",
    close: "סגירה",
    uncertain:
      "לא הצלחנו לאשר שההודעה התקבלה. היסטוריית השיחה רועננה; כדאי לבדוק לפני שליחה נוספת.",
    reconnecting: "החיבור נותק. מתחברים מחדש…",
  },
} as const

const labels: Record<Locale, ThreadLabels> = {
  en: {
    ...sharedThreadLabels.en,
    welcome: "Start the conversation",
    assistantWorking: "Reply in progress",
    refresh: "Regenerate response",
  },
  he: {
    ...sharedThreadLabels.he,
    welcome: "אפשר להתחיל את השיחה",
    assistantWorking: "התשובה נכתבת",
    refresh: "יצירת תשובה מחדש",
  },
}

const dictionaries = { en, he } as const

type GuestQuestionContextValue = {
  client: GuestClient
  locale: Locale
  questions: GuestPendingQuestion[]
}

const GuestQuestionContext = createContext<GuestQuestionContextValue | null>(
  null
)

function GuestQuestionComposer({ fallback }: ThreadComposerOverrideProps) {
  const context = useContext(GuestQuestionContext)
  const [resolvedIds, setResolvedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const question = context?.questions.find(({ id }) => !resolvedIds.has(id))

  if (!context || !question) return fallback
  return (
    <PendingQuestionForm
      key={question.id}
      locale={context.locale}
      request={question}
      onReply={(answers) =>
        context.client.replyToQuestion(
          question.id,
          answers.map((answer) => [...answer])
        )
      }
      onReject={() => context.client.rejectQuestion(question.id)}
      onResolved={() =>
        setResolvedIds((current) => new Set(current).add(question.id))
      }
    />
  )
}

const threadComponents = {
  ToolFallback: AosToolPresentation,
  Composer: GuestQuestionComposer,
}

function localeFor(bootstrap?: GuestBootstrap): Locale {
  return readPreferredLocale() ?? bootstrap?.ui?.lang ?? "en"
}

function welcomeKey(conversation: string) {
  return `aos.guest.welcome.v1.${conversation}`
}

function invitationAccentStyle(
  accent?: string
): React.CSSProperties | undefined {
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return undefined
  const channels = [1, 3, 5].map((start) =>
    Number.parseInt(accent.slice(start, start + 2), 16)
  )
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  const foreground =
    (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
      ? "#000000"
      : "#ffffff"
  return {
    "--primary": accent,
    "--primary-foreground": foreground,
  } as React.CSSProperties
}

function GuestComposerPrefill({ bootstrap }: { bootstrap: GuestBootstrap }) {
  const aui = useAui()
  const applied = useRef(false)

  useEffect(() => {
    if (applied.current || bootstrap.state !== "new" || !bootstrap.prefill) {
      return
    }
    applied.current = true
    const composer = aui.thread.composer()
    if (composer.getState().text === "") composer.setText(bootstrap.prefill)
  }, [aui, bootstrap])

  return null
}

function GuestConversation({ bootstrap }: { bootstrap: GuestBootstrap }) {
  const client = useMemo(() => new GuestClient(bootstrap), [bootstrap])
  const { runtime, media, artifacts, artifactMessages, snapshot } =
    useGuestRuntime(client)
  const [locale, setLocale] = useState(() => localeFor(bootstrap))
  const hasWelcome = Boolean(bootstrap.ui?.message)
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    if (!hasWelcome) return false
    try {
      return (
        localStorage.getItem(welcomeKey(bootstrap.conversation)) !== "dismissed"
      )
    } catch {
      return true
    }
  })

  useEffect(() => {
    const update = (event: Event) =>
      setLocale((event as CustomEvent<Locale>).detail ?? localeFor(bootstrap))
    window.addEventListener(localeChangeEvent, update)
    return () => window.removeEventListener(localeChangeEvent, update)
  }, [bootstrap])

  const setOpen = (open: boolean) => {
    setWelcomeOpen(open)
    if (!open) {
      try {
        localStorage.setItem(welcomeKey(bootstrap.conversation), "dismissed")
      } catch {
        // Dismissal is a view preference only.
      }
    }
  }

  const accentStyle = invitationAccentStyle(bootstrap.ui?.accent)
  const text = copy[locale]

  return (
    <ThemeProvider>
      <DocumentLocale locale={locale} />
      <div
        data-slot="guest-surface"
        className="bg-canvas text-foreground selection:bg-primary/25"
        style={accentStyle}
      >
        <ToolUiLocaleProvider locale={locale}>
          <VoiceMediaProvider media={media} locale={locale}>
            <AssistantRuntimeProvider runtime={runtime}>
              <ArtifactWorkspaceProvider
                locale={locale}
                adapter={artifacts}
                agentId="guest"
                threadId={bootstrap.conversation}
                messages={artifactMessages}
              >
                <GuestWorkspaceShell
                  locale={locale}
                  header={
                    <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border/70 px-4 sm:px-6">
                      <img
                        src={bootstrap.ui?.logoUrl ?? "/logo-adaptive.svg"}
                        alt=""
                        className="size-9 rounded-xl object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">
                          {bootstrap.ui?.name ?? "AOS"}
                        </p>
                        <h1 className="truncate text-sm text-muted-foreground">
                          {bootstrap.ui?.title ??
                            labels[locale].conversationHeading}
                        </h1>
                      </div>
                      {hasWelcome ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="gap-2"
                          aria-label={text.welcomeNote}
                          onClick={() => setWelcomeOpen(true)}
                        >
                          <InfoIcon aria-hidden="true" className="size-4" />
                          <span className="hidden sm:inline">
                            {text.welcomeNote}
                          </span>
                        </Button>
                      ) : null}
                    </header>
                  }
                >
                  <ArtifactDataUI />
                  <GuestQuestionContext.Provider
                    value={{
                      client,
                      locale,
                      questions: bootstrap.capabilities.questions
                        ? snapshot.pendingQuestions
                        : [],
                    }}
                  >
                    <GuestComposerPrefill bootstrap={bootstrap} />
                    <Thread
                      autoFocus={false}
                      labels={labels[locale]}
                      components={threadComponents}
                    />
                  </GuestQuestionContext.Provider>
                </GuestWorkspaceShell>
              </ArtifactWorkspaceProvider>
            </AssistantRuntimeProvider>
          </VoiceMediaProvider>
        </ToolUiLocaleProvider>
        <GuestStatus snapshot={snapshot} text={text} />
        {hasWelcome && welcomeOpen ? (
          <Dialog open={welcomeOpen} onOpenChange={setOpen}>
            <DialogContent className="sm:max-w-md" closeLabel={text.close}>
              <DialogHeader>
                <DialogTitle>
                  {bootstrap.ui?.title ?? text.welcomeNote}
                </DialogTitle>
                <DialogDescription
                  className="text-start leading-6 whitespace-pre-wrap"
                  dir="auto"
                >
                  {bootstrap.ui?.message}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" onClick={() => setOpen(false)}>
                  {text.continue}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    </ThemeProvider>
  )
}

function GuestWorkspaceShell({
  locale,
  header,
  children,
}: {
  locale: Locale
  header: React.ReactNode
  children: React.ReactNode
}) {
  const {
    closeArtifact,
    labels: artifactLabels,
    selectedArtifact,
  } = useArtifactWorkspace()

  return (
    <WorkspaceConversationShell
      locale={locale}
      dictionary={dictionaries[locale]}
      header={header}
      artifactViewer={<ArtifactViewerContent />}
      artifactViewerOpen={selectedArtifact !== null}
      artifactViewerLabel={artifactLabels.viewerLabel}
      onCloseArtifactViewer={closeArtifact}
    >
      {children}
    </WorkspaceConversationShell>
  )
}

function GuestStatus({
  snapshot,
  text,
}: {
  snapshot: ReturnType<typeof useGuestRuntime>["snapshot"]
  text: (typeof copy)[Locale]
}) {
  if (snapshot.revoked) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-6">
        <div className="max-w-sm text-center">
          <h2 className="text-lg font-semibold">{text.unavailable}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {text.unavailableHint}
          </p>
        </div>
      </div>
    )
  }
  if (!snapshot.error) return null
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-amber-500/25 bg-amber-500/10 px-4 py-2 text-center text-xs text-foreground"
      role="status"
    >
      {snapshot.error === "uncertain" ? text.uncertain : text.reconnecting}
    </div>
  )
}

export function GuestApp({
  initialBootstrap,
  inviteToken: initialInviteToken,
}: {
  initialBootstrap?: GuestBootstrap
  inviteToken?: string
} = {}) {
  const [bootstrap, setBootstrap] = useState(initialBootstrap)
  const [error, setError] = useState<string>()
  const [inviteToken, setInviteToken] = useState(
    () => initialInviteToken ?? captureInviteToken()
  )
  const locale = localeFor(bootstrap)
  const requestBootstrap = useCallback(
    () =>
      loadGuestBootstrap(fetch, inviteToken).then((value) => {
        setInviteToken(undefined)
        return value
      }),
    [inviteToken]
  )

  useEffect(() => {
    if (bootstrap) return
    let active = true
    void requestBootstrap()
      .then((value) => active && setBootstrap(value))
      .catch(
        (reason) =>
          active &&
          setError(reason instanceof Error ? reason.message : String(reason))
      )
    return () => {
      active = false
    }
  }, [bootstrap, requestBootstrap])

  if (bootstrap) return <GuestConversation bootstrap={bootstrap} />
  const text = copy[locale]
  return (
    <ThemeProvider>
      <DocumentLocale locale={locale} />
      <main className="bg-canvas grid min-h-dvh place-items-center p-6 text-foreground">
        {error ? (
          <div className="max-w-sm text-center" role="alert">
            <h1 className="text-lg font-semibold">{text.unavailable}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {text.unavailableHint}
            </p>
            <Button
              className="mt-5"
              onClick={() => {
                setError(undefined)
                void requestBootstrap()
                  .then(setBootstrap)
                  .catch((reason) => setError(String(reason)))
              }}
            >
              {text.retry}
            </Button>
          </div>
        ) : (
          <p role="status" className={cn("text-sm text-muted-foreground")}>
            {text.loading}
          </p>
        )}
      </main>
    </ThemeProvider>
  )
}
