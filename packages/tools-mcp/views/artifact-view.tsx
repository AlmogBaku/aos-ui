import {
  Download,
  ExternalLink,
  PictureInPicture2,
  RotateCw,
} from "lucide-react"
import { lazy, Suspense, useEffect, useState } from "react"
import { z } from "zod"

import type { PresentArtifactResult } from "../../../shared/presentation/tools"
import {
  PREVIEW_LIMITS,
  type FilePreview,
  type PreviewLimits,
} from "./artifact/file"
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

function Preview({
  preview,
  filename,
  labels,
  read,
}: {
  preview: FilePreview
  filename: string
  labels: ArtifactLabels
  read: ViewApp["readServerResource"]
}) {
  switch (preview.kind) {
    case "pdf":
      return (
        <Suspense fallback={<Status>{labels.loading}</Status>}>
          <PdfPreview blob={preview.blob} read={read} labels={labels} />
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
      // An empty sandbox runs none of the file's scripts and gives it an
      // opaque origin, so it reaches neither this view nor the page.
      return (
        <iframe
          sandbox=""
          srcDoc={preview.text}
          title={labels.htmlTitle}
          className="h-96 w-full rounded-md border bg-white"
        />
      )
    case "text":
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
    case "none":
      return <Status>{labels.noPreview}</Status>
  }
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
            {context?.availableDisplayModes?.includes("pip") ? (
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
        <Preview
          preview={file.state.preview}
          filename={value.filename}
          labels={artifact}
          read={app.readServerResource}
        />
      ) : (
        // Each state still loading or refused names its own label.
        <Status>{artifact[file.state.status]}</Status>
      )}
    </div>
  )
}
