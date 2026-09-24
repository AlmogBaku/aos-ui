import { describe, expect, it } from "vitest"

import {
  extractArtifactOccurrences,
  parseArtifactDescriptor,
} from "./artifacts"

describe("parseArtifactDescriptor", () => {
  it.each([
    [
      "an inline UTF-8",
      {
        id: "report",
        filename: "report.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        source: { type: "inline", encoding: "utf8", data: "hello world!" },
      },
    ],
    [
      "an inline base64",
      {
        id: "image",
        filename: "image.png",
        source: { type: "inline", encoding: "base64", data: "iVBORw0KGgo=" },
      },
    ],
    [
      "an HTTPS",
      {
        id: "export",
        filename: "export.csv",
        source: { type: "url", url: "https://files.example.com/export.csv" },
      },
    ],
    [
      "an HTTP",
      {
        id: "local-export",
        filename: "export.csv",
        source: { type: "url", url: "http://localhost:3001/export.csv" },
      },
    ],
    [
      "an opaque provider-reference",
      {
        id: "native-output",
        filename: "analysis.pdf",
        source: { type: "provider", reference: "file_01J9ABC" },
      },
    ],
  ])("accepts %s artifact descriptor", (_label, descriptor) => {
    expect(parseArtifactDescriptor(descriptor)).toEqual(descriptor)
  })

  it("rejects descriptors with empty identities", () => {
    const source = { type: "inline", encoding: "utf8", data: "content" }

    expect([
      parseArtifactDescriptor({ id: "", filename: "report.txt", source }),
      parseArtifactDescriptor({ id: "   ", filename: "report.txt", source }),
      parseArtifactDescriptor({ id: "report", filename: "", source }),
      parseArtifactDescriptor({ id: "report", filename: "\t", source }),
    ]).toEqual([null, null, null, null])
  })

  it("rejects invalid optional metadata", () => {
    const descriptor = {
      id: "report",
      filename: "report.txt",
      source: { type: "inline", encoding: "utf8", data: "content" },
    }

    expect([
      parseArtifactDescriptor({ ...descriptor, mimeType: 42 }),
      parseArtifactDescriptor({ ...descriptor, sizeBytes: -1 }),
      parseArtifactDescriptor({ ...descriptor, sizeBytes: 1.5 }),
      parseArtifactDescriptor({ ...descriptor, sizeBytes: Number.NaN }),
    ]).toEqual([null, null, null, null])
  })

  it("rejects malformed artifact sources", () => {
    const descriptor = { id: "report", filename: "report.txt" }

    expect([
      parseArtifactDescriptor({
        ...descriptor,
        source: { type: "inline", encoding: "binary", data: "content" },
      }),
      parseArtifactDescriptor({
        ...descriptor,
        source: { type: "inline", encoding: "utf8" },
      }),
      parseArtifactDescriptor({
        ...descriptor,
        source: { type: "url", url: "ftp://files.example.com/report.txt" },
      }),
      parseArtifactDescriptor({
        ...descriptor,
        source: { type: "url", url: "https://" },
      }),
      parseArtifactDescriptor({
        ...descriptor,
        source: {
          type: "url",
          url: "https://user:secret@files.example/report",
        },
      }),
      parseArtifactDescriptor({
        ...descriptor,
        source: { type: "provider", reference: "" },
      }),
    ]).toEqual([null, null, null, null, null, null])
  })
})

describe("extractArtifactOccurrences", () => {
  it("extracts only canonical artifact data, from either participant", () => {
    const artifact = {
      id: "report",
      filename: "report.txt",
      source: { type: "inline", encoding: "utf8", data: "content" },
    }

    expect(
      extractArtifactOccurrences([
        {
          id: "assistant-message",
          role: "assistant",
          content: [
            { type: "text", text: "Created report.txt" },
            { type: "file", filename: "ordinary.txt", data: "ignored" },
            {
              type: "tool-call",
              toolName: "write_file",
              result: artifact,
            },
            { type: "data", name: "other.data", data: artifact },
            { type: "data", name: "aos.artifact", data: artifact },
          ],
        },
        {
          id: "user-message",
          role: "user",
          content: [{ type: "data", name: "aos.artifact", data: artifact }],
        },
        {
          id: "system-message",
          role: "system",
          content: [{ type: "data", name: "aos.artifact", data: artifact }],
        },
      ])
    ).toEqual([
      {
        key: "assistant-message:4",
        messageId: "assistant-message",
        partIndex: 4,
        artifact,
      },
      {
        key: "user-message:0",
        messageId: "user-message",
        partIndex: 0,
        artifact,
      },
    ])
  })

  it("keeps each explicit republication as a distinct occurrence", () => {
    const artifact = {
      id: "report",
      filename: "report.txt",
      source: { type: "inline", encoding: "utf8", data: "revised" },
    }

    expect(
      extractArtifactOccurrences([
        {
          id: "publication-1",
          role: "assistant",
          content: [{ type: "data", name: "aos.artifact", data: artifact }],
        },
        {
          id: "publication-2",
          role: "assistant",
          content: [{ type: "data", name: "aos.artifact", data: artifact }],
        },
      ]).map(({ key }) => key)
    ).toEqual(["publication-1:0", "publication-2:0"])
  })

  it("preserves message and part order", () => {
    const artifact = (id: string) => ({
      id,
      filename: `${id}.txt`,
      source: { type: "inline", encoding: "utf8", data: id },
    })

    const occurrences = extractArtifactOccurrences([
      {
        id: "older-message",
        role: "assistant",
        content: [
          { type: "data", name: "aos.artifact", data: artifact("first") },
          { type: "text", text: "between" },
          { type: "data", name: "aos.artifact", data: artifact("second") },
        ],
      },
      {
        id: "newer-message",
        role: "assistant",
        content: [
          { type: "data", name: "aos.artifact", data: artifact("third") },
        ],
      },
    ])

    expect(occurrences.map(({ key }) => key)).toEqual([
      "older-message:0",
      "older-message:2",
      "newer-message:0",
    ])
  })
})
