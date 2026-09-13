import { describe, expect, it, vi } from "vitest"

import { HermesDashboardClient } from "./dashboard-client"

describe("Hermes dashboard client", () => {
  it("wraps the dashboard Session routes without adding adapter behavior", async () => {
    const http = vi.fn(async () => ({ ok: true }))
    const client = new HermesDashboardClient(http)

    await client.listSessions("research profile", 50, 10)
    await client.getSession("research profile", "stored/1")
    await client.getSessionMessages("research profile", "stored/1", 200, 20)
    await client.updateSession("research profile", "stored/1", {
      title: "Renamed",
    })
    await client.deleteSession("research profile", "stored/1")

    expect(http.mock.calls).toEqual([
      [
        "/api/sessions?profile=research+profile&limit=50&offset=10&order=recent&archived=include&exclude_sources=cron%2Ctool%2Ckanban",
      ],
      ["/api/sessions/stored%2F1?profile=research%20profile"],
      [
        "/api/sessions/stored%2F1/messages?profile=research+profile&limit=200&offset=20&order=oldest&include_compacted=true",
      ],
      [
        "/api/sessions/stored%2F1?profile=research%20profile",
        {
          method: "PATCH",
          body: { title: "Renamed", profile: "research profile" },
        },
      ],
      [
        "/api/sessions/stored%2F1?profile=research%20profile",
        { method: "DELETE", body: undefined },
      ],
    ])
  })

  it("wraps artifact and native audio routes with response bounds", async () => {
    const http = vi.fn(async () => ({ ok: true }))
    const client = new HermesDashboardClient(http)

    await client.readArtifactDataUrl(
      "research profile",
      "stored/1",
      "reports/result.txt",
      123
    )
    await client.getAudioConfig("research profile", "stt", 234)
    await client.transcribe(
      "research profile",
      { data_url: "data:audio/wav;base64,YQ==", mime_type: "audio/wav" },
      345
    )
    await client.speak("research profile", "hello", 456)

    expect(http.mock.calls).toEqual([
      [
        "/api/fs/read-data-url?path=reports%2Fresult.txt&profile=research+profile&session_id=stored%2F1",
        { maxResponseBytes: 123 },
      ],
      [
        "/api/tools/toolsets/stt/config?profile=research+profile",
        { maxResponseBytes: 234 },
      ],
      [
        "/api/audio/transcribe?profile=research+profile",
        {
          method: "POST",
          body: {
            data_url: "data:audio/wav;base64,YQ==",
            mime_type: "audio/wav",
          },
          maxResponseBytes: 345,
        },
      ],
      [
        "/api/audio/speak?profile=research+profile",
        { method: "POST", body: { text: "hello" }, maxResponseBytes: 456 },
      ],
    ])
  })
})
