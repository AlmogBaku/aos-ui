"use client"

import { useAuiState } from "@assistant-ui/react"
import type {
  CodeHeaderProps,
  SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown"
import { ChevronDown, LoaderCircle } from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useId, useRef, useState, type FC } from "react"

import { CopyButton } from "@/components/tool-ui/common"
import { useToolUiLocale } from "@/components/tool-ui/locale"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { sanitizeMermaidSvg } from "./mermaid-sanitize"

export const MERMAID_MAX_SOURCE_CHARS = 20_000
export const MERMAID_MAX_SOURCE_LINES = 400
const MERMAID_MAX_EDGES = 300

function countSourceLines(source: string) {
  if (source.length === 0) return 0

  const lineBreakCount = source.match(/\r\n|\r|\n/g)?.length ?? 0
  // A trailing line break terminates the last line without adding an empty one.
  const hasTrailingLineBreak = /(?:\r\n|\r|\n)$/.test(source)
  return lineBreakCount + (hasTrailingLineBreak ? 0 : 1)
}

type DiagramState =
  | { phase: "ready"; source: string; theme: "dark" | "default"; svg: string }
  | { phase: "failed"; source: string; theme: "dark" | "default" }

const mermaidLabels = {
  en: {
    diagram: "Mermaid diagram",
    rendering: "Rendering diagram…",
    failed: "Diagram could not be rendered.",
    tooLarge: "Diagram source is too large to render safely.",
    viewSource: "View diagram source",
    hideSource: "Hide diagram source",
    source: "Diagram source",
    copySource: "Copy diagram source",
  },
  he: {
    diagram: "תרשים Mermaid",
    rendering: "התרשים נטען…",
    failed: "לא ניתן להציג את התרשים.",
    tooLarge: "מקור התרשים גדול מדי להצגה בטוחה.",
    viewSource: "הצגת מקור התרשים",
    hideSource: "הסתרת מקור התרשים",
    source: "מקור התרשים",
    copySource: "העתקת מקור התרשים",
  },
} as const

let mermaidRenderQueue = Promise.resolve()

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const pending = mermaidRenderQueue.then(task, task)
  mermaidRenderQueue = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}

function SourcePanel({ code }: { code: string }) {
  const { locale } = useToolUiLocale()
  const labels = mermaidLabels[locale]

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {labels.source}
        </span>
        <CopyButton value={code} label={labels.copySource} />
      </div>
      <pre
        className="max-h-72 overflow-auto p-3 text-start font-mono text-xs leading-relaxed text-foreground"
        dir="ltr"
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

export const MermaidCodeHeader: FC<CodeHeaderProps> = () => null

export function MermaidDiagram({ code }: SyntaxHighlighterProps) {
  const partStatus = useAuiState((state) => state.part.status.type)
  const { locale, direction } = useToolUiLocale()
  const labels = mermaidLabels[locale]
  const { forcedTheme, resolvedTheme } = useTheme()
  const renderTheme =
    forcedTheme === "dark" ||
    (forcedTheme !== "light" && resolvedTheme === "dark")
      ? "dark"
      : "default"
  const renderId = `mermaid-${useId().replace(/:/g, "")}`
  const revisionRef = useRef(0)
  const [openSourceKey, setOpenSourceKey] = useState<string | null>(null)
  const [diagram, setDiagram] = useState<DiagramState | null>(null)
  const tooLarge =
    code.length > MERMAID_MAX_SOURCE_CHARS ||
    countSourceLines(code) > MERMAID_MAX_SOURCE_LINES

  useEffect(() => {
    const revision = ++revisionRef.current
    let active = true

    if (partStatus !== "complete" || tooLarge) {
      return () => {
        active = false
      }
    }

    void enqueueMermaidRender(async () => {
      const { default: mermaid } = await import("mermaid")

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
        maxTextSize: MERMAID_MAX_SOURCE_CHARS,
        maxEdges: MERMAID_MAX_EDGES,
        secure: [
          "secure",
          "securityLevel",
          "startOnLoad",
          "suppressErrorRendering",
          "htmlLabels",
          "maxTextSize",
          "maxEdges",
          "theme",
        ],
        theme: renderTheme,
      })

      const result = await mermaid.render(renderId, code)
      return sanitizeMermaidSvg(result.svg)
    }).then(
      (svg) => {
        if (active && revisionRef.current === revision) {
          setDiagram({
            phase: "ready",
            source: code,
            theme: renderTheme,
            svg,
          })
        }
      },
      () => {
        if (active && revisionRef.current === revision) {
          setDiagram({ phase: "failed", source: code, theme: renderTheme })
        }
      }
    )

    return () => {
      active = false
    }
  }, [code, partStatus, renderId, renderTheme, tooLarge])

  const sourceKey = `${renderTheme}\0${code}`
  const isCurrentDiagram =
    diagram?.source === code && diagram.theme === renderTheme
  const phase =
    partStatus === "running"
      ? "waiting"
      : partStatus === "incomplete"
        ? "failed"
        : tooLarge
          ? "too-large"
          : isCurrentDiagram
            ? diagram.phase
            : "loading"
  const sourceOpen = openSourceKey === sourceKey
  const sourceIsForced = phase !== "ready"
  const showSource = sourceIsForced || sourceOpen

  return (
    <section
      className="my-3 flex max-w-2xl flex-col gap-3 rounded-xl border border-border/60 bg-card p-3.5 text-card-foreground"
      dir={direction}
      lang={locale}
      aria-busy={phase === "loading" || phase === "waiting"}
    >
      {phase === "loading" || phase === "waiting" ? (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle
            className="size-4 motion-safe:animate-spin"
            aria-hidden="true"
          />
          {labels.rendering}
        </div>
      ) : null}

      {phase === "failed" || phase === "too-large" ? (
        <p className="text-sm text-destructive" role="alert">
          {phase === "too-large" ? labels.tooLarge : labels.failed}
        </p>
      ) : null}

      {phase === "ready" && diagram?.phase === "ready" ? (
        <div
          className="overflow-auto rounded-lg bg-background p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          role="img"
          aria-label={labels.diagram}
          dir="ltr"
          dangerouslySetInnerHTML={{ __html: diagram.svg }}
        />
      ) : null}

      {phase === "ready" ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="w-fit text-muted-foreground"
          aria-expanded={sourceOpen}
          onClick={() => setOpenSourceKey(sourceOpen ? null : sourceKey)}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "transition-transform motion-reduce:transition-none",
              sourceOpen && "rotate-180"
            )}
          />
          {sourceOpen ? labels.hideSource : labels.viewSource}
        </Button>
      ) : null}

      {showSource ? <SourcePanel code={code} /> : null}
    </section>
  )
}
