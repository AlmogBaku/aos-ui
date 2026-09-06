import assert from "node:assert/strict"
import { chromium } from "@playwright/test"

// Run against a production fixture server, never `next dev`:
// AOS_UI_RUNTIME_MODE=fixture bun run start -- --port 3194
// bun run scripts/check-initial-javascript.ts http://localhost:3194/en
const route = process.argv[2]
assert(route, "Pass the production fixture route URL")

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(route)
  await page.getByRole("tablist").waitFor()
  await page.waitForLoadState("networkidle")
  const chunks = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter(
        (entry): entry is PerformanceResourceTiming =>
          entry instanceof PerformanceResourceTiming &&
          entry.name.includes("/_next/") &&
          new URL(entry.name).pathname.endsWith(".js")
      )
      .map((entry) => ({
        file: new URL(entry.name).pathname,
        encoded: entry.encodedBodySize,
        decoded: entry.decodedBodySize,
      }))
  )
  assert(chunks.length > 0, "Expected production JavaScript requests")
  assert(
    chunks.every((chunk) => chunk.encoded > 0),
    "Missing transfer sizes"
  )
  const totalEncoded = chunks.reduce((sum, chunk) => sum + chunk.encoded, 0)
  const totalDecoded = chunks.reduce((sum, chunk) => sum + chunk.decoded, 0)
  console.log(
    JSON.stringify(
      {
        route,
        totalEncoded,
        totalDecoded,
        chunks: chunks.sort((a, b) => b.encoded - a.encoded),
      },
      null,
      2
    )
  )
  assert(
    totalEncoded <= 650_000,
    `Initial JavaScript ${totalEncoded} > 650000 bytes`
  )
} finally {
  await browser.close()
}
