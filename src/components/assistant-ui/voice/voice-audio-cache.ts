const DATABASE_NAME = "aos-voice-audio-v1"
const DATABASE_VERSION = 1
const STORE_NAME = "playbacks"

export const VOICE_AUDIO_TTL_MS = 60 * 60 * 1_000
export const VOICE_AUDIO_PRUNE_INTERVAL_MS = 5 * 60 * 1_000

type CachedAudio = {
  audio: Blob
  expiresAt: number
}

let databasePromise: Promise<IDBDatabase> | undefined
let database: IDBDatabase | undefined
let prunePromise: Promise<void> | undefined
let pruneTimer: ReturnType<typeof setInterval> | undefined

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    })
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    })
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true })
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    })
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB aborted")),
      { once: true }
    )
  })
}

function isCachedAudio(value: unknown): value is CachedAudio {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<CachedAudio>
  return candidate.audio instanceof Blob && Number.isFinite(candidate.expiresAt)
}

function startPruning() {
  if (pruneTimer !== undefined) return
  void pruneExpiredAudio(Date.now()).catch(() => {})
  pruneTimer = setInterval(() => {
    void pruneExpiredAudio(Date.now()).catch(() => {})
  }, VOICE_AUDIO_PRUNE_INTERVAL_MS)
}

function openDatabase() {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.addEventListener(
      "upgradeneeded",
      () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME))
          request.result.createObjectStore(STORE_NAME)
      },
      { once: true }
    )
    request.addEventListener(
      "success",
      () => {
        database = request.result
        const reset = () => {
          if (database !== request.result) return
          database = undefined
          databasePromise = undefined
        }
        request.result.addEventListener("versionchange", () => {
          request.result.close()
          reset()
        })
        request.result.addEventListener("close", reset)
        resolve(request.result)
        startPruning()
      },
      { once: true }
    )
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    })
    request.addEventListener(
      "blocked",
      () => reject(new Error("IndexedDB open blocked")),
      { once: true }
    )
  }).catch((error) => {
    databasePromise = undefined
    throw error
  })
  return databasePromise
}

export async function getCachedAudio(key: string) {
  const database = await openDatabase()
  const transaction = database.transaction(STORE_NAME, "readwrite")
  const done = transactionDone(transaction)
  const store = transaction.objectStore(STORE_NAME)
  let value: unknown
  try {
    value = await requestResult(store.get(key))
  } catch (error) {
    await done.catch(() => {})
    throw error
  }
  if (!isCachedAudio(value) || value.expiresAt <= Date.now()) {
    if (value !== undefined) store.delete(key)
    await done
    return undefined
  }
  await done
  return value.audio
}

export async function putCachedAudio(
  key: string,
  audio: Blob,
  expiresAt: number
) {
  const database = await openDatabase()
  const transaction = database.transaction(STORE_NAME, "readwrite")
  const done = transactionDone(transaction)
  transaction.objectStore(STORE_NAME).put({ audio, expiresAt }, key)
  await done
}

async function pruneExpiredAudioOnce(now: number) {
  const database = await openDatabase()
  const transaction = database.transaction(STORE_NAME, "readwrite")
  const done = transactionDone(transaction)
  const request = transaction.objectStore(STORE_NAME).openCursor()
  request.addEventListener("success", () => {
    const cursor = request.result
    if (!cursor) return
    if (!isCachedAudio(cursor.value) || cursor.value.expiresAt <= now)
      cursor.delete()
    cursor.continue()
  })
  await done
}

export function pruneExpiredAudio(now: number): Promise<void> {
  prunePromise ??= pruneExpiredAudioOnce(now).finally(() => {
    prunePromise = undefined
  })
  return prunePromise
}
