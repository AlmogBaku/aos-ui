"use client"


import {
  memo,
  useState,
  useEffect,
  useRef,
  type PropsWithChildren,
} from "react"
import { cva, type VariantProps } from "class-variance-authority"
import {
  CopyIcon,
  DownloadIcon,
  ImageIcon,
  ImageOffIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react"
import type {
  ImageMessagePart,
  ImageMessagePartComponent,
} from "@assistant-ui/react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useToolUiLocale } from "@/components/tool-ui/locale"
import { cn } from "@/lib/utils"

const extensionForMimeType = (mimeType?: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png"
    case "image/jpeg":
    case "image/jpg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    case "image/svg+xml":
      return "svg"
    default:
      return "png"
  }
}

const dataUriToBlob = (dataUri: string): Blob => {
  const commaIndex = dataUri.indexOf(",")
  const meta = commaIndex >= 0 ? dataUri.slice(0, commaIndex) : dataUri
  const data = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : ""
  const mime =
    meta.match(/data:([^;]+)/i)?.[1]?.toLowerCase() ??
    "application/octet-stream"
  if (!/;base64/i.test(meta)) {
    const text = data.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq)
      } catch {
        return seq
      }
    })
    return new Blob([text], { type: mime })
  }
  const bytes = atob(data)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

const mimeFromImage = (image: string): string | undefined =>
  image.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase()

const downloadImagePart = (
  part: Pick<ImageMessagePart, "image" | "filename">
): void => {
  if (typeof document === "undefined") return
  const ext = extensionForMimeType(mimeFromImage(part.image))
  const filename = part.filename ?? `image.${ext}`
  const isDataUri = /^data:/i.test(part.image)
  const objectUrl = isDataUri
    ? URL.createObjectURL(dataUriToBlob(part.image))
    : null
  const href = objectUrl ?? part.image
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 40_000)
}

const copyImagePart = async (
  part: Pick<ImageMessagePart, "image">
): Promise<void> => {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error("Clipboard API is not available in this environment.")
  }
  const blob = /^data:/i.test(part.image)
    ? dataUriToBlob(part.image)
    : await fetch(part.image).then((r) => r.blob())
  const mime = mimeFromImage(part.image) ?? blob.type ?? "image/png"
  await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
}

const imageVariants = cva(
  "aui-image-root relative overflow-hidden rounded-lg",
  {
    variants: {
      variant: {
        outline: "border border-border",
        ghost: "",
        muted: "bg-muted/50",
      },
      size: {
        sm: "max-w-64",
        default: "max-w-96",
        lg: "max-w-[512px]",
        full: "w-full",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  }
)

export type ImageRootProps = React.ComponentProps<"div"> &
  VariantProps<typeof imageVariants>

function ImageRoot({
  className,
  variant,
  size,
  children,
  ...props
}: ImageRootProps) {
  return (
    <div
      data-slot="image-root"
      data-variant={variant}
      data-size={size}
      className={cn(imageVariants({ variant, size, className }))}
      {...props}
    >
      {children}
    </div>
  )
}

type ImagePreviewProps = Omit<React.ComponentProps<"img">, "children"> & {
  containerClassName?: string
}

function ImagePreview({
  className,
  containerClassName,
  onLoad,
  onError,
  alt,
  src,
  ...props
}: ImagePreviewProps) {
  const { labels } = useToolUiLocale()
  const imgRef = useRef<HTMLImageElement>(null)
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined)
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined)

  const loaded = loadedSrc === src
  const error = errorSrc === src

  useEffect(() => {
    if (
      typeof src === "string" &&
      imgRef.current?.complete &&
      imgRef.current.naturalWidth > 0
    ) {
      setLoadedSrc(src)
    }
  }, [src])

  return (
    <span
      data-slot="image-preview"
      className={cn("relative block min-h-32", containerClassName)}
    >
      {!loaded && !error && (
        <span
          data-slot="image-preview-loading"
          aria-live="polite"
          className="absolute inset-0 flex items-center justify-center bg-muted/50"
        >
          <ImageIcon className="size-8 animate-pulse text-muted-foreground motion-reduce:animate-none" />
          <span className="sr-only">{labels.assistant.imageLoading}</span>
        </span>
      )}
      {error ? (
        <span
          data-slot="image-preview-error"
          role="alert"
          className="flex min-h-32 items-center justify-center bg-muted/50 p-4"
        >
          <ImageOffIcon className="size-8 text-muted-foreground" />
          <span className="sr-only">{labels.assistant.imageLoadFailed}</span>
        </span>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt ?? labels.assistant.imageContent}
          className={cn(
            "block h-auto w-full object-contain",
            !loaded && "invisible",
            className
          )}
          onLoad={(e) => {
            if (typeof src === "string") setLoadedSrc(src)
            onLoad?.(e)
          }}
          onError={(e) => {
            if (typeof src === "string") setErrorSrc(src)
            onError?.(e)
          }}
          {...props}
        />
      )}
    </span>
  )
}

function ImageFilename({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  if (!children) return null

  return (
    <span
      data-slot="image-filename"
      className={cn(
        "block truncate px-2 py-1.5 text-xs text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

type ImageZoomProps = PropsWithChildren<{
  src: string
  alt?: string
}>

function ImageZoom({ src, alt, children }: ImageZoomProps) {
  const { labels } = useToolUiLocale()
  const resolvedAlt = alt ?? labels.assistant.imagePreview

  return (
    <Dialog>
      <DialogTrigger
        render={<button type="button" />}
        className="aui-image-zoom-trigger block w-full cursor-zoom-in appearance-none rounded-lg border-0 bg-transparent p-0 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
        aria-label={labels.assistant.zoomImage}
      >
        {children}
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        overlayClassName="aui-image-zoom-overlay bg-black/80 supports-backdrop-filter:backdrop-blur-sm"
        className="aui-image-zoom-dialog w-auto max-w-[calc(100%-2rem)] gap-0 rounded-xl bg-transparent p-0 ring-0 sm:max-w-[90vw]"
      >
        <DialogTitle className="sr-only">
          {labels.assistant.zoomedImage}
        </DialogTitle>
        <img
          data-slot="image-zoom-content"
          src={src}
          alt={resolvedAlt}
          className="aui-image-zoom-content max-h-[90dvh] max-w-[90vw] animate-in rounded-xl object-contain duration-200 zoom-in-95 fade-in motion-reduce:animate-none"
        />
        <DialogClose
          render={<button type="button" />}
          aria-label={labels.assistant.closeImage}
          className="absolute end-3 top-3 inline-flex size-9 cursor-pointer items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
        >
          <XIcon className="size-5" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  )
}

function ImageGenerating({ className }: { className?: string }) {
  const { labels } = useToolUiLocale()
  return (
    <div
      data-slot="image-generating"
      role="status"
      className={cn(
        "flex min-h-32 items-center justify-center bg-muted/50 p-4",
        className
      )}
    >
      <Loader2Icon className="size-8 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <span className="sr-only">{labels.assistant.generatingImage}</span>
    </div>
  )
}

function ImageContentFilterError({
  className,
  reason,
}: {
  className?: string
  reason?: string
}) {
  const { labels } = useToolUiLocale()
  return (
    <div
      data-slot="image-content-filter-error"
      className={cn(
        "flex min-h-32 flex-col items-center justify-center gap-2 bg-muted/50 p-4 text-center",
        className
      )}
    >
      <ShieldAlertIcon className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium">
        {labels.assistant.imageGenerationFailed}
      </p>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
    </div>
  )
}

export type ImageActionsProps = {
  part: ImageMessagePart
  /**
   * Wire to your own generation call to show a regenerate button. The button
   * renders only when this is set and the part carries a `prompt`.
   */
  onRegenerate?: () => void | Promise<void>
  className?: string
}

function RegenerateButton({
  onRegenerate,
}: {
  onRegenerate: () => void | Promise<void>
}) {
  const [isRegenerating, setIsRegenerating] = useState(false)
  const { labels } = useToolUiLocale()
  return (
    <button
      type="button"
      onClick={async () => {
        setIsRegenerating(true)
        try {
          await onRegenerate()
        } catch {
        } finally {
          setIsRegenerating(false)
        }
      }}
      disabled={isRegenerating}
      data-slot="image-regenerate"
      aria-label={
        isRegenerating
          ? labels.assistant.regeneratingImage
          : labels.assistant.regenerateImage
      }
      className="inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-muted disabled:opacity-50 motion-reduce:transition-none"
    >
      <RefreshCwIcon
        className={cn(
          "size-4",
          isRegenerating && "animate-spin motion-reduce:animate-none"
        )}
      />
    </button>
  )
}

function ImageActions({ part, onRegenerate, className }: ImageActionsProps) {
  const { labels } = useToolUiLocale()
  return (
    <div
      data-slot="image-actions"
      className={cn("flex items-center gap-1 p-1", className)}
    >
      <button
        type="button"
        onClick={() => downloadImagePart(part)}
        data-slot="image-download"
        aria-label={labels.assistant.downloadImage}
        className="inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-muted motion-reduce:transition-none"
      >
        <DownloadIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => {
          copyImagePart(part).catch(() => {})
        }}
        data-slot="image-copy"
        aria-label={labels.assistant.copyImage}
        className="inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-muted motion-reduce:transition-none"
      >
        <CopyIcon className="size-4" />
      </button>
      {onRegenerate && <RegenerateButton onRegenerate={onRegenerate} />}
    </div>
  )
}

const ImageImpl: ImageMessagePartComponent = (props) => {
  const { image, filename, status } = props
  const { labels } = useToolUiLocale()

  if (status?.type === "running") {
    return (
      <ImageRoot>
        <ImageGenerating />
        <ImageFilename>{filename}</ImageFilename>
      </ImageRoot>
    )
  }

  if (status?.type === "incomplete" && status.reason === "content-filter") {
    return (
      <ImageRoot>
        <ImageContentFilterError
          reason={labels.assistant.providerBlockedImage}
        />
      </ImageRoot>
    )
  }

  return (
    <ImageRoot>
      <ImageZoom src={image} alt={filename || labels.assistant.imageContent}>
        <ImagePreview
          src={image}
          alt={filename || labels.assistant.imageContent}
        />
      </ImageZoom>
      <ImageFilename>{filename}</ImageFilename>
    </ImageRoot>
  )
}

const Image = memo(ImageImpl) as unknown as ImageMessagePartComponent & {
  Root: typeof ImageRoot
  Preview: typeof ImagePreview
  Filename: typeof ImageFilename
  Zoom: typeof ImageZoom
  Actions: typeof ImageActions
  Generating: typeof ImageGenerating
  ContentFilterError: typeof ImageContentFilterError
}

Image.displayName = "Image"
Image.Root = ImageRoot
Image.Preview = ImagePreview
Image.Filename = ImageFilename
Image.Zoom = ImageZoom
Image.Actions = ImageActions
Image.Generating = ImageGenerating
Image.ContentFilterError = ImageContentFilterError

export {
  Image,
  ImageRoot,
  ImagePreview,
  ImageFilename,
  ImageZoom,
  ImageActions,
  ImageGenerating,
  ImageContentFilterError,
  imageVariants,
}
