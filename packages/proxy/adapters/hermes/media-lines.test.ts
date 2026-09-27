import { describe, expect, it } from "vitest"

import {
  MAX_MEDIA_LINE_BYTES,
  MEDIA_UNAVAILABLE,
  MediaLineFilter,
  mediaReference,
} from "./media-lines"

function filtered(
  chunks: string[],
  claim: (reference: string) => boolean = () => true
) {
  const references: string[] = []
  const filter = new MediaLineFilter((reference) => {
    references.push(reference)
    return claim(reference)
  })
  const text =
    chunks.map((chunk) => filter.write(chunk)).join("") + filter.finish()
  return { text, references }
}

describe("mediaReference", () => {
  it.each([
    ["MEDIA:/tmp/a b.pdf", undefined],
    ["MEDIA:/tmp/out.pdf", "/tmp/out.pdf"],
    ["  MEDIA:  /tmp/out.pdf  ", "/tmp/out.pdf"],
    ["MEDIA:`/tmp/a b.pdf`", "/tmp/a b.pdf"],
    ['MEDIA:"/tmp/a b.pdf"', "/tmp/a b.pdf"],
    ["MEDIA:'/tmp/a b.pdf'", "/tmp/a b.pdf"],
    ["See MEDIA:/tmp/out.pdf", undefined],
  ])("reads %s", (line, expected) => {
    expect(mediaReference(line)).toBe(expected)
  })
})

describe("MediaLineFilter", () => {
  it("removes a claimed line and reports its reference", () => {
    expect(filtered(["Here it is.\nMEDIA:/tmp/out.pdf\nDone."])).toEqual({
      text: "Here it is.\nDone.",
      references: ["/tmp/out.pdf"],
    })
  })

  it("replaces an unclaimed line with the unavailable marker", () => {
    expect(filtered(["MEDIA:/tmp/out.pdf"], () => false).text).toBe(
      MEDIA_UNAVAILABLE
    )
  })

  it("reassembles a line split across chunks", () => {
    expect(
      filtered(["Ready.\nME", "DIA:", "/tmp/sp", "lit.pdf\nAfter."])
    ).toEqual({ text: "Ready.\nAfter.", references: ["/tmp/split.pdf"] })
  })

  it("releases a prefix that turns out to be prose", () => {
    expect(filtered(["MED", "ICINE is not media."]).text).toBe(
      "MEDICINE is not media."
    )
  })

  it("gives up on an overlong line without reporting it", () => {
    const result = filtered([
      `MEDIA:/tmp/${"a".repeat(MAX_MEDIA_LINE_BYTES)}`,
      "more",
      "\nAfter.",
    ])
    expect(result).toEqual({
      text: `${MEDIA_UNAVAILABLE}\nAfter.`,
      references: [],
    })
  })
})
