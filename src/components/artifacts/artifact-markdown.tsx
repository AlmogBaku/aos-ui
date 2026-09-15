import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { HighlightedCode } from "@/components/code/syntax-highlighter"
import { normalizeSyntaxLanguage } from "@/components/code/syntax-language"
import { cn } from "@/lib/utils"

const components = {
  h1: ({ className, ...props }) => (
    <h1
      dir="auto"
      className={cn(
        "mt-8 mb-3 scroll-m-20 text-start text-2xl font-semibold tracking-tight first:mt-0",
        className
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      dir="auto"
      className={cn(
        "mt-7 mb-3 scroll-m-20 border-b border-border/60 pb-2 text-start text-xl font-semibold first:mt-0",
        className
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      dir="auto"
      className={cn(
        "mt-6 mb-2 scroll-m-20 text-start text-lg font-semibold first:mt-0",
        className
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      dir="auto"
      className={cn(
        "mt-5 mb-2 scroll-m-20 text-start text-base font-semibold first:mt-0",
        className
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      dir="auto"
      className={cn(
        "mt-4 mb-1.5 text-start text-sm font-semibold first:mt-0",
        className
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      dir="auto"
      className={cn(
        "mt-4 mb-1.5 text-start text-sm font-medium text-muted-foreground first:mt-0",
        className
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      dir="auto"
      className={cn(
        "my-3 text-start leading-7 first:mt-0 last:mb-0",
        className
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      dir="auto"
      className={cn(
        "my-4 border-s-4 border-muted-foreground/25 ps-4 text-start text-muted-foreground",
        className
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      dir="auto"
      className={cn(
        "my-3 ms-6 list-disc text-start marker:text-muted-foreground [&>li]:mt-1",
        className
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      dir="auto"
      className={cn(
        "my-3 ms-6 list-decimal text-start marker:text-muted-foreground [&>li]:mt-1",
        className
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li
      dir="auto"
      className={cn("text-start leading-7", className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("my-6 border-muted-foreground/20", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border/70">
      <table
        className={cn("w-full border-collapse text-sm", className)}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      dir="auto"
      className={cn(
        "border-e border-b border-border/70 bg-muted px-3 py-2 text-start font-semibold last:border-e-0",
        className
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      dir="auto"
      className={cn(
        "border-e border-b border-border/70 px-3 py-2 text-start align-top last:border-e-0",
        className
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr className={cn("last:[&>td]:border-b-0", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong className={cn("font-semibold", className)} {...props} />
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const source = String(children)
    const code = source.replace(/\n$/u, "")
    const language = /(?:^|\s)language-([^\s]+)/u.exec(className ?? "")?.[1]

    if (language || source.endsWith("\n")) {
      return (
        <HighlightedCode
          code={code}
          language={normalizeSyntaxLanguage(language)}
          className="my-4 rounded-xl border-t"
        />
      )
    }

    return (
      <code
        dir="ltr"
        className={cn(
          "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] [unicode-bidi:isolate]",
          className
        )}
        {...props}
      >
        {children}
      </code>
    )
  },
  a: ({ href, className, ...props }) =>
    href && /^https?:\/\//u.test(href) ? (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "text-primary underline underline-offset-2 hover:text-primary/80",
          className
        )}
      />
    ) : (
      <span {...props} className={className} />
    ),
  img: ({ alt }) => <span>{alt ? `[${alt}]` : "[image]"}</span>,
} satisfies Components

export function ArtifactMarkdown({ source }: { source: string }) {
  return (
    <div className="aui-md rounded-xl bg-background p-6 text-sm leading-6 shadow-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
}
