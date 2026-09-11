import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function makeTemporaryDirectory() {
  return mkdtemp(join(tmpdir(), "aos-openclaw-test-"))
}

export async function removeTemporaryDirectory(path: string) {
  if (path) await rm(path, { recursive: true, force: true })
}
