# AOS-ui

AOS is a multilingual React workspace for native AI harnesses. OpenCode and Hermes own execution, persistence, credentials, and Agent configuration. Assistant UI owns frontend conversations; a small workspace adapter adds Agent catalogs, verified Session ownership, Todos, and optional capabilities.

One engine is selected per deployment. English and Hebrew, RTL, keyboard navigation, rich-message fallbacks, generic AG-UI, and explicit fixtures are supported. URLs are `/{agentId}/{sessionId}`; language preference is stored locally. Legacy `/en` and `/he` links remain recognized.

## Development

Use Bun. Fixture mode needs no backend or model credentials and intentionally
does not offer Agent creation:

```bash
bun install
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

Open http://localhost:3000. Vite serves development only; production is static Nginx hosting.

### OpenCode

Install OpenCode separately and configure its model credentials outside this checkout. Build the integration, then run in separate terminals:

```bash
bun run integrations:build
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree bun run opencode:serve
```

```bash
AOS_UI_RUNTIME_MODE=opencode \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
bun run dev
```

The same external directory scopes the native process, SDK requests, Agent writes, and native tools. Existing definitions are never overwritten. The launcher installs its dedicated creator Agent and portable skill; ordinary Agent content stays external. Secure Agent writes currently require Linux directory descriptors; use the supplied OpenCode container on other hosts. Old user-owned content remaining in this checkout is preserved but is not migrated or loaded automatically.

OpenCode 1.18.29 caches Agent definitions. Newly saved Agents can report `setup-needed` until an operator restarts the harness after its runs finish. AOS does not automatically use the instance-disposal endpoint: it can abort unrelated runs. Saving a definition is not reported as readiness.

OpenCode defaults to port 4096. Agent visibility is read from native metadata; management is read-only when native mutation support is absent. Leave model selection native, or set `AOS_UI_OPENCODE_PROVIDER_ID` and `AOS_UI_OPENCODE_MODEL_ID` together. Optional `AOS_UI_OPENAI_COMPATIBLE_BASE_URL`, `AOS_UI_OPENAI_COMPATIBLE_API_KEY`, and `AOS_UI_OPENAI_COMPATIBLE_MODEL_ID` are all-or-none and belong only in the native process environment.

### Hermes

Hermes itself is operator-managed. AOS connects directly to the native `hermes serve` HTTP/WebSocket API and discovers profiles through `profiles.list`. There is no AOS bridge, profile registry, or database. Follow the [Hermes installation guide](integrations/hermes/README.md) for native presentation, inbound-session, and creator tools.

```bash
bun run integrations:build
uv sync --project integrations/hermes --frozen
AOS_UI_RUNTIME_MODE=hermes AOS_UI_HERMES_BASE_URL=/hermes bun run dev
```

Vite forwards `/hermes` to `AOS_UI_HERMES_TARGET` (default `http://127.0.0.1:9119`). Configure native authentication. Hermes owns recovery policy, including auto-continue; AOS does not require changing it or submit prompts on reattachment. The browser uses native login/cookies and single-use WebSocket tickets; never put credentials in public configuration. Production requires a native public URL including the `/hermes` prefix.

The live native API baseline is checkout `b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`; the required direct RPC surface was also verified in unmodified Hermes `v2026.9.7`. Incompatible interfaces remain unavailable. Native CLI/cron Sessions can be discoverable without gateway live control; Stop uses native Session interruption, not an AOS cancellation layer.

Automated Hermes Agent creation is currently blocked: upstream profile creation is not atomic against concurrent creators. The interview remains available, but the writer fails without native writes. See the integration guide for the exact upstream prerequisite.

Hermes voice v1 adds native transcription and in-message read-aloud. Tap the
microphone to record; hold for 450 ms (or use Arrow Down / Shift+F10) to choose
Transcription or explicit Voice turn. Native STT and TTS are checked independently
using non-secret profile configuration metadata. No browser speech fallback or
additional AOS server is used. The recording bars reflect the active microphone;
capture continues across tab/window switches until an explicit action or safety
limit. PTT auto-read coordination uses Assistant UI thread/run/queue state and
does not depend on Hermes completion events; Hermes provides the native speech
transport only. OpenCode, generic AG-UI and fixtures omit voice in v1.

Microphone capture requires HTTPS or localhost, browser permission, and a
supported `MediaRecorder`. See [Chat voice setup and use](docs/chat-voice.md)
for configuration, limits, privacy, troubleshooting and the pending live
acceptance gate. Automated fixtures do not certify live speech support.

### Generic AG-UI

Set `AOS_UI_RUNTIME_MODE=ag-ui`, `AOS_UI_AG_UI_URL`, and `AOS_UI_AG_UI_WORKSPACE_URL`. The workspace host implements `GET /agents`, `GET /sessions`, `POST /sessions`, and `GET /sessions/:threadId`. Capabilities absent from the integration remain visibly unavailable.

Generic AG-UI composition uses public `HttpAgent` instances, one per Session. Navigation detaches the outgoing HTTP stream and parks its queue; it does not invoke a native Stop callback. Custom agents with native cancellation side effects are not supported by this composition.

### Optional Monty

Core startup does not require Monty. Configure it explicitly on the harness side; credentials and downstream tools remain native:

```bash
bun run monty:sync
```

See [Monty](integrations/monty/README.md). Its implementation, MIT license, and upstream attribution remain independent.

## Public configuration and static deployment

The browser fetches `/runtime-config.json` without caching. This deployment file is separate from the frontend build; do not put secrets in it or in `VITE_*`. Missing/invalid configuration renders unavailable state, never fixture fallback. Development accepts the same file via `AOS_UI_RUNTIME_CONFIG_FILE`, or the allowlisted environment values in [.env.example](.env.example).

The shared composer model selector and authoritative context indicator are
enabled by default. Public JSON may set `composerModelSelectorEnabled` or
`composerContextEnabled` to `false` independently; environment-derived config
uses `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` and
`AOS_UI_COMPOSER_CONTEXT_ENABLED`.

Public examples are in `deploy/runtime-config.fixture.json`,
`deploy/runtime-config.opencode.json`, and
`deploy/runtime-config.hermes-native.json`. OpenCode's `directory` is the path
inside the native server/container, not necessarily the browser host's path.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json docker compose up --build
```

The base composition is web-only. The OpenCode overlay runs native OpenCode; the Hermes overlay only forwards to operator-managed Hermes:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes-native.json \
docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

Add `-f compose.dev.yaml` for hot-reloading frontend development. Source mounts and native content/state mounts are separate. Configuration is mounted read-only; changes require no frontend rebuild. Hashed assets are immutable, HTML revalidates, and proxy errors never fall through to the SPA. Event-stream forwarding disables buffering.

Loopback is the default. Wider exposure requires appropriate protection; this is not a public multi-user authentication system. Web health is `/api/health`; OpenCode is `/global/health`. Hermes must be reachable from the web container; a host-loopback-only listener is not reachable through Docker's host gateway. Use the same Compose files with `down` to stop; do not use `down -v` unless you intend to delete the named native-state volumes.

## Activity and live notifications

Activity is the persistent inbox for notification history and unread state;
provider data remains authoritative for the work itself. Open it from the bell
in the desktop Agents heading or mobile header. Inline conversation state,
Activity, coalesced in-app notices, and optional browser notifications form the
four notification surfaces.

In Activity → Notification settings, explicitly enable browser notifications and
grant browser permission. Delivery requires at least one loaded AOS tab.
Switching tabs (hidden) and switching windows/apps (visible but unfocused) both
allow eligible notifications. The exact visible, focused conversation suppresses
alerts; another Session in the foreground gets unread markers and one coalesced
in-app notice. Denied or unsupported browser permissions leave Activity usable.

OS text is generic: no Agent/Session names, conversation, tool, question,
permission, or error content. Clicking focuses the app and opens the owning
Agent/Session only after provider validation; deleted targets are unavailable.
Tabs synchronize read state and elect one delivery tab. Reloaded history never
replays OS notifications. Browser/OS settings and background throttling can delay
or suppress delivery; Activity remains the place to check.

OpenCode observes workspace activity; fixtures provide deterministic scenarios;
AG-UI covers only the selected Session, as explained in settings. V1 has no
service worker, Web Push, notification backend, email, or closed-app delivery.
Once all AOS tabs close, no new notifications can be delivered. See the
[notification journey matrix](./docs/notification-journeys.md) for verification
coverage and the manual host OS check.

## Architecture

- `src/app/`: bootstrap, React Router, selected runtime loading.
- `src/components/`: workspace, Assistant UI, safe tool renderers, keyboard and UI primitives.
- `src/runtime-adapters/`: contracts and OpenCode/Hermes/AG-UI/fixture implementations.
- `src/lib/`: browser locale, preferences, and helpers.
- `shared/`: public runtime configuration, presentation schemas/examples, portable creator skill.
- `integrations/`: native OpenCode and Hermes packages; independent optional Monty.
- `deploy/`: static hosting and public configuration examples.

Browser code never imports native implementations. Shared definitions contain no React, browser state, filesystem access, SDKs, or secrets. Split TypeScript targets and import restrictions enforce these boundaries.

Assistant UI packages are version-pinned and installed without dependency patches.
Adapters compose public upstream APIs; upgrades must retain focused lifecycle and
ownership regressions. Stop parks the upstream queue; a subsequent explicit send
may restart it. There is no custom single-item Resume operation.

Agent creation is an ordinary creator-owned Session opened through `New Agent`;
the creator is discovered from native metadata (`aos_ui_role: creator` in OpenCode,
`ui_meta.aos.role: creator` in Hermes) and never appears in the ordinary Agent roster
or management catalog. Native safe writers return inspectable outcomes;
creation never changes the interview's owner or starts the new Agent's first
Session automatically. Native `start_session` support works without a browser.
Discovery must not steal selection.

Read [PRODUCT.md](PRODUCT.md) for ownership and [the design lock](docs/design/agent-workspace-design-lock.md) for the visual direction.

## Verification

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run integrations:build
bun run hermes:test
bun run test:e2e
```

Install Chromium with `bunx playwright install chromium`. Run `bun run monty:test` when changing Monty. Container changes also require Compose validation, image builds, and health/streaming smoke checks.

Automated browser tests use deterministic harnesses. Required live acceptance uses real models and disposable external targets: chat/persistence, inbound Sessions, usable Agent creation, rich output, reconnect/Stop, and exact-request approval on each engine. Missing credentials, API support, or disposable-target approval blocks live acceptance; skipped checks are not passes.
