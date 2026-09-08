"use client"

import "@assistant-ui/react-markdown/styles/dot.css"

import { MessagePartPrimitive, useAuiState } from "@assistant-ui/react"
import { lazy, Suspense, useState, type ComponentProps } from "react"

import { LazyVisualBoundary } from "@/components/tool-ui/lazy-boundary"
import { useToolUiLocale } from "@/components/tool-ui/locale"

const MarkdownText = lazy(() =>
  import("./markdown-text").then((module) => ({ default: module.MarkdownText }))
)

// This is a deliberately conservative plain-text fast path, not a Markdown
// parser. Any possible markup, GFM autolink, indented code or hard break uses
// the complete existing Markdown renderer.
function isPlainParagraphs(text: string) {
  return (
    /^[\p{L}\p{M}\p{N} ,.!?'’‘“”\n]*$/u.test(text) &&
    !/(?:^|\n) {4}| {2}\n|(?:^|\n) *\d+\.|\bwww\./i.test(text)
  )
}

function PlainParagraphs({ children, ...props }: ComponentProps<"div">) {
  if (typeof children !== "string") return null
  return (
    <div {...props} className="aui-md">
      {children
        .trim()
        .split(/\n *\n/)
        .filter(Boolean)
        .map((paragraph, index) => (
          <p
            key={index}
            className="aui-md-p my-3 leading-relaxed first:mt-0 last:mb-0"
          >
            {paragraph}
          </p>
        ))}
    </div>
  )
}

function TextDisplayFallback({ failed = false }: { failed?: boolean }) {
  const { direction, labels, locale } = useToolUiLocale()
  return (
    <div className="min-w-0" dir={direction} lang={locale}>
      <p
        className="text-sm text-muted-foreground"
        role={failed ? "alert" : "status"}
      >
        {failed
          ? labels.assistant.markdownUnavailable
          : labels.assistant.markdownLoading}
      </p>
      <MessagePartPrimitive.Text
        smooth={false}
        component="pre"
        dir="auto"
        className="font-sans leading-relaxed break-words whitespace-pre-wrap"
      />
    </div>
  )
}

export function MessageText() {
  const needsMarkdown = useAuiState((state) => {
    const part = state.part
    return (
      (part.type === "text" || part.type === "reasoning") &&
      !isPlainParagraphs(part.text)
    )
  })
  // Once syntax appears, keep the full renderer for this mounted part even if
  // the provider subsequently edits it back to plain text. Text and streaming
  // state stay owned by Assistant UI's native primitives.
  const [hasMarkdown, setHasMarkdown] = useState(needsMarkdown)
  if (needsMarkdown && !hasMarkdown) setHasMarkdown(true)
  const { labels } = useToolUiLocale()

  if (!hasMarkdown && !needsMarkdown) {
    return <MessagePartPrimitive.Text component={PlainParagraphs} />
  }
  return (
    <LazyVisualBoundary
      fallbackLabel={labels.assistant.markdownUnavailable}
      fallback={<TextDisplayFallback failed />}
    >
      <Suspense fallback={<TextDisplayFallback />}>
        {/* A newly mounted smooth cursor starts empty. Read the current native
            part directly on handoff so visible text is never replayed. */}
        <MarkdownText smooth={false} />
      </Suspense>
    </LazyVisualBoundary>
  )
}
