import { describe, expect, it } from "vitest"

import {
  normalizeSyntaxLanguage,
  syntaxLanguageFromFilename,
} from "./syntax-language"

describe("syntax languages", () => {
  it("normalizes common Markdown fence aliases", () => {
    expect(normalizeSyntaxLanguage("ts")).toBe("typescript")
    expect(normalizeSyntaxLanguage("sh")).toBe("bash")
    expect(normalizeSyntaxLanguage("plaintext")).toBe("text")
    expect(normalizeSyntaxLanguage("made-up-language")).toBe("text")
  })

  it("infers standalone artifact languages from filenames", () => {
    expect(syntaxLanguageFromFilename("component.tsx")).toBe("tsx")
    expect(syntaxLanguageFromFilename("worker.py")).toBe("python")
    expect(syntaxLanguageFromFilename("Dockerfile")).toBe("dockerfile")
    expect(syntaxLanguageFromFilename("notes.unknown")).toBe("text")
  })
})
