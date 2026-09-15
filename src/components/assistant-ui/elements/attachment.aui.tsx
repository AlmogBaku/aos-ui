"use client"

import {
  type PropsWithChildren,
  useEffect,
  useRef,
  useState,
  type FC,
  isValidElement,
} from "react"
import {
  XIcon,
  PlusIcon,
  FileText,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react"
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import { useAttachmentLabels } from "@/components/assistant-ui/elements/attachment-labels"
import { useAttachmentSrc } from "@/hooks/use-attachment-src"
import { cn } from "@/lib/utils"

type AttachmentPreviewProps = {
  src: string
}

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false)
  const labels = useAttachmentLabels()
  return (
    // Blob/data attachment previews require their natural dimensions.
    <img
      src={src}
      alt={labels.preview}
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain transition-opacity duration-300 motion-reduce:transition-none",
        isLoaded
          ? "aui-attachment-preview-image-loaded opacity-100"
          : "aui-attachment-preview-image-loading opacity-0"
      )}
      onLoad={() => setIsLoaded(true)}
    />
  )
}

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc()
  const labels = useAttachmentLabels()

  if (!src) return children

  return (
    <Dialog>
      <DialogTrigger
        nativeButton={false}
        className="aui-attachment-preview-trigger cursor-zoom-in"
        render={
          isValidElement(children) ? (
            children
          ) : (
            <button type="button">{children}</button>
          )
        }
      />
      <DialogContent className="aui-attachment-preview-dialog-content p-2 sm:max-w-3xl [&_svg]:text-background [&>button]:rounded-full [&>button]:bg-foreground/60 [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0! [&>button]:hover:bg-foreground/80">
        <DialogTitle className="aui-sr-only sr-only">
          {labels.preview}
        </DialogTitle>
        <div className="aui-attachment-preview relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm bg-background">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc()
  const labels = useAttachmentLabels()

  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none after:hidden">
      <AvatarImage
        src={src}
        alt={labels.preview}
        className="aui-attachment-tile-image rounded-none object-cover"
      />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon size-6 stroke-[1.5] text-muted-foreground/80" />
      </AvatarFallback>
    </Avatar>
  )
}

const AttachmentUI: FC = () => {
  const aui = useAui()
  const labels = useAttachmentLabels()
  const isComposer = aui.attachment.source !== "message"

  const isImage = useAuiState((s) => s.attachment.type === "image")
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type
    switch (type) {
      case "image":
        return labels.image
      case "document":
        return labels.document
      case "file":
        return labels.file
      default:
        return type
    }
  })

  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "running"
      ? "uploading"
      : s.attachment.status.type === "incomplete" &&
          s.attachment.status.reason === "error"
        ? "error"
        : undefined
  )
  const isUploading = uploadState === "uploading"
  const isError = uploadState === "error"

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? labels.uploadFailed)
      : undefined
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <AttachmentPrimitive.Root
          className={cn(
            "aui-attachment-root relative",
            isComposer &&
              "animate-in duration-200 fade-in-0 zoom-in-95 motion-reduce:animate-none",
            isImage &&
              !isComposer &&
              "aui-attachment-root-message only:*:first:size-24"
          )}
        >
          <AttachmentPreviewDialog>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    "aui-attachment-tile relative size-14 cursor-pointer overflow-hidden rounded-[calc(var(--composer-radius,1.5rem)-var(--composer-padding,8px))] bg-muted transition-transform outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:transition-colors after:ring-inset hover:after:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring/50 active:scale-[0.96] motion-reduce:transition-none dark:after:ring-white/10",
                    isError &&
                      "after:ring-destructive/60 dark:after:ring-destructive/60"
                  )}
                  role="button"
                  tabIndex={0}
                  aria-label={`${typeLabel}${
                    isError
                      ? `, ${labels.uploadFailed}`
                      : isUploading
                        ? `, ${labels.uploading}`
                        : ""
                  }`}
                />
              }
            >
              <AttachmentThumb />
              {isUploading && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-uploading absolute inset-0 flex animate-in items-center justify-center bg-background/60 backdrop-blur-[2px] fade-in-0 motion-reduce:animate-none"
                >
                  <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {isError && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-error absolute inset-0 flex animate-in items-center justify-center bg-background/70 backdrop-blur-[2px] fade-in-0 motion-reduce:animate-none"
                >
                  <AlertCircleIcon className="size-4 text-destructive" />
                </div>
              )}
            </TooltipTrigger>
          </AttachmentPreviewDialog>
          {isComposer && <AttachmentRemove />}
        </AttachmentPrimitive.Root>
        <TooltipContent side="top">
          <AttachmentPrimitive.Name />
          {errorMessage && (
            <p className="aui-attachment-error-message">{errorMessage}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const AttachmentRemove: FC = () => {
  const labels = useAttachmentLabels()
  return (
    <AttachmentPrimitive.Remove
      render={
        <TooltipIconButton
          tooltip={labels.remove}
          className="aui-attachment-tile-remove absolute end-1 top-1 size-5 rounded-full bg-black/50! text-white after:absolute after:-inset-1.5 hover:bg-black/70! hover:text-white! active:scale-[0.96] motion-reduce:transition-none"
          side="top"
        />
      }
    >
      <XIcon className="aui-attachment-remove-icon size-3 stroke-[2.5]" />
    </AttachmentPrimitive.Remove>
  )
}

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  )
}

export const ComposerAttachments: FC = () => {
  const root = useRef<HTMLDivElement>(null)
  const count = useAuiState((s) => s.composer.attachments.length)
  const previousCount = useRef(count)
  useEffect(() => {
    const added = count > previousCount.current
    previousCount.current = count
    if (!added || document.visibilityState === "hidden") return
    root.current
      ?.closest('[data-slot="aui_composer-shell"]')
      ?.querySelector<HTMLTextAreaElement>("textarea:not([aria-hidden=true])")
      ?.focus({ preventScroll: true })
  }, [count])
  return (
    <div
      ref={root}
      className="aui-composer-attachments col-span-full row-start-1 flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden"
    >
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  )
}

export const ComposerAddAttachment: FC = () => {
  const labels = useAttachmentLabels()
  const dictating = useAuiState((s) => s.composer.dictation != null)
  return (
    <ComposerPrimitive.AddAttachment
      disabled={dictating}
      render={
        <TooltipIconButton
          tooltip={labels.add}
          side="bottom"
          variant="ghost"
          size="icon"
          className="aui-composer-add-attachment relative size-11 shrink-0 rounded-full bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground active:scale-[0.96] motion-reduce:transition-none @min-[64rem]/workspace:size-8 @min-[64rem]/workspace:hover:bg-muted-foreground/15 dark:hover:bg-transparent @min-[64rem]/workspace:dark:hover:bg-muted-foreground/30"
          aria-label={labels.add}
        />
      }
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground/[0.04] @min-[64rem]/workspace:size-auto @min-[64rem]/workspace:bg-transparent dark:bg-foreground/[0.06] @min-[64rem]/workspace:dark:bg-transparent">
        <PlusIcon className="aui-attachment-add-icon size-4" />
      </span>
    </ComposerPrimitive.AddAttachment>
  )
}
