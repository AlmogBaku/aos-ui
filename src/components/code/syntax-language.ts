const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cjs: "javascript",
  js: "javascript",
  mjs: "javascript",
  mts: "typescript",
  plaintext: "text",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  text: "text",
  ts: "typescript",
  yml: "yaml",
}

const SUPPORTED_LANGUAGES = new Set([
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "dockerfile",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "kotlin",
  "makefile",
  "markdown",
  "mdx",
  "php",
  "python",
  "ruby",
  "rust",
  "sql",
  "swift",
  "text",
  "toml",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
])

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
}

export function normalizeSyntaxLanguage(language: string | undefined) {
  const normalized = language?.trim().toLowerCase() || "text"
  const aliased = LANGUAGE_ALIASES[normalized] ?? normalized
  return SUPPORTED_LANGUAGES.has(aliased) ? aliased : "text"
}

export function syntaxLanguageFromFilename(filename: string) {
  const basename = filename.split(/[\\/]/u).at(-1)?.toLowerCase() ?? ""
  if (basename === "dockerfile") return "dockerfile"
  if (basename === "makefile") return "makefile"
  const extension = basename.includes(".") ? basename.split(".").at(-1) : ""
  return (extension && EXTENSION_LANGUAGES[extension]) || "text"
}
