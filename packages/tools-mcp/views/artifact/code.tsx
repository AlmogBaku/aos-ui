import {
  createHighlighterCoreSync,
  type HighlighterCore,
  type ThemedToken,
} from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import css from "shiki/langs/css.mjs"
import json from "shiki/langs/json.mjs"
import python from "shiki/langs/python.mjs"
import rust from "shiki/langs/rust.mjs"
import shellscript from "shiki/langs/shellscript.mjs"
import tsx from "shiki/langs/tsx.mjs"
import yaml from "shiki/langs/yaml.mjs"
import githubDark from "shiki/themes/github-dark.mjs"
import githubLight from "shiki/themes/github-light.mjs"
import { Fragment, useMemo } from "react"

import styles from "./code.module.css"

/**
 * The grammars the view carries. Each costs its size in the view's document,
 * so TSX's one grammar reads JavaScript, TypeScript, and JSX as well.
 */
const LANGUAGES = { css, json, python, rust, shellscript, tsx, yaml }

export type CodeLanguage = keyof typeof LANGUAGES

/** A fenced block's language, by the names Markdown authors write. */
const ALIASES: Record<string, CodeLanguage> = {
  bash: "shellscript",
  css: "css",
  javascript: "tsx",
  js: "tsx",
  json: "json",
  jsx: "tsx",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  ts: "tsx",
  tsx: "tsx",
  typescript: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
}

export function codeLanguage(name: string | undefined) {
  return name === undefined ? undefined : ALIASES[name.toLowerCase()]
}

let highlighter: HighlighterCore | undefined

/**
 * Compiled on first use. Forgiving skips a grammar rule this engine cannot
 * compile, rather than fail the whole file; JavaScriptCore needs it.
 */
function tokens(code: string, language: CodeLanguage): ThemedToken[][] {
  highlighter ??= createHighlighterCoreSync({
    themes: [githubLight, githubDark],
    langs: Object.values(LANGUAGES),
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return highlighter.codeToTokens(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  }).tokens
}

/**
 * Source text, coloured by its language for the view's theme. Each run of
 * text is a React text node, so nothing in the file becomes markup.
 */
export function Code({
  code,
  language,
  label,
}: {
  code: string
  language: CodeLanguage
  label?: string
}) {
  const lines = useMemo(() => tokens(code, language), [code, language])
  return (
    <pre
      dir="ltr"
      tabIndex={0}
      role="region"
      aria-label={label}
      className={`${styles.code} m-0 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
    >
      <code>
        {lines.map((line, index) => (
          <Fragment key={index}>
            {index > 0 ? "\n" : null}
            {line.map((token, at) => (
              <span key={at} style={token.htmlStyle}>
                {token.content}
              </span>
            ))}
          </Fragment>
        ))}
      </code>
    </pre>
  )
}
