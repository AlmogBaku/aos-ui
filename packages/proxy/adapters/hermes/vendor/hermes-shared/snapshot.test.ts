// @vitest-environment node
// Snapshot integrity test for vendored upstream files.
//
// The constants below are the SHA-256 hashes of the upstream blobs at
// NousResearch/hermes-agent@47685348eaca9d673719003b9e03a71becfa6423
// (apps/shared/src/<file> for TypeScript sources; root LICENSE for the license).
//
// If any of these fail, a vendored file was modified. To update after an
// intentional upstream sync:
//   1. Re-fetch each file with:
//        gh api "repos/NousResearch/hermes-agent/contents/apps/shared/src/<file>?ref=<new-pin>" \
//          --jq '.content' | base64 -d > <dest>
//   2. Re-run this test and update the hash constants to match.
//   3. Update vendor/hermes-shared/UPSTREAM.md with the new pin and hashes.
//
// DO NOT edit the hash constants here without re-fetching the upstream source.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const DIR = fileURLToPath(new URL(".", import.meta.url))

const UPSTREAM_HASHES: Record<string, string> = {
  "json-rpc-gateway.ts":
    "ab80102da6d5e0cd5c831271f4bd353e0b2ecb711281f1d78745e9149da293a8",
  "json-rpc-channel.ts":
    "9ab20d7e9ab8829650a98dc8967283439ae13b11b46f36f4d64ea1243a5250d8",
  "reconnect-backoff.ts":
    "323c4cd02b95010a6fd7a197f2ccb5182507142677d01fa506b08c055c5ff1f8",
  "json-rpc-channel.test.ts":
    "bb49e96d31602af46c9787fc35f8c8e6a7600409f09c9592faa40cd259dbc343",
  "json-rpc-gateway-replay.test.ts":
    "58e0edbaf4b166f02a482dbacc74ac55e8df6740914e30dda74e6bb89dcbdfd6",
  "reconnect-backoff.test.ts":
    "149cb74814b5bfde1249dd75490a7bb7131e6ce4151e0cce247aa432d519323f",
  LICENSE: "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
}

function sha256(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash("sha256").update(content).digest("hex")
}

describe("vendored upstream file integrity", () => {
  for (const [filename, expectedHash] of Object.entries(UPSTREAM_HASHES)) {
    it(`${filename} matches upstream blob hash`, () => {
      const actual = sha256(join(DIR, filename))
      expect(actual).toBe(expectedHash)
    })
  }
})
