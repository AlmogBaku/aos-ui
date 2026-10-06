import {
  Download,
  ExternalLink,
  File,
  FileCode,
  FileImage,
  FileMusic,
  FileText,
  FileVideoCamera,
  Maximize2,
  PictureInPicture2,
  RotateCw,
  type LucideIcon,
} from "lucide-react"
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { z } from "zod"

import type { PresentArtifactResult } from "../../../shared/presentation/tools"
import {
  PREVIEW_LIMITS,
  kindOf,
  knownType,
  type FileKind,
  type FilePreview,
  type PreviewLimits,
} from "./artifact/file"
import { Code } from "./artifact/code"
import { CopyButton } from "./artifact/copy-button"
import { CsvTable } from "./artifact/csv-table"
import { HtmlPreview } from "./artifact/html-preview"
import { Markdown } from "./artifact/markdown"
import { MediaPlayer } from "./artifact/media-player"
import { useRoom, type Room } from "./artifact/room"
import { useFile } from "./artifact/use-file"
import { ZoomPane } from "./artifact/zoom"
import type { ViewLabels } from "./locale"
import { IconButton } from "./ui/icon-button"
import { MenuButton, type MenuAction } from "./ui/menu-button"
import { Status } from "./ui/status"
import { Compact, ToolbarSlot, useCompact } from "./ui/toolbar"
import type { ViewApp, ViewProps } from "./view"

const PdfPreview = lazy(() =>
  import("./artifact/pdf-preview").then((module) => ({
    default: module.PdfPreview,
  }))
)

/**
 * The page's `aos/files`: the file's current address under the argument that
 * named it. The page renews the address as its pass expires.
 */
const filesSchema = z.object({ path: z.url({ protocol: /^https?$/u }) })

type ArtifactLabels = ViewLabels["artifact"]

function ignore() {}

/**
 * An image fitted to the room, never past its own size until zoomed, so a
 * small one stays sharp and a large one shows whole.
 */
function ImagePreview({
  url,
  name,
  labels,
  room,
}: {
  url: string
  name: string
  labels: ArtifactLabels
  room: Room
}) {
  const [broken, setBroken] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number }>()
  if (broken) return <Status>{labels.noPreview}</Status>
  return (
    <ZoomPane room={room} label={labels.imageTitle} labels={labels}>
      {(space, zoom) => {
        const fit = size
          ? Math.min(1, space.width / size.width, space.height / size.height)
          : 0
        return (
          <img
            src={url}
            alt={name}
            className="m-auto block max-w-none shrink-0 rounded-md"
            style={
              size
                ? {
                    width: Math.floor(size.width * fit * zoom),
                    height: Math.floor(size.height * fit * zoom),
                  }
                : { maxWidth: "100%", maxHeight: space.height }
            }
            onLoad={(event) => {
              // An SVG without a size of its own keeps to the space unzoomed.
              const { naturalWidth: width, naturalHeight: height } =
                event.currentTarget
              if (width && height) setSize({ width, height })
            }}
            onError={() => setBroken(true)}
          />
        )
      }}
    </ZoomPane>
  )
}

/** JSON indented two spaces; text that does not parse stays as it came. */
function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * A text file in a box of its own that scrolls: in the side panel it fills the
 * room, and in its message it grows with the text up to the room's height.
 */
function TextPreview({
  preview,
  filename,
  labels,
  app,
  size,
}: {
  preview: Extract<FilePreview, { kind: "text" }>
  filename: string
  labels: ArtifactLabels
  app: ViewApp
  size: CSSProperties
}) {
  switch (preview.format) {
    case "markdown":
      return (
        <Markdown
          source={preview.text}
          label={filename}
          openLink={app.openLink}
          read={app.readServerResource}
          style={size}
        />
      )
    case "csv":
      return (
        <CsvTable
          text={preview.text}
          label={filename}
          truncatedLabel={labels.csvTruncated}
          style={size}
        />
      )
    case "json":
      return (
        <Code
          code={prettyJson(preview.text)}
          language="json"
          label={filename}
          read={app.readServerResource}
          style={size}
        />
      )
    case "code":
      return (
        <Code
          code={preview.text}
          language={preview.language}
          label={filename}
          read={app.readServerResource}
          style={size}
        />
      )
    case "plain":
      return (
        <pre
          dir="auto"
          tabIndex={0}
          role="region"
          aria-label={filename}
          style={size}
          className="m-0 overflow-auto rounded-md bg-muted p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {preview.text}
        </pre>
      )
  }
}

function Preview({
  preview,
  filename,
  labels,
  app,
  room,
}: {
  preview: FilePreview
  filename: string
  labels: ArtifactLabels
  app: ViewApp
  room: Room
}) {
  switch (preview.kind) {
    case "pdf":
      return (
        <Suspense fallback={<Status>{labels.loading}</Status>}>
          <PdfPreview
            blob={preview.blob}
            read={app.readServerResource}
            labels={labels}
            room={room}
          />
        </Suspense>
      )
    case "image":
      return (
        <ImagePreview
          url={preview.url}
          name={filename}
          labels={labels}
          room={room}
        />
      )
    case "html":
      return (
        <HtmlPreview
          text={preview.text}
          height={room.height}
          labels={labels}
          read={app.readServerResource}
        />
      )
    case "text":
      return (
        <TextPreview
          preview={preview}
          filename={filename}
          labels={labels}
          app={app}
          size={{ height: room.height }}
        />
      )
    case "none":
      return <Status>{labels.noPreview}</Status>
  }
}

/** Each kind's icon on the file's card. */
const KIND_ICONS: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  image: FileImage,
  html: FileCode,
  text: FileText,
  audio: FileMusic,
  video: FileVideoCamera,
}

/**
 * The file in its message, as a card that names it and its type, with Download
 * and Open in new tab; a press on it opens the side panel where that is
 * offered. A player, as `children`, plays in place below.
 */
function FileCard({
  filename,
  type,
  labels,
  actions,
  onOpen,
  children,
}: {
  filename: string
  type: string | undefined
  labels: ArtifactLabels
  actions: readonly MenuAction[]
  onOpen: (() => void) | undefined
  children?: ReactNode
}) {
  const kind = kindOf(type)
  const Icon = kind ? KIND_ICONS[kind] : File
  const content = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" dir="auto">
          {filename}
        </span>
        {type ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {type}
          </span>
        ) : null}
      </span>
    </span>
  )
  const contentClass = "flex min-w-0 rounded-lg text-start"
  // The name column shrinks and truncates beside the actions at their own
  // width; the standard `grid-cols-*` scale has only equal columns.
  return (
    <article
      className={`grid ${children ? "w-full" : "w-fit"} max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border bg-card p-2 text-card-foreground`}
    >
      {onOpen ? (
        <button
          type="button"
          aria-label={labels.view(filename)}
          className={`${contentClass} cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11`}
          onClick={onOpen}
        >
          {content}
        </button>
      ) : (
        <div className={contentClass}>{content}</div>
      )}
      <div className="flex items-center gap-1">
        {actions.map(({ label, icon, onSelect }) => (
          <IconButton key={label} label={label} onClick={onSelect}>
            {icon}
          </IconButton>
        ))}
      </div>
      {children ? <div className="col-span-2">{children}</div> : null}
    </article>
  )
}

/** The width the page gives the view in its message, when it gives one. */
function roomWidth(context: ViewProps<unknown>["context"]) {
  const dimensions = context?.containerDimensions
  return dimensions && "width" in dimensions ? dimensions.width : undefined
}

/** How tall an image shows in its message, in CSS pixels, as `max-h-64`. */
const THUMBNAIL_HEIGHT = 256

/**
 * An image in its message, as an attachment's image shows: alone, start
 * aligned, at its own aspect, as tall as `THUMBNAIL_HEIGHT` but no wider than
 * `room`, a small one scaled up to fit. The view takes the image's width, so
 * its frame hugs it; a press on it opens the side panel where that is offered.
 */
function ImageThumbnail({
  url,
  filename,
  labels,
  room,
  fitWidth,
  onOpen,
}: {
  url: string
  filename: string
  labels: ArtifactLabels
  room: number | undefined
  fitWidth: ViewApp["fitWidth"]
  onOpen: (() => void) | undefined
}) {
  const [natural, setNatural] = useState<{ width: number; height: number }>()
  const size =
    natural && room
      ? (() => {
          const height = Math.min(
            THUMBNAIL_HEIGHT,
            (room * natural.height) / natural.width
          )
          return {
            width: Math.floor((height * natural.width) / natural.height),
            height: Math.floor(height),
          }
        })()
      : undefined
  const width = size?.width
  useEffect(() => {
    fitWidth(width)
    return () => fitWidth(undefined)
  }, [fitWidth, width])
  const image = (
    <img
      src={url}
      alt={filename}
      className="block h-auto max-h-64 w-auto max-w-full rounded-lg border border-border object-contain"
      style={size}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget
        if (naturalWidth && naturalHeight)
          setNatural({ width: naturalWidth, height: naturalHeight })
      }}
    />
  )
  return onOpen ? (
    <button
      type="button"
      aria-label={labels.view(filename)}
      className="block cursor-pointer rounded-lg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      onClick={onOpen}
    >
      {image}
    </button>
  ) : (
    image
  )
}

/** The kinds a browser shows itself, so a new tab opens them as they are. */
const OPENS_IN_TAB: ReadonlySet<FileKind> = new Set([
  "pdf",
  "image",
  "audio",
  "video",
])

/**
 * The file `present_artifact` shows, read from the address the page grants in
 * `aos/files`. In its message an image shows alone, and any other file as a
 * card without its contents; the side panel and full screen preview it whole,
 * with every control. Download and Open in new tab hand the page that same
 * address; Open is offered only for a kind the browser shows itself, since the
 * page serves any other as plain text.
 */
export function ArtifactView({
  value,
  labels,
  app,
  context,
  previewLimits = PREVIEW_LIMITS,
}: ViewProps<PresentArtifactResult> & { previewLimits?: PreviewLimits }) {
  const artifact = labels.artifact
  const address = filesSchema.safeParse(context?.["aos/files"]).data?.path
  const mode = context?.displayMode
  const pip = mode === "pip"
  const fullscreen = mode === "fullscreen"
  const expanded = pip || fullscreen
  const type = knownType(value)
  const kind = kindOf(type)
  // Media plays from its address, never read; in its message only an image
  // is read, since only an image shows there.
  const media = kind === "audio" || kind === "video" ? kind : undefined
  const file = useFile(
    media === undefined && (expanded || kind === "image") ? address : undefined,
    value.filename,
    value.mimeType,
    previewLimits
  )
  const root = useRef<HTMLDivElement>(null)
  const compact = useCompact(root)
  const box = useRef<HTMLDivElement>(null)
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const room = useRoom(root, box, expanded && file.state.status === "ready")
  const offered = context?.availableDisplayModes
  const offersPip = offered?.includes("pip") === true
  const openPip = offersPip
    ? () => void app.requestDisplayMode({ mode: "pip" }).catch(ignore)
    : undefined
  // Where the view was before full screen, which Esc returns it to.
  const [home, setHome] = useState<"inline" | "pip">("inline")
  const goFullscreen: MenuAction | undefined =
    offered?.includes("fullscreen") && !fullscreen
      ? {
          label: artifact.fullscreen,
          icon: <Maximize2 />,
          onSelect: () => {
            setHome(pip ? "pip" : "inline")
            void app.requestDisplayMode({ mode: "fullscreen" }).catch(ignore)
          },
        }
      : undefined
  const download: MenuAction | undefined =
    address === undefined
      ? undefined
      : {
          label: artifact.download,
          icon: <Download />,
          onSelect: () =>
            void app
              .downloadFile({
                contents: [
                  {
                    type: "resource_link",
                    uri: address,
                    name: value.filename,
                    ...(value.mimeType === undefined
                      ? {}
                      : { mimeType: value.mimeType }),
                  },
                ],
              })
              .catch(ignore),
        }
  const open: MenuAction | undefined =
    address === undefined || kind === undefined || !OPENS_IN_TAB.has(kind)
      ? undefined
      : {
          label: artifact.open,
          icon: <ExternalLink />,
          onSelect: () => void app.openLink({ url: address }).catch(ignore),
        }
  // Esc returns the view from the side panel to its message, and from full
  // screen to where it was, unless something in the view used the key first.
  useEffect(() => {
    if (!expanded) return
    const leave = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      void app
        .requestDisplayMode({ mode: fullscreen ? home : "inline" })
        .catch(ignore)
    }
    window.addEventListener("keydown", leave)
    return () => window.removeEventListener("keydown", leave)
  }, [app, expanded, fullscreen, home])

  if (context !== undefined && address === undefined)
    return (
      <div ref={root} className="p-3">
        <Status>{artifact.unreachable}</Status>
      </div>
    )
  const player =
    media && address ? (
      <MediaPlayer
        kind={media}
        src={address}
        label={`${artifact[media]}: ${value.filename}`}
        speedLabel={artifact.playbackSpeed}
        fill={expanded}
      />
    ) : null
  if (!expanded)
    return file.state.status === "ready" &&
      file.state.preview.kind === "image" ? (
      <div ref={root}>
        <ImageThumbnail
          url={file.state.preview.url}
          filename={value.filename}
          labels={artifact}
          room={roomWidth(context)}
          fitWidth={app.fitWidth}
          onOpen={openPip}
        />
      </div>
    ) : (
      <div ref={root} className="p-3">
        <FileCard
          filename={value.filename}
          type={type}
          labels={artifact}
          actions={[download, goFullscreen, open].filter(
            (action) => action !== undefined
          )}
          onOpen={openPip}
        >
          {player}
        </FileCard>
      </div>
    )
  // The page names the file above the side panel and in full screen, so the
  // view does not.
  // Media reloads from its own controls, so it has no Refresh.
  const actions = [
    media
      ? undefined
      : { label: artifact.refresh, icon: <RotateCw />, onSelect: file.refresh },
    download,
    goFullscreen,
    open,
  ].filter((action) => action !== undefined)
  return (
    <div ref={root} className="flex h-dvh flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div ref={setToolbar} className="flex items-center empty:hidden" />
        <div className="ms-auto flex items-center gap-1">
          {/* HTML carries its Copy over its source. */}
          {file.state.status === "ready" &&
          file.state.preview.kind === "text" ? (
            <CopyButton text={file.state.preview.text} labels={artifact} />
          ) : null}
          {compact ? (
            <MenuButton label={artifact.more} actions={actions} />
          ) : (
            actions.map(({ label, icon, onSelect }) => (
              <IconButton key={label} label={label} onClick={onSelect}>
                {icon}
              </IconButton>
            ))
          )}
          {pip && offersPip ? (
            <IconButton
              label={artifact.pip}
              pressed
              onClick={() =>
                void app.requestDisplayMode({ mode: "inline" }).catch(ignore)
              }
            >
              <PictureInPicture2 />
            </IconButton>
          ) : null}
        </div>
      </div>
      {player ??
        (file.state.status === "ready" ? (
          <div ref={box}>
            <ToolbarSlot value={toolbar}>
              <Compact value={compact}>
                <Preview
                  preview={file.state.preview}
                  filename={value.filename}
                  labels={artifact}
                  app={app}
                  room={room}
                />
              </Compact>
            </ToolbarSlot>
          </div>
        ) : (
          // Each state still loading or refused names its own label.
          <Status>{artifact[file.state.status]}</Status>
        ))}
    </div>
  )
}
