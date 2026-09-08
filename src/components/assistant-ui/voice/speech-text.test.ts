import { describe, expect, it } from "vitest"
import { projectSpeechText } from "./speech-text"

describe("speech text projection", () => {
  it("reads prose and lists while preserving link labels and inline code", () => {
    expect(
      projectSpeechText(
        "# Result\n\n**Hello** [world](https://private.test/path).\n\n- First\n- Run `check`\n",
        "en"
      )
    ).toBe("Result\n\nHello world.\n\nFirst\nRun check")
  })
  it.each(["en", "he"] as const)(
    "uses localized cues instead of speaking code or tables in %s",
    (locale) => {
      const text =
        "Before.\n\n```js\nsecretToolPayload()\n```\n\n| Private | Values |\n| --- | --- |\n| data | 99 |\n\nAfter."
      const speech = projectSpeechText(text, locale)
      expect(speech).not.toContain("secretToolPayload")
      expect(speech).not.toContain("Private")
      expect(speech).toContain(
        locale === "he"
          ? "קטע קוד מופיע בהודעה."
          : "Code block shown in the message."
      )
      expect(speech).toContain(
        locale === "he" ? "טבלה מופיעה בהודעה." : "Table shown in the message."
      )
      expect(speech.endsWith("After.")).toBe(true)
    }
  )
  it("does not speak HTML, image URLs or definition targets", () => {
    expect(
      projectSpeechText(
        "Visible [label][id].\n\n![image](https://hidden.test)\n\n[id]: https://hidden.test\n\n<script>secret</script>",
        "en"
      )
    ).toBe("Visible label.")
  })
  it("keeps long responses complete without client truncation or chunking", () => {
    const text = "A long sentence. ".repeat(2000) + "Final sentence."
    expect(projectSpeechText(text, "en")).toBe(text)
  })
})
