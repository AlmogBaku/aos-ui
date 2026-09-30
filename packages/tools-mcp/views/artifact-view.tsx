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
import { useFile } from "./artifact/use-file"
import type { ViewLabels } from "./locale"
import { IconButton } from "./ui/icon-button"
import { Status } from "./ui/status"
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

function ImagePreview({
  url,
  name,
  fallback,
}: {
  url: string
  name: string
  fallback: string
}) {
  const [broken, setBroken] = useState(false)
  if (broken) return <Status>{fallback}</Status>
  return (
    <img
      src={url}
      alt={name}
      className="max-h-96 max-w-full rounded-md object-contain"
      onError={() => setBroken(true)}
    />
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

function TextPreview({
  preview,
  filename,
  labels,
  openLink,
}: {
  preview: Extract<FilePreview, { kind: "text" }>
  filename: string
  labels: ArtifactLabels
  openLink: ViewApp["openLink"]
}) {
  switch (preview.format) {
    case "markdown":
      return (
        <Markdown source={preview.text} label={filename} openLink={openLink} />
      )
    case "csv":
      return (
        <CsvTable
          text={preview.text}
          label={filename}
          truncatedLabel={labels.csvTruncated}
        />
      )
    case "json":
      return (
        <Code
          code={prettyJson(preview.text)}
          language="json"
          label={filename}
        />
      )
    case "code":
      return (
        <Code
          code={preview.text}
          language={preview.language}
          label={filename}
        />
      )
    case "plain":
      return (
        <pre
          dir="auto"
          tabIndex={0}
          role="region"
          aria-label={filename}
          className="m-0 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
}: {
  preview: FilePreview
  filename: string
  labels: ArtifactLabels
  app: ViewApp
}) {
  switch (preview.kind) {
    case "pdf":
      return (
        <Suspense fallback={<Status>{labels.loading}</Status>}>
          <PdfPreview
            blob={preview.blob}
            read={app.readServerResource}
            labels={labels}
          />
        </Suspense>
      )
    case "image":
      return (
        <ImagePreview
          url={preview.url}
          name={filename}
          fallback={labels.noPreview}
        />
      )
    case "html":
      return <HtmlPreview text={preview.text} labels={labels} />
    case "text":
      return (
        <TextPreview
          preview={preview}
          filename={filename}
          labels={labels}
          openLink={app.openLink}
        />
      )
    case "none":
      return <Status>{labels.noPreview}</Status>
  }
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
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 wrap-anywhere">
          <ViewTitle title={value.filename} />
        </div>
        {address === undefined ? null : (
          <div className="flex items-center gap-1">
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
          onPointerDown={() => {
            selected.current = selecting()
          }}
          onClick={expand}
        >
          <Preview
            preview={file.state.preview}
            filename={value.filename}
            labels={artifact}
            app={app}
          />
        </div>
      ) : (
        // Each state still loading or refused names its own label.
        <Status>{artifact[file.state.status]}</Status>
      )}
    </div>
  )
}
