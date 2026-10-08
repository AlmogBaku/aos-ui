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
- `src/runtime-adapters/contracts.ts` is the browser runtime boundary. The
  gateway, its server adapter boundary (`src/core/runtime.ts`), and the wire
  contract (`protocol/acp.ts`) live in the separate harness-gw repository
  (`https://github.com/AlmogBaku/harness-gw`); its `docs/protocol.md` specifies
  the wire and its `docs/development/runtime-adapter-authoring.md` covers
  server runtime adapters. aos-ui consumes the browser client and protocol as
  the `@harness-gw/sdk` package. Keep provider details behind the gateway.

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

For local gateway development, run harness-gw from its own checkout against an
independently operated Hermes server, then attach Vite to it:

```bash
# in the harness-gw checkout
bun run serve --config /absolute/private/path/config.yaml
```

With no `--config`, the gateway reads `HARNESS_GW_CONFIG_FILE` or discovers
`${XDG_CONFIG_HOME:-$HOME/.config}/harness-gw/config.yaml`.

```bash
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_GATEWAY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

Vite forwards only `/api/v1` to the gateway and keeps the browser's `Origin`,
so the gateway's `publicOrigin` (or `allowedOrigins`) must list the dev origin,
such as `http://localhost:3000`. An SDK change is made and tested
in harness-gw, then consumed here through the `@harness-gw/sdk` package
(a local tarball until the first release); rerun `bun install` after
replacing it.

Open `http://localhost:3000`; compact Agent/Session URLs preserve local EN/HE preference.
Copy `.env.example` to `.env.local` only for local overrides.

Run the production containers:

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json docker compose up --build
```

Compose is loopback-only by default. Treat any wider operator binding as a
trusted-private-network deployment: this stack has no TLS or public multi-user
authentication. Caddy (`deploy/Caddyfile`) is the only published lane port: it
sends `/api/v1` to the gateway and everything else to the aos-ui web server
(`bun run web:serve`, `server/cli.ts`). A harness overlay adds the gateway and
the guest lane. An external TLS reverse proxy is optional.

## Architecture and invariants

- Assistant UI owns threads, messages, runs, branches, composer state, and
  thread lifecycle. `WorkspaceAdapter` adds Agent catalog access and Agent
  updates (visibility and avatar), Session metadata (including `unread` read
  state), creator identity,
  Todos subscription, catalog/metadata/activity subscriptions, `markSessionRead`,
  and `reportFocus`. Session Todos arrive
  as ACP `plan_update` notifications carrying `_meta.hgw.todos`. Creation opens
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
- The browser supports only the normalized `aos` runtime, which speaks to the
  harness-gw gateway, and explicit `fixture` mode. The gateway selects one
  server adapter per deployment; Hermes is the primary V1 implementation.
  OpenClaw and OpenCode keep their distinct native transports inside the
  gateway, never in this repository.
- The three `AOS_UI_OPENAI_COMPATIBLE_*` values (`AOS_UI_OPENAI_COMPATIBLE_BASE_URL`,
  `AOS_UI_OPENAI_COMPATIBLE_API_KEY`, `AOS_UI_OPENAI_COMPATIBLE_MODEL_ID`) are
  all-or-none; setting any one without the others is an error.
- Provider-owned read state: the browser reports the focused Session via a
  `_hgw/session/focus` request (the gateway's acknowledgment is the liveness
  check); the runtime decides when that Session becomes read and delivers an
  `unread` update. One ACP WebSocket is opened per browser tab; the gateway
  closes a connection that does not complete `initialize` within 15 s, and a
  gateway whose `_meta.hgw` extension version differs ends the connection
  without reconnecting. The web server's `/runtime-config.json` carries the
  served `buildId`; the browser refetches it when the socket comes back and
  when the tab becomes visible, and reloads once when it differs from its
  compiled id (a `sessionStorage` entry prevents a loop).
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
  gateway, scoped to the tool call's own Session, and the card keeps its textual
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
- `@harness-gw/sdk` is the framework-free browser client (the ACP connection,
  the workspace client, approvals, questions, and the HTTP client);
  `@harness-gw/sdk/protocol` is the wire alone (`_hgw/*` method names, the
  `_meta.hgw` schemas, the MCP App and audio limits). Both are built in
  harness-gw; this repository only consumes them.
  `src/runtime-adapters/client-contract.ts` proves at compile time that the
  client's types still match `contracts.ts`. Gateway coordination, native
  adapters, roles, guest rules, routes, voice providers, MCP App serving, and
  file passes all belong to harness-gw; change them there.
- `server/` owns the aos-ui web server: one listener per surface (operator,
  and guest when `AOS_UI_GUEST_WEB_PORT` is set), the built assets,
  `/runtime-config.json` with the served build id, the guest page policy, and
  `/healthz`. It answers nothing under `/api` and refuses non-GET requests.
  `deploy/Caddyfile` and `deploy/caddy/guest.caddy` own lane routing and Host
  checks; `deploy/compose.host.yaml` is the host-networking shape.
- MCP Apps: `src/components/mcp-apps` owns the sandbox frame, its CSP, and the
  host handlers; `src/runtime-adapters/aos/aos-mcp-apps.ts` adapts the SDK's
  MCP App client to `contracts.ts`. The view schemas come from
  `@harness-gw/sdk/protocol`.
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
  `present_artifact`'s view shows the file the gateway serves for that call.
  `shared/presentation` defines the tool schemas and view resources it
  serves. `shared/invite-link` and `shared/agent-creator` are
  plain skills operators install into a harness. The gateway names the four
  `aos-ui` tools bare and every other MCP tool `mcp__<server>__<tool>`, and
  validates Artifact paths. Agent worktrees,
  profiles, secrets, and state remain external. Never import native
  implementations into browser code.
- Architecture boundary tests live in `test/architecture/`; the ESLint rule is
  `scripts/eslint-runtime-boundaries.mjs`.

Treat generated and user-owned material carefully. Do not blindly regenerate
customized shadcn/Assistant UI components. Only `aos-deploy` under
`.agents/skills/` is tracked project tooling; do
not touch user-local `.opencode/` or any other `.agents/skills/` content that
is not tracked. Preserve unrelated working-tree changes.

Assistant UI packages are version-pinned and unpatched. Compose exported APIs;
keep queue, runtime-switching, ownership, and reconnect regressions passing.
Prefer Assistant UI's established concepts, primitives, and components over
parallel local implementations. Customize through supported composition seams;
when a product requirement truly needs a replacement, document the unsupported
case and keep the custom surface as narrow as possible.
Native runtimes own the catalog, visibility, creator role, and persistence.
The gateway uses Hermes native HTTP/WebSocket APIs without adding a workspace
database or provider registry, and aos-ui adds none either.

## Conventions

- Follow the existing strict TypeScript, ESM, Prettier, and ESLint configuration.
- Prefer standard Tailwind spacing, typography, and size utilities. Use an
  arbitrary value only when a documented visual, responsive, or accessibility
  constraint cannot be expressed by the standard scale.
- Prefer focused modules and pure functions at provider/configuration
  boundaries. Validate external HTTP payloads before adapting them.
- Load public runtime configuration from `/runtime-config.json`, separate from
  the frontend build. Never put credentials in it or `VITE_*`. The aos-ui web
  server serves it and the production assets; the gateway serves only
  `/api/v1`; Caddy joins them on one origin per lane, and an external TLS
  reverse proxy may sit in front. Feature flags `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` and
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
  (`fake-clock`, `production-sources`, `log-capture`),
  `src/runtime-adapters/aos/acp/test-socket.ts`, the `*.test-helpers.ts(x)`
  files beside the component, and
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
- **Test the client where it lives.** A rule about the gateway, the wire, or
  the SDK client is tested in harness-gw; aos-ui tests only how the UI uses
  the client.

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
runs the DOM-free web-server, browser-logic, and tooling tests, and
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
  HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
    HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
    HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
  HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
    HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
    HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    docker compose -f compose.yaml -f compose.hermes.yaml -f deploy/compose.host.yaml config --quiet
  HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
    HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
    HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    HARNESS_GW_PUSH_STATE_DIR=/absolute/operator/dir \
    HARNESS_GW_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
    HARNESS_GW_PUSH_VAPID_SUBJECT=mailto:ops@example.com \
    docker compose -f compose.yaml -f compose.hermes.yaml -f compose.push.yaml config --quiet
  HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.openclaw.yaml \
    HARNESS_GW_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
    HARNESS_GW_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
    HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    docker compose -f compose.yaml -f compose.openclaw.yaml config --quiet
  AOS_UI_OPENCODE_WORKTREE=/absolute/external/worktree \
    HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.opencode.yaml \
    HARNESS_GW_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
    HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
    docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
  ```

  `deploy/compose.host.yaml` goes after the harness overlay. `compose.dev.yaml`
  runs the Vite dev server in `web` (operator surface only). Build affected
  images and smoke Caddy's `/healthz`, the gateway's `/api/v1/healthz`, and a
  streaming turn when runtime container behavior changes. The compose test
  also checks the Caddyfile's lane routing and Host rules.
- A web server change: `bunx vitest run server`.
- A gateway, protocol, or SDK client change: make it in harness-gw and run its
  own checks there; here, rerun `typecheck` and the affected tests after
  installing the new package.
- Live harness acceptance requires credentials and approved disposable external
  targets. No runtime ships an Agent-creation tool. The creator is a Hermes
  profile marked `ui_meta.aos.role: creator`, the OpenClaw Agent with the
  reserved id `aos-agent-creator`, or the OpenCode launcher's hidden
  `agent-builder`, which AOS does not yet report as the creator; each creates
  Agents through its harness's own means, so a live creation run writes a real
  Agent. `shared/install/PROMPT.md` installs the tools, skills, and creator. Do not treat
  mocked or skipped journeys as live passes; never change existing user
  Agents/profiles for routine tests.
