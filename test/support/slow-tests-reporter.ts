import type { Reporter, TestModule, Vitest } from "vitest/node"

const shown = 10

/**
 * Milliseconds a test should stay under, per Vitest project. The gate's
 * builds and external tools are slow by design, so it flags only a runaway.
 */
const budgetMs: Record<string, number> = {
  node: 1_000,
  dom: 3_000,
  gate: 60_000,
}

/**
 * Lists the slowest tests over their project's budget after a run. A slow
 * test is a review finding: usually a missing production seam (a hard-coded
 * limit, a real clock) or a check mounted at a higher layer than its rule
 * needs. See AGENTS.md › Writing tests.
 */
export default class SlowTestsReporter implements Reporter {
  #vitest?: Vitest

  onInit(vitest: Vitest) {
    this.#vitest = vitest
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const slow = testModules
      .flatMap((module) => [...module.children.allTests()])
      .flatMap((test) => {
        const ms = test.diagnostic()?.duration ?? 0
        const budget = budgetMs[test.project.name] ?? budgetMs.node
        return ms > budget ? [{ test, ms }] : []
      })
      .sort((a, b) => b.ms - a.ms)
    if (slow.length === 0) return

    const log = this.#vitest?.logger
    const lines = slow
      .slice(0, shown)
      .map(
        ({ test, ms }) =>
          `  ${(ms / 1000).toFixed(1).padStart(6)} s  [${test.project.name}] ${test.module.relativeModuleId} › ${test.fullName}`
      )
    log?.log(
      [
        `\n${slow.length} test(s) over their project's budget; slowest ${Math.min(shown, slow.length)}:`,
        ...lines,
      ].join("\n")
    )
  }
}
