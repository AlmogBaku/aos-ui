import { describe, expect, it } from "vitest"

import { defaultLocale, getLocaleDirection, isLocale, locales } from "./config"
import { getDictionary } from "./get-dictionary"
import { runErrorMessage, type RunErrorCode } from "./run-errors"
import {
  getLocaleFromPathname,
  negotiateLocale,
  resolveLocale,
  stripLocaleFromPathname,
} from "./routing"

describe("locale configuration", () => {
  it("supports exactly the English and Hebrew workspace routes", () => {
    expect(locales).toEqual(["en", "he"])
    expect(defaultLocale).toBe("en")
    expect(isLocale("en")).toBe(true)
    expect(isLocale("he")).toBe(true)
    expect(isLocale("fr")).toBe(false)
  })

  it("assigns a first-class writing direction to each locale", () => {
    expect(getLocaleDirection("en")).toBe("ltr")
    expect(getLocaleDirection("he")).toBe("rtl")
  })
})

describe("locale routing", () => {
  it("recognizes locale-prefixed paths without matching partial segments", () => {
    expect(getLocaleFromPathname("/en/session")).toBe("en")
    expect(getLocaleFromPathname("/he")).toBe("he")
    expect(getLocaleFromPathname("/help")).toBeNull()
  })

  it("prefers a supported browser language and falls back to English", () => {
    expect(negotiateLocale("fr-CA, he-IL;q=0.9, en;q=0.8")).toBe("he")
    expect(negotiateLocale("he;q=0, en;q=0.5")).toBe("en")
    expect(negotiateLocale("fr;q=0.5, he;q=0")).toBe("en")
    expect(negotiateLocale("fr-FR, de;q=0.8")).toBe("en")
    expect(negotiateLocale(null)).toBe("en")
  })

  it("prefers a valid locale cookie over browser negotiation", () => {
    expect(resolveLocale("he", "en-US")).toBe("he")
    expect(resolveLocale("fr", "he-IL")).toBe("he")
  })

  it("strips only the legacy leading locale segment", () => {
    expect(stripLocaleFromPathname("/en")).toBe("/")
    expect(stripLocaleFromPathname("/he/agent/session")).toBe("/agent/session")
    expect(stripLocaleFromPathname("/help/en")).toBe("/help/en")
  })
})

describe("typed dictionaries", () => {
  it("loads complete, nonempty dictionaries for both supported locales", async () => {
    const english = await getDictionary("en")
    const hebrew = await getDictionary("he")

    const collectPaths = (value: unknown, prefix = ""): string[] => {
      if (typeof value === "string") return [prefix]
      if (!value || typeof value !== "object") return []
      return Object.entries(value).flatMap(([key, child]) =>
        collectPaths(child, prefix ? `${prefix}.${key}` : key)
      )
    }

    const englishPaths = collectPaths(english)
    const hebrewPaths = collectPaths(hebrew)
    expect(englishPaths.length).toBeGreaterThan(0)
    expect(hebrewPaths).toEqual(englishPaths)
    const collectLeaves = (value: unknown): string[] => {
      if (typeof value === "string") return [value]
      if (!value || typeof value !== "object") return []
      return Object.values(value).flatMap(collectLeaves)
    }
    expect(
      collectLeaves(english).every((value) => value.trim().length > 0)
    ).toBe(true)
    expect(
      collectLeaves(hebrew).every((value) => value.trim().length > 0)
    ).toBe(true)
  })

  it("provides complete artifact actions and states in both locales", async () => {
    const english = await getDictionary("en")
    const hebrew = await getDictionary("he")

    for (const key of Object.keys(english.artifacts)) {
      expect(english.artifacts[key as keyof typeof english.artifacts]).toEqual(
        expect.any(String)
      )
      expect(hebrew.artifacts[key as keyof typeof hebrew.artifacts]).toEqual(
        expect.any(String)
      )
    }
    expect(hebrew.artifacts).not.toEqual(english.artifacts)
  })
})

describe("run error messages", () => {
  it("localizes every public run error code in both locales", async () => {
    const english = await getDictionary("en")
    const hebrew = await getDictionary("he")

    expect(Object.keys(hebrew.runErrors)).toEqual(
      Object.keys(english.runErrors)
    )
    expect(Object.keys(english.runErrors)).toContain("AOS_RECONNECT_EXHAUSTED")
    for (const code of Object.keys(english.runErrors) as RunErrorCode[]) {
      expect(english.runErrors[code].trim().length).toBeGreaterThan(0)
      expect(hebrew.runErrors[code].trim().length).toBeGreaterThan(0)
      expect(hebrew.runErrors[code]).not.toBe(english.runErrors[code])
      expect(runErrorMessage(english, code, "proxy text")).toBe(
        english.runErrors[code]
      )
      expect(runErrorMessage(hebrew, code, "proxy text")).toBe(
        hebrew.runErrors[code]
      )
    }
  })

  it("names no provider slash command the browser cannot know exists", async () => {
    const english = await getDictionary("en")
    const hebrew = await getDictionary("he")

    for (const dictionary of [english, hebrew])
      for (const code of Object.keys(dictionary.runErrors) as RunErrorCode[])
        expect(dictionary.runErrors[code]).not.toMatch(/\/[A-Za-z]/u)
    expect(english.runErrors.AOS_PROVIDER_RETRYABLE_FAILURE).toBe(
      "The model provider returned an error for this turn. Retry, switch models, or continue in a new Session."
    )
    expect(hebrew.runErrors.AOS_PROVIDER_RETRYABLE_FAILURE).toBe(
      "ספק המודל החזיר שגיאה בפנייה הזו. נסו שוב, החליפו מודל, או המשיכו בשיחה חדשה."
    )
  })

  it("localizes the headline a failure named neither by code nor by text", async () => {
    const english = await getDictionary("en")
    const hebrew = await getDictionary("he")

    expect(english.turnFailed).toBe("This turn did not complete.")
    expect(hebrew.turnFailed).toBe("התור הזה לא הושלם.")
    // The generic headline is the fallback, so an unknown code keeps it.
    expect(runErrorMessage(hebrew, "AOS_NOT_A_CODE", hebrew.turnFailed)).toBe(
      hebrew.turnFailed
    )
  })

  it("keeps the proxy description for an unknown or absent run error code", async () => {
    const english = await getDictionary("en")

    expect(runErrorMessage(english, "AOS_NOT_A_CODE", "Proxy said this")).toBe(
      "Proxy said this"
    )
    expect(runErrorMessage(english, undefined, "Proxy said this")).toBe(
      "Proxy said this"
    )
    // An inherited object key is not a run error code.
    for (const inherited of ["constructor", "toString", "hasOwnProperty"])
      expect(runErrorMessage(english, inherited, "Proxy said this")).toBe(
        "Proxy said this"
      )
  })
})
