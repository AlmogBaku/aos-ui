import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import {
  createHighlighterCoreSync,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedToken,
} from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import githubDark from "shiki/themes/github-dark.mjs"
import githubLight from "shiki/themes/github-light.mjs"
import { Fragment, useEffect, useState, type CSSProperties } from "react"

import { GRAMMAR_RESOURCE_URI } from "../../../../shared/presentation/views"
import { normalizeSyntaxLanguage } from "../../../../shared/syntax-language"
import { cn } from "../ui/cn"
import type { ViewApp } from "../view"
import styles from "./code.module.css"

type Read = ViewApp["readServerResource"]

/**
 * The longest text the view colours. Each run of colour is an element of its
 * own, so a longer file shows as plain text, as it does while its grammar
 * loads.
 */
export const MAX_HIGHLIGHTED_CHARACTERS = 50_000

/** The language a fence or source type names, if the view highlights it. */
export function codeLanguage(name: string | undefined) {
  const language = normalizeSyntaxLanguage(name)
  return language === "text" ? undefined : language
}

let highlighter: HighlighterCore | undefined

/**
 * Starts with the themes and no grammar. Forgiving skips a grammar rule this
 * engine cannot compile, rather than fail the whole file; JavaScriptCore
 * needs it.
 */
function core() {
  highlighter ??= createHighlighterCoreSync({
    themes: [githubLight, githubDark],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return highlighter
}

function registration({ contents: [content] }: ReadResourceResult) {
  const grammar: unknown =
    content && "text" in content ? JSON.parse(content.text) : undefined
  if (
    typeof grammar !== "object" ||
    grammar === null ||
    !("name" in grammar) ||
    typeof grammar.name !== "string"
  )
    throw new Error(`No grammar came back for ${content?.uri}`)
  return grammar as LanguageRegistration
}

const grammars = new Map<string, Promise<string>>()

/**
 * Loads the grammar `name` from the server once, after the grammars it
 * embeds, and resolves to the name it highlights under. A grammar that fails
 * to load is asked for again next time.
 */
function load(name: string, read: Read): Promise<string> {
  let loading = grammars.get(name)
  if (!loading) {
    loading = read({ uri: `${GRAMMAR_RESOURCE_URI}${name}.json` }).then(
      async (result) => {
        const grammar = registration(result)
        await Promise.all(
          (grammar.embeddedLangs ?? []).map((embedded) => load(embedded, read))
        )
        core().loadLanguageSync(grammar)
        return grammar.name
      }
    )
    loading.catch(() => grammars.delete(name))
    grammars.set(name, loading)
  }
  return loading
}

function tokens(code: string, language: string): ThemedToken[][] {
  return core().codeToTokens(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  }).tokens
}

/**
 * Source text, coloured by its language for the view's theme once that
 * language's grammar loads; plain without a language, past `limit`, or when
 * the grammar cannot load. Each run of text is a React text node, so nothing
 * in the file becomes markup.
 */
export function Code({
  code,
  language,
  label,
  read,
  limit = MAX_HIGHLIGHTED_CHARACTERS,
  className,
  style,
}: {
  code: string
  language: string | undefined
  label?: string
  read: Read
  limit?: number
  className?: string
  style?: CSSProperties
}) {
  const [coloured, setColoured] = useState<{
    code: string
    language: string
    lines: ThemedToken[][]
  }>()
  const highlighted = language !== undefined && code.length <= limit
  useEffect(() => {
    if (!highlighted) return
    let cancelled = false
    load(language, read).then(
      (name) => {
        if (!cancelled)
          setColoured({ code, language, lines: tokens(code, name) })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [code, language, highlighted, read])
  const lines =
    highlighted && coloured?.code === code && coloured.language === language
      ? coloured.lines
      : undefined
  return (
    <pre
      dir="ltr"
      tabIndex={0}
      role="region"
      aria-label={label}
      className={cn(
        styles.code,
        "m-0 overflow-auto rounded-md bg-muted p-3 font-mono text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
      style={style}
    >
      <code>
        {lines
          ? lines.map((line, index) => (
              <Fragment key={index}>
                {index > 0 ? "\n" : null}
                {line.map((token, at) => (
                  <span key={at} style={token.htmlStyle}>
                    {token.content}
                  </span>
                ))}
              </Fragment>
            ))
          : code}
      </code>
    </pre>
  )
}
