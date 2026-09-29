import { describe, expect, it } from "vitest"

import { sessionPlatform } from "./session-platform"

describe("sessionPlatform", () => {
  it.each([
    ["buzz", "buzz"],
    ["whatsapp", "whatsapp"],
    ["whatsapp_cloud", "whatsapp"],
    ["slack", "slack"],
    ["telegram", "telegram"],
    ["email", "email"],
    ["discord", "discord"],
    // Case-insensitive
    ["BUZZ", "buzz"],
    ["WhatsApp", "whatsapp"],
    ["WHATSAPP_CLOUD", "whatsapp"],
  ] as const)(
    "maps %s to %s",
    (native, expected) => {
      expect(sessionPlatform(native)).toBe(expected)
    }
  )

  it.each([
    "aos-ui",
    "cli",
    "unknown-channel",
    "",
    "DISCORD_UNKNOWN",
  ])("returns undefined for unlisted string %s", (native) => {
    expect(sessionPlatform(native)).toBeUndefined()
  })

  it.each([undefined, null, 42, {}, []])("returns undefined for non-string %s", (native) => {
    expect(sessionPlatform(native)).toBeUndefined()
  })
})
