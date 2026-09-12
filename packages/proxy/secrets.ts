import { lstat, readFile } from "node:fs/promises"
import { isAbsolute } from "node:path"

const MAX_SECRET_BYTES = 8 * 1024

export async function readSecretFile(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("Invalid secret file")
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("Invalid secret file")
  if ((metadata.mode & 0o077) !== 0)
    throw new Error("Secret file permissions are too broad")
  if (metadata.size <= 0 || metadata.size > MAX_SECRET_BYTES)
    throw new Error("Invalid secret file")
  const value = await readFile(path, "utf8")
  const normalized = value.endsWith("\n")
    ? value.slice(0, value.endsWith("\r\n") ? -2 : -1)
    : value
  if (!normalized || /[\r\n\0]/u.test(normalized))
    throw new Error("Invalid secret file")
  return normalized
}
