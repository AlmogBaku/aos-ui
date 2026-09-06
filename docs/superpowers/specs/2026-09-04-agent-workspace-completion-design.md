# Agent Workspace Completion Design

**Date:** 2026-09-04
**Status:** Approved for implementation planning

## Goal

Complete the AOS workspace without changing its locked visual direction: an elegant, spacious, macOS-native-feeling shadcn interface with AOS's restrained brand tint. This increment adds a real Agent Builder lifecycle, a collapsible inspector and appearance controls, safe Mermaid rendering, and one provider-neutral harness prompt that tells Agents which presentation capabilities are actually available.

The existing runtime boundary remains intact. Assistant UI owns thread and run state; `WorkspaceAdapter` supplies workspace concepts; OpenCode remains the primary provider; AG-UI degrades honestly when host capabilities are absent; fixtures remain deterministic.

## Decisions

### Keep OpenCode-native Agent storage

Ready Agents remain native OpenCode definitions:

- configuration-owned Agents may live in `opencode.json`;
- project Agents created by the Builder live at `.opencode/agents/<agent-id>.md`;
- the Agent file's frontmatter carries OpenCode metadata and permissions;
- the file body contains that Agent's identity and operating instructions.

AOS will not introduce a folder-per-Agent format, a second Agent registry, or a new canonical `.aos-ui/agents` store. The root `AGENTS.md` also remains unrelated to product Agents.

### Hide the infrastructure Builder, show provisional Agents

`agent-builder` is an infrastructure Agent, not a user Agent. It is provider-native but hidden from the normal catalog. Every click on Create Agent starts a fresh Builder session and projects that session into the workspace as one provisional Agent.

The projected Agent has:

- UI ID `draft:<builder-thread-id>`;
- display name `New Agent` until promotion;
- exactly one visible Session, backed by that Builder thread;
- a no-Agent glyph with a stable color derived from the Builder thread ID;
- a lifecycle phase, not a fabricated provider status;
- persistence derived from OpenCode session metadata, including after 12 hours.

OpenCode retains the thread's immutable raw owner, `agent-builder`. The workspace adapter projects its visible owner as the draft ID only at the AOS boundary. `OpenCodeSessionOwnership` keeps raw provider ownership so events cannot bleed into another thread.

### Builder lifecycle

```text
Create Agent
    |
    v
interview --waiting-for-input--> interview
    ^
    | retry kickoff
start-failed
    |
    | create_agent succeeds
    v
activating --provider reload/verification--> promoted
    |                                      |
    | failure                              v
    +-------------------------------> activation-failed
                                           |
                                           +-- retry --> activating

interview/start-failed --explicit delete--> deleted
```

On each Create Agent action, the adapter:

1. verifies the hidden `agent-builder` exists;
2. creates a new OpenCode session with title `New Agent` and versioned draft metadata;
3. immediately sends the exact user message `Hey, let's build a new agent.`;
4. returns both the Builder thread ID and projected draft Agent ID;
5. selects the provisional Agent and its sole Session.

If kickoff delivery fails, the session remains visible in `start-failed`. Retry first inspects the session transcript so an accepted-but-disconnected request cannot duplicate the exact kickoff. Only `interview` and `start-failed` drafts are deletable.

The Builder prompt requires it to read and follow `.agents/skills/grilling/SKILL.md`, conduct a brief adaptive interview through OpenCode's native question tool, choose a suitable identity/configuration, seek one final confirmation, and call one allowlisted `create_agent` tool. The exact Grilling skill directory is an intentional tracked product dependency even though other local `.agents` artifacts remain ignored. Direct file editing and shell access remain denied to the Builder.

`create_agent` is the only creation authority. It validates a traversal-safe slug, human display name, and bounded configuration; checks at runtime that the caller is `agent-builder`; writes `.opencode/agents/<agent-id>.md` relative to the trusted OpenCode worktree exclusively without overwriting an existing Agent; and returns versioned result metadata. A validated `aos_ui_name` option preserves the human display name while the filename remains the provider Agent ID. Promotion is triggered only by that typed result. AOS never infers completion from prose or merely watches for files.

After the Builder run and every AOS-observed session in the same directory are idle, a short activation barrier prevents AOS from starting another send while the OpenCode adapter disposes the directory instance. The adapter immediately re-lists Agents to lazily rehydrate configuration, verifies the exact created Agent as a non-hidden primary Agent, then creates or reuses one first ordinary Session carrying draft-provenance metadata. The provisional rail row is replaced in place by the ready Agent and its new runnable Session is selected only if that draft is still foreground. The immutable hidden Builder transcript remains provider-owned read-only audit history; it does not become a runnable Session of the new Agent.

If reload, verification, or first-Session creation fails, the draft remains visible in `activation-failed` with an explicit retry action. Versioned metadata includes a monotonic revision, candidate Agent ID, and first-Session provenance. Retry searches for and reuses a matching first Session before creating one, making recovery idempotent per adapter even if a response was lost. OpenCode exposes no compare-and-swap across independent clients, so cross-client exactly-once creation is not claimed. A successful `create_agent` result may be rediscovered from the draft transcript only as a typed completed tool state if the session metadata update was interrupted.

Deleting a draft is explicit and confirmed. An `interview` or `start-failed` draft deletes its Builder session. Once the Agent file has been created, AOS offers activation retry rather than silently deleting or orphaning the definition.

### Shared harness prompt, provider-specific delivery

`buildAosUiHarnessPrompt(capabilities)` is the single pure source of product presentation guidance. It is not a provider registry and does not contain an Agent's identity or domain instructions.

Common guidance covers:

- ordinary Markdown conventions;
- fenced Mermaid diagrams and their limits;
- no HTML, scripts, or browser-executable code;
- Plans are message artifacts, while Todos are provider-owned execution state;
- questions, permissions, Todos, and subagents must use provider-native controls;
- Monty is mentioned only when its MCP capability is advertised.

Capability manifests carry exact advertised tool IDs, not booleans. OpenCode receives `render_chart`, `render_map`, `render_stats`, and `present_plan` when those tools are present. The current AG-UI host contract has no presentation-capability endpoint, so AG-UI receives common Markdown/Mermaid guidance only; it is never told OpenCode tool names.

Delivery differs only at the provider seam:

- fixture and AG-UI mount Assistant UI instructions through `useAssistantInstructions`;
- OpenCode uses a project plugin hook, `experimental.chat.system.transform`, importing the same runtime-neutral builder through a fixed relative path, because the installed Assistant UI OpenCode adapter does not forward client system context;
- OpenCode does not also mount the client instruction component, preventing duplicate guidance;
- `.opencode/chart-instructions.md` and the corresponding `opencode.json.instructions` entry are replaced by the shared prompt seam.

Agent definitions, tool schemas, and transport code therefore stay detached: Agent files describe who an Agent is; the harness prompt describes the product surface; tool files validate and execute calls; provider adapters deliver the prompt.

### Mermaid is Markdown, not a tool

Agents may emit fenced `mermaid` blocks inside ordinary Markdown. No `render_diagram` tool is added.

The renderer:

- dispatches only the `mermaid` language through Assistant UI's Markdown language-component API;
- shows escaped source while the message part is streaming;
- imports the local Mermaid package only after the part is complete;
- enforces a source-length limit before parsing;
- initializes Mermaid with strict security and no automatic rendering;
- serializes initialization/rendering through a module queue because Mermaid configuration is singleton state;
- ignores Mermaid interaction binders and never evaluates arbitrary browser code;
- sanitizes the returned SVG before insertion, removing active/embedded content, event attributes, non-fragment links, and external CSS URLs/imports;
- uses a stable per-instance ID and discards stale async renders;
- rerenders when the resolved light/dark theme changes;
- supplies a localized accessible name while treating the generated SVG as decorative;
- always offers a copyable source disclosure;
- shows source plus an explicit localized error for malformed or oversized input;
- keeps diagram content and source LTR while preserving labels verbatim;
- makes no CDN, font, image, link, or other network request from rendered SVG.

The initial bounds are 20,000 source characters and 400 lines. These bounds reduce accidental complexity but are not presented as complete denial-of-service protection because Mermaid parsing can perform synchronous work.

Chart, map, and stats remain structured tools because they need validated data and dedicated accessible alternatives. Mermaid is the slicker choice for explanatory flows and relationships expressed in prose.

### Shell preferences

The desktop inspector is open by default. A direction-aware icon at the inline end of the Session tab bar hides or shows it. Hiding it expands the conversation without changing the selected Agent or Session. The choice persists locally and storage failures fall back to open. Mobile retains the existing focus-managed details drawer; its state is independent.

Appearance controls use shadcn's single-select toggle group with Light, System, and Dark icons. System is the default, follows OS changes live, and is persisted by `next-themes`. The current undocumented `D` keyboard shortcut is removed.

The EN/HE control shows the destination language, replaces the existing locale path segment rather than prefixing another one, and preserves query and hash. Before navigation it writes a versioned, short-lived, one-shot session-storage handoff containing the selected Agent and Session. The localized workspace validates ownership after loading, restores the selection when valid, and consumes the handoff. The document updates `lang`, `dir`, localized labels, and RTL-sensitive icons.

The controls live in the Agent rail footer, which also makes them available inside the mobile Agents drawer without crowding the conversation toolbar. The right inspector continues to show only Agent identity, description, status, and sessions—never skills or tools.

## Shared contracts

The narrow contract gains lifecycle data and actions without becoming a state framework:

```ts
type ReadyAgentSummary = AgentSummaryBase & {
  kind: "ready"
}

type ProvisionalAgentSummary = AgentSummaryBase & {
  kind: "provisional"
  builderThreadId: string
  phase: "interview" | "start-failed" | "activating" | "activation-failed"
  lastError?: string
}

type AgentSummary = ReadyAgentSummary | ProvisionalAgentSummary

type AgentBuilderResult = {
  threadId: string
  draftAgentId: string
}

type AgentLifecycleEvent =
  | {
      type: "draft-created"
      draftAgentId: string
      threadId: string
      revision: number
    }
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

`WorkspaceAdapter` adds typed Builder creation, lifecycle subscription, retry, and deletion methods. `WorkspaceCapabilities` exposes them explicitly. AG-UI reports them unavailable unless its host implements equivalent endpoints; its UI never pretends local creation succeeded.

`isBuilder` is removed from the public Agent summary. Infrastructure Builders are hidden at the provider boundary rather than tagged in the visible catalog. Existing AG-UI host Agent payloads are normalized to `kind: "ready"`, so this increment does not impose a breaking host schema change.

Session metadata remains authoritative. Provisional projection occurs only for Builder threads carrying valid, versioned AOS draft metadata. Unknown Builder sessions stay hidden rather than appearing as user Agents.

## Failure and concurrency rules

- Two rapid Create Agent actions create two distinct drafts and two Builder sessions.
- Repeated activation events are idempotent; at most one ready Agent definition and one first Session are selected.
- Delayed lifecycle or stream events retain their originating thread and cannot select a different visible Session.
- Deleted drafts ignore lifecycle events whose revision is not newer than the locally observed revision.
- A missing Builder produces a retryable workspace error; no blank local Agent is fabricated.
- Invalid Builder metadata is ignored and reported through adapter diagnostics, not rendered as an Agent.
- A name collision fails creation visibly and never overwrites an Agent file.
- Provider disposal waits for all AOS-observed directory sessions to become idle, rejects/holds AOS sends during its short activation barrier, and remains best-effort against unknown external clients.
- The experimental OpenCode prompt hook is protected by unit tests, startup/load errors, and an opt-in live smoke. The current provider exposes no reliable client-visible plugin-health handshake, so the UI does not claim one.
- Mermaid parse, import, theme-change, and unmount races resolve to either the newest valid SVG or the explicit source fallback.

## Accessibility and visual behavior

- Provisional Agent state is conveyed by text as well as its neutral `unassigned` glyph/color.
- Waiting for user input remains orange; running remains a reduced-motion-aware green breathing indicator; idle has no dot.
- The no-Agent color is decorative and never the only status cue.
- Inspector collapse retains focus on its trigger and uses `aria-controls` and `aria-expanded`.
- Theme and locale controls have localized tooltips, selected-state semantics, and 44px effective touch targets.
- Light and dark semantic tokens meet contrast expectations without changing the locked spacing, rounded shell, tab treatment, or typography.
- Mermaid source is the textual alternative and remains reachable by keyboard.

## Verification strategy

Use test-driven changes at every boundary:

- adapter and pure-function unit tests for draft projection, lifecycle idempotency, locale replacement, prompt capabilities, and Mermaid validation;
- component tests with real fixture runtime for creation, promotion, failure recovery, inspector/theme/locale controls, streaming Mermaid, and fallbacks;
- fake-transport contract coverage for OpenCode and AG-UI capability degradation;
- Playwright journeys for Builder creation/promotion, persisted shell preferences, English/Hebrew, and Mermaid accessibility;
- opt-in OpenCode smoke coverage for ownership, harness tool discovery, and rich-tool invocation; live Builder creation, project-instance disposal/reload, native-question completion, and Agent discovery remain a separately invoked destructive manual journey using a unique Agent ID and exact scoped cleanup;
- `agent-browser` review of the running fixture and OpenCode modes after automated checks;
- a production build inspection confirming Mermaid is code-split from the initial chat bundle.

## Not in scope

- A AOS-specific folder-per-Agent storage format.
- Moving or rewriting existing OpenCode Agent definitions.
- A provider registry, event bus, runtime hot-switcher, or parallel chat state store.
- Browser execution of Mermaid callbacks, Monty, generated code, or arbitrary HTML.
- Converting charts, maps, stats, Plans, questions, permissions, Todos, or subagents into Markdown conventions.
- Adding Agent skills/tools to the right inspector.
- Custom message virtualization or speculative performance infrastructure.

## Implementation plans

The work is split into three reviewable plans:

1. `2026-09-04-agent-builder-lifecycle.md`
2. `2026-09-04-workspace-shell-preferences.md`
3. `2026-09-04-mermaid-harness-instructions.md`

Builder lifecycle, shell routing, and harness-prompt work can begin independently. Mermaid theme-aware rendering integrates after the shell's `ThemeProvider` foundation. The Builder plan owns lifecycle contract edits; the harness capability type remains in its runtime-neutral prompt module to avoid a contract collision.
