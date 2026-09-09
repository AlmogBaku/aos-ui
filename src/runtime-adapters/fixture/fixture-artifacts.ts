import { ArtifactUnavailableError } from "@/artifacts/browser-artifact-adapter"
import type { ArtifactAdapter, ArtifactDescriptor } from "../contracts"

const example = <T extends ArtifactDescriptor>(artifact: T) => artifact

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
    markdown: example({
      id: "fixture-market-brief",
      filename: "enterprise-ai-brief.md",
      mimeType: "text/markdown",
      source: {
        type: "inline",
        encoding: "utf8",
        data: "# Enterprise AI brief\n\nInvestment is moving from pilots toward governed deployments.\n\n```ts\nconst governedGrowth = (57 - 42) / 42\n```",
      },
    }),
    text: example({
      id: "fixture-text",
      filename: "research-notes.txt",
      mimeType: "text/plain",
      source: {
        type: "inline",
        encoding: "utf8",
        data: "Enterprise adoption rose in both observed quarters.",
      },
    }),
    code: example({
      id: "fixture-code",
      filename: "growth-rate.ts",
      mimeType: "application/typescript",
      source: {
        type: "inline",
        encoding: "utf8",
        data: "export const growthRate = (57 - 42) / 42\n",
      },
    }),
    json: example({
      id: "fixture-json",
      filename: "quarterly-spend.json",
      mimeType: "application/json",
      source: {
        type: "inline",
        encoding: "utf8",
        data: '{"quarter":"Q1 2025","spend":57}',
      },
    }),
    csv: example({
      id: "fixture-market-data",
      filename: "quarterly-spend.csv",
      mimeType: "text/csv",
      source: {
        type: "inline",
        encoding: "utf8",
        data: 'Quarter,Segment,Spend\nQ4 2024,"Data, governance",42\nQ1 2025,"Applied\nAI",57',
      },
    }),
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
    pdf: example({
      id: "fixture-pdf",
      filename: "market-brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 595,
      source: {
        type: "inline",
        encoding: "base64",
        data: "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoQU9TIEFydGlmYWN0IFByZXZpZXcpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzQyIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDEyCiUlRU9GCg==",
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
    html: example({
      id: "fixture-market-html",
      filename: "market-summary.html",
      mimeType: "text/html",
      source: {
        type: "inline",
        encoding: "utf8",
        data: `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; padding: clamp(24px, 8vw, 64px); background: #f4f1eb; color: #17211e; }
      main { max-width: 680px; margin: 0 auto; }
      .label { color: #315c52; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      h1 { max-width: 11ch; margin: 18px 0; font-size: clamp(38px, 8vw, 72px); line-height: .96; letter-spacing: -.045em; }
      .lede { max-width: 46ch; color: #52605b; font-size: clamp(17px, 3vw, 21px); line-height: 1.55; }
      .signal { display: grid; grid-template-columns: auto 1fr; gap: 18px; align-items: center; margin-top: 48px; border-top: 1px solid #cdd5d1; padding-top: 24px; }
      .value { color: #315c52; font-size: 36px; font-weight: 700; letter-spacing: -.04em; }
      .caption { color: #52605b; font-size: 14px; line-height: 1.45; }
    </style>
  </head>
  <body>
    <main>
      <div class="label">Market pulse · Q1 2025</div>
      <h1>Enterprise AI is moving into production.</h1>
      <p class="lede">Governed deployments are expanding as investment shifts from isolated pilots toward durable platforms and measurable workflows.</p>
      <div class="signal"><div class="value">+36%</div><div class="caption">Illustrative quarter-over-quarter growth in the fixture dataset.</div></div>
    </main>
  </body>
</html>`,
      },
    }),
    unsupported: example({
      id: "fixture-unsupported",
      filename: "market-data.zip",
      mimeType: "application/zip",
      source: {
        type: "inline",
        encoding: "base64",
        data: "UEsDBAoAAAAA",
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
