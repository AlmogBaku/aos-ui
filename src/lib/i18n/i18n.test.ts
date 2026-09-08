import { describe, expect, it } from "vitest"

import { defaultLocale, getLocaleDirection, isLocale, locales } from "./config"
import { getDictionary } from "./get-dictionary"
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
  it("loads localized workspace chrome for both supported locales", async () => {
    const english = await getDictionary("en")
    const hebrew = await getDictionary("he")

    expect(english.workspace.agents).toBe("Agents")
    expect(hebrew.workspace.agents).toBe("סוכנים")
    expect(hebrew.workspace.sessions).not.toBe(english.workspace.sessions)
    expect(hebrew.status.waitingForInput).not.toBe(
      english.status.waitingForInput
    )
    expect(english.workspace.fixtureLabel).toBe("Demo workspace")
    expect(hebrew.workspace.fixtureLabel).toBe("סביבת הדגמה")
  })
})
