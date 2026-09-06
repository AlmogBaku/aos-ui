import { describe, expect, it } from "vitest"

import { GET } from "./route"

describe("GET /api/health", () => {
  it("reports that the web service is healthy", async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })
})
