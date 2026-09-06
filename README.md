# AOS-ui

AOS is a multilingual workspace for provider-owned AI Agents and their
Sessions. It combines [Assistant UI](https://www.assistant-ui.com/) conversation
state with a narrow workspace adapter for Agent ownership, Session metadata,
Todos, and provider capabilities.

The interface stores the preferred language locally and uses compact workspace
URLs: `/{agentId}/{sessionId}`. OpenCode is the default runtime, AG-UI is
supported through an explicit workspace API, and a deterministic fixture mode
keeps the complete interface developable offline.

## Requirements

Choose the toolchain for the way you want to run AOS:

- **Fixture development:** [Bun](https://bun.sh/).
- **Local OpenCode:** Bun, [OpenCode](https://opencode.ai/),
  [uv](https://docs.astral.sh/uv/), and credentials for an OpenCode provider.
- **Containers:** Docker Engine or Docker Desktop with Docker Compose.

The container images pin their own Bun, Node.js, OpenCode, and uv versions. A
local installation only needs to provide the `bun`, `opencode`, and `uv`
executables used by the project scripts.

## Quickstart

### Develop against fixtures

This is the fastest way to work on the interface. It needs no model provider or
backend:

```bash
bun install
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

Open <http://localhost:3000>. The app negotiates and remembers a locale while
keeping Agent and Session selection in the URL.

Fixture data is always labeled as a demo workspace so it cannot be mistaken for
provider data.

### Develop against local OpenCode

Install the JavaScript and locked Monty dependencies once:

```bash
bun install
bun run monty:sync
```

Then run the services in separate terminals:

```bash
# Terminal 1
bun run opencode:serve

# Terminal 2
AOS_UI_OPENCODE_MANAGEMENT_URL=http://127.0.0.1:4097 bun run dev
```

AOS connects to `http://127.0.0.1:4096` by default. OpenCode discovers the
providers available from its configuration and environment; AOS does not
force a model unless both an explicit provider and model are configured.

No `.env.local` file is required for the defaults. Copy `.env.example` to
`.env.local` when you need to change the runtime address, server bind, or AWS
profile. Environment changes require restarting the affected process.
Changes under `.opencode/plugins` also require restarting OpenCode; the project
plugin loader does not hot-reload an already running provider process.

The launcher also serves Agent visibility management on port `4097`. The web
app uses `AOS_UI_OPENCODE_MANAGEMENT_URL` to enable this capability; omit it
when connecting to an external OpenCode server without the AOS management
service. Set `AOS_UI_OPENCODE_MANAGEMENT_PORT` to change the launcher's port.
See [Agent visibility management](./docs/agent-visibility-management.md) for
the persistence contract, active-Session behavior, and deployment limits.

## Docker Compose

Compose runs AOS and OpenCode as separate non-root containers. Copy the
operator configuration before changing any defaults:

```bash
cp .env.compose.example .env
```

Start the production build:

```bash
docker compose up --build
```

For hot-reloading web development with containerized OpenCode:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

AOS is published at <http://127.0.0.1:3000> and OpenCode at
<http://127.0.0.1:4096>. The OpenCode container receives a writable bind mount
of this repository at `/workspace`, while named volumes retain OpenCode state
and the locked Monty environment.

On Linux, set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` in `.env` to the numeric
output of `id -u` and `id -g`. This lets the non-root OpenCode container write
the workspace and read mode-`600` AWS files. Docker Desktop users can normally
keep the default `1000:1000` identity.

Compose mounts `${HOME}/.aws` read-only by default. The directory must exist;
set `AOS_UI_AWS_CONFIG_DIR` if the AWS configuration is elsewhere or if you
want to mount a different existing directory.

Stop the stack without deleting its named volumes:

```bash
docker compose down
```

`docker compose down -v` also removes the persisted OpenCode and Monty volumes.
It does not remove Agent definitions written into the repository bind mount.

### Ports, health, and network safety

Set these values in `.env` to change the published endpoints:

| Variable                          | Default                | Purpose                                             |
| --------------------------------- | ---------------------- | --------------------------------------------------- |
| `AOS_UI_BIND_ADDRESS`            | `127.0.0.1`            | Host address for both published services            |
| `AOS_UI_WEB_PUBLISHED_PORT`      | `3000`                 | AOS port exposed to the browser                 |
| `AOS_UI_OPENCODE_PUBLISHED_PORT` | `4096`                 | OpenCode port exposed to the browser                |
| `AOS_UI_OPENCODE_BASE_URL`       | Published OpenCode URL | Browser-reachable OpenCode address                  |
| `AOS_UI_OPENCODE_CORS_ORIGINS`   | Local AOS origins  | Comma-separated browser origins allowed by OpenCode |

Health endpoints are available at `/api/health` on AOS and
`/global/health` on OpenCode. Agent management exposes `/health` on port `4097`.
Compose publishes it on loopback; `AOS_UI_OPENCODE_MANAGEMENT_PUBLISHED_PORT`
changes that port. For a LAN deployment, also set a browser-reachable
`AOS_UI_OPENCODE_MANAGEMENT_URL` and the allowed
`AOS_UI_OPENCODE_CORS_ORIGINS`.

The default loopback binding is intentional. Compose includes no TLS,
authentication, or reverse proxy. If you publish to a LAN, set a
browser-reachable `AOS_UI_OPENCODE_BASE_URL` and matching CORS origins, and run
the stack only on a trusted private network.

## Runtime configuration

`AOS_UI_RUNTIME_MODE` accepts `fixture`, `opencode`, or `ag-ui` and defaults to
`opencode`. Invalid or incomplete configuration renders an explicit unavailable
state instead of silently falling back to fixtures.

### OpenCode providers and models

Without model overrides, OpenCode selects from its configured, available
catalog. To force a model, set both values together:

```bash
AOS_UI_OPENCODE_PROVIDER_ID=amazon-bedrock \
AOS_UI_OPENCODE_MODEL_ID=eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
bun run dev
```

Setting only one of these variables is an error. AWS credential-chain values,
including `AWS_PROFILE`, `AWS_REGION`, and exported temporary credentials, pass
through to OpenCode.

For Google models, set `GOOGLE_GENERATIVE_AI_API_KEY`. The OpenCode launcher
also accepts `GEMINI_API_KEY` as an alias when the canonical variable is unset;
Compose passes either variable only to the OpenCode service.

The OpenCode launcher can register one optional OpenAI-compatible provider. Set
all three variables in the environment (or in Compose's `.env`):

- `AOS_UI_OPENAI_COMPATIBLE_BASE_URL`
- `AOS_UI_OPENAI_COMPATIBLE_API_KEY`
- `AOS_UI_OPENAI_COMPATIBLE_MODEL_ID`

OpenCode exposes it as provider `openai-compatible` and local model `default`.
To select it explicitly, also set:

```dotenv
AOS_UI_OPENCODE_PROVIDER_ID=openai-compatible
AOS_UI_OPENCODE_MODEL_ID=default
```

### AG-UI

AG-UI needs both its run endpoint and a host API for workspace ownership:

```bash
AOS_UI_RUNTIME_MODE=ag-ui \
AOS_UI_AG_UI_URL=https://example.test/agent \
AOS_UI_AG_UI_WORKSPACE_URL=https://example.test/workspace \
bun run dev
```

The workspace host implements `GET /agents`, `GET /sessions`, `POST /sessions`,
and `GET /sessions/:threadId`. This generic composition advertises common
Markdown and Mermaid only; provider-specific rich controls remain visibly
unavailable rather than being simulated.

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

| Area                | Responsibility                                                      | Main location                                              |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Next.js application | Locale routing and runtime composition                              | `app/[locale]`, `lib/runtime-config.ts`                    |
| Assistant UI        | Threads, messages, runs, branches, and composer state               | `components/assistant-ui`, `components/aos-ui-*-app.tsx`  |
| Workspace layer     | Agent ownership, Session metadata, Todos, and capabilities          | `components/aos-ui-workspace.tsx`, `lib/runtime-adapters` |
| Provider adapters   | OpenCode, AG-UI, and deterministic fixtures                         | `lib/runtime-adapters/{opencode,ag-ui,fixture}`            |
| Rich tools          | Safe chart, map, stats, Plan, question, permission, and Monty views | `components/tool-ui`                                       |
| OpenCode project    | Agents, tools, permissions, and presentation harness                | `opencode.json`, `.opencode`                               |

Provider data remains authoritative: a Session belongs to exactly one Agent,
delayed events retain their originating Agent and Session, Plans belong to the
message that produced them, and Todos belong to the Session. The browser owns
view preferences, selection restoration, and content-free Activity read/delivery
state in local browser storage.

Seeded and user-created product Agents share the native
`.opencode/agents/<id>.md` format. The hidden `agent-builder` conducts the
creation interview; its allowlisted `create_agent` tool writes a new definition,
and AOS promotes a provisional row only after OpenCode confirms discovery.
The root `AGENTS.md` guides coding agents and is unrelated to these product
Agent definitions.

Monty runs Python with builtins and tools from a configured downstream MCP server.
See [the Monty integration reference](./integrations/monty/README.md)
for its executable surface and resource limits.

For product boundaries and terminology, read [PRODUCT.md](./PRODUCT.md). The
approved visual direction is recorded in the
[workspace design lock](./docs/design/agent-workspace-design-lock.md).

## Verification

| Command              | Coverage                                                           |
| -------------------- | ------------------------------------------------------------------ |
| `bun run test`       | Vitest unit, component, adapter, and container-configuration tests |
| `bun run test:watch` | Focused Vitest development loop                                    |
| `bun run typecheck`  | TypeScript checking without emit                                   |
| `bun run lint`       | ESLint, including Next.js rules                                    |
| `bun run build`      | Production standalone Next.js build                                |
| `bun run monty:test` | Locked Python/Monty integration tests                              |
| `bun run test:e2e`   | Fixture, mocked OpenCode, and AG-UI Playwright journeys            |

Install the Chromium browser binary with `bunx playwright install chromium`
before running Playwright for the first time.

The automated browser suites do not require live model credentials. A live
OpenCode contract smoke is opt-in and requires an existing ordinary primary
Agent plus an inexpensive Bedrock Haiku or Nova model:

```bash
AOS_UI_LIVE_OPENCODE=1 \
AOS_UI_OPENCODE_PROVIDER_ID=amazon-bedrock \
AOS_UI_OPENCODE_MODEL_ID=<cheap-haiku-or-nova-model-id> \
AOS_UI_OPENCODE_AGENT_ID=<existing-primary-agent-id> \
bunx vitest run lib/runtime-adapters/opencode/opencode-workspace.live.test.ts
```

The smoke may create and remove temporary Sessions. It verifies that Mermaid
stays fenced Markdown while structured charts use `render_chart`. It
deliberately does not complete an Agent Builder flow because that writes a real
Agent definition into the repository. Exercise live Builder creation only as an
explicit manual test with a unique Agent ID and exact scoped cleanup.
