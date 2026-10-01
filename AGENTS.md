# AOS-ui agent guide

## Read first

- `README.md` is the operator entry point. Keep its commands aligned with
  `package.json`, the Compose files, and the environment examples; follow
  `docs/README.md` for the maintained operator documentation map.
- Hermes, OpenClaw, and OpenCode are independently installed and operated
  runtimes. Hermes is the primary and first-supported harness. AOS attaches to
  native servers; treat repository launchers and runtime overlays as optional
  development conveniences.
- `PRODUCT.md` defines product terminology, ownership, scope, and accessibility
  commitments.
- `docs/design/agent-workspace-design-lock.md` is the visual design authority.
  Preserve its direction unless the task explicitly changes it.
- `DESIGN.md` defines reusable component rules. Read **Conversation and
  Execution** before changing tool timelines, reasoning, rich tool placement,
  conversation search, or their responsive presentation.
- `src/runtime-adapters/contracts.ts` is the browser runtime boundary;
  `packages/proxy/core/runtime.ts` is the server adapter boundary;
  `packages/protocol/acp.ts` is the browser-wire contract. Read
  `docs/development/runtime-adapter-authoring.md` before adding, auditing, or
  debugging a server runtime adapter, and keep provider details behind the
  corresponding boundary.

## Install and run

Use Bun for the JavaScript toolchain.

```bash
bun install
```

A fresh worktree, and a checkout whose dependencies predate a new package, each
need their own `bun install`.

Run fixture mode for backend-free UI work:

```bash
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

For local proxy development, run the proxy against an independently operated
Hermes server, then attach Vite to the normalized proxy:

```bash
bun run proxy:serve -- --config /absolute/private/path/proxy.yaml
```

With no `--config`, the proxy discovers `${XDG_CONFIG_HOME:-$HOME/.config}/aos-ui/proxy.yaml`.

```bash
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_PROXY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

Open `http://localhost:3000`; compact Agent/Session URLs preserve local EN/HE preference.
Copy `.env.example` to `.env.local` only for local overrides.

Run the production containers:

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json docker compose up --build
```

Compose is loopback-only by default. Treat any wider operator binding as a
trusted-private-network deployment: this stack has no TLS or public multi-user
authentication. The Bun proxy serves static assets and normalized APIs; an
external reverse proxy is optional.

## Architecture and invariants

- Assistant UI owns threads, messages, runs, branches, composer state, and
  thread lifecycle. `WorkspaceAdapter` adds Agent catalog access and Agent
  updates (visibility and avatar), Session metadata (including `unread` read
  state), creator identity,
  Todos subscription, catalog/metadata/activity subscriptions, `markSessionRead`,
  and `reportFocus`. Session Todos arrive
  as ACP `plan_update` notifications carrying `_meta.aos.todos`. Creation opens
  an ordinary creator-owned Session through `New Agent` that the browser alone
  projects as a `New Agent` draft row until a creator run ends with a new Agent
  in the refreshed catalog; the hidden creator stays out of the roster and
  management surfaces, and creation never transfers ownership or starts the
  created Agent's first Session. The creator writes the Agent with its
  harness's own CLI or files, following `shared/agent-creator/reference/`.
- Provider data is authoritative. Every Session belongs to one Agent; delayed
  events stay scoped to their originating Agent and Session. Todos are
  Session-scoped.
- Runtime selection is strict. Fixture data appears only in explicit `fixture`
  mode; invalid provider configuration renders unavailable state instead of
  falling back to synthetic data. Public fixtures intentionally omit Agent
  creation; configured real runtimes may expose the hidden creator through
  `New Agent`.
- The browser supports only the normalized `aos` runtime and explicit
  `fixture` mode. The proxy selects one server adapter per deployment; Hermes
  is the primary V1 implementation. OpenClaw and OpenCode adapters keep their
  distinct native transports server-side.
- The three `AOS_UI_OPENAI_COMPATIBLE_*` values (`AOS_UI_OPENAI_COMPATIBLE_BASE_URL`,
  `AOS_UI_OPENAI_COMPATIBLE_API_KEY`, `AOS_UI_OPENAI_COMPATIBLE_MODEL_ID`) are
  all-or-none; setting any one without the others is an error.
- Provider-owned read state: the browser reports the focused Session via a
  `_aos/session/focus` request (the proxy's acknowledgment is the liveness
  check); the runtime decides when that Session becomes read and delivers an
  `unread` update. One ACP WebSocket is opened per browser tab; the browser
  sends its compiled build id in `initialize` and reloads once when the proxy's
  id differs (a `sessionStorage` entry prevents a loop); the proxy closes a
  connection that does not complete `initialize` within 15 s.
  Usage is reported via ACP `usage_update`; model and effort are set via
  `session/set_config_option`.
- A pinned Session is always open. It sits in Open sessions and in the tab
  strip however old it is, leads both, and never appears in History. The pin is
  provider-owned: native `pinned` on Hermes and OpenClaw, and one AOS-owned key
  in the Session's native `metadata` on OpenCode, which has no native flag.
  Closing a pinned tab removes only the tab; its Open sessions row stays so the
  Session cannot become unreachable, and the tab returns when it is next active.
- English LTR and Hebrew RTL are first-class. Update both locales, logical
  layout behavior, accessible labels, keyboard flow, and reduced-motion states
  whenever affected. What triggers a second-locale pass is copy, direction, or
  positioning: a new or changed string, a new control or popover that has to
  mirror, or a layout that stops being expressible in logical properties. A
  change that only moves values on the spacing, type, or radius scale does not
  earn one, because the utilities are already direction-agnostic; verify it once
  in the rendered app and move on.
- Rich output must remain inspectable and safe. Keep textual fallbacks for
  charts, maps, tools, and Mermaid; never execute generated code or
  arbitrary HTML in the browser. The one exception is an MCP App: HTML its own
  MCP server authored as a `ui://` resource, rendered only inside the
  opaque-origin double iframe with a CSP built from its declared domains. The
  browser never talks to an MCP server; every App request goes through the
  proxy, scoped to the tool call's own Session, and the card keeps its textual
  details. Inside it, Agent HTML a file-showing view previews runs its scripts
  in a nested `sandbox="allow-scripts"` frame: an opaque origin with no
  same-origin access, popups, forms, or top navigation, under a policy whose
  `connect-src`, `frame-src`, `base-uri`, and `form-action` are `'none'`, so it
  reaches no network or file.
- Preserve the separation between compact, inspectable execution history and
  first-class assistant outcomes. Final prose and meaningful rich UI remain
  visible message content; follow `DESIGN.md` for the governing principles.

## Where changes belong

- `src/main.tsx` is the Vite entry point. `src/app` owns config load, locale
  selection, and React Router navigation. `src/runtime-adapters/registry.tsx`
  is the fixture/`aos` runtime switch.
- `src/components/aos-ui-workspace.tsx` is the provider-neutral workspace UI;
  `src/components/workspace` owns navigation and catalog observation.
- `src/runtime-adapters/aos` contains the provider-neutral remote browser
  runtime; `src/runtime-adapters/fixture` contains the explicit preview.
  Extend browser `contracts.ts` only for genuinely shared UI concepts.
- `packages/proxy/core` owns normalized execution coordination;
  `packages/proxy/adapters` owns native server clients, transports, identity,
  retention, recovery, validation, and conversion. Do not move a native
  transport concern into the shared coordinator. Session membership and
  per-member delivery live in `packages/proxy/core/channel.ts`, and the member
  types (`Principal`, `Member`, `Middleware`, commands, and events) in
  `packages/proxy/core/member.ts`. `packages/proxy/acp` owns ACP translation,
  read state, and the activity feed; `acp/member-encoder.ts` is the only code
  that turns member events into ACP. `packages/proxy/auth` and
  `packages/proxy/guest` own the operator and guest roles, and the guest
  rules live in the `packages/proxy/guest/middleware` stack;
  `packages/proxy/routes` owns HTTP handlers; `packages/proxy/cli` is the
  server entry point. `packages/proxy/voice` owns proxy speech providers (the
  OpenAI-compatible client and the `ServerRuntime` voice wrapper);
  `packages/proxy/guest` owns the guest audio budget;
  `packages/protocol/audio.ts` holds the shared audio limits.
- `packages/lifecycle` is the shared owner state machine library for
  connections, memberships, turns, native links, and readings; it composes
  XState v5, cockatiel, and `DisposableStack`. The proxy imports it as
  `../../lifecycle`; browser code and tests use `@aos/lifecycle`. Do not
  duplicate owner machines in adapter or browser code.
- MCP Apps: `packages/protocol/mcp-apps.ts` holds the view and request
  schemas; `packages/proxy/routes/mcp-apps.ts` and
  `packages/proxy/guest/routes/mcp-apps.ts` serve them; each adapter's
  `mcp-apps.ts` implements `ServerRuntime.mcpApps`. `packages/proxy/mcp-apps`
  is the proxy's own MCP client for runtimes without native MCP Apps (Hermes
  and OpenCode) plus the `withMcpApps` wrapper and the shared name resolver;
  delete the fallback once no adapter reaches it. `src/components/mcp-apps`
  owns the sandbox frame, its CSP, and the host handlers. For file serving:
  `packages/proxy/auth/file-pass.ts` manages passes,
  `packages/proxy/core/app-files.ts` owns servable arguments and folder
  rules, and `packages/proxy/routes/app-files.ts` owns the file and renewal
  routes.
- `src/components/ui/menu-popup.tsx` is the one popup shell for every menu.
  Session rows use it through `src/components/workspace/session-row-menu.tsx`
  and messages through
  `src/components/assistant-ui/elements/message-context-menu.tsx`; both open on
  a right click and a long press through Base UI's `ContextMenu`. Do not add a
  second menu library or a parallel popup. A message menu hands the press back
  to the browser when it lands in a selection or on a field, link, or media, and
  Base UI suppresses the native menu from a document listener, so a veto needs
  both `stopPropagation()` and `preventBaseUIHandler()` on the trigger's own
  handler.
- `src/components/tool-ui` owns rich tool lifecycles and safe fallbacks.
- `src/components/assistant-ui/elements` owns Thread/Message composition,
  execution timelines, ordinary tool-call presentation, reasoning disclosure,
  and conversation search. Do not recreate these flows in runtime adapters.
- `src/components/artifacts` and `src/artifacts` own attachment resolution,
  the attachment card, and the inline image.
  `src/components/runtime-interactions` owns pending composer and question
  flows. `src/components/keyboard` and `src/lib/keyboard` own keyboard actions
  and the command palette. `src/lib/notifications` owns Activity and OS
  notification delivery. `shared/invite-link` packages guest invite logic.
- `src/lib/i18n` owns shared locale behavior. Some feature-local copy lives beside
  its component; search for both English and Hebrew variants before editing.
- `packages/tools-mcp` is the stateless `aos-ui` MCP server every harness
  registers for `render_chart`, `render_map`, `render_stats`, and
  `present_artifact`; it never reads files. All four are MCP Apps whose
  single-file views live in `packages/tools-mcp/views`;
  `present_artifact`'s view shows the file the proxy serves for that call.
  `shared/presentation` defines the tool schemas and view resources it
  serves. `shared/invite-link` and `shared/agent-creator` are
  plain skills operators install into a harness. The proxy names the four
  `aos-ui` tools bare and every other MCP tool `mcp__<server>__<tool>` in
  `packages/proxy/core/aos-tool-names.ts`, and validates
  Artifact paths in `packages/proxy/core/artifact-path.ts`. Agent worktrees,
  profiles, secrets, and state remain external. Never import native
  implementations into browser code.
- Architecture boundary tests live in `test/architecture/` and
  `packages/proxy/architecture.test.ts`; the ESLint rule is
  `scripts/eslint-runtime-boundaries.mjs`.

Treat generated and user-owned material carefully. Do not blindly regenerate
customized shadcn/Assistant UI components. Only `aos-deploy` and
`aos-runtime-adapter` under `.agents/skills/` are tracked project tooling; do
not touch user-local `.opencode/` or any other `.agents/skills/` content that
is not tracked. Preserve unrelated working-tree changes.

Assistant UI packages are version-pinned and unpatched. Compose exported APIs;
keep queue, runtime-switching, ownership, and reconnect regressions passing.
Prefer Assistant UI's established concepts, primitives, and components over
parallel local implementations. Customize through supported composition seams;
when a product requirement truly needs a replacement, document the unsupported
case and keep the custom surface as narrow as possible.
Native runtimes own the catalog, visibility, creator role, and persistence.
The proxy uses Hermes native HTTP/WebSocket APIs without adding a workspace
database or provider registry.

## Conventions

- Follow the existing strict TypeScript, ESM, Prettier, and ESLint configuration.
- Prefer standard Tailwind spacing, typography, and size utilities. Use an
  arbitrary value only when a documented visual, responsive, or accessibility
  constraint cannot be expressed by the standard scale.
- Prefer focused modules and pure functions at provider/configuration
  boundaries. Validate external HTTP payloads before adapting them.
- Load public runtime configuration from `/runtime-config.json`, separate from
  the frontend build. Never put credentials in it or `VITE_*`. The Bun proxy
  serves the production assets and normalized APIs; Nginx may be an external
  TLS/reverse proxy. Feature flags `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` and
  `AOS_UI_COMPOSER_CONTEXT_ENABLED` gate composer model and context-window UI
  at runtime (`shared/runtime-config.ts`).
- Use `@/` imports for project modules and logical CSS properties for RTL-safe
  layout.

## Writing tests

A test earns its place by protecting one rule nothing else protects, at the
cheapest layer that proves it. The suite has been cut back twice for breaking
this (duplicates across layers, copied setup, tests that could not fail), so
each step below leaves evidence a reviewer can check.

- **Name the rule, then find its cover.** Write the rule in one sentence, then
  grep the tests for it and the helpers for its setup: `test/support/`
  (`fake-clock`, `acp-bridge-socket`, `production-sources`, `leak-oracle`,
  `log-capture`), the `*.test-helpers.ts(x)` files beside the component, and
  the fixture scenarios under `src/runtime-adapters/fixture/`. Extend the
  test that already covers the rule; write a new one only when none does.
  An "already covered by X" claim, in a deletion or a review, quotes X's
  assertion with its file and line.
- **Pick the cheapest layer that proves it:** a pure function, then a hook
  (`renderHook`), then a component with props (`WorkspaceShell`), then a full
  `aos-ui-workspace` mount, then Playwright. Mount the workspace only for
  wiring that crosses components, such as navigation moving focus after Undo.
  Playwright keeps only what a real browser alone proves: layout, touch, focus
  order across regions, and real navigation. Test a rule once, not again
  through a higher layer, and in one viewport and one locale unless the rule
  is about the viewport or the locale.
- **Make it able to fail.** Break the production line once and watch the test
  fail. Assert the negative case too (absence, rejection, the path not
  taken), and prefer an observable result over a mock's call record.
- **Earns no test:** a constant or capability object restated, a schema
  accepting valid input, a template echo, a library doing what its own tests
  prove, or code nothing else calls; delete that code instead.
- **Reuse setup.** Build on the nearest helper; add one at the third copy of
  a shape, beside its callers, named for what it builds. Keep the input that
  matters and the expected outcome visible in the test body. Runs of cases
  that differ only in data become an `it.each` table that asserts everything
  each case did.
- **Give production code seams, not tests huge data.** A limit, page size,
  or clock a test must reach is a constructor option with a production
  default; tests pass small values and drive time with `fake-clock`, never
  real sleeps. A slow test usually means a missing seam or too high a layer:
  find that cause before raising a budget or tuning the test. The Vitest run
  lists every test over 1 s in `node` or 3 s in `dom`; one you add or touch
  stays under.
- **Keep a test in its project.** A `.test.ts` that needs no DOM stays in
  `node`; add it to `domTests` in `vitest.config.ts` only when it touches a
  browser global. Anything that builds, runs Compose, or runs type-aware
  ESLint belongs in `gateTests`.
- **Assert behavior, never styling.** Exact text is appropriate for
  accessible names, user-authored input, provider fidelity, protocols,
  security, configuration, and localization keys; editorial fixture copy is
  not a readiness or state contract. No CSS classes, `data-slot` markup,
  computed styles, pixel sizes, bounding boxes, colors, contrast ratios, or
  font sizes, in Vitest or Playwright; ESLint rejects the common forms.
  Verify appearance by looking at the rendered app. Do not assert icon
  internals or storage keys, and do not add test IDs solely to preserve
  implementation-coupled tests.
- **Fixtures and mocks stay honest.** Fixtures are deterministic, and provider
  mocks preserve ownership semantics.

## Verify changes

Pick checks by what changed, never by how many files changed or how big the
diff looks:

| What changed | Run | Not |
|---|---|---|
| styling, layout, copy, text, theme tokens | `bun run typecheck` and `bun run build` if code was touched; look once at the rendered surface | `test:e2e`, a new test, the unit suite |
| a mechanical rename across files | `bun run typecheck`, `bun run build` | the full suite |
| logic in one module | that module's tests (`bun run test <path>` or `vitest --changed`) | the full suite |
| a shared surface (`shared/`, build config, dependencies) or genuinely uncertain impact | `bun run test`, `test:gate`, `typecheck`, `lint`, `build`, once | — |
| behavior a Playwright flow covers | that one spec, once | the whole e2e suite |

A green run stays valid while the tree is unchanged: do not rerun before the
commit. After a merge or rebase, rerun only the checks whose files overlap the
incoming diff; a fast-forward or a docs-only upstream needs nothing. When the
person says the change is small or asks for no ceremony, run what they said and
name what was not run in the report.

Several worktrees sweeping at once oversubscribe a shared machine and starve any
deployment running on it, so `vitest.config.ts` caps workers at half the cores.
Raise it through `AOS_UI_TEST_WORKERS` only when the machine is yours alone, and
prefer `nice bun run test` for a full sweep beside a live deployment.
The everyday suite is two Vitest projects: `bunx vitest run --project node`
runs the DOM-free server, protocol, browser-logic, and tooling tests, and
`--project dom` the jsdom rest (`.tsx` files and the `domTests` list in
`vitest.config.ts`). A third project, `gate`, holds the production-build,
Compose, and type-aware ESLint checks; `bun run test` skips it and
`bun run test:gate` runs it alone.

When a worktree-isolated session's shell guard rejects a compound command, put
the steps in a script file under `/tmp` and run that script. The tracked skills
under `.agents/skills/` sit in an ignored directory, so stage them with
`git add -f <file>`.

Additional checks by area:

- A change to UI behavior, locale switching, runtime composition, or a browser
  flow a spec covers: that Playwright spec via `bun run test:e2e -- <spec>`,
  once. A styling-only change has no test to write, because styling is never
  asserted: look at the changed surface once in the rendered app and stop
  there. A second look in the other theme is earned only by a change to
  color, contrast, or theme tokens; a behavior change that happens to alter
  what renders needs no theme pass at all, its tests already cover it.
- Tools MCP server or shared presentation schemas: `bunx vitest run packages/tools-mcp`
  and `tsc -p tsconfig.tools-mcp.json --noEmit`; both also run inside the root
  test, test:gate, and typecheck gates.
- Compose or Docker changes:

  ```bash
  bunx vitest run test/containers/compose.test.ts
  docker compose -f compose.yaml config --quiet
  AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.yaml \
    AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
    AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
  AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.yaml \
    AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
    AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    AOS_UI_PUSH_STATE_DIR=/absolute/operator/dir \
    AOS_UI_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
    AOS_UI_PUSH_VAPID_SUBJECT=mailto:ops@example.com \
    docker compose -f compose.yaml -f compose.hermes.yaml -f compose.push.yaml config --quiet
  AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.openclaw.yaml \
    AOS_UI_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
    AOS_UI_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
    AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    docker compose -f compose.yaml -f compose.openclaw.yaml config --quiet
  AOS_UI_OPENCODE_WORKTREE=/absolute/external/worktree \
    AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.opencode.yaml \
    AOS_UI_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
    AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
  ```

  `compose.dev.yaml` adds the Vite dev server for local development. Build
  affected images and smoke their health and streaming endpoints when runtime
  container behavior changes.

- Live harness acceptance requires credentials and approved disposable external
  targets. No runtime ships an Agent-creation tool. The creator is a Hermes
  profile marked `ui_meta.aos.role: creator`, the OpenClaw Agent with the
  reserved id `aos-agent-creator`, or the OpenCode launcher's hidden
  `agent-builder`, which AOS does not yet report as the creator; each creates
  Agents through its harness's own means, so a live creation run writes a real
  Agent. `shared/install/PROMPT.md` installs the tools, skills, and creator. Do not treat
  mocked or skipped journeys as live passes; never change existing user
  Agents/profiles for routine tests.
