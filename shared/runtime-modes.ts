/** Public runtime names and their development entrypoints. No unknown-mode fallback. */
export const runtimeCatalog = {
  fixture: {
    entrypoint: "/src/runtime-adapters/fixture/composition.tsx",
    fixedNow: "2026-09-03T12:00:00.000Z",
  },
  opencode: { entrypoint: "/src/runtime-adapters/opencode/composition.tsx" },
  hermes: { entrypoint: "/src/runtime-adapters/hermes/composition.tsx" },
  "ag-ui": { entrypoint: "/src/runtime-adapters/ag-ui/composition.tsx" },
} as const

export type RuntimeMode = keyof typeof runtimeCatalog

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "opencode"

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return typeof value === "string" && Object.hasOwn(runtimeCatalog, value)
}

export function getRuntimeEntrypoint(value: unknown) {
  return isRuntimeMode(value) ? runtimeCatalog[value].entrypoint : undefined
}

/** Demo dates stay stable even when rendered through the shared application. */
export function createRuntimeClock(mode: unknown, now = new Date()) {
  const entry = isRuntimeMode(mode) ? runtimeCatalog[mode] : undefined
  const fixedNow = entry && "fixedNow" in entry ? entry.fixedNow : undefined
  return {
    now: fixedNow ? new Date(fixedNow) : now,
    readNow: fixedNow ? () => new Date(fixedNow) : () => new Date(),
  }
}
