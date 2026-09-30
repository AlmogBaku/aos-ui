import {
  FIXTURE_MCP_APP_FILES,
  FIXTURE_MCP_APP_FILES_PATH,
} from "@shared/presentation/views"
import { ArtifactUnavailableError } from "@/artifacts/browser-artifact-adapter"
import type { ArtifactAdapter, ArtifactDescriptor } from "../contracts"

const example = <T extends ArtifactDescriptor>(artifact: T) => artifact

/**
 * A published attachment whose bytes the preview serves as a static file, so
 * the artifact view can fetch them from its sandbox as it fetches a real one.
 */
const servedExample = (
  id: string,
  file: keyof typeof FIXTURE_MCP_APP_FILES,
  mimeType: string
) =>
  example({
    id,
    filename: FIXTURE_MCP_APP_FILES[file],
    mimeType,
    source: {
      type: "provider",
      reference: `${FIXTURE_MCP_APP_FILES_PATH}/${FIXTURE_MCP_APP_FILES[file]}`,
    },
  })

const createToneWavBase64 = () => {
  const sampleRate = 8_000
  const sampleCount = sampleRate * 2
  const bytes = new Uint8Array(44 + sampleCount)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, value: string) =>
    [...value].forEach((character, index) => {
      bytes[offset + index] = character.charCodeAt(0)
    })
  write(0, "RIFF")
  view.setUint32(4, 36 + sampleCount, true)
  write(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  write(36, "data")
  view.setUint32(40, sampleCount, true)
  for (let index = 0; index < sampleCount; index += 1) {
    bytes[44 + index] = Math.round(
      128 + 22 * Math.sin((index * 2 * Math.PI * 440) / sampleRate)
    )
  }
  return btoa(String.fromCharCode(...bytes))
}

export const FIXTURE_ARTIFACT_CATALOG = {
  examples: {
    markdown: servedExample(
      "fixture-market-brief",
      "markdown",
      "text/markdown"
    ),
    csv: servedExample("fixture-market-data", "csv", "text/csv"),
    json: servedExample("fixture-json", "json", "application/json"),
    code: servedExample("fixture-code", "code", "application/typescript"),
    html: servedExample("fixture-market-html", "page", "text/html"),
    image: example({
      id: "fixture-image",
      filename: "market-chart.svg",
      mimeType: "image/svg+xml",
      source: {
        type: "inline",
        encoding: "utf8",
        data: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#f4f1eb"/><path d="M40 140L130 105L220 60L280 38" fill="none" stroke="#315c52" stroke-width="8"/><title>Quarterly spend trend</title></svg>',
      },
    }),
    audio: example({
      id: "fixture-audio",
      filename: "market-summary.wav",
      mimeType: "audio/wav",
      sizeBytes: 16_044,
      source: {
        type: "inline",
        encoding: "base64",
        data: createToneWavBase64(),
      },
    }),
    video: example({
      id: "fixture-video",
      filename: "market-summary.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1534,
      source: {
        type: "inline",
        encoding: "base64",
        data: "AAAAIGZ0eXBpc29tAAACAGlzb21hdjAxaXNvMm1wNDEAAAOgbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAsp0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAJCbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAMgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB7W1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAa1zdGJsAAAArHN0c2QAAAAAAAAAAQAAAJxhdjAxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABF0xhdmM2Mi4yOC4xMDIgbGlic3Z0YXYxAAAAAAAAAAAAGP//AAAAGGF2MUOBAAwACgoAAAADtP2QC+ABAAAACmZpZWwBAAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABFwAAARcAAAABhzdHRzAAAAAAAAAAEAAAAZAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAJXNkdHAAAAAAIBgQGBAYEBgQGBAYEBgQGBAYEBgQGBAYEAAAABxzdHNjAAAAAAAAAAEAAAABAAAAGQAAAAEAAAB4c3RzegAAAAAAAAAAAAAAGQAAACgAAABmAAAAAwAAABQAAAADAAAAKAAAAAMAAAAUAAAAAwAAADwAAAADAAAAFAAAAAMAAAAoAAAAAwAAABQAAAADAAAAUAAAAAMAAAAUAAAAAwAAACgAAAADAAAAFAAAAAMAAAAUc3RjbwAAAAAAAAABAAAD0AAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAyAAAACGZyZWUAAAI2bWRhdAoKAAAAA7T9kSvkATIaEACQoILLFFCAAACX0yN1by70dOTp2Whl280yEygQACSSSRkqAQAACAAMAI8SsyAyEygIAQSSABEqAAAAQABgAJW97UAyEigEhASSbZEqAAAAQABgAJdyXDISKAKIBJK2kS4AAABAAGAAmBZwMhIwAwAJJbYiZAAAAIAAwACY54AaAegyEjAGABttbSJkAAAAgADAAJjngBoB2DISKAYIC21tkS4AAABAAGAAmBZwMhIwCwAW27YiZAAAAIAAwACY54AaAegyEjAOABts2yJkAAAAgADAAJjngBoBuDISKAwEBtsAESoAAABAAGAAl3JcMhIoCogG27aRLgAAAEAAYACYFnAyEjATAA23tiJkAAAAgADAAJjngBoB6DISMBYAG21tImQAAACAAMAAmOeAGgHYMhIoDggLbQARLgAAAEAAYACYFnAyEjAbABbbtiJkAAAAgADAAJjngBoB6DISMB4AG2wAImQAAACAAMAAmOeAGgGIMhIoGABAAAAZLYAAAEAAYACNECQyEigUAgAAJJEtgAAAQABgAJc7PzISKBKEAACSES2AAABAAGAAmHMwMhIwIwAAAW0iZAAAAIAAwACZHUAaAdgyEjAmABbbJCJkAAAAgADAAJkdQBoByDISKBYECSQkkS2AAABAAGAAmHMwMhIwKwASSW0iZAAAAIAAwACZHUAaAdgyEjAuABbaSSJkAAAAgADAAJkdQBoBmA==",
      },
    }),
  },
  malformedDescriptor: {
    id: "",
    filename: "invalid.txt",
    source: { type: "provider", reference: "" },
  },
  missingProviderReference: example({
    id: "fixture-missing-provider",
    filename: "unavailable-source.txt",
    mimeType: "text/plain",
    source: { type: "provider", reference: "fixture-does-not-exist" },
  }),
  oversizedDescriptor: example({
    id: "fixture-oversized",
    filename: "oversized-video.mp4",
    mimeType: "video/mp4",
    sizeBytes: 25 * 1024 * 1024 + 1,
    source: { type: "inline", encoding: "base64", data: "" },
  }),
} as const

const aborted = () =>
  new DOMException("Artifact resolution aborted", "AbortError")

export function createFixtureArtifactAdapter(): ArtifactAdapter {
  return {
    async resolve({ artifact, signal }) {
      if (signal.aborted) throw aborted()
      if (
        artifact.source.type === "provider" &&
        artifact.source.reference.startsWith(`${FIXTURE_MCP_APP_FILES_PATH}/`)
      ) {
        const response = await fetch(artifact.source.reference, { signal })
        if (!response.ok) throw new Error("Fixture file is not served")
        return new Blob([await response.arrayBuffer()], {
          type: artifact.mimeType,
        })
      }
      if (artifact.source.type === "provider") {
        throw new ArtifactUnavailableError(
          `Fixture artifact reference is unavailable: ${artifact.source.reference}`
        )
      }
      if (artifact.source.type !== "inline") {
        throw new Error("Fixture artifacts must use inline content")
      }

      if (artifact.source.encoding === "utf8") {
        return new Blob([artifact.source.data], { type: artifact.mimeType })
      }

      const decoded = atob(artifact.source.data)
      const bytes = Uint8Array.from(decoded, (character) =>
        character.charCodeAt(0)
      )
      return new Blob([bytes], { type: artifact.mimeType })
    },
  }
}
