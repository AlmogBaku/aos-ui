import { posix } from "node:path"

import { z } from "zod"

import type { Logger } from "../../../lifecycle"
import type { ServerFileReader } from "../../core/runtime"
import { HermesUnavailableError } from "./gateway"
import { HermesHttpError, type HermesHttp } from "./http"

/**
 * The files an MCP App's call names, read through the Hermes dashboard. Only a
 * folder listing says where a path leads: `GET /api/files` resolves each entry
 * (`hermes_cli/web_server_files.py:181`), while `GET /api/fs/download` reads
 * whatever its path resolves to. So every read lists the file's folder for
 * core to judge the real path, then downloads that path.
 */

/** The part of a folder listing that gives each entry's real path. */
const FolderListingSchema = z.object({
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
})

/**
 * Why Hermes refused to list a folder, by status. One entry it cannot resolve
 * fails the whole listing (`hermes_cli/web_routers/files.py:405`).
 */
const LISTING_REFUSALS: Readonly<Record<number, string>> = {
  // A link loop (`web_server_files.py:185`), or a path that is no folder.
  400: "listing_invalid",
  // A folder or a link target outside a locked root (`:171`, `:187`), or a
  // folder Hermes may not read.
  403: "listing_refused",
  404: "listing_missing",
  // A broken link, whose target Hermes cannot stat (`:192`).
  500: "listing_failed",
}

export function createHermesFileReader(
  native: Pick<HermesHttp, "http" | "stream">,
  log?: Logger
): ServerFileReader {
  return {
    async realPath(scope, path) {
      const unknown = (reason: string) => {
        // Never the path: it may name a file the operator denied.
        log?.info(
          { reason, agentId: scope.agentId, sessionId: scope.sessionId },
          "hermes.file.real_path_unknown"
        )
        return undefined
      }
      let payload: unknown
      try {
        payload = await native.http(
          `/api/files?${new URLSearchParams({ path: posix.dirname(path) })}`
        )
      } catch (error) {
        const reason =
          error instanceof HermesHttpError
            ? LISTING_REFUSALS[error.status]
            : undefined
        if (reason) return unknown(reason)
        throw error
      }
      const listing = FolderListingSchema.safeParse(payload)
      if (!listing.success) throw new HermesUnavailableError()
      const name = posix.basename(path)
      // Hermes leaves a sensitive file out of its listing.
      const entry = listing.data.entries.find((each) => each.name === name)
      return entry ? entry.path : unknown("not_listed")
    },
    read(scope, path, init) {
      const query = new URLSearchParams({
        path,
        profile: scope.agentId,
        session_id: scope.providerSessionId,
      })
      return native.stream(`/api/fs/download?${query}`, init)
    },
  }
}
