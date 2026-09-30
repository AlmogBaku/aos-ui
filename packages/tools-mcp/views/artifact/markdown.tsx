import { useMemo, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import type { ViewApp } from "../view"
import { Code, codeLanguage } from "./code"

function ignore() {}

const HEADING = "mt-5 mb-2 text-start font-semibold first:mt-0"

/** An element that keeps only its children, in the direction they read. */
function text(
  Tag:
    | "h1"
    | "h2"
    | "h3"
    | "h4"
    | "h5"
    | "h6"
    | "p"
    | "blockquote"
    | "ul"
    | "li"
    | "th"
    | "td",
  className: string
) {
  return function Text({ children }: { children?: ReactNode }) {
    return (
      <Tag dir="auto" className={className}>
        {children}
      </Tag>
    )
  }
}

/**
 * Markdown laid out by the view. Raw HTML in the file stays out, and images
 * show only their alt text, since the view loads nothing by address. A web
 * link opens through the page, so it never moves this frame.
 */
function components(openLink: ViewApp["openLink"]): Components {
  return {
    h1: text("h1", `${HEADING} text-xl`),
    h2: text("h2", `${HEADING} text-lg`),
    h3: text("h3", `${HEADING} text-base`),
    h4: text("h4", `${HEADING} text-sm`),
    h5: text("h5", `${HEADING} text-sm`),
    h6: text("h6", `${HEADING} text-sm text-muted-foreground`),
    p: text("p", "my-3 text-start first:mt-0 last:mb-0"),
    blockquote: text(
      "blockquote",
      "my-3 ms-0 border-s-4 ps-4 text-start text-muted-foreground"
    ),
    ul: text("ul", "my-3 list-disc ps-6 text-start"),
    ol: ({ start, children }) => (
      <ol
        dir="auto"
        start={start}
        className="my-3 list-decimal ps-6 text-start"
      >
        {children}
      </ol>
    ),
    li: text("li", "mt-1 text-start"),
    th: text("th", "border-b bg-muted px-3 py-2 text-start font-medium"),
    td: text("td", "border-b px-3 py-2 text-start align-top"),
    hr: () => <hr className="my-5 border-t" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const source = String(children)
      const name = /(?:^|\s)language-(\S+)/u.exec(className ?? "")?.[1]
      if (name === undefined && !source.endsWith("\n"))
        return (
          <code
            dir="ltr"
            className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs"
          >
            {children}
          </code>
        )
      const code = source.replace(/\n$/u, "")
      const language = codeLanguage(name)
      return language ? (
        <div className="my-3">
          <Code code={code} language={language} />
        </div>
      ) : (
        <pre
          dir="ltr"
          className="my-3 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
        >
          {code}
        </pre>
      )
    },
    a: ({ href, children }) =>
      href && /^https?:\/\//iu.test(href) ? (
        <a
          href={href}
          className="text-primary underline underline-offset-2"
          onClick={(event) => {
            event.preventDefault()
            void openLink({ url: href }).catch(ignore)
          }}
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
    img: ({ alt }) => <span>{alt ? `[${alt}]` : "[image]"}</span>,
  }
}

export function Markdown({
  source,
  label,
  openLink,
}: {
  source: string
  label: string
  openLink: ViewApp["openLink"]
}) {
  const parts = useMemo(() => components(openLink), [openLink])
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={label}
      className="max-h-96 overflow-auto rounded-md bg-muted/40 p-4 text-sm leading-6 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={parts}>
        {source}
      </ReactMarkdown>
    </div>
  )
}
