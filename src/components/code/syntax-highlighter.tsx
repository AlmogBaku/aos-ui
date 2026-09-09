"use client"

import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown"
import { lazy, Suspense } from "react"

import { cn } from "@/lib/utils"

import { normalizeSyntaxLanguage } from "./syntax-language"

const ShikiCode = lazy(() =>
  import("./shiki-code").then((module) => ({ default: module.ShikiCode }))
)

type HighlightedCodeProps = Pick<
  SyntaxHighlighterProps,
  "code" | "language"
> & {
  className?: string
}

function CodeFallback({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto p-3.5 text-[13px] leading-relaxed">
      <code>{code}</code>
    </pre>
  )
}

export function HighlightedCode({
  code,
  language,
  className,
}: HighlightedCodeProps) {
  const normalizedLanguage = normalizeSyntaxLanguage(language)
  return (
    <div
      data-syntax-language={normalizedLanguage}
      className={cn(
        "overflow-hidden rounded-b-xl border border-t-0 border-border/50 bg-muted/30 text-start",
        className
      )}
      dir="ltr"
    >
      <Suspense fallback={<CodeFallback code={code} />}>
        <ShikiCode
          code={code}
          language={normalizedLanguage}
          className="bg-transparent"
        />
      </Suspense>
    </div>
  )
}

export function SyntaxHighlighter({ code, language }: SyntaxHighlighterProps) {
  return <HighlightedCode code={code} language={language} />
}
