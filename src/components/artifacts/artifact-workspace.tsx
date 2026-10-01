"use client"

import { makeAssistantDataUI, useAui, useAuiState } from "@assistant-ui/react"
import {
  ChevronDownIcon,
  DownloadIcon,
  FileIcon,
  Loader2Icon,
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

import { saveShownFile } from "@/components/mcp-apps/host-handlers"
import type { McpAppPipFailure } from "@/components/mcp-apps/mcp-app-card"
import {
  useMcpAppHost,
  type McpAppPip,
} from "@/components/mcp-apps/mcp-app-host"
import { Button } from "@/components/ui/button"
import { MediaPlayer } from "@/components/artifacts/media-player"
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
  extractSessionOutputs,
  parseArtifactDescriptor,
  type ArtifactMessage,
  type ArtifactOccurrence,
  type SessionOutput,
  type ShownFile,
} from "@/artifacts/artifacts"
import type { Dictionary } from "@/lib/i18n/dictionary"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { getLocaleDirection, type Locale } from "@/lib/i18n/config"
import type {
  ArtifactAdapter,
  ArtifactDescriptor,
} from "@/runtime-adapters/contracts"

import { artifactMediaKind, type ArtifactMediaKind } from "./artifact-renderers"

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

type ArtifactPreviewFailure =
  "load" | "unavailable" | "missing" | "file-too-large"

type ArtifactPreviewState =
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
  /** Every file the Session published, oldest first. */
  outputs: SessionOutput[]
  /**
   * Whether the Outputs list is expanded, held here because the inspector
   * unmounts it while the side panel shows, and the row that opened the
   * panel takes the focus back once it closes.
   */
  outputsOpen: boolean
  setOutputsOpen: (open: boolean) => void
  downloadArtifact: (artifact: ArtifactDescriptor) => Promise<void>
}

const ArtifactWorkspaceContext =
  createContext<ArtifactWorkspaceContextValue | null>(null)

function useArtifactWorkspace() {
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

function sameSessionOutput(previous: SessionOutput, next: SessionOutput) {
  if (previous.key !== next.key) return false
  if (previous.kind === "artifact" || next.kind === "artifact")
    return (
      previous.kind === "artifact" &&
      next.kind === "artifact" &&
      sameArtifactDescriptor(previous.artifact, next.artifact)
    )
  return (
    previous.toolCallId === next.toolCallId &&
    previous.toolName === next.toolName &&
    previous.file.filename === next.file.filename &&
    previous.file.mimeType === next.file.mimeType
  )
}

export function createArtifactMessageStabilizer(
  project?: (messages: readonly ArtifactMessage[]) => readonly ArtifactMessage[]
) {
  let previousMessages: readonly ArtifactMessage[] = []
  let previousPathKey = ""
  let previousOutputs: SessionOutput[] = []

  return (messages: readonly ArtifactMessage[]) => {
    const projected = project?.(messages) ?? messages
    const pathKey = projected.map(({ id }) => id).join("\u0000")
    const outputs = extractSessionOutputs(projected)
    if (
      pathKey === previousPathKey &&
      previousOutputs.length === outputs.length &&
      previousOutputs.every((output, index) =>
        sameSessionOutput(output, outputs[index]!)
      )
    )
      return previousMessages

    previousMessages = projected
    previousPathKey = pathKey
    previousOutputs = outputs
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
  const downloadControllersRef = useRef(new Set<AbortController>())
  const downloadUrlsRef = useRef(new Set<string>())
  const labels = (locale === "he" ? he : en).artifacts
  const occurrences = useMemo(
    () => extractArtifactOccurrences(messages),
    [messages]
  )
  const outputs = useMemo(() => extractSessionOutputs(messages), [messages])
  const [outputsOpen, setOutputsOpen] = useState(false)
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
      outputs,
      outputsOpen,
      setOutputsOpen,
      downloadArtifact,
    }),
    [
      adapter,
      agentId,
      downloadArtifact,
      labels,
      locale,
      occurrences,
      outputs,
      outputsOpen,
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

/** A download control's action, and whether its last attempt failed. */
function useDownload(save: () => Promise<void>) {
  const [downloadFailed, setDownloadFailed] = useState(false)

  const download = async () => {
    setDownloadFailed(false)
    try {
      await save()
    } catch {
      setDownloadFailed(true)
    }
  }

  return { download, downloadFailed }
}

function useArtifactDownload(artifact: ArtifactDescriptor) {
  const { downloadArtifact } = useArtifactWorkspace()
  return useDownload(() => downloadArtifact(artifact))
}

type PanelTarget = { toolCallId: string } | { artifactId: string }

/**
 * Opens a published file in the side panel, from the control `opener`, where
 * the runtime hosts App views; `undefined` where it hosts none.
 */
function useOpenInPanel() {
  const host = useMcpAppHost()
  if (!host) return undefined
  const { agentId, sessionId, showInPip } = host
  return (
    target: PanelTarget,
    file: ShownFile,
    opener: HTMLElement,
    toolName?: string
  ) =>
    showInPip({
      target: { agentId, sessionId, ...target },
      file,
      opener,
      ...(toolName === undefined ? {} : { toolName }),
    })
}

const artifactFile = ({ filename, mimeType }: ArtifactDescriptor) => ({
  filename,
  ...(mimeType === undefined ? {} : { mimeType }),
})

/** Whose message carries the artifact; its media sits on that sender's side. */
type ArtifactSender = "assistant" | "user"

type ArtifactCardProps = {
  artifact: ArtifactDescriptor
  occurrenceKey?: string
  sender?: ArtifactSender
}

function ArtifactCard(props: ArtifactCardProps) {
  // Audio, video, and images show inline in the conversation as native players
  // and bounded previews. Every other artifact renders as a file card.
  const mediaKind = artifactMediaKind(
    props.artifact.mimeType,
    props.artifact.filename
  )

  return mediaKind ? (
    <ArtifactInlineMedia
      artifact={props.artifact}
      kind={mediaKind}
      occurrenceKey={props.occurrenceKey}
      sender={props.sender}
    />
  ) : (
    <ArtifactFileCard artifact={props.artifact} />
  )
}

/** A file's icon, name, and whatever is known of its type and size. */
function FileIdentity({
  file,
  sizeBytes,
  compact = false,
}: {
  file: ShownFile
  sizeBytes?: number
  compact?: boolean
}) {
  const { locale } = useArtifactWorkspace()
  return (
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
          {file.filename}
        </p>
        {(file.mimeType || sizeBytes !== undefined) && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[
              file.mimeType,
              sizeBytes === undefined ? null : formatSize(sizeBytes, locale),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    </>
  )
}

function ArtifactFileCard({ artifact }: { artifact: ArtifactDescriptor }) {
  const { adapter, labels, locale } = useArtifactWorkspace()
  const { download, downloadFailed } = useArtifactDownload(artifact)
  const openInPanel = useOpenInPanel()
  const identity = (
    <FileIdentity
      file={artifactFile(artifact)}
      sizeBytes={artifact.sizeBytes}
    />
  )

  // The name column shrinks and truncates beside the actions at their own
  // width; the standard `grid-cols-*` scale has only equal columns.
  return (
    <article className="grid w-fit max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border bg-card p-2 text-card-foreground">
      {openInPanel ? (
        <button
          type="button"
          aria-label={`${labels.open}: ${artifact.filename}`}
          className="flex min-w-0 items-center gap-2 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
          onClick={(event) =>
            openInPanel(
              { artifactId: artifact.id },
              artifactFile(artifact),
              event.currentTarget
            )
          }
        >
          {identity}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2">{identity}</div>
      )}
      <div className="col-start-2 row-start-1 flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!adapter}
          onClick={() => void download()}
          className="motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
        >
          <DownloadIcon data-icon="inline-start" />
          {labels.download}
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
 * Audio and video show in the message as native players whose own controls
 * carry the download, and nothing about them opens the side panel. An image
 * is a bounded preview, never at its original size, that opens the side
 * panel, which holds the full picture and the download.
 */
function ArtifactInlineMedia({
  artifact,
  kind,
  occurrenceKey,
  sender = "assistant",
}: {
  artifact: ArtifactDescriptor
  kind: ArtifactMediaKind
  occurrenceKey?: string
  sender?: ArtifactSender
}) {
  const { labels, locale, occurrences } = useArtifactWorkspace()
  const openInPanel = useOpenInPanel()
  // The provider keeps one descriptor identity per publication while the
  // conversation streams, so the bytes are not reloaded on every render.
  const published =
    occurrences.find(({ key }) => key === occurrenceKey)?.artifact ?? artifact
  const state = useArtifactPreviewController(published)
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

  const image = (
    <img
      src={url}
      alt={published.filename}
      className="block h-auto max-h-64 w-auto max-w-full rounded-lg border border-border object-contain"
    />
  )
  // The interface direction, not the message text's guessed one, sets the
  // sides: an agent's media sits at the start edge and a user's at the end,
  // beside its bubble. An auto margin pushes each box to its sender's side.
  const edge = sender === "user" ? "ms-auto" : "me-auto"
  // A definite width: a native player inside a shrink-to-fit box collapses to
  // its minimal pill.
  return (
    <div
      className={`w-full max-w-[30rem] ${edge}`}
      dir={getLocaleDirection(locale)}
    >
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
        openInPanel ? (
          <button
            type="button"
            aria-label={`${labels.open}: ${published.filename}`}
            className={`block w-fit max-w-sm cursor-zoom-in rounded-lg ${edge} outline-none focus-visible:ring-2 focus-visible:ring-ring`}
            onClick={(event) =>
              openInPanel(
                { artifactId: published.id },
                artifactFile(published),
                event.currentTarget
              )
            }
          >
            {image}
          </button>
        ) : (
          <div className={`w-fit max-w-sm ${edge}`}>{image}</div>
        )
      ) : (
        <MediaPlayer
          kind={kind}
          src={url}
          label={`${labels[kind]}: ${published.filename}`}
          speedLabel={labels.playbackSpeed}
        />
      )}
    </div>
  )
}

/**
 * One row of the Outputs list: its name opens the file in the side panel, and
 * its own Download saves it.
 */
function SessionOutputRow({ output }: { output: SessionOutput }) {
  const { adapter, downloadArtifact, labels, locale } = useArtifactWorkspace()
  const host = useMcpAppHost()
  const openInPanel = useOpenInPanel()
  const file =
    output.kind === "artifact" ? artifactFile(output.artifact) : output.file
  const target: PanelTarget =
    output.kind === "artifact"
      ? { artifactId: output.artifact.id }
      : { toolCallId: output.toolCallId }
  const { download, downloadFailed } = useDownload(async () => {
    if (output.kind === "artifact") return downloadArtifact(output.artifact)
    if (!host) throw new Error("This runtime hosts no App views")
    const { agentId, sessionId } = host
    await saveShownFile(
      host.adapter,
      { agentId, sessionId, toolCallId: output.toolCallId },
      file.filename
    )
  })
  const identity = (
    <FileIdentity
      file={file}
      sizeBytes={
        output.kind === "artifact" ? output.artifact.sizeBytes : undefined
      }
      compact
    />
  )

  // The name column shrinks and truncates beside the actions at their own
  // width; the standard `grid-cols-*` scale has only equal columns.
  return (
    <article className="grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-1.5 border-b border-border/70 text-card-foreground last:border-b-0">
      {openInPanel ? (
        <button
          type="button"
          aria-label={`${labels.open}: ${file.filename}`}
          data-artifact-open-id={output.key}
          className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
          onClick={(event) =>
            openInPanel(
              target,
              file,
              event.currentTarget,
              output.kind === "app" ? output.toolName : undefined
            )
          }
        >
          {identity}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
          {identity}
        </div>
      )}
      <div className="col-start-2 row-start-1 flex items-center pe-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={labels.download}
          title={labels.download}
          disabled={output.kind === "artifact" ? !adapter : !host}
          onClick={() => void download()}
          className="motion-reduce:transition-none [@media(pointer:coarse)]:size-11"
        >
          <DownloadIcon data-icon="inline-start" />
        </Button>
      </div>
      {downloadFailed && (
        <SystemNotice
          className="col-span-2 mx-2 mb-2"
          locale={locale}
          title={labels.downloadFailed}
          tone="error"
        />
      )}
    </article>
  )
}

/**
 * The inspector's collapsible list of every file the Session published,
 * newest first: its Artifacts, and the files its App views show.
 */
export function ArtifactOutputs({ className = "" }: { className?: string }) {
  const { labels, locale, outputs, outputsOpen, setOutputsOpen } =
    useArtifactWorkspace()
  const titleId = useId()

  return (
    <details
      className={`group ${className}`}
      dir={locale === "he" ? "rtl" : "ltr"}
      role="region"
      aria-label={labels.outputs}
      open={outputsOpen}
      onToggle={(event) => setOutputsOpen(event.currentTarget.open)}
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
        {outputs.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{labels.empty}</p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
            {outputs.toReversed().map((output) => (
              <SessionOutputRow key={output.key} output={output} />
            ))}
          </div>
        )}
      </div>
    </details>
  )
}

/**
 * What the side panel says of an Artifact it could not show: that the
 * provider no longer holds it, with no download to offer; or that no viewer
 * opens it, with its Download still there.
 */
function ArtifactPanelFailure({
  artifactId,
  reason,
}: {
  artifactId: string
  reason: McpAppPipFailure
}) {
  const { labels, locale, occurrences } = useArtifactWorkspace()
  const artifact = occurrences.findLast(
    (occurrence) => occurrence.artifact.id === artifactId
  )?.artifact
  return (
    <SystemNotice
      detail={artifact && previewFailureDetail(reason, labels, artifact)}
      locale={locale}
      title={previewFailureMessage(reason, labels)}
      tone={previewFailureTone(reason)}
    >
      {reason === "unavailable" && artifact ? (
        <ArtifactDownloadAction artifact={artifact} />
      ) : null}
    </SystemNotice>
  )
}

/** The side panel's failure notice for an Artifact; any other keeps its own. */
export function artifactPanelFailure(pip: McpAppPip, reason: McpAppPipFailure) {
  return "artifactId" in pip.target ? (
    <ArtifactPanelFailure artifactId={pip.target.artifactId} reason={reason} />
  ) : undefined
}

/**
 * The same descriptor for as long as its bytes are the same. A re-projected
 * conversation hands an inline player a new object for an artifact that has not
 * changed, and resolving by reference would download it again on every streamed
 * token — restarting playback along the way.
 */
function useArtifactByValue(artifact: ArtifactDescriptor) {
  const [held, setHeld] = useState(artifact)
  const settled = sameArtifactDescriptor(held, artifact)
  if (!settled && held !== artifact) {
    setHeld(artifact)
    return artifact
  }
  return settled ? held : artifact
}

/** Loads an inline media artifact's bytes as an object URL. */
function useArtifactPreviewController(artifact: ArtifactDescriptor) {
  const { adapter, agentId, sessionId } = useArtifactWorkspace()
  const previewArtifact = useArtifactByValue(artifact)
  const [resolved, setResolved] = useState<{
    artifact: ArtifactDescriptor
    adapter: ArtifactAdapter
    agentId: string
    sessionId: string
    state: ArtifactPreviewState
  } | null>(null)

  const preflightState: ArtifactPreviewState | null = !adapter
    ? { status: "error", reason: "unavailable" }
    : previewArtifact.sizeBytes !== undefined &&
        previewArtifact.sizeBytes > MAX_ARTIFACT_BYTES
      ? { status: "error", reason: "file-too-large" }
      : null
  const shouldResolve = preflightState === null

  useEffect(() => {
    if (!adapter || !shouldResolve) return

    const controller = new AbortController()
    let active = true
    let objectUrl: string | undefined
    const request = { artifact: previewArtifact, adapter, agentId, sessionId }
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
  }, [adapter, agentId, previewArtifact, shouldResolve, sessionId])

  const isCurrentResolution =
    adapter !== undefined &&
    resolved?.artifact === previewArtifact &&
    resolved.adapter === adapter &&
    resolved.agentId === agentId &&
    resolved.sessionId === sessionId
  return (
    preflightState ??
    (isCurrentResolution ? resolved.state : { status: "loading" as const })
  )
}

export function ArtifactToolResultCard({
  result,
  occurrenceKey,
  sender,
}: {
  result?: unknown
  occurrenceKey?: string
  sender?: ArtifactSender
}) {
  const artifact = parseArtifactDescriptor(result)
  return artifact ? (
    <ArtifactCard
      artifact={artifact}
      occurrenceKey={occurrenceKey}
      sender={sender}
    />
  ) : null
}

function ArtifactDataPart({ data }: { data: unknown }) {
  const messageId = useAuiState((state) => state.message.id)
  const sender = useAuiState((state) =>
    state.message.role === "user" ? "user" : "assistant"
  )
  const part = useAui().part
  const occurrenceKey =
    part.source === "message" && part.query.type === "index"
      ? `${messageId}:${part.query.index}`
      : undefined

  return (
    <ArtifactToolResultCard
      result={data}
      occurrenceKey={occurrenceKey}
      sender={sender}
    />
  )
}

export const ArtifactDataUI = makeAssistantDataUI<unknown>({
  name: ARTIFACT_DATA_PART_NAME,
  render: ArtifactDataPart,
})
