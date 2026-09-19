"use client"

import "@assistant-ui/react-markdown/styles/dot.css"

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown"
import remarkGfm from "remark-gfm"
import { type FC, memo, useMemo } from "react"
import type { TextMessagePartProps } from "@assistant-ui/react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button"
import { SyntaxHighlighter } from "@/components/code/syntax-highlighter"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { cn } from "@/lib/utils"
import { useToolUiLocale } from "@/components/tool-ui/locale"

import { MermaidCodeHeader, MermaidDiagram } from "./mermaid-diagram"

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0]
  smooth?: boolean
}

const areComponentMapsShallowEqual = (
  previous: MarkdownTextProps["components"],
  current: MarkdownTextProps["components"]
) => {
  if (previous === current) return true
  if (previous === undefined || current === undefined) return false

  const previousKeys = Object.keys(previous) as Array<keyof typeof previous>
  const currentKeys = Object.keys(current) as Array<keyof typeof current>
  return (
    previousKeys.length === currentKeys.length &&
    currentKeys.every((key) => previous[key] === current[key])
  )
}

/**
 * The shared body type scale for conversation text, per DESIGN.md: one scale
 * for every message regardless of role. User and assistant turns both render
 * through `MarkdownText`, so this is its single owner; nothing else may set a
 * message font size.
 */
export const MESSAGE_BODY_TYPOGRAPHY =
  "text-base leading-7 @min-[64rem]/workspace:text-sm @min-[64rem]/workspace:leading-6"

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components, smooth }) => {
  const markdownComponents = useMemo(() => {
    if (!components) return defaultComponents
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(components),
    }
  }, [components])

  return (
    <MarkdownTextPrimitive
      smooth={smooth}
      remarkPlugins={[remarkGfm]}
      className={cn("aui-md", MESSAGE_BODY_TYPOGRAPHY)}
      components={markdownComponents}
      componentsByLanguage={componentsByLanguage}
      defer
    />
  )
}

export const MarkdownText = memo(
  MarkdownTextImpl,
  (previous, current) =>
    previous.smooth === current.smooth &&
    areComponentMapsShallowEqual(previous.components, current.components)
)

export const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const { labels } = useToolUiLocale()
  const onCopy = () => {
    if (!code || isCopied) return
    copyToClipboard(code)
  }

  return (
    <div className="aui-code-header-root mt-3 flex items-center justify-between rounded-t-xl border border-b-0 border-border/50 bg-muted/50 px-3.5 py-1.5 text-xs">
      <span className="aui-code-header-language font-medium text-muted-foreground lowercase">
        {language}
      </span>
      <TooltipIconButton
        tooltip={isCopied ? labels.common.copied : labels.assistant.copyCode}
        onClick={onCopy}
      >
        {!isCopied && (
          <CopyIcon className="animate-in duration-150 zoom-in-75 fade-in motion-reduce:animate-none" />
        )}
        {isCopied && (
          <CheckIcon className="animate-in duration-200 ease-out zoom-in-50 fade-in motion-reduce:animate-none" />
        )}
      </TooltipIconButton>
    </div>
  )
}

const componentsByLanguage = {
  mermaid: {
    CodeHeader: MermaidCodeHeader,
    SyntaxHighlighter: MermaidDiagram,
  },
}

const defaultComponents = memoizeMarkdownComponents({
  SyntaxHighlighter,
  h1: ({ className, ...props }) => (
    <h1
      dir="auto"
      className={cn(
        "aui-md-h1 mt-5 mb-2 scroll-m-20 text-start text-xl font-semibold first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      dir="auto"
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-start text-lg font-semibold first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      dir="auto"
      className={cn(
        "aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-start text-base font-semibold first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      dir="auto"
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-start text-base font-medium first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      dir="auto"
      className={cn(
        "aui-md-h5 mt-3 mb-1 text-start text-sm font-semibold first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      dir="auto"
      className={cn(
        "aui-md-h6 mt-3 mb-1 text-start text-sm font-medium first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      dir="auto"
      className={cn(
        "aui-md-p my-3 max-w-prose text-start leading-7 first:mt-0 last:mb-0 @min-[64rem]/workspace:my-2 @min-[64rem]/workspace:leading-6",
        className
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a text-primary underline underline-offset-2 hover:text-primary/80",
        className
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      dir="auto"
      className={cn(
        "aui-md-blockquote my-3 max-w-prose border-s-2 border-muted-foreground/30 ps-4 text-start text-muted-foreground @min-[64rem]/workspace:my-2",
        className
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      dir="auto"
      className={cn(
        "aui-md-ul my-3 ms-5 max-w-prose list-disc text-start marker:text-muted-foreground @min-[64rem]/workspace:my-2 [&>li]:mt-1",
        className
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      dir="auto"
      className={cn(
        "aui-md-ol my-3 ms-5 max-w-prose list-decimal text-start marker:text-muted-foreground @min-[64rem]/workspace:my-2 [&>li]:mt-1",
        className
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr my-3 border-muted-foreground/20", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <table
      className={cn(
        "aui-md-table my-3 w-full border-separate border-spacing-0 overflow-y-auto",
        className
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }) => (
    <th
      dir="auto"
      className={cn(
        "aui-md-th bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-end",
        className
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      dir="auto"
      className={cn(
        "aui-md-td border-s border-b border-muted-foreground/20 px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-end",
        className
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li
      dir="auto"
      className={cn(
        "aui-md-li text-start leading-7 @min-[64rem]/workspace:leading-6",
        className
      )}
      {...props}
    />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("aui-md-strong font-semibold", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      dir="ltr"
      className={cn(
        "aui-md-pre overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 border-border/50 bg-muted/30 p-3.5 text-start text-[13px] leading-relaxed",
        className
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock()
    return (
      <code
        dir="ltr"
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] [unicode-bidi:isolate]",
          className
        )}
        {...props}
      />
    )
  },
  CodeHeader,
})
