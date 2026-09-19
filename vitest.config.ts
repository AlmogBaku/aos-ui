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
  },
})
