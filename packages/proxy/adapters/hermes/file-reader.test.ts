import { describe, expect, it } from "vitest"

import { captureLogs } from "../../../../test/support/log-capture"
import { createHermesFileReader } from "./file-reader"
import {
  fakeHermes,
  fakeHermesGateway,
  PROJECT_FOLDER,
} from "./test-utils/fake-hermes"

const NOTES = `${PROJECT_FOLDER}/notes.txt`
const signal = new AbortController().signal

/** The file reader over one fake Hermes, with the log it writes. */
function hermesFiles() {
  const hermes = fakeHermes()
  const logs = captureLogs()
  const reader = createHermesFileReader(
    fakeHermesGateway(hermes, logs.logger),
    logs.logger
  )
  return {
    hermes,
    logs,
    realPath: (path: string) => reader.realPath!(hermes.scope, path, signal),
    read: (path: string, range?: string) =>
      reader.read(hermes.scope, path, { ...(range ? { range } : {}), signal }),
  }
}

describe("Hermes MCP App file reads", () => {
  it("reports the real path Hermes resolves, afresh on every read", async () => {
    const { hermes, realPath } = hermesFiles()
    hermes.listFolder(PROJECT_FOLDER, { "notes.txt": NOTES })
    await expect(realPath(NOTES)).resolves.toBe(NOTES)

    // The file is swapped for a link that leads out of the Agent's folder.
    hermes.listFolder(PROJECT_FOLDER, { "notes.txt": "/etc/hermes/notes.txt" })
    await expect(realPath(NOTES)).resolves.toBe("/etc/hermes/notes.txt")
  })

  it.each([
    ["a broken link", 500, "listing_failed"],
    ["a link loop", 400, "listing_invalid"],
    ["a folder outside a locked root", 403, "listing_refused"],
    ["a missing folder", 404, "listing_missing"],
    [
      "a file its listing leaves out",
      { "other.txt": `${PROJECT_FOLDER}/other.txt` },
      "not_listed",
    ],
  ])(
    "knows no real path for %s, and logs why but never where",
    async (_case, listing, reason) => {
      const { hermes, logs, realPath } = hermesFiles()
      hermes.listFolder(PROJECT_FOLDER, listing)

      await expect(realPath(NOTES)).resolves.toBeUndefined()
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          message: "hermes.file.real_path_unknown",
          fields: expect.objectContaining({ reason }),
        })
      )
      expect(JSON.stringify(logs.records())).not.toContain(PROJECT_FOLDER)
    }
  )

  it("streams the Session's file uncompressed, in the range asked", async () => {
    const { hermes, read } = hermesFiles()
    hermes.storeFile(NOTES, "alpha\nbeta")

    await expect((await read(NOTES)).text()).resolves.toBe("alpha\nbeta")
    await read(NOTES, "bytes=0-4")
    const [whole, ranged] = hermes.httpRequests("/api/fs/download")
    expect(Object.fromEntries(whole.url.searchParams)).toEqual({
      path: NOTES,
      profile: "researcher",
      session_id: "stored-1",
    })
    expect(whole.headers.get("accept-encoding")).toBe("identity")
    expect(whole.headers.has("range")).toBe(false)
    expect(ranged.headers.get("range")).toBe("bytes=0-4")
  })

  it("hands core the status of a file Hermes does not serve", async () => {
    const { read } = hermesFiles()
    const response = await read(`${PROJECT_FOLDER}/missing.txt`)
    expect(response.status).toBe(404)
  })
})
