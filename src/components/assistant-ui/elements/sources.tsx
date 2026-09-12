import { ExternalLinkIcon, FileTextIcon } from "lucide-react"

export type SourceLabels = {
  openSource: string
  documentSource: string
}

const DEFAULT_LABELS: SourceLabels = {
  openSource: "Open source",
  documentSource: "Source document",
}

function getSafeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

function getSourceTitle(title: string | undefined, url: URL | null): string {
  return title?.trim() || url?.hostname || DEFAULT_LABELS.documentSource
}

type SourceProps =
  | {
      type: "source"
      sourceType: "url"
      id: string
      url: string
      title?: string
      labels?: Partial<SourceLabels>
    }
  | {
      type: "source"
      sourceType: "document"
      id: string
      title: string
      mediaType: string
      filename?: string
      labels?: Partial<SourceLabels>
    }

export const Source = ({ labels: labelOverrides, ...part }: SourceProps) => {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides }
  const url =
    part.sourceType === "url" && typeof part.url === "string"
      ? getSafeHttpUrl(part.url)
      : null
  const title = getSourceTitle(part.title, url)
  const fallbackLabel = `${labels.documentSource}: ${title}`
  const className =
    "aui-source inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-sm leading-5 text-muted-foreground"

  if (url) {
    return (
      <a
        className={`${className} hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        href={url.href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`${labels.openSource}: ${title}`}
      >
        <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{title}</span>
        <ExternalLinkIcon className="size-3 shrink-0" aria-hidden="true" />
      </a>
    )
  }

  return (
    <span className={className} aria-label={fallbackLabel} dir="auto">
      <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{title}</span>
    </span>
  )
}
