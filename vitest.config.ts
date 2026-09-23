import { configDefaults, defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@aos/protocol/acp": path.resolve(
        import.meta.dirname,
        "packages/protocol/acp.ts"
      ),
      "@aos/protocol/push": path.resolve(
        import.meta.dirname,
        "packages/protocol/push.ts"
      ),
      "@aos/protocol/mcp-apps": path.resolve(
        import.meta.dirname,
        "packages/protocol/mcp-apps.ts"
      ),
      "@aos/protocol": path.resolve(
        import.meta.dirname,
        "packages/protocol/index.ts"
      ),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    // Agent worktrees nest a full checkout under `.claude`; sweeping them
    // reports every test twice and the stale copy's failures as ours.
    exclude: [...configDefaults.exclude, ".worktrees/**", "**/.claude/**"],
    restoreMocks: true,
    // The workspace composition tests each drive a full jsdom app through
    // several async Session switches and take 2-6s alone; with one worker per
    // core they slow 3-4x under load, so the default 5s budget turned real
    // load into phantom failures. The budget bounds a hung test, not a slow
    // one: a passing test never waits for it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One worker per core is the default, and several agent worktrees sweeping
    // at once oversubscribe the machine several times over — which starves the
    // operator's own deployment on the same host, not just the suite. Half the
    // cores keeps a concurrent sweep survivable; a machine running one sweep
    // alone can raise it.
    maxWorkers: Number(process.env.AOS_UI_TEST_WORKERS) || "50%",
  },
})
