# Agent Builder Lifecycle Implementation Plan

> **For the implementing agent:** REQUIRED SKILLS: use `executing-plans`, `test-driven-development`, `assistant-ui`, `runtime`, `thread-list`, `tools`, `shadcn`, and `verification-before-completion`. Read each selected `SKILL.md` completely before changing code.

**Goal:** Make every Create Agent click open a distinct, persistent provisional Agent backed by the hidden OpenCode `agent-builder`, then promote it deterministically into a native project Agent and its first normal Session.

**Architecture:** OpenCode keeps raw ownership of Builder sessions. `WorkspaceAdapter` projects a valid Builder draft session as a provisional Agent with exactly one Session, and emits typed lifecycle events. A single allowlisted `create_agent` tool writes a native `.opencode/agents/<id>.md` file and returns structured completion metadata; the adapter waits for safe provider reload, verifies discovery, creates the first normal Session, and replaces the draft in the UI. No prose parsing, local CRUD registry, or folder-per-Agent format is introduced.

**Tech stack:** Next.js 16.2.6, React 19, TypeScript, Assistant UI, `@assistant-ui/react-opencode` 0.2.22, OpenCode SDK/plugin 1.18.27, shadcn/Base UI, Vitest, Testing Library, Playwright.

**Design reference:** `docs/superpowers/specs/2026-09-04-agent-workspace-completion-design.md`

**Worktree safety:** The current application is mostly untracked relative to the initial commit. Do not stage or commit implementation files while executing this plan unless the user separately authorizes a baseline/commit. After every task, inspect only the named paths with `git status --short -- <paths>` and run `git diff --check`; preserve all unrelated work.

---

## Task 1: Lock the lifecycle contract with failing tests

**Files:**

- Modify: `lib/runtime-adapters/contracts.ts`
- Modify: `lib/runtime-adapters/workspace-state.ts`
- Modify: `lib/runtime-adapters/workspace-state.test.ts`
- Modify: `lib/runtime-adapters/opencode/workspace-adapter.contract.ts`
- Modify: `lib/runtime-adapters/ag-ui/ag-ui-http-transport.ts`
- Modify: `lib/runtime-adapters/ag-ui/ag-ui-http-transport.test.ts`
- Modify: `lib/runtime-adapters/ag-ui/ag-ui-workspace.test.ts`
- Modify: `lib/runtime-adapters/fixture/fixture-workspace.ts`
- Modify: `lib/runtime-adapters/fixture/fixture-workspace.test.ts`
- Modify: `lib/runtime-adapters/opencode/opencode-workspace.test.ts`
- Modify: `components/aos-ui-workspace.test.tsx`
- Modify: `components/workspace/workspace-shell.test.tsx`

- [ ] Read `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` and the installed OpenCode SDK declarations for session create/update/delete, session metadata, message-part events, session status, and instance disposal before writing implementation code.

- [ ] In `workspace-state.test.ts`, first add failing capability assertions for Builder creation, draft deletion, draft retry, and lifecycle subscription. Keep the minimum and AG-UI adapters explicitly false when those methods are absent.

- [ ] Change `AgentSummary` into a discriminated union while retaining the existing shared fields:

```ts
type AgentSummaryBase = {
  id: string
  name: string
  description?: string
  status?: AgentStatus
  icon?: AgentIcon
}

type AgentSummary =
  | (AgentSummaryBase & { kind: "ready" })
  | (AgentSummaryBase & {
      kind: "provisional"
      builderThreadId: string
      phase: "interview" | "start-failed" | "activating" | "activation-failed"
      lastError?: string
    })
```

- [ ] Add `unassigned` to `AgentIconName`, plus these contracts:

```ts
type AgentBuilderResult = { threadId: string; draftAgentId: string }

type AgentLifecycleEvent =
  | { type: "draft-created"; draftAgentId: string; threadId: string; revision: number }
  | { type: "draft-updated"; draftAgentId: string; revision: number }
  | {
      type: "draft-promoted"
      draftAgentId: string
      agentId: string
      threadId: string
      revision: number
    }
  | { type: "draft-deleted"; draftAgentId: string; revision: number }
```

- [ ] Change `openAgentBuilder` to return `AgentBuilderResult`; add optional `deleteAgentDraft`, `retryAgentDraft`, and `subscribeAgentLifecycle` methods. Extend `WorkspaceCapabilities` with matching booleans without adding a registry or state store.

- [ ] Remove public `isBuilder`; infrastructure builders will be excluded at the provider boundary. Update fixture/OpenCode test data so every ready Agent declares `kind: "ready"`. In the AG-UI HTTP decoder, normalize legacy host payloads without `kind` to `kind: "ready"` so the host contract remains backward compatible; reject host-supplied provisional objects because AG-UI draft lifecycle is unsupported in this increment.

- [ ] Run `bun test lib/runtime-adapters/workspace-state.test.ts lib/runtime-adapters/opencode/workspace-adapter.contract.ts` and confirm the new lifecycle assertions fail for missing behavior before completing the production type changes.

- [ ] Run `bun run typecheck` and repair only direct discriminant fallout in the listed test fixtures. Keep the behavior tests red. Finish with `git status --short --` for the listed paths and `git diff --check`; do not stage them.

## Task 2: Implement a safe native Agent-definition writer

**Files:**

- Create: `.opencode/lib/agent-definition.ts`
- Create: `.opencode/lib/agent-definition.test.ts`
- Create: `.opencode/tools/create_agent.ts`
- Modify: `.gitignore`
- Modify: `opencode.json`

- [ ] Add failing tests for the pure writer using one `mkdtemp` directory per case. Cover a valid definition, invalid/reserved slug, `/` and `..` traversal, missing/oversized text, unsupported permission keys, YAML delimiter/newline injection, and exclusive no-overwrite behavior.

- [ ] Put `// @vitest-environment node` on the filesystem test. Define a bounded input shape. The Agent chooses a provider `agentId`, a separate human display `name`, `description`, operating prompt, optional installed model ID, and permissions from a fixed allowlist. Do not accept arbitrary frontmatter or filesystem paths.

- [ ] Implement `normalizeAgentDefinition(input)` and `writeAgentDefinition(worktree, input)` in `.opencode/lib/agent-definition.ts`. Validate `agentId` with a conservative lowercase slug expression, reject `agent-builder` and existing paths, serialize fixed frontmatter including validated `aos_ui_name`, resolve and verify that the final path remains under `<worktree>/.opencode/agents`, create with exclusive `wx`, and close handles in `finally`.

- [ ] Implement `.opencode/tools/create_agent.ts` with the same Zod schema and `execute(args, context)`. Reject unless `context.agent === "agent-builder"`, use `context.worktree` as the trusted root, obtain `draftThreadId` from `context.sessionID`, call the writer, and return:

```ts
{
  title: `Created ${args.agentId}`,
  output: `Agent ${args.agentId} is ready for activation.`,
  metadata: {
    aos_ui: {
      version: 1,
      kind: "agent-created",
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      draftThreadId: context.sessionID,
    },
  },
}
```

- [ ] Narrow `.gitignore` so all `.agents` artifacts remain ignored except `.agents/skills/grilling/SKILL.md` and its required `agents/openai.yaml`. Confirm `git check-ignore` reports those two files as trackable. This makes the required interview behavior available in a clean checkout.

- [ ] Update `opencode.json`: set `agent-builder.hidden` to `true`; tell it to read and follow `.agents/skills/grilling/SKILL.md`, interview briefly using native `question`, choose the final definition, confirm once, and call `create_agent`. Deny Builder `edit` and `bash`; allow only required read/list/question/create-agent operations. Do not ask it to restart OpenCode.

- [ ] Set top-level `create_agent` permission to `deny` and override it to `allow` only under `agent.agent-builder.permission`. Add tests for both the config projection and the tool's defense-in-depth rejection when a non-Builder invokes `execute` directly.

- [ ] Run `bun test .opencode/lib/agent-definition.test.ts` and then `bun run typecheck && bun run lint`.

- [ ] Restart the OpenCode server once after adding the tool/config/skill dependency; these configuration-time files are not hot-reloaded. Verify `/experimental/tool/ids` contains `create_agent` before proceeding to adapter lifecycle tests. Finish with `git status --short -- .gitignore .agents/skills/grilling .opencode/lib .opencode/tools/create_agent.ts opencode.json` and `git diff --check`; do not stage them.

## Task 3: Project persistent drafts in the OpenCode adapter

**Files:**

- Create: `lib/runtime-adapters/opencode/agent-draft.ts`
- Create: `lib/runtime-adapters/opencode/agent-draft.test.ts`
- Modify: `lib/runtime-adapters/opencode/opencode-workspace.ts`
- Modify: `lib/runtime-adapters/opencode/opencode-workspace.test.ts`
- Modify: `lib/runtime-adapters/opencode/opencode-session-ownership.ts`

- [ ] Add failing pure-function tests for versioned session metadata parsing, monotonic revisions, `draft:<threadId>` IDs, raw/projected ownership, deterministic icon tone, invalid metadata rejection, promoted/deleted exclusion, and drafts older than 12 hours remaining in the Agent catalog.

- [ ] Add adapter tests proving two calls to `openAgentBuilder()` create two sessions, both titled `New Agent`, both carry independent draft metadata, and both receive exactly one exact prompt: `Hey, let's build a new agent.`. Delete the current session-reuse expectation.

- [ ] Implement versioned `AgentDraftMetadata` guards and projections in `agent-draft.ts`. Include `phase`, `revision`, candidate/first-Session provenance, and `lastError`. Derive the neutral `unassigned` symbol/tone from the thread ID; never store random client state.

- [ ] Make `listAgents()` fetch provider Agents and unarchived root sessions in parallel. Return non-hidden primary/all Agents as `kind: "ready"`, never return the infrastructure Builder, and append only sessions with valid AOS draft metadata as `kind: "provisional"` regardless of age. Read a bounded string from `agent.options.aos_ui_name` as the display name, falling back to the provider Agent ID.

- [ ] Make `getSessionMetadata()` project a valid Builder draft thread's visible `agentId` to its `draft:<threadId>` ID. Keep the ownership cache's raw value as `agent-builder`, and assert delayed provider events still address only their source thread.

- [ ] Rewrite `openAgentBuilder()` to locate the hidden Builder explicitly, call `session.create` with title and versioned metadata, remember raw ownership, send the kickoff with `promptAsync`, and return `{ threadId, draftAgentId }`. If kickoff fails after session creation, persist `start-failed` and surface the draft. For an ambiguous accepted-but-client-failed response, query `session.messages` and match the exact user text before retrying so kickoff is never duplicated.

- [ ] Implement `retryAgentDraft()` for `start-failed`: inspect transcript, resend kickoff only when absent, and return the draft to `interview`. Implement `deleteAgentDraft()` only for `interview`/`start-failed` using the OpenCode session delete endpoint. Validate projected ID, revision, and metadata before deletion. Do not permit deletion after a successful Agent definition result has been observed.

- [ ] Add an outbound retry/send test proving that `ownership.remember(threadId, "agent-builder")` happens before returning projected metadata and that the scoped OpenCode client still sends `agent: "agent-builder"` after reload.

- [ ] Run `bun test lib/runtime-adapters/opencode/agent-draft.test.ts lib/runtime-adapters/opencode/opencode-workspace.test.ts` and `bun run typecheck`.

- [ ] Finish with `git status --short -- lib/runtime-adapters/opencode/agent-draft.ts lib/runtime-adapters/opencode/agent-draft.test.ts lib/runtime-adapters/opencode/opencode-workspace.ts lib/runtime-adapters/opencode/opencode-workspace.test.ts lib/runtime-adapters/opencode/opencode-session-ownership.ts` and `git diff --check`; do not stage them.

## Task 4: Activate and promote drafts idempotently

**Files:**

- Create: `lib/runtime-adapters/opencode/agent-activation.ts`
- Create: `lib/runtime-adapters/opencode/agent-activation.test.ts`
- Modify: `lib/runtime-adapters/opencode/opencode-workspace.ts`
- Modify: `lib/runtime-adapters/opencode/opencode-workspace.test.ts`

- [ ] Extend the fake OpenCode transport with message-part events, `session.status`/`session.idle` events, metadata update, first-Session provenance, `instance.dispose`, Agent catalog mutation after disposal, and controlled failures.

- [ ] Write failing tests for this exact ordering:

```text
typed create_agent result
  -> persist candidate + activating phase
  -> wait until all AOS-observed directory sessions are idle
  -> enter a short scoped-client send barrier
  -> dispose current directory instance
  -> immediately re-list Agents to rehydrate config
  -> verify exact ready Agent
  -> find or create one provenance-marked first normal Session
  -> persist promoted + normal thread
  -> emit draft-promoted
```

- [ ] Also test duplicate tool updates, reconnect replay, reload during activation, disposal failure, verification failure, response loss after first-Session creation, metadata-update failure, retry, and an unrelated Session streaming while activation is requested. Activation remains pending until observed statuses are safe. During the disposal barrier, sends through AOS's scoped client fail visibly/retryably or queue by one documented policy; external OpenCode clients remain outside this guarantee.

- [ ] Implement strict guards for `message.part.updated.properties.part`: require `part.type === "tool"`, `part.tool === "create_agent"`, `part.state.status === "completed"`, and valid metadata at `part.state.metadata.aos_ui` whose `draftThreadId` matches the event session. Reject top-level metadata spoofs, malformed states, wrong sessions, and replayed call IDs. Never parse assistant prose or infer from a file watcher.

- [ ] Persist every transition through OpenCode's session metadata update. Use an in-memory revision only to suppress duplicate work during the current process; persisted metadata is authoritative after reload.

- [ ] Implement `subscribeAgentLifecycle()` and keep the official event source alive while lifecycle listeners exist. Carry the persisted revision on every event; ignore stale revisions and tombstoned deleted sessions. Ensure unsubscribe invalidates queued async work for that listener.

- [ ] Implement activation retry for `activation-failed`. Re-verify a typed successful tool result/candidate, resume from the last persisted phase, and search all root Sessions for `{ aos_ui: { kind: "agent-first-session", draftThreadId } }` before creating. A new first Session is created with that metadata and its ID is persisted immediately. State the guarantee as idempotent per adapter/provider metadata; OpenCode provides no cross-client compare-and-swap.

- [ ] On startup/catalog refresh, recover interrupted activation from valid metadata. Scan `session.messages` only when metadata lacks a candidate after a known interruption and accept only the identical nested completed-tool-state guard.

- [ ] Run `bun test lib/runtime-adapters/opencode/agent-activation.test.ts lib/runtime-adapters/opencode/opencode-workspace.test.ts` repeatedly, including `--repeat=3` if supported by the installed Vitest CLI, then `bun run typecheck && bun run lint`.

- [ ] Finish with `git status --short -- lib/runtime-adapters/opencode/agent-activation.ts lib/runtime-adapters/opencode/agent-activation.test.ts lib/runtime-adapters/opencode/opencode-workspace.ts lib/runtime-adapters/opencode/opencode-workspace.test.ts` and `git diff --check`; do not stage them.

## Task 5: Make fixtures model the complete lifecycle

**Files:**

- Modify: `lib/runtime-adapters/fixture/fixture-workspace.ts`
- Modify: `lib/runtime-adapters/fixture/fixture-workspace.test.ts`
- Modify: `lib/runtime-adapters/fixture/fixture-runtime.ts`
- Modify: `lib/runtime-adapters/fixture/fixture-scenarios.ts`

- [ ] Replace the one static Builder Session with deterministic draft creation. Add failing tests for distinct drafts, exact kickoff content, one Session per draft, an old persisted draft, waiting state, activation failure/retry, deletion, and promotion.

- [ ] Add fixture controls that emit the same public `AgentLifecycleEvent` values as OpenCode. Keep stable IDs and the injected fixture clock; do not add timers or parse model prose.

- [ ] Script the Builder interview through the existing native question presentation, then a deterministic creation success. Add a separate activation-failure scenario.

- [ ] Make promotion remove the provisional Agent, add one `kind: "ready"` Agent, add/select one normal Session, and preserve the hidden Builder transcript outside the visible catalog.

- [ ] Run `bun test lib/runtime-adapters/fixture/fixture-workspace.test.ts lib/runtime-adapters/fixture/fixture-scenarios.test.ts`.

- [ ] Commit:

```bash
git add lib/runtime-adapters/fixture
git diff --cached --check
git commit -m "test: model agent builder lifecycle in fixtures"
```

## Task 6: Integrate drafts into workspace selection and UI

**Files:**

- Modify: `components/aos-ui-workspace.tsx`
- Modify: `components/aos-ui-workspace.test.tsx`
- Modify: `components/workspace/workspace-shell.tsx`
- Modify: `components/workspace/workspace-shell.module.css`
- Modify: `components/workspace/workspace-shell.test.tsx`
- Modify: `lib/i18n/dictionary.ts`
- Modify: `lib/i18n/en.ts`
- Modify: `lib/i18n/he.ts`
- Add through shadcn if absent: `components/ui/alert-dialog.tsx`

- [ ] Add failing component tests: Create Agent adds and selects `New Agent`; the infrastructure Builder is absent; a second click creates a second draft; each draft shows one tab; an old draft remains visible; waiting/running indicators use existing semantics; promotion selects the ready Agent and first Session; activation failure exposes Retry; deleting an eligible draft confirms, restores focus, and cannot affect another draft.

- [ ] Change `AosUiWorkspace.openAgentBuilder()` to consume `{ threadId, draftAgentId }`, refresh catalog/session data, select the draft, and manually open its sole thread. Do not resolve its owner back to `agent-builder`.

- [ ] Subscribe to lifecycle events. For `draft-promoted`, refresh the provider catalog and Assistant UI thread list, remove stale per-draft selection/dismissal state, select the ready Agent, and select the returned first Session only if the event belongs to the current draft. Background promotion must not steal focus.

- [ ] Bypass normal `<12h` tab eligibility only for a provisional Agent's one Builder thread. Ready-Agent tabs continue using the existing recency/running/waiting/manual-open rules.

- [ ] Add the `bot`/no-Agent glyph to the existing icon component. Reuse the stable adapter tone and the locked rounded icon treatment. Do not add a new card style.

- [ ] Add localized provisional phase text, creation/activation errors, Retry, Delete draft, confirmation, and cancellation labels in English and Hebrew. Preserve `dir="auto"` for names and descriptions.

- [ ] Add a restrained draft action in the existing Agent/inspector surface. Use shadcn Alert Dialog for destructive confirmation; show no delete action once creation succeeded.

- [ ] Run `bun test components/aos-ui-workspace.test.tsx components/workspace/workspace-shell.test.tsx` and keyboard-test the confirm/cancel/focus paths.

- [ ] Commit:

```bash
git add components/aos-ui-workspace.tsx components/aos-ui-workspace.test.tsx components/workspace components/ui/alert-dialog.tsx lib/i18n
git diff --cached --check
git commit -m "feat: add provisional agents to workspace"
```

## Task 7: Verify fixture and real OpenCode journeys

**Files:**

- Modify: `e2e/desktop.workspace.spec.ts`
- Modify: `e2e/mobile.workspace.spec.ts`
- Create: `e2e/agent-builder.workspace.spec.ts`
- Modify: `playwright.opencode.config.ts`
- Modify: `README.md`

- [ ] Add fixture Playwright coverage for create, native question, distinct second draft, persistence beyond 12 hours, cancellation/delete, successful promotion, activation failure/retry, and keyboard focus restoration.

- [ ] Add an opt-in OpenCode smoke that uses a unique test Agent ID, verifies the exact kickoff, answers the Builder flow, observes the typed creation receipt, disposes/reloads the directory instance, discovers the Agent, and opens its first Session. Cleanup must delete only the unique test definition/session and dispose once more; never glob-delete `.opencode/agents`.

- [ ] Pin the smoke assertion to installed OpenCode/plugin 1.18.27 behavior and document that the project plugin/provider must be restarted after its own code changes. Keep live Bedrock use opt-in through existing environment configuration.

- [ ] Run the targeted suites:

```bash
bun test lib/runtime-adapters/opencode lib/runtime-adapters/fixture components/aos-ui-workspace.test.tsx components/workspace/workspace-shell.test.tsx
bunx playwright test e2e/agent-builder.workspace.spec.ts
```

- [ ] Run the full quality gate:

```bash
bun run typecheck
bun run lint
bun test
bun run build
bun run test:e2e
```

- [ ] Start only the required dev/provider processes, record their PIDs, and stop them in `finally`/shell traps. Never leave background Next or OpenCode servers running.

- [ ] Use `agent-browser` against EN desktop, HE desktop, and one mobile viewport. Verify the provisional identity, native question, one-tab rule, promotion, error/retry, delete confirmation, focus restoration, and no hidden Builder entry.

- [ ] Update `README.md` with the OpenCode Builder setup, native storage path, lifecycle behavior, optional Bedrock smoke command, and cleanup safety.

- [ ] Commit verification and documentation:

```bash
git add e2e playwright.opencode.config.ts README.md
git diff --cached --check
git commit -m "test: verify agent builder end to end"
```

## Definition of done

- Every plus click produces one new provisional Agent and one fresh Builder Session.
- `agent-builder` is never visible as a normal Agent.
- The exact kickoff is sent once per draft.
- Drafts persist independent of Session recency and are explicitly deletable before creation.
- The Builder uses the Grilling skill and native questions, then one validated creation tool.
- Promotion is typed, idempotent, provider-verified, and selects one first normal Session.
- All production failure phases are visible and retryable.
- Fixture, unit, component, Playwright, opt-in OpenCode smoke, and `agent-browser` checks pass.
