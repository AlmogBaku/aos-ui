import {
  Download,
  ExternalLink,
  PictureInPicture2,
  RotateCw,
} from "lucide-react"
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react"
import { z } from "zod"

import type { PresentArtifactResult } from "../../../shared/presentation/tools"
import {
  PREVIEW_LIMITS,
  type FilePreview,
  type PreviewLimits,
} from "./artifact/file"
import { Code } from "./artifact/code"
import { CopyButton } from "./artifact/copy-button"
import { CsvTable } from "./artifact/csv-table"
import { HtmlPreview } from "./artifact/html-preview"
import { Markdown } from "./artifact/markdown"
import { useRoom, type Room } from "./artifact/room"
import { useFile } from "./artifact/use-file"
import { ZoomPane } from "./artifact/zoom"
import type { ViewLabels } from "./locale"
import { cn } from "./ui/cn"
import { IconButton } from "./ui/icon-button"
import { Status } from "./ui/status"
import { ToolbarSlot } from "./ui/toolbar"
import { ViewTitle } from "./ui/view-title"
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
  pip,
}: {
  preview: FilePreview
  filename: string
  labels: ArtifactLabels
  app: ViewApp
  room: Room
  pip: boolean
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
          size={pip ? { height: room.height } : { maxHeight: room.height }}
        />
      )
    case "none":
      return <Status>{labels.noPreview}</Status>
  }
}

/** The height the view keeps to in its message when the host names none. */
const INLINE_HEIGHT = 480

/**
 * The height the host lets the view take in its message, which a page, an
 * image, or an HTML file fills, as the page's own preview gave one most of
 * the window.
 */
function inlineLimit(context: ViewProps<unknown>["context"]) {
  const dimensions = context?.containerDimensions
  return dimensions && "maxHeight" in dimensions && dimensions.maxHeight
    ? dimensions.maxHeight
    : INLINE_HEIGHT
}

/** What a press on a control or link does itself, rather than expand the view. */
const CONTROLS = "a, button, input, select, textarea, summary, [role='tab']"

/** Whether text in the view is selected, so a press may be ending a selection. */
function selecting() {
  return window.getSelection()?.isCollapsed === false
}

/**
 * The file `present_artifact` shows, read from the address the page grants in
 * `aos/files`. Download and Open in new tab hand the page that same address.
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
  const file = useFile(address, value.filename, value.mimeType, previewLimits)
  const pip = context?.displayMode === "pip"
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  // In the side panel the view fills it; in its message it keeps to the
  // height the host allows.
  const room = useRoom(
    root,
    box,
    pip ? undefined : inlineLimit(context),
    file.state.status === "ready"
  )
  const offersPip = context?.availableDisplayModes?.includes("pip") === true
  // A press that starts or ends inside a selection is reading, not asking.
  const selected = useRef(false)
  const expand = (event: MouseEvent) => {
    const pressedSelection = selected.current || selecting()
    selected.current = false
    if (!offersPip || pip || pressedSelection) return
    if ((event.target as Element).closest(CONTROLS)) return
    void app.requestDisplayMode({ mode: "pip" }).catch(ignore)
  }
  // In the side panel, Esc returns the view to its message, unless something
  // in the view used the key first.
  useEffect(() => {
    if (!pip) return
    const leave = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      void app.requestDisplayMode({ mode: "inline" }).catch(ignore)
    }
    window.addEventListener("keydown", leave)
    return () => window.removeEventListener("keydown", leave)
  }, [app, pip])
  return (
    <div ref={root} className={cn("flex flex-col gap-3 p-3", pip && "h-dvh")}>
      {/* The side panel names the file above the view, so the view does not. */}
      <div className="flex flex-wrap items-center gap-2">
        {pip ? null : (
          <div className="min-w-0 flex-1 basis-48 wrap-anywhere">
            <ViewTitle title={value.filename} />
          </div>
        )}
        <div ref={setToolbar} className="flex items-center empty:hidden" />
        {address === undefined ? null : (
          <div className="ms-auto flex items-center gap-1">
            {file.state.status === "ready" &&
            (file.state.preview.kind === "text" ||
              file.state.preview.kind === "html") ? (
              <CopyButton text={file.state.preview.text} labels={artifact} />
            ) : null}
            <IconButton label={artifact.refresh} onClick={file.refresh}>
              <RotateCw />
            </IconButton>
            <IconButton
              label={artifact.download}
              onClick={() =>
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
                  .catch(ignore)
              }
            >
              <Download />
            </IconButton>
            <IconButton
              label={artifact.open}
              onClick={() => void app.openLink({ url: address }).catch(ignore)}
            >
              <ExternalLink />
            </IconButton>
            {offersPip ? (
              <IconButton
                label={artifact.pip}
                pressed={pip}
                onClick={() =>
                  void app
                    .requestDisplayMode({ mode: pip ? "inline" : "pip" })
                    .catch(ignore)
                }
              >
                <PictureInPicture2 />
              </IconButton>
            ) : null}
          </div>
        )}
      </div>
      {context !== undefined && address === undefined ? (
        <Status>{artifact.unreachable}</Status>
      ) : file.state.status === "ready" ? (
        // A press on the preview opens the side panel; the Picture in picture
        // button does the same from the keyboard.
        <div
          ref={box}
          onPointerDown={() => {
            selected.current = selecting()
          }}
          onClick={expand}
        >
          <ToolbarSlot value={toolbar}>
            <Preview
              preview={file.state.preview}
              filename={value.filename}
              labels={artifact}
              app={app}
              room={room}
              pip={pip}
            />
          </ToolbarSlot>
        </div>
      ) : (
        // Each state still loading or refused names its own label.
        <Status>{artifact[file.state.status]}</Status>
      )}
    </div>
  )
}
