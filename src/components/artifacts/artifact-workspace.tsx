"use client"

import { makeAssistantDataUI, useAui, useAuiState } from "@assistant-ui/react"
import {
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  Loader2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "@/components/ui/button"
import { HighlightedCode } from "@/components/code/syntax-highlighter"
import { syntaxLanguageFromFilename } from "@/components/code/syntax-language"
import { ArtifactUnavailableError } from "@/artifacts/browser-artifact-adapter"
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

import {
  classifyArtifactPreview,
  parseCsvPreview,
  type ArtifactPreviewKind,
} from "./artifact-renderers"
import { injectArtifactHtmlCsp } from "./artifact-frame-policy"
import { ArtifactMarkdown } from "./artifact-markdown"

export const MAX_ARTIFACT_PREVIEW_BYTES = 25 * 1024 * 1024
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024

export type ArtifactPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "error"
      reason: "load" | "unavailable" | "file-too-large" | "text-too-large"
    }
  | {
      status: "ready"
      kind: ArtifactPreviewKind
      text?: string
      url?: string
    }

type ArtifactWorkspaceContextValue = {
  locale: Locale
  labels: Dictionary["artifacts"]
  adapter: ArtifactAdapter | undefined
  agentId: string
  threadId: string
  occurrences: ArtifactOccurrence[]
  artifactHtmlAssetOrigins: readonly string[]
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
  threadId: string
  messages: readonly ArtifactMessage[]
  artifactHtmlAssetOrigins?: readonly string[]
  children: ReactNode
}

const NO_ASSET_ORIGINS: readonly string[] = []

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
  threadId,
  messages,
  artifactHtmlAssetOrigins = NO_ASSET_ORIGINS,
  children,
}: ArtifactWorkspaceProviderProps) {
  const [selection, setSelection] = useState<{
    artifact: ArtifactDescriptor
    agentId: string
    threadId: string
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
    selection.threadId === threadId &&
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
        threadId,
        occurrenceKey: publication.key,
      })
    },
    [agentId, occurrences, threadId]
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
          threadId,
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
      } finally {
        downloadControllersRef.current.delete(controller)
      }
    },
    [adapter, agentId, threadId]
  )

  useEffect(
    () => () => {
      downloadControllersRef.current.forEach((controller) => controller.abort())
      downloadUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      downloadControllersRef.current.clear()
      downloadUrlsRef.current.clear()
    },
    [agentId, threadId]
  )

  const value = useMemo<ArtifactWorkspaceContextValue>(
    () => ({
      locale,
      labels,
      adapter,
      agentId,
      threadId,
      occurrences,
      artifactHtmlAssetOrigins,
      selectedArtifact,
      openArtifact,
      closeArtifact,
      downloadArtifact,
    }),
    [
      adapter,
      agentId,
      artifactHtmlAssetOrigins,
      closeArtifact,
      downloadArtifact,
      labels,
      locale,
      occurrences,
      openArtifact,
      selectedArtifact,
      threadId,
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

export function ArtifactCard({
  artifact,
  compact = false,
  occurrenceKey,
}: {
  artifact: ArtifactDescriptor
  compact?: boolean
  occurrenceKey?: string
}) {
  const { adapter, downloadArtifact, labels, locale, openArtifact } =
    useArtifactWorkspace()
  const [downloadFailed, setDownloadFailed] = useState(false)

  const download = async () => {
    setDownloadFailed(false)
    try {
      await downloadArtifact(artifact)
    } catch {
      setDownloadFailed(true)
    }
  }

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
        <p className="mt-2 text-sm text-destructive" role="status">
          {labels.downloadFailed}
        </p>
      )}
    </article>
  )
}

export function ArtifactOutputs({ className = "" }: { className?: string }) {
  const { labels, locale, occurrences } = useArtifactWorkspace()
  const titleId = useId()

  return (
    <details
      className={`group ${className}`}
      dir={locale === "he" ? "rtl" : "ltr"}
      role="region"
      aria-label={labels.outputs}
    >
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <h2 id={titleId} className="text-sm font-semibold">
          {labels.outputs}
        </h2>
      </summary>
      <div aria-labelledby={titleId}>
        {occurrences.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{labels.empty}</p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
            {occurrences.toReversed().map(({ key, artifact }) => (
              <ArtifactCard
                key={key}
                artifact={artifact}
                occurrenceKey={key}
                compact
              />
            ))}
          </div>
        )}
      </div>
    </details>
  )
}

function isTextPreview(kind: ArtifactPreviewKind) {
  return ["markdown", "text", "code", "json", "csv", "html"].includes(kind)
}

function ArtifactCopyButton({
  labels,
  text,
}: {
  labels: Dictionary["artifacts"]
  text: string
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  )

  const copyText = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable")
      }
      await navigator.clipboard.writeText(text)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => void copyText()}
      className="[@media(pointer:coarse)]:min-h-11"
    >
      <CopyIcon data-icon="inline-start" />
      {copyState === "copied"
        ? labels.copied
        : copyState === "failed"
          ? labels.copyFailed
          : labels.copy}
    </Button>
  )
}

export function useArtifactPreviewController() {
  const { adapter, agentId, selectedArtifact, threadId } =
    useArtifactWorkspace()
  const [resolved, setResolved] = useState<{
    artifact: ArtifactDescriptor
    adapter: ArtifactAdapter
    agentId: string
    threadId: string
    retryToken: number
    state: ArtifactPreviewState
  } | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const kind = selectedArtifact
    ? classifyArtifactPreview(
        selectedArtifact.mimeType,
        selectedArtifact.filename
      )
    : "unsupported"
  const preflightState: ArtifactPreviewState | null = !selectedArtifact
    ? { status: "idle" }
    : !adapter
      ? { status: "error", reason: "unavailable" }
      : isTextPreview(kind) &&
          selectedArtifact.sizeBytes !== undefined &&
          selectedArtifact.sizeBytes > MAX_TEXT_PREVIEW_BYTES
        ? { status: "error", reason: "text-too-large" }
        : selectedArtifact.sizeBytes !== undefined &&
            selectedArtifact.sizeBytes > MAX_ARTIFACT_PREVIEW_BYTES
          ? { status: "error", reason: "file-too-large" }
          : kind === "unsupported"
            ? { status: "ready", kind }
            : null
  const shouldResolve = preflightState === null

  useEffect(() => {
    if (!selectedArtifact || !adapter || !shouldResolve) return

    const controller = new AbortController()
    let active = true
    let objectUrl: string | undefined
    const request = {
      artifact: selectedArtifact,
      adapter,
      agentId,
      threadId,
      retryToken,
    }
    const finish = (state: ArtifactPreviewState) =>
      setResolved({ ...request, state })

    void adapter
      .resolve({
        artifact: selectedArtifact,
        agentId,
        threadId,
        signal: controller.signal,
      })
      .then(async (blob) => {
        if (!active) return
        if (isTextPreview(kind)) {
          if (blob.size > MAX_TEXT_PREVIEW_BYTES) {
            finish({ status: "error", reason: "text-too-large" })
            return
          }
          const text = await blob.text()
          if (active) finish({ status: "ready", kind, text })
          return
        }
        if (blob.size > MAX_ARTIFACT_PREVIEW_BYTES) {
          finish({ status: "error", reason: "file-too-large" })
          return
        }
        objectUrl = URL.createObjectURL(blob)
        finish({ status: "ready", kind, url: objectUrl })
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) {
          finish({
            status: "error",
            reason:
              error instanceof ArtifactUnavailableError
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
    kind,
    retryToken,
    selectedArtifact,
    shouldResolve,
    threadId,
  ])

  const isCurrentResolution =
    selectedArtifact !== null &&
    adapter !== undefined &&
    resolved?.artifact === selectedArtifact &&
    resolved.adapter === adapter &&
    resolved.agentId === agentId &&
    resolved.threadId === threadId &&
    resolved.retryToken === retryToken
  const state =
    preflightState ??
    (isCurrentResolution ? resolved.state : { status: "loading" as const })

  return {
    state,
    retry: () => setRetryToken((token) => token + 1),
  }
}

export function ArtifactViewerContent({
  className = "",
  showCloseButton = true,
}: {
  className?: string
  showCloseButton?: boolean
}) {
  const {
    adapter,
    closeArtifact,
    downloadArtifact,
    labels,
    locale,
    selectedArtifact,
  } = useArtifactWorkspace()
  const { retry, state } = useArtifactPreviewController()
  const [downloadFailed, setDownloadFailed] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  if (!selectedArtifact) return null

  return (
    <section
      className={`flex h-full min-h-0 flex-col overflow-hidden bg-background ${className}`}
      dir={locale === "he" ? "rtl" : "ltr"}
      aria-label={labels.viewerLabel}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        closeArtifact()
      }}
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-medium" dir="auto">
            {selectedArtifact.filename}
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {selectedArtifact.mimeType ?? labels.unsupported}
          </p>
        </div>
        {state.status === "ready" && isTextPreview(state.kind) && (
          <ArtifactCopyButton labels={labels} text={state.text ?? ""} />
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={!adapter}
          onClick={() => {
            setDownloadFailed(false)
            void downloadArtifact(selectedArtifact).catch(() =>
              setDownloadFailed(true)
            )
          }}
          className="[@media(pointer:coarse)]:min-h-11"
        >
          <DownloadIcon data-icon="inline-start" />
          {labels.download}
        </Button>
        {showCloseButton && (
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={closeArtifact}
            aria-label={labels.close}
            className="[@media(pointer:coarse)]:size-11"
          >
            <XIcon />
          </Button>
        )}
      </header>
      {downloadFailed && (
        <p
          className="border-b border-border px-4 py-2 text-sm text-destructive"
          role="status"
        >
          {labels.downloadFailed}
        </p>
      )}
      <div className="min-h-64 flex-1 overflow-auto bg-muted/30 p-4">
        <ArtifactPreview
          state={state}
          labels={labels}
          filename={selectedArtifact.filename}
          onRetry={retry}
        />
      </div>
    </section>
  )
}

function ArtifactPreview({
  state,
  labels,
  filename,
  onRetry,
}: {
  state: ArtifactPreviewState
  labels: Dictionary["artifacts"]
  filename: string
  onRetry: () => void
}) {
  if (state.status === "idle") return null
  if (state.status === "loading") {
    return (
      <div
        className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2Icon className="size-4 motion-safe:animate-spin" />
        {labels.loading}
      </div>
    )
  }
  if (state.status === "error") {
    const message =
      state.reason === "file-too-large"
        ? labels.fileTooLarge
        : state.reason === "text-too-large"
          ? labels.textTooLarge
          : state.reason === "unavailable"
            ? labels.unavailable
            : labels.loadFailed
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{message}</p>
        {state.reason === "load" && (
          <Button type="button" variant="outline" onClick={onRetry}>
            <RotateCcwIcon data-icon="inline-start" />
            {labels.retry}
          </Button>
        )}
      </div>
    )
  }

  if (state.kind === "unsupported") {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {labels.unsupported}
      </p>
    )
  }
  if (state.kind === "image") {
    return (
      <img
        src={state.url}
        alt={filename}
        className="mx-auto max-h-[70dvh] max-w-full object-contain"
      />
    )
  }
  if (state.kind === "pdf") {
    return (
      <iframe
        src={`${state.url}#toolbar=1&view=FitH&page=1`}
        title={labels.pdfPreviewTitle}
        referrerPolicy="no-referrer"
        className="h-[70dvh] w-full rounded-xl bg-background"
      />
    )
  }
  if (state.kind === "audio") {
    return (
      <div className="mx-auto flex min-h-56 max-w-2xl items-center rounded-2xl bg-background p-5 shadow-sm">
        <audio src={state.url} controls className="w-full" />
      </div>
    )
  }
  if (state.kind === "video") {
    return (
      <video
        src={state.url}
        controls
        className="mx-auto aspect-video max-h-[70dvh] w-full rounded-xl bg-black object-contain"
      />
    )
  }
  if (state.kind === "csv") {
    return <CsvPreview text={state.text ?? ""} labels={labels} />
  }
  if (state.kind === "html") {
    return <HtmlPreview text={state.text ?? ""} labels={labels} />
  }
  if (state.kind === "markdown") {
    return <ArtifactMarkdown source={state.text ?? ""} />
  }

  let text = state.text ?? ""
  if (state.kind === "json") {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Preserve malformed JSON as inspectable source.
    }
  }
  if (state.kind === "code" || state.kind === "json") {
    return (
      <HighlightedCode
        code={text}
        language={
          state.kind === "json" ? "json" : syntaxLanguageFromFilename(filename)
        }
        className="rounded-xl border-t bg-background shadow-sm"
      />
    )
  }
  return (
    <pre
      className={`overflow-auto rounded-xl bg-background p-5 text-sm leading-6 whitespace-pre-wrap shadow-sm ${state.kind === "text" ? "font-sans" : "font-mono"}`}
      dir="auto"
    >
      {text}
    </pre>
  )
}

function CsvPreview({
  text,
  labels,
}: {
  text: string
  labels: Dictionary["artifacts"]
}) {
  const preview = useMemo(() => parseCsvPreview(text), [text])
  const [header, ...rows] = preview.rows
  return (
    <div className="overflow-auto rounded-xl bg-background shadow-sm">
      <table className="w-full border-collapse text-sm tabular-nums">
        {header && (
          <thead className="sticky top-0 bg-muted">
            <tr>
              {header.map((cell, index) => (
                <th
                  key={index}
                  scope="col"
                  className="border-b border-border px-3 py-2 text-start font-medium"
                  dir="auto"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className="border-b border-border/60 last:border-b-0"
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="px-3 py-2 align-top whitespace-pre-wrap"
                  dir="auto"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.truncated && (
        <p className="border-t border-border p-3 text-xs text-muted-foreground">
          {labels.csvTruncated}
        </p>
      )}
    </div>
  )
}

function HtmlPreview({
  text,
  labels,
}: {
  text: string
  labels: Dictionary["artifacts"]
}) {
  const { artifactHtmlAssetOrigins } = useArtifactWorkspace()
  const [tab, setTab] = useState<"preview" | "source">("preview")
  const previewTabId = useId()
  const sourceTabId = useId()
  const panelId = useId()
  const html = useMemo(
    () => injectArtifactHtmlCsp(text, artifactHtmlAssetOrigins),
    [artifactHtmlAssetOrigins, text]
  )

  const selectTab = (next: "preview" | "source") => {
    setTab(next)
    document
      .getElementById(next === "preview" ? previewTabId : sourceTabId)
      ?.focus()
  }

  return (
    <div className="grid gap-3">
      <div
        role="tablist"
        aria-label={labels.htmlView}
        className="inline-flex w-fit rounded-lg bg-muted p-1"
        onKeyDown={(event) => {
          if (event.key === "Home") selectTab("preview")
          else if (event.key === "End") selectTab("source")
          else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            selectTab(tab === "preview" ? "source" : "preview")
          } else return
          event.preventDefault()
        }}
      >
        <button
          id={previewTabId}
          type="button"
          role="tab"
          aria-selected={tab === "preview"}
          aria-controls={panelId}
          tabIndex={tab === "preview" ? 0 : -1}
          onClick={() => setTab("preview")}
          className="rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-background aria-selected:shadow-sm [@media(pointer:coarse)]:min-h-11"
        >
          {labels.preview}
        </button>
        <button
          id={sourceTabId}
          type="button"
          role="tab"
          aria-selected={tab === "source"}
          aria-controls={panelId}
          tabIndex={tab === "source" ? 0 : -1}
          onClick={() => setTab("source")}
          className="rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-background aria-selected:shadow-sm [@media(pointer:coarse)]:min-h-11"
        >
          {labels.source}
        </button>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tab === "preview" ? previewTabId : sourceTabId}
      >
        {tab === "preview" ? (
          <iframe
            title={labels.htmlPreviewTitle}
            srcDoc={html}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-[68dvh] w-full rounded-xl bg-background shadow-sm"
          />
        ) : (
          <pre
            className="max-h-[68dvh] overflow-auto rounded-xl bg-background p-5 font-mono text-sm leading-6 whitespace-pre-wrap shadow-sm"
            dir="auto"
          >
            {text}
          </pre>
        )}
      </div>
    </div>
  )
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
