"use client"

import ShikiHighlighter, { type PreloadLanguage } from "react-shiki/web"

import { cn } from "@/lib/utils"

import { normalizeSyntaxLanguage } from "./syntax-language"

const EXTRA_LANGUAGE_LOADERS: Readonly<Record<string, PreloadLanguage>> = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  makefile: () => import("@shikijs/langs/makefile"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
}

export function ShikiCode({
  code,
  language,
  className,
}: {
  code: string
  language?: string
  className?: string
}) {
  const normalizedLanguage = normalizeSyntaxLanguage(language)
  const extraLanguage = EXTRA_LANGUAGE_LOADERS[normalizedLanguage]
  return (
    <ShikiHighlighter
      language={normalizedLanguage}
      preloadLanguages={extraLanguage}
      theme={{ light: "github-light", dark: "github-dark" }}
      defaultColor="light-dark()"
      engine="javascript"
      addDefaultStyles={false}
      showLanguage={false}
      className={cn(
        "min-w-0 overflow-x-auto text-[13px] leading-relaxed [&_code]:font-mono [&_pre]:min-w-max [&_pre]:bg-transparent! [&_pre]:p-3.5",
        className
      )}
    >
      {code}
    </ShikiHighlighter>
  )
}
