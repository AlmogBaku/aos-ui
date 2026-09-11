"use client"

import { AssistantRuntimeProvider } from "@assistant-ui/react"
import {
  OpenCodeEventSource,
  type OpenCodeQuestionRequest,
  type OpencodeClient,
} from "@assistant-ui/react-opencode"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"

import type { ThreadComposerOverrideProps } from "@/components/assistant-ui/elements/thread.aui"
import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"
import { LegacyAosUiWorkspace as AosUiWorkspace } from "@/components/aos-ui-workspace"
import { RuntimeQuestionComposer } from "@/components/runtime-interactions/question-composer"
import { Button } from "@/components/ui/button"
import { ErrorToast } from "@/components/ui/error-toast"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { ComposerFeatureConfig } from "@shared/runtime-config"
import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "@/runtime-adapters/definition"
import type {
  RuntimeInteractionActions,
  RuntimeQuestionRequest,
} from "@/runtime-adapters/contracts"
import {
  useAosOpenCodeQuestions as useOpenCodeQuestions,
  useAosOpenCodeRuntimeExtras as useOpenCodeRuntimeExtras,
  useAosOpenCodeSession as useOpenCodeSession,
} from "./opencode-runtime-extras"
import { findOrphanedOpenCodeQuestion } from "./orphaned-question"
import { useOpenCodeComposerFeatures } from "./use-opencode-composer-features"
import {
  createOpenCodeRuntimeInteractions,
  useOpenCodeRuntimeBundle,
} from "./use-opencode-runtime-bundle"

const REQUEST_OPTIONS = { throwOnError: true } as const

/** Temporary minimal provider; the legacy application below retains feature behavior until migration. */
function OpenCodeRuntimeProvider({
  config,
  children,
}: RuntimeAdapterProps<"opencode">) {
  const bundle = useOpenCodeRuntimeBundle(config)
  return children({
    assistantRuntime: bundle.assistantRuntime,
    workspace: bundle.workspace,
    activityCoverage: "workspace",
    artifacts: bundle.artifacts
      ? {
          resolver: bundle.artifacts,
          htmlAssetOrigins: config.artifactHtmlAssetOrigins,
        }
      : undefined,
  })
}

export const runtimeAdapter: RuntimeAdapterDefinition<"opencode"> = {
  mode: "opencode",
  Provider: OpenCodeRuntimeProvider,
}
const emptyQuestionIds = new Set<string>()

type QuestionListSnapshot = {
  sessionId: string
  questions: readonly OpenCodeQuestionRequest[]
  error: Error | null
}

type QuestionRequestIdentity = {
  requestId: string
  sessionId: string
}

function toError(reason: unknown) {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function mergePendingQuestions(
  sessionId: string,
  official: readonly OpenCodeQuestionRequest[],
  listed: readonly OpenCodeQuestionRequest[],
  resolvedIds: ReadonlySet<string>
) {
  const byId = new Map<string, OpenCodeQuestionRequest>()
  for (const question of [...listed, ...official]) {
    if (question.sessionID === sessionId && !resolvedIds.has(question.id)) {
      byId.set(question.id, question)
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.askedAt - right.askedAt || left.id.localeCompare(right.id)
  )
}

function addQuestionId(
  ids: ReadonlySet<string>,
  requestId: string
): ReadonlySet<string> {
  const next = new Set(ids)
  next.add(requestId)
  return next
}

function toRuntimeQuestionRequest(
  request: OpenCodeQuestionRequest
): RuntimeQuestionRequest {
  return {
    kind: "question",
    requestId: request.id,
    sessionId: request.sessionID,
    questions: request.questions.map((question) => ({
      header: question.header,
      prompt: question.question,
      options: question.options,
      multiple: question.multiple,
      custom: question.custom,
    })),
  }
}

function OpenCodeQuestionForm({
  locale,
  request,
  interactions,
  expired,
  recovered,
  onDismissExpired,
  onResponsePending,
  onResolved,
}: {
  locale: Locale
  request: OpenCodeQuestionRequest
  interactions: RuntimeInteractionActions
  expired?: boolean
  recovered?: boolean
  onDismissExpired: () => void
  onResponsePending: (
    identity: QuestionRequestIdentity,
    pending: boolean
  ) => void
  onResolved: (identity: QuestionRequestIdentity) => void
}) {
  const runtimeRequest = useMemo(
    () => toRuntimeQuestionRequest(request),
    [request]
  )

  return (
    <RuntimeQuestionComposer
      locale={locale}
      request={runtimeRequest}
      interactions={interactions}
      expired={expired}
      recovered={recovered}
      onDismissExpired={onDismissExpired}
      onResponsePending={onResponsePending}
      onResolved={onResolved}
    />
  )
}

export function OpenCodeQuestionBridge({
  locale,
  client,
  interactions = createOpenCodeRuntimeInteractions(client),
  fallback = null,
}: {
  locale: Locale
  client: OpencodeClient
  interactions?: RuntimeInteractionActions
  fallback?: ReactNode
}) {
  const session = useOpenCodeSession()
  const officialQuestions = useOpenCodeQuestions()
  const { state } = useOpenCodeRuntimeExtras()
  const [reloadKey, setReloadKey] = useState(0)
  const [listedSnapshot, setListedSnapshot] = useState<QuestionListSnapshot>({
    sessionId: "",
    questions: [],
    error: null,
  })
  const [resolvedSnapshot, setResolvedSnapshot] = useState<{
    sessionId: string
    ids: ReadonlySet<string>
  }>({ sessionId: "", ids: emptyQuestionIds })
  const [expiredSnapshot, setExpiredSnapshot] = useState<{
    sessionId: string
    request: OpenCodeQuestionRequest
  } | null>(null)
  const locallyPending = useRef({ sessionId: "", ids: new Set<string>() })
  const locallyResolved = useRef({ sessionId: "", ids: new Set<string>() })
  const [presentedQuestion, setPresentedQuestion] = useState<{
    sessionId: string
    requestId: string | null
  }>({ sessionId: "", requestId: null })
  const visibleQuestions = useRef<{
    sessionId: string
    questions: readonly OpenCodeQuestionRequest[]
  }>({ sessionId: "", questions: [] })
  const sessionId = session?.id ?? ""

  useEffect(() => {
    if (!sessionId) return
    let active = true
    void client.question
      .list(undefined, REQUEST_OPTIONS)
      .then((response) => {
        if (!active) return
        const now = Date.now()
        setListedSnapshot({
          sessionId,
          questions: (response.data ?? [])
            .filter((question) => question.sessionID === sessionId)
            .map((question, index) => ({
              ...question,
              askedAt: now + index,
            })),
          error: null,
        })
      })
      .catch((reason: unknown) => {
        if (!active) return
        setListedSnapshot({
          sessionId,
          questions: [],
          error: toError(reason),
        })
      })
    return () => {
      active = false
    }
  }, [client, reloadKey, sessionId])

  const listedQuestions = useMemo(
    () =>
      listedSnapshot.sessionId === sessionId ? listedSnapshot.questions : [],
    [listedSnapshot.questions, listedSnapshot.sessionId, sessionId]
  )
  const resolvedIds =
    resolvedSnapshot.sessionId === sessionId
      ? resolvedSnapshot.ids
      : emptyQuestionIds
  const questions = mergePendingQuestions(
    sessionId,
    officialQuestions,
    listedQuestions,
    resolvedIds
  )
  const activeQuestion =
    (presentedQuestion.sessionId === sessionId && presentedQuestion.requestId
      ? questions.find(({ id }) => id === presentedQuestion.requestId)
      : undefined) ?? questions[0]

  useEffect(() => {
    // The provider question list is external state. Keep the visible request
    // stable while new requests arrive, then advance only when it resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPresentedQuestion((current) => {
      if (
        current.sessionId === sessionId &&
        ((current.requestId &&
          questions.some(({ id }) => id === current.requestId)) ||
          (!current.requestId && questions.length === 0))
      ) {
        return current
      }
      return { sessionId, requestId: questions[0]?.id ?? null }
    })
  }, [questions, sessionId])
  const expiredQuestion =
    expiredSnapshot?.sessionId === sessionId
      ? expiredSnapshot.request
      : undefined
  const loadError =
    listedSnapshot.sessionId === sessionId ? listedSnapshot.error : null
  const orphanedQuestion =
    listedSnapshot.sessionId === sessionId && !loadError
      ? findOrphanedOpenCodeQuestion(state)
      : null

  useEffect(() => {
    visibleQuestions.current = { sessionId, questions }
    if (
      !sessionId ||
      listedSnapshot.sessionId !== sessionId ||
      listedSnapshot.error
    ) {
      return
    }
    const current = locallyResolved.current
    if (current.sessionId !== sessionId) return
    const providerQuestionIds = new Set(
      [...officialQuestions, ...listedQuestions]
        .filter((question) => question.sessionID === sessionId)
        .map((question) => question.id)
    )
    for (const requestId of current.ids) {
      if (!providerQuestionIds.has(requestId)) current.ids.delete(requestId)
    }
    setResolvedSnapshot((snapshot) => {
      if (snapshot.sessionId !== sessionId) return snapshot
      const ids = new Set(
        [...snapshot.ids].filter((requestId) =>
          providerQuestionIds.has(requestId)
        )
      )
      return ids.size === snapshot.ids.size ? snapshot : { sessionId, ids }
    })
  }, [listedQuestions, listedSnapshot, officialQuestions, questions, sessionId])

  function resolveQuestion(identity: QuestionRequestIdentity) {
    if (identity.sessionId !== sessionId) return
    if (locallyResolved.current.sessionId !== sessionId) {
      locallyResolved.current = { sessionId, ids: new Set() }
    }
    locallyResolved.current.ids.add(identity.requestId)
    setResolvedSnapshot((current) => {
      const ids =
        current.sessionId === sessionId ? current.ids : emptyQuestionIds
      return {
        sessionId,
        ids: addQuestionId(ids, identity.requestId),
      }
    })
  }

  function setResponsePending(
    identity: QuestionRequestIdentity,
    pending: boolean
  ) {
    if (identity.sessionId !== sessionId) return
    if (locallyPending.current.sessionId !== sessionId) {
      locallyPending.current = { sessionId, ids: new Set() }
    }
    if (pending) locallyPending.current.ids.add(identity.requestId)
    else locallyPending.current.ids.delete(identity.requestId)
  }

  useEffect(() => {
    if (!sessionId) return
    const source = new OpenCodeEventSource(client)
    const unsubscribe = source.subscribe((event) => {
      if (event.sessionId !== sessionId) return
      if (
        event.type === "question.asked" ||
        event.type === "stream.reconnected"
      ) {
        setReloadKey((key) => key + 1)
        return
      }
      if (
        event.type !== "question.replied" &&
        event.type !== "question.rejected"
      ) {
        return
      }
      const requestId = event.properties.requestID
      if (typeof requestId !== "string") return
      if (
        locallyPending.current.sessionId === sessionId &&
        locallyPending.current.ids.has(requestId)
      ) {
        return
      }
      if (
        locallyResolved.current.sessionId === sessionId &&
        locallyResolved.current.ids.has(requestId)
      ) {
        return
      }
      const current = visibleQuestions.current
      const request =
        current.sessionId === sessionId
          ? current.questions.find(({ id }) => id === requestId)
          : undefined
      if (!request) return
      setResolvedSnapshot((snapshot) => {
        const ids =
          snapshot.sessionId === sessionId ? snapshot.ids : emptyQuestionIds
        return { sessionId, ids: addQuestionId(ids, requestId) }
      })
      setExpiredSnapshot({ sessionId, request })
      setReloadKey((key) => key + 1)
    })
    return () => {
      unsubscribe()
      source.dispose()
    }
  }, [client, sessionId])

  if (expiredQuestion || activeQuestion) {
    const presentedQuestion = expiredQuestion ?? activeQuestion!
    return (
      <OpenCodeQuestionForm
        key={`${presentedQuestion.sessionID}:${presentedQuestion.id}`}
        locale={locale}
        request={presentedQuestion}
        interactions={interactions}
        expired={Boolean(expiredQuestion)}
        onDismissExpired={() => setExpiredSnapshot(null)}
        onResponsePending={setResponsePending}
        onResolved={resolveQuestion}
      />
    )
  }

  if (loadError) {
    return (
      <>
        {fallback}
        <div
          className="fixed start-1/2 bottom-4 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-popover px-4 py-3 text-sm shadow-lg rtl:translate-x-1/2"
          role="alert"
        >
          <span>
            {locale === "he"
              ? "לא ניתן לטעון שאלות ממתינות מ-OpenCode."
              : "Pending OpenCode questions could not be loaded."}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            {locale === "he" ? "ניסיון חוזר" : "Try again"}
          </Button>
        </div>
      </>
    )
  }

  if (orphanedQuestion) {
    return (
      <>
        <div className="mx-auto flex w-full max-w-2xl px-4 pb-3">
          <OpenCodeQuestionForm
            locale={locale}
            request={{
              id: orphanedQuestion.callId,
              sessionID: sessionId,
              askedAt: orphanedQuestion.askedAt,
              questions: orphanedQuestion.questions,
            }}
            interactions={interactions}
            recovered
            onDismissExpired={() => {}}
            onResponsePending={() => {}}
            onResolved={() => {}}
          />
        </div>
        {fallback}
      </>
    )
  }

  return fallback
}

export function OpenCodeComposerFeatures({
  client,
  config,
  locale,
  children,
}: {
  client: OpencodeClient
  config?: ComposerFeatureConfig | undefined
  locale: Locale
  children: (features: ComposerFeatureViewModel) => ReactNode
}) {
  const session = useOpenCodeSession()
  const [errors, setErrors] = useState<Record<string, Error | undefined>>({})
  const features = useOpenCodeComposerFeatures(
    client,
    config,
    (error, sessionId) => {
      setErrors((previous) => ({ ...previous, [sessionId]: error }))
    }
  )
  const sessionId = session?.id
  const error = sessionId ? errors[sessionId] : undefined
  return (
    <>
      {children(features)}
      {error && sessionId ? (
        <ErrorToast
          locale={locale}
          title={locale === "he" ? "שינוי המודל נכשל" : "Model change failed"}
          message={error.message}
          onDismiss={() =>
            setErrors((previous) => ({ ...previous, [sessionId]: undefined }))
          }
        />
      ) : null}
    </>
  )
}

function OpenCodeWorkspace({
  client,
  composerFeatureConfig,
  ...props
}: Omit<ComponentProps<typeof AosUiWorkspace>, "composerFeatures"> & {
  client: OpencodeClient
  composerFeatureConfig?: ComposerFeatureConfig | undefined
}) {
  return (
    <OpenCodeComposerFeatures
      client={client}
      config={composerFeatureConfig}
      locale={props.locale}
    >
      {(composerFeatures) => (
        <AosUiWorkspace {...props} composerFeatures={composerFeatures} />
      )}
    </OpenCodeComposerFeatures>
  )
}

export function OpenCodeAosUiApp({
  locale,
  dictionary,
  baseUrl,
  directory,
  defaultModel,
  nowIso,
  composerFeatures,
  artifactHtmlAssetOrigins,
}: {
  locale: Locale
  dictionary: Dictionary
  baseUrl: string
  directory: string
  defaultModel?: { providerID: string; modelID: string }
  nowIso: string
  composerFeatures?: ComposerFeatureConfig
  artifactHtmlAssetOrigins?: readonly string[]
}) {
  const bundle = useOpenCodeRuntimeBundle({
    baseUrl,
    directory,
    defaultModel,
  })
  const [now] = useState(() => new Date(nowIso))
  const composer = useMemo(
    () =>
      function OpenCodeComposer({ fallback }: ThreadComposerOverrideProps) {
        return (
          <OpenCodeQuestionBridge
            locale={locale}
            client={bundle.client}
            interactions={bundle.interactions}
            fallback={fallback}
          />
        )
      },
    [bundle.client, bundle.interactions, locale]
  )

  return (
    <AssistantRuntimeProvider runtime={bundle.assistantRuntime}>
      <OpenCodeWorkspace
        locale={locale}
        dictionary={dictionary}
        bundle={bundle}
        now={now}
        composer={composer}
        client={bundle.client}
        composerFeatureConfig={composerFeatures}
        artifactHtmlAssetOrigins={artifactHtmlAssetOrigins}
      />
    </AssistantRuntimeProvider>
  )
}
