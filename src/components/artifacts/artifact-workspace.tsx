"use client"

import { makeAssistantDataUI, useAui, useAuiState } from "@assistant-ui/react"
import { DownloadIcon, FileIcon, Loader2Icon } from "lucide-react"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "@/components/ui/button"
import {
  SystemNotice,
  type SystemNoticeTone,
} from "@/components/ui/system-notice"
import {
  ArtifactMissingError,
  ArtifactUnavailableError,
} from "@/artifacts/browser-artifact-adapter"
import {
  ARTIFACT_DATA_PART_NAME,
  extractArtifactOccurrences,
  parseArtifactDescriptor,
  type ArtifactMessage,
  type ArtifactOccurrence,
} from "@/artifacts/artifacts"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type { Locale } from "@/lib/i18n/config"
import type {
  ArtifactAdapter,
  ArtifactDescriptor,
} from "@/runtime-adapters/contracts"

import { artifactMediaKind, type ArtifactMediaKind } from "./artifact-renderers"

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

export type ArtifactPreviewFailure =
  "load" | "unavailable" | "missing" | "file-too-large"

export type ArtifactPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; reason: ArtifactPreviewFailure }
  | { status: "ready"; url: string }

type ArtifactWorkspaceContextValue = {
  locale: Locale
  labels: Dictionary["artifacts"]
  adapter: ArtifactAdapter | undefined
  agentId: string
  sessionId: string
  occurrences: ArtifactOccurrence[]
  selectedArtifact: ArtifactDescriptor | null
  openArtifact: (
    artifact: ArtifactDescriptor,
    trigger?: HTMLElement,
    occurrenceKey?: string
  ) => void
  closeArtifact: () => void
  downloadArtifact: (artifact: ArtifactDescriptor) => Promise<void>
}

const ArtifactWorkspaceContext =
  createContext<ArtifactWorkspaceContextValue | null>(null)

export function useArtifactWorkspace() {
  const context = useContext(ArtifactWorkspaceContext)
  if (!context) {
    throw new Error(
      "Artifact components must be rendered inside ArtifactWorkspaceProvider"
    )
  }
  return context
}

export type ArtifactWorkspaceProviderProps = {
  locale: Locale
  adapter: ArtifactAdapter | undefined
  agentId: string
  sessionId: string
  messages: readonly ArtifactMessage[]
  children: ReactNode
}

function sameArtifactDescriptor(
  previousArtifact: ArtifactDescriptor,
  nextArtifact: ArtifactDescriptor
) {
  const previousSource = previousArtifact.source
  const nextSource = nextArtifact.source
  const sameSource =
    previousSource.type === nextSource.type &&
    (previousSource.type === "inline" && nextSource.type === "inline"
      ? previousSource.encoding === nextSource.encoding &&
        previousSource.data === nextSource.data
      : previousSource.type === "url" && nextSource.type === "url"
        ? previousSource.url === nextSource.url
        : previousSource.type === "provider" && nextSource.type === "provider"
          ? previousSource.reference === nextSource.reference
          : false)

  return (
    previousArtifact.id === nextArtifact.id &&
    previousArtifact.filename === nextArtifact.filename &&
    previousArtifact.mimeType === nextArtifact.mimeType &&
    previousArtifact.sizeBytes === nextArtifact.sizeBytes &&
    sameSource
  )
}

function sameArtifactOccurrence(
  previous: ArtifactOccurrence,
  next: ArtifactOccurrence
) {
  return (
    previous.key === next.key &&
    sameArtifactDescriptor(previous.artifact, next.artifact)
  )
}

export function createArtifactMessageStabilizer(
  project?: (messages: readonly ArtifactMessage[]) => readonly ArtifactMessage[]
) {
  let previousMessages: readonly ArtifactMessage[] = []
  let previousPathKey = ""
  let previousOccurrences: ArtifactOccurrence[] = []

  return (messages: readonly ArtifactMessage[]) => {
    const projected = project?.(messages) ?? messages
    const pathKey = projected.map(({ id }) => id).join("\u0000")
    const occurrences = extractArtifactOccurrences(projected)
    if (
      pathKey === previousPathKey &&
      previousOccurrences.length === occurrences.length &&
      previousOccurrences.every((occurrence, index) =>
        sameArtifactOccurrence(occurrence, occurrences[index]!)
      )
    )
      return previousMessages

    previousMessages = projected
    previousPathKey = pathKey
    previousOccurrences = occurrences
    return projected
  }
}

export function ArtifactWorkspaceProvider({
  locale,
  adapter,
  agentId,
  sessionId,
  messages,
  children,
}: ArtifactWorkspaceProviderProps) {
  const [selection, setSelection] = useState<{
    artifact: ArtifactDescriptor
    agentId: string
    sessionId: string
    occurrenceKey: string
  } | null>(null)
  const openingControlRef = useRef<HTMLElement | null>(null)
  const downloadControllersRef = useRef(new Set<AbortController>())
  const downloadUrlsRef = useRef(new Set<string>())
  const labels = (locale === "he" ? he : en).artifacts
  const occurrences = useMemo(
    () => extractArtifactOccurrences(messages),
    [messages]
  )
  const selectedArtifact =
    selection?.agentId === agentId &&
    selection.sessionId === sessionId &&
    occurrences.some(
      ({ artifact, key }) =>
        key === selection.occurrenceKey &&
        sameArtifactDescriptor(artifact, selection.artifact)
    )
      ? selection.artifact
      : null

  useEffect(() => {
    if (!selection || selectedArtifact) return
    const timer = window.setTimeout(() => {
      openingControlRef.current = null
      setSelection(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [selectedArtifact, selection])

  const openArtifact = useCallback(
    (
      artifact: ArtifactDescriptor,
      trigger?: HTMLElement,
      occurrenceKey?: string
    ) => {
      const publication = occurrenceKey
        ? occurrences.find(({ key }) => key === occurrenceKey)
        : occurrences.findLast(({ artifact: candidate }) =>
            sameArtifactDescriptor(candidate, artifact)
          )
      if (!publication) return
      openingControlRef.current = trigger ?? null
      setSelection({
        artifact,
        agentId,
        sessionId,
        occurrenceKey: publication.key,
      })
    },
    [agentId, occurrences, sessionId]
  )
  const closeArtifact = useCallback(() => {
    const openingControl = openingControlRef.current
    openingControlRef.current = null
    setSelection(null)
    window.setTimeout(() => {
      if (openingControl?.isConnected) {
        openingControl.focus()
        return
      }
      ;[
        ...document.querySelectorAll<HTMLElement>(
          "#workspace-agent-inspector [data-artifact-open-id]"
        ),
      ]
        .find(
          ({ dataset }) => dataset.artifactOpenId === selection?.artifact.id
        )
        ?.focus()
    }, 0)
  }, [selection])
  const downloadArtifact = useCallback(
    async (artifact: ArtifactDescriptor) => {
      if (!adapter) return
      const controller = new AbortController()
      downloadControllersRef.current.add(controller)
      try {
        const blob = await adapter.resolve({
          artifact,
          agentId,
          sessionId,
          signal: controller.signal,
        })
        const url = URL.createObjectURL(blob)
        downloadUrlsRef.current.add(url)
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = artifact.filename
        anchor.click()
        window.setTimeout(() => {
          URL.revokeObjectURL(url)
          downloadUrlsRef.current.delete(url)
        }, 0)
      } catch (error) {
        // A catch-and-rethrow rather than `finally`, which React Compiler
        // cannot compile yet.
        downloadControllersRef.current.delete(controller)
        throw error
      }
      downloadControllersRef.current.delete(controller)
    },
    [adapter, agentId, sessionId]
  )

  useEffect(
    () => () => {
      downloadControllersRef.current.forEach((controller) => controller.abort())
      downloadUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      downloadControllersRef.current.clear()
      downloadUrlsRef.current.clear()
    },
    [agentId, sessionId]
  )

  const value = useMemo<ArtifactWorkspaceContextValue>(
    () => ({
      locale,
      labels,
      adapter,
      agentId,
      sessionId,
      occurrences,
      selectedArtifact,
      openArtifact,
      closeArtifact,
      downloadArtifact,
    }),
    [
      adapter,
      agentId,
      closeArtifact,
      downloadArtifact,
      labels,
      locale,
      occurrences,
      openArtifact,
      selectedArtifact,
      sessionId,
    ]
  )

  return (
    <ArtifactWorkspaceContext.Provider value={value}>
      {children}
    </ArtifactWorkspaceContext.Provider>
  )
}

function formatSize(sizeBytes: number, locale: Locale) {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(sizeBytes / 1024)} KB`
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(sizeBytes / 1024 / 1024)} MB`
}

function previewFailureMessage(
  reason: ArtifactPreviewFailure,
  labels: Dictionary["artifacts"]
) {
  if (reason === "file-too-large") return labels.fileTooLarge
  if (reason === "unavailable") return labels.unavailable
  if (reason === "missing") return labels.missing
  return labels.loadFailed
}

/**
 * Only pruned bytes need a second line: what happened and what to do next. The
 * retention explanation holds only for generated audio and video.
 */
function previewFailureDetail(
  reason: ArtifactPreviewFailure,
  labels: Dictionary["artifacts"],
  artifact: Pick<ArtifactDescriptor, "filename" | "mimeType">
) {
  if (reason !== "missing") return undefined
  const kind = artifactMediaKind(artifact.mimeType, artifact.filename)
  return kind === "audio" || kind === "video"
    ? labels.missingDetail
    : labels.missingFileDetail
}

function previewFailureTone(reason: ArtifactPreviewFailure): SystemNoticeTone {
  if (reason === "load") return "error"
  if (reason === "missing" || reason === "unavailable") return "warning"
  return "info"
}

/** A pruned artifact has no bytes left to download and no retry that can win. */
function isArtifactGone(state: ArtifactPreviewState) {
  return state.status === "error" && state.reason === "missing"
}

function useArtifactDownload(artifact: ArtifactDescriptor) {
  const { downloadArtifact } = useArtifactWorkspace()
  const [downloadFailed, setDownloadFailed] = useState(false)

  const download = async () => {
    setDownloadFailed(false)
    try {
      await downloadArtifact(artifact)
    } catch {
      setDownloadFailed(true)
    }
  }

  return { download, downloadFailed }
}

export type ArtifactCardProps = {
  artifact: ArtifactDescriptor
  compact?: boolean
  occurrenceKey?: string
}

export function ArtifactCard(props: ArtifactCardProps) {
  // Audio, video, and images are first-class inline outcomes in the
  // conversation. The compact Artifacts roster stays a list of rows that open
  // the viewer.
  const mediaKind = props.compact
    ? null
    : artifactMediaKind(props.artifact.mimeType, props.artifact.filename)

  return mediaKind ? (
    <ArtifactInlineMedia
      artifact={props.artifact}
      kind={mediaKind}
      occurrenceKey={props.occurrenceKey}
    />
  ) : (
    <ArtifactFileCard {...props} />
  )
}

function ArtifactFileCard({
  artifact,
  compact = false,
  occurrenceKey,
}: ArtifactCardProps) {
  const { adapter, labels, locale, openArtifact } = useArtifactWorkspace()
  const { download, downloadFailed } = useArtifactDownload(artifact)

  const identity = (
    <>
      <div
        className={
          compact
            ? "flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            : "flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        }
      >
        <FileIcon
          className={compact ? "size-3.5" : "size-4"}
          aria-hidden="true"
        />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium"
          data-testid="artifact-filename"
          dir="auto"
        >
          {artifact.filename}
        </p>
        {(artifact.mimeType || artifact.sizeBytes !== undefined) && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[
              artifact.mimeType,
              artifact.sizeBytes === undefined
                ? null
                : formatSize(artifact.sizeBytes, locale),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    </>
  )

  return (
    <article
      className={
        compact
          ? "grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-1.5 border-b border-border/70 text-card-foreground last:border-b-0"
          : "grid w-fit max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border bg-card p-2 text-card-foreground"
      }
    >
      <button
        type="button"
        aria-label={`${labels.open}: ${artifact.filename}`}
        data-artifact-open-id={compact ? artifact.id : undefined}
        className={
          compact
            ? "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
            : "flex min-w-0 items-center gap-2 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
        }
        onClick={(event) =>
          openArtifact(artifact, event.currentTarget, occurrenceKey)
        }
      >
        {identity}
      </button>
      <div
        className={
          compact
            ? "col-start-2 row-start-1 flex items-center pe-2"
            : "col-start-2 row-start-1 flex items-center gap-1"
        }
      >
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-xs" : "sm"}
          aria-label={compact ? labels.download : undefined}
          title={compact ? labels.download : undefined}
          disabled={!adapter}
          onClick={() => void download()}
          className={
            compact
              ? "motion-reduce:transition-none [@media(pointer:coarse)]:size-11"
              : "motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
          }
        >
          <DownloadIcon data-icon="inline-start" />
          {!compact && labels.download}
        </Button>
      </div>
      {downloadFailed && (
        <SystemNotice
          className="col-span-2 mt-2"
          locale={locale}
          title={labels.downloadFailed}
          tone="error"
        />
      )}
    </article>
  )
}

/** The one download control, with whatever AOS has to say about a failed one. */
function ArtifactDownloadAction({
  artifact,
}: {
  artifact: ArtifactDescriptor
}) {
  const { adapter, labels, locale } = useArtifactWorkspace()
  const { download, downloadFailed } = useArtifactDownload(artifact)

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!adapter}
        onClick={() => void download()}
        className="w-fit motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
      >
        <DownloadIcon data-icon="inline-start" />
        {labels.download}
      </Button>
      {downloadFailed && (
        <SystemNotice
          locale={locale}
          title={labels.downloadFailed}
          tone="error"
        />
      )}
    </div>
  )
}

/**
 * Plays a published audio or video artifact in the conversation, on the same
 * byte loader, bounds, and abort behavior as the Artifact viewer. Sizing mirrors
 * a sent media attachment so both conversation surfaces read the same.
 */
/**
 * A published audio, video, or image outcome shown in the message itself, with
 * no download of its own: the native player controls carry one, and an image
 * — bounded here, never at its original size — opens the viewer, which holds
 * the full picture and the download. Nothing about audio or video opens it.
 */
function ArtifactInlineMedia({
  artifact,
  kind,
  occurrenceKey,
}: {
  artifact: ArtifactDescriptor
  kind: ArtifactMediaKind
  occurrenceKey?: string
}) {
  const { labels, locale, occurrences, openArtifact } = useArtifactWorkspace()
  // The provider keeps one descriptor identity per publication while the
  // conversation streams, so the bytes are not reloaded on every render.
  const published =
    occurrences.find(({ key }) => key === occurrenceKey)?.artifact ?? artifact
  const { state } = useArtifactPreviewController(published)
  const url = state.status === "ready" ? state.url : undefined

  if (state.status === "error") {
    return (
      <div className="grid max-w-full gap-1.5">
        <p className="truncate text-sm font-medium" dir="auto">
          {published.filename}
        </p>
        <SystemNotice
          detail={previewFailureDetail(state.reason, labels, published)}
          locale={locale}
          title={previewFailureMessage(state.reason, labels)}
          tone={previewFailureTone(state.reason)}
        >
          {!isArtifactGone(state) && (
            <ArtifactDownloadAction artifact={published} />
          )}
        </SystemNotice>
      </div>
    )
  }

  // A definite width: a native player inside a shrink-to-fit box collapses to
  // its minimal pill.
  return (
    <div className="w-full max-w-[30rem]">
      {url === undefined ? (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2Icon
            className="size-4 motion-safe:animate-spin"
            aria-hidden="true"
          />
          {labels.loading}
        </p>
      ) : kind === "image" ? (
        <button
          type="button"
          aria-label={`${labels.open}: ${published.filename}`}
          className="block max-w-sm cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) =>
            openArtifact(published, event.currentTarget, occurrenceKey)
          }
        >
          <img
            src={url}
            alt={published.filename}
            className="block h-auto max-h-64 w-auto max-w-full rounded-lg border border-border object-contain"
          />
        </button>
      ) : kind === "audio" ? (
        <audio
          aria-label={`${labels.audio}: ${published.filename}`}
          className="block w-full"
          controls
          preload="metadata"
          src={url}
        />
      ) : (
        <video
          aria-label={`${labels.video}: ${published.filename}`}
          className="block h-auto max-h-96 w-full rounded-lg bg-black object-contain"
          controls
          preload="metadata"
          src={url}
        />
      )}
    </div>
  )
}

/**
 * The same descriptor for as long as its bytes are the same. A re-projected
 * conversation hands an inline player a new object for an artifact that has not
 * changed, and resolving by reference would download it again on every streamed
 * token — restarting playback along the way.
 */
function useArtifactByValue(artifact: ArtifactDescriptor | null) {
  const [held, setHeld] = useState(artifact)
  const settled =
    held !== null && artifact !== null && sameArtifactDescriptor(held, artifact)
  if (!settled && held !== artifact) {
    setHeld(artifact)
    return artifact
  }
  return settled ? held : artifact
}

/** Loads an inline media artifact's bytes as an object URL. */
export function useArtifactPreviewController(artifact?: ArtifactDescriptor) {
  const { adapter, agentId, selectedArtifact, sessionId } =
    useArtifactWorkspace()
  const previewArtifact = useArtifactByValue(artifact ?? selectedArtifact)
  const [resolved, setResolved] = useState<{
    artifact: ArtifactDescriptor
    adapter: ArtifactAdapter
    agentId: string
    sessionId: string
    retryToken: number
    state: ArtifactPreviewState
  } | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const isMedia = previewArtifact
    ? artifactMediaKind(previewArtifact.mimeType, previewArtifact.filename) !==
      null
    : false
  const preflightState: ArtifactPreviewState | null = !previewArtifact
    ? { status: "idle" }
    : !adapter
      ? { status: "error", reason: "unavailable" }
      : previewArtifact.sizeBytes !== undefined &&
          previewArtifact.sizeBytes > MAX_ARTIFACT_BYTES
        ? { status: "error", reason: "file-too-large" }
        : !isMedia
          ? { status: "idle" }
          : null
  const shouldResolve = preflightState === null

  useEffect(() => {
    if (!previewArtifact || !adapter || !shouldResolve) return

    const controller = new AbortController()
    let active = true
    let objectUrl: string | undefined
    const request = {
      artifact: previewArtifact,
      adapter,
      agentId,
      sessionId,
      retryToken,
    }
    const finish = (state: ArtifactPreviewState) =>
      setResolved({ ...request, state })

    void adapter
      .resolve({
        artifact: previewArtifact,
        agentId,
        sessionId,
        signal: controller.signal,
      })
      .then((blob) => {
        if (!active) return
        if (blob.size > MAX_ARTIFACT_BYTES) {
          finish({ status: "error", reason: "file-too-large" })
          return
        }
        objectUrl = URL.createObjectURL(blob)
        finish({ status: "ready", url: objectUrl })
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) {
          finish({
            status: "error",
            reason:
              error instanceof ArtifactMissingError
                ? "missing"
                : error instanceof ArtifactUnavailableError
                  ? "unavailable"
                  : "load",
          })
        }
      })

    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [
    adapter,
    agentId,
    isMedia,
    previewArtifact,
    retryToken,
    shouldResolve,
    sessionId,
  ])

  const isCurrentResolution =
    previewArtifact !== null &&
    adapter !== undefined &&
    resolved?.artifact === previewArtifact &&
    resolved.adapter === adapter &&
    resolved.agentId === agentId &&
    resolved.sessionId === sessionId &&
    resolved.retryToken === retryToken
  const state =
    preflightState ??
    (isCurrentResolution ? resolved.state : { status: "loading" as const })

  return {
    state,
    retry: () => setRetryToken((token) => token + 1),
  }
}

/**
 * @deprecated The side viewer is removed. This stub satisfies the import in
 * src/runtime-adapters/aos/guest-composition.tsx until lane C's merge cleans
 * it up.
 */
export function ArtifactViewerContent() {
  return null
}

export function ArtifactToolResultCard({
  result,
  occurrenceKey,
}: {
  result?: unknown
  occurrenceKey?: string
}) {
  const artifact = parseArtifactDescriptor(result)
  return artifact ? (
    <ArtifactCard artifact={artifact} occurrenceKey={occurrenceKey} />
  ) : null
}

function ArtifactDataPart({ data }: { data: unknown }) {
  const messageId = useAuiState((state) => state.message.id)
  const part = useAui().part
  const occurrenceKey =
    part.source === "message" && part.query.type === "index"
      ? `${messageId}:${part.query.index}`
      : undefined

  return <ArtifactToolResultCard result={data} occurrenceKey={occurrenceKey} />
}

export const ArtifactDataUI = makeAssistantDataUI<unknown>({
  name: ARTIFACT_DATA_PART_NAME,
  render: ArtifactDataPart,
})
