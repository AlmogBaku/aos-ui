# Mermaid and Harness Instructions Implementation Plan

> **For the implementing agent:** REQUIRED SKILLS: use `executing-plans`, `test-driven-development`, `assistant-ui`, `markdown`, `tools`, `runtime`, `vercel-react-best-practices`, and `verification-before-completion`. Read each selected `SKILL.md` completely before changing code.

**Goal:** Render safe, elegant Mermaid fences in Assistant messages and give every runtime one capability-accurate AOS harness prompt without coupling Agent definitions, `AGENTS.md`, tool execution, or provider internals.

**Architecture:** A pure `buildAosUiHarnessPrompt(capabilities)` owns product-surface guidance. Fixture and AG-UI deliver it through Assistant UI instructions; OpenCode delivers the same builder output through a project plugin system-transform hook because its installed Assistant UI adapter drops client system context. Markdown dispatches completed `mermaid` fences to a client renderer that lazy-imports Mermaid under strict security and always retains a textual source fallback.

**Tech stack:** Assistant UI React 0.15.18, Assistant UI Markdown 0.14.14, AG-UI React 0.0.58, OpenCode plugin 1.18.27, Mermaid, React 19, `next-themes`, Vitest, Testing Library, Playwright.

**Design reference:** `docs/superpowers/specs/2026-09-04-agent-workspace-completion-design.md`

---

## Task 1: Define one capability-accurate harness prompt

**Files:**

- Create: `lib/runtime-adapters/harness-prompt.ts`
- Create: `lib/runtime-adapters/harness-prompt.test.ts`
- Modify: `lib/runtime-adapters/contracts.ts`

- [ ] Add failing tests for common guidance and three manifests: fixture, OpenCode, and AG-UI minimum. Assert Mermaid is always documented, OpenCode structured tool names appear only when enabled, Monty appears only when advertised, native question/permission/Todo/subagent semantics are conditional, Plans and Todos are explicitly independent, and neither `AGENTS.md` nor provider implementation details appear.

- [ ] Add a narrow serializable capability type, separate from `WorkspaceCapabilities` if that keeps workspace CRUD concerns clearer:

```ts
type HarnessCapabilities = {
  markdown: true
  mermaid: boolean
  charts: boolean
  maps: boolean
  stats: boolean
  plans: boolean
  questions: "native" | "unavailable"
  permissions: "native" | "unavailable"
  todos: "native" | "unavailable"
  subagents: "native" | "unavailable"
  monty: boolean
}
```

- [ ] Implement `buildAosUiHarnessPrompt(capabilities)` as a deterministic pure function. Keep it concise and actionable: Markdown, fenced Mermaid, source size/complexity guidance, no HTML/scripts, exact enabled tool names, native interaction rules, and no invented unsupported control.

- [ ] Export explicit frozen capability manifests from the runtime composition modules; do not add runtime hot switching or a generic provider registry.

- [ ] Run `bun test lib/runtime-adapters/harness-prompt.test.ts` and review the rendered prompt manually for duplication and ambiguity.

- [ ] Commit:

```bash
git add lib/runtime-adapters/harness-prompt.ts lib/runtime-adapters/harness-prompt.test.ts lib/runtime-adapters/contracts.ts lib/runtime-adapters/fixture lib/runtime-adapters/opencode lib/runtime-adapters/ag-ui
git diff --cached --check
git commit -m "feat: define capability-aware agent harness"
```

## Task 2: Deliver the prompt through each provider's real seam

**Files:**

- Create: `components/assistant-ui/harness-instructions.tsx`
- Create: `components/assistant-ui/harness-instructions.test.tsx`
- Modify: `components/aos-ui-fixture-app.tsx`
- Modify: `components/aos-ui-ag-ui-app.tsx`
- Create: `.opencode/plugins/aos-ui-harness.ts`
- Create: `.opencode/plugins/aos-ui-harness.test.ts`
- Modify: `opencode.json`
- Delete: `.opencode/chart-instructions.md`

- [ ] Read the installed implementations/types for `useAssistantInstructions`, AG-UI `AgUiThreadRuntimeCore.buildRunInput`, OpenCode `experimental.chat.system.transform`, and the Next 16 lazy-loading guide before writing provider glue.

- [ ] Write failing Assistant UI tests proving one mounted instruction source contributes the harness to fixture/AG-UI model context and unmount removes it. Assert the OpenCode application does not mount this client component.

- [ ] Implement `HarnessInstructions({ prompt })` as a renderless component calling `useAssistantInstructions(prompt)`. Mount it inside the fixture and AG-UI `AssistantRuntimeProvider` trees using only their manifest.

- [ ] Add AG-UI fake-transport coverage that the outgoing `RunAgentInput.context` contains exactly one system entry with the built prompt. Prove unavailable OpenCode tool names are absent.

- [ ] Export the OpenCode plugin hook in a testable form. Add failing tests that `experimental.chat.system.transform` appends the shared OpenCode prompt exactly once, preserves existing system entries, and does not depend on root `AGENTS.md`.

- [ ] Implement `.opencode/plugins/aos-ui-harness.ts` using the pinned plugin API. Import the shared pure prompt builder through a stable relative path supported by OpenCode's plugin loader. If direct cross-root import is not supported in the installed loader, move the pure builder to an environment-neutral shared module that both Next and the plugin can import; do not duplicate prompt text.

- [ ] Remove `.opencode/chart-instructions.md` and the `opencode.json.instructions` reference after the plugin test passes, preventing duplicate or stale guidance. Keep tool descriptions in the tool files as schema-local help.

- [ ] Add a provider-health assertion/log surface during OpenCode composition so a missing harness plugin is reported as degraded guidance. Do not block chat if the provider itself is otherwise usable.

- [ ] Run:

```bash
bun test lib/runtime-adapters/harness-prompt.test.ts components/assistant-ui/harness-instructions.test.tsx .opencode/plugins/aos-ui-harness.test.ts components/aos-ui-ag-ui-app.test.tsx
bun run typecheck
bun run lint
```

- [ ] Commit:

```bash
git add components/assistant-ui/harness-instructions.tsx components/assistant-ui/harness-instructions.test.tsx components/aos-ui-fixture-app.tsx components/aos-ui-ag-ui-app.tsx .opencode/plugins/aos-ui-harness.ts .opencode/plugins/aos-ui-harness.test.ts opencode.json .opencode/chart-instructions.md lib/runtime-adapters
git diff --cached --check
git commit -m "feat: inject harness instructions across runtimes"
```

## Task 3: Add the lazy, strict Mermaid renderer test-first

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Create: `components/assistant-ui/elements/mermaid-diagram.tsx`
- Create: `components/assistant-ui/elements/mermaid-diagram.test.tsx`
- Modify: `components/tool-ui/locale.tsx`

- [ ] Check the current Mermaid release, its browser/React 19 compatibility, and its security configuration in primary package documentation. Pin the selected compatible version with `bun add mermaid@<exact-version>` so the initial conversation bundle can still exclude it.

- [ ] Add localized EN/HE labels for Diagram, Rendering diagram, View/Hide source, render failure, source too large, and Copy source. Reuse existing Copied label.

- [ ] Write failing tests with a mocked dynamic `mermaid` import. Cover:
  - escaped/copyable source while the message part is running;
  - no Mermaid import/render before completion;
  - strict initialization and `startOnLoad: false`;
  - successful accessible image wrapper and collapsed source;
  - malformed and oversized source fallback with disclosure open;
  - stale render ignored after source/theme change;
  - unmount cancellation;
  - Hebrew labels with LTR source/diagram;
  - dark/System resolved-theme rerender;
  - reduced-motion loading state.

- [ ] Implement `MermaidDiagram` against Assistant UI Markdown's installed `SyntaxHighlighterProps`. Obtain the message-part completion state through the supported Assistant UI context/hook; do not detect completion by scanning for closing backticks.

- [ ] Until complete, render the escaped code block and loading status only. On completion, reject a documented source-length cap, then call a dynamic `import("mermaid")` inside an effect. Initialize with `startOnLoad: false`, `securityLevel: "strict"`, `suppressErrorRendering: true`, and the resolved Light/Dark theme.

- [ ] Derive a DOM-safe stable ID from `useId`; call `mermaid.render`; inject only the returned SVG; discard `bindFunctions`; mark the SVG `aria-hidden`; and expose a localized `role="img"` name on the containing region. Cancel/ignore every outdated promise result using an effect revision.

- [ ] Render a keyboard-accessible source disclosure and existing copy-button treatment. Keep source `dir="ltr"`, never add a Run control, never fetch a CDN asset, and never hide source on an error.

- [ ] Run `bun test components/assistant-ui/elements/mermaid-diagram.test.tsx` and `bun run typecheck && bun run lint`.

- [ ] Commit:

```bash
git add package.json bun.lock components/assistant-ui/elements/mermaid-diagram.tsx components/assistant-ui/elements/mermaid-diagram.test.tsx components/tool-ui/locale.tsx
git diff --cached --check
git commit -m "feat: render safe mermaid diagrams"
```

## Task 4: Dispatch Mermaid fences through Assistant UI Markdown

**Files:**

- Modify: `components/assistant-ui/elements/markdown-text.tsx`
- Create: `components/assistant-ui/elements/markdown-text.test.tsx`
- Modify: `components/assistant-ui/elements/presentation-a11y.test.tsx`

- [ ] Add a failing integration test proving a completed fenced `mermaid` block selects `MermaidDiagram`, while `ts`, `json`, and unlabeled code blocks retain the current `CodeHeader`, syntax, source, and copy behavior.

- [ ] Add a module-scope stable `componentsByLanguage` map using the installed API:

```ts
const componentsByLanguage = {
  mermaid: { SyntaxHighlighter: MermaidDiagram },
}
```

- [ ] Pass that map to `MarkdownTextPrimitive` without recreating it per render. Preserve `remark-gfm`, `defer`, memoized ordinary components, and the existing offscreen/stream rendering behavior.

- [ ] Add presentation accessibility assertions for localized source toggle/copy labels, LTR source under Hebrew, and absence of a Run button.

- [ ] Run `bun test components/assistant-ui/elements/markdown-text.test.tsx components/assistant-ui/elements/presentation-a11y.test.tsx components/assistant-ui/elements/mermaid-diagram.test.tsx`.

- [ ] Commit:

```bash
git add components/assistant-ui/elements/markdown-text.tsx components/assistant-ui/elements/markdown-text.test.tsx components/assistant-ui/elements/presentation-a11y.test.tsx
git diff --cached --check
git commit -m "feat: dispatch mermaid markdown fences"
```

## Task 5: Add deterministic fixtures and browser verification

**Files:**

- Modify: `lib/runtime-adapters/fixture/fixture-scenarios.ts`
- Modify: `lib/runtime-adapters/fixture/fixture-scenarios.test.ts`
- Modify: `lib/runtime-adapters/fixture/fixture-runtime.ts`
- Modify: `e2e/rich.desktop.workspace.spec.ts`
- Modify: `e2e/rtl.workspace.spec.ts`
- Modify: `playwright.opencode.config.ts`
- Modify: `README.md`

- [ ] Add fixture messages for a valid diagram, a streamed incomplete diagram, malformed syntax, and oversized source. Use stable content/IDs and no external network.

- [ ] Test the fixture runtime preserves the Mermaid fence verbatim and completion status changes, rather than translating it into a tool call.

- [ ] Add Playwright assertions for named rendered diagram, source disclosure/copy, no Run button, malformed source with visible error, and Hebrew UI with LTR source.

- [ ] Add an opt-in OpenCode smoke that sends a constrained request for a simple Mermaid flow and verifies the response uses a Mermaid fence. Separately ask for a small chart and verify `render_chart` is still called. This proves prompt capability separation; it must not depend on model wording beyond the fenced language/tool name.

- [ ] Add an AG-UI fake-transport E2E/contract assertion that the system context advertises Mermaid but does not advertise unavailable OpenCode tool names.

- [ ] Run targeted verification:

```bash
bun test lib/runtime-adapters/harness-prompt.test.ts lib/runtime-adapters/fixture/fixture-scenarios.test.ts components/assistant-ui/elements
bunx playwright test e2e/rich.desktop.workspace.spec.ts e2e/rtl.workspace.spec.ts
```

- [ ] Run the full quality gate:

```bash
bun run typecheck
bun run lint
bun test
bun run build
bun run test:e2e
```

- [ ] Inspect the production build output or bundle analyzer supported by the installed Next version and prove Mermaid is absent from the initial conversation chunk and present in a lazy chunk. Record the observation in the implementation handoff; do not add a flaky bundle-size gate.

- [ ] Start only one required fixture server at a time with a PID/cleanup trap. Use `agent-browser` to review valid, loading, failure, source-open, dark, Light, English, Hebrew, and mobile states. Stop all started processes before finishing.

- [ ] Update `README.md`: fenced Mermaid syntax, security/fallback behavior, capability-aware harness, runtime delivery differences, OpenCode plugin restart expectations, and the fact that Agent definitions remain OpenCode-native.

- [ ] Commit:

```bash
git add lib/runtime-adapters/fixture/fixture-scenarios.ts lib/runtime-adapters/fixture/fixture-scenarios.test.ts lib/runtime-adapters/fixture/fixture-runtime.ts e2e/rich.desktop.workspace.spec.ts e2e/rtl.workspace.spec.ts playwright.opencode.config.ts README.md
git diff --cached --check
git commit -m "test: verify mermaid and harness integration"
```

## Definition of done

- Completed Mermaid fences render locally, lazily, strictly, accessibly, and theme-aware.
- Streaming, malformed, oversized, stale, and failed diagrams always retain escaped/copyable source.
- No Mermaid callback, external asset, arbitrary HTML, or browser-side generated code is executed.
- Every runtime receives one prompt that advertises only its actual capabilities.
- OpenCode structured tools and native interactions remain distinct from Mermaid Markdown.
- Root `AGENTS.md`, Agent definition files, tool execution, and provider adapters remain separate concerns.
- Unit, integration, fixture, Playwright, opt-in OpenCode smoke, build chunk inspection, and `agent-browser` checks pass.
