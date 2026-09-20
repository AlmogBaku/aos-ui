import {
  access,
  chmod,
  constants,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import {
  PushRegistrationSchema,
  type PushRegistration,
} from "../../protocol/push"

/** Where the proxy keeps the operator's push devices, inside the state dir. */
export const PUSH_REGISTRATIONS_FILE = "push-subscriptions.json"

/** How many devices one principal may register at once. */
const MAX_PER_PRINCIPAL = 32

/** One stored device: what the browser sent, and when it was recorded. */
export const StoredRegistrationSchema = PushRegistrationSchema.extend({
  createdAt: z.string().datetime(),
})
export type StoredRegistration = z.infer<typeof StoredRegistrationSchema>

const RegistrationFileSchema = z.strictObject({
  version: z.literal(1),
  principals: z.record(z.string(), z.array(StoredRegistrationSchema)),
})

/** Thrown when a principal already holds every device it is allowed. */
export class PushRegistrationLimitError extends Error {
  constructor() {
    super("Too many push registrations for this principal")
    this.name = "PushRegistrationLimitError"
  }
}

type RegistrationLogger = { error(value: unknown): void }

export type PushRegistrationsOptions = {
  /** Must already exist and be writable; push state is never kept in memory. */
  stateDir: string
  maxPerPrincipal?: number
  logger?: RegistrationLogger
  now?: () => number
}

/**
 * The operator's push devices, in one owner-only JSON file. Reads are served
 * from memory, and every write replaces the whole file by writing a temporary
 * file and renaming it, so a reader never sees a half-written state.
 */
export interface PushRegistrations {
  list(principalId: string): StoredRegistration[]
  /** Replaces the device with the same endpoint; throws past the limit. */
  put(principalId: string, registration: PushRegistration): Promise<void>
  remove(principalId: string, endpoint: string): Promise<void>
}

/** Fails closed: a state directory the proxy cannot write is a startup error. */
async function requireWritableDirectory(stateDir: string) {
  try {
    const details = await stat(stateDir)
    if (!details.isDirectory()) throw new Error("not a directory")
    await access(stateDir, constants.W_OK)
  } catch {
    throw new Error(`Push state directory is not writable: ${stateDir}`)
  }
}

/**
 * Replaces the whole file, owner-only, one write at a time. Every write carries
 * the complete state, so the last one queued is the one that must land; a failed
 * write is reported to its own caller and does not poison the ones behind it.
 */
function createStateWriter(path: string) {
  const temporaryPath = `${path}.tmp`
  let queue: Promise<void> = Promise.resolve()
  return (contents: string) => {
    const write = queue
      .catch(() => undefined)
      .then(async () => {
        await writeFile(temporaryPath, contents, { mode: 0o600 })
        // `mode` applies only when the file is created, so a temporary file left
        // behind by an interrupted write cannot widen this one.
        await chmod(temporaryPath, 0o600)
        await rename(temporaryPath, path)
      })
    queue = write
    return write
  }
}

/** `undefined` for anything that is not JSON; the schema refuses it either way. */
function parsedJson(contents: string): unknown {
  try {
    return JSON.parse(contents)
  } catch {
    return undefined
  }
}

/** The stored file, or nothing when it is absent, unreadable, or invalid. */
async function readRegistrationFile(path: string, logger?: RegistrationLogger) {
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  const parsed = RegistrationFileSchema.safeParse(parsedJson(contents))
  if (parsed.success) return parsed.data
  // The contents are subscription endpoints and device keys: report only that
  // the file could not be used.
  logger?.error({ event: "push.registrations.invalid" })
  return undefined
}

export async function openPushRegistrations({
  stateDir,
  maxPerPrincipal = MAX_PER_PRINCIPAL,
  logger,
  now = Date.now,
}: PushRegistrationsOptions): Promise<PushRegistrations> {
  await requireWritableDirectory(stateDir)
  const path = join(stateDir, PUSH_REGISTRATIONS_FILE)
  const stored = await readRegistrationFile(path, logger)
  const principals = new Map<string, StoredRegistration[]>(
    Object.entries(stored?.principals ?? {})
  )
  const write = createStateWriter(path)

  const flush = () =>
    write(
      JSON.stringify({
        version: 1,
        principals: Object.fromEntries(principals),
      })
    )

  return {
    list(principalId) {
      return [...(principals.get(principalId) ?? [])]
    },

    async put(principalId, registration) {
      const devices = principals.get(principalId) ?? []
      const index = devices.findIndex(
        (device) =>
          device.subscription.endpoint === registration.subscription.endpoint
      )
      if (index === -1 && devices.length >= maxPerPrincipal)
        throw new PushRegistrationLimitError()
      const device: StoredRegistration = {
        ...registration,
        createdAt: new Date(now()).toISOString(),
      }
      if (index === -1) devices.push(device)
      else devices[index] = device
      principals.set(principalId, devices)
      await flush()
    },

    async remove(principalId, endpoint) {
      const devices = principals.get(principalId)
      if (!devices) return
      const remaining = devices.filter(
        (device) => device.subscription.endpoint !== endpoint
      )
      if (remaining.length === devices.length) return
      if (remaining.length === 0) principals.delete(principalId)
      else principals.set(principalId, remaining)
      await flush()
    },
  }
}
