# AOS-ui agent guide

## Read first

- `README.md` is the operator and contributor guide. Keep its commands aligned
  with `package.json`, the Compose files, and the environment examples.
- `PRODUCT.md` defines product terminology, ownership, scope, and accessibility
  commitments.
- `docs/design/agent-workspace-design-lock.md` is the visual design authority.
  Preserve its direction unless the task explicitly changes it.
- `src/runtime-adapters/contracts.ts` is the shared provider boundary. Keep
  provider-specific details behind the corresponding adapter.

## Install and run

Use Bun for the JavaScript toolchain.

```bash
bun install
```

Run fixture mode for backend-free UI work:

```bash
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

Run the real local OpenCode composition in two terminals:

```bash
bun run integrations:build
AOS_UI_OPENCODE_WORKTREE=/absolute/external/worktree bun run opencode:serve
```

```bash
AOS_UI_RUNTIME_MODE=opencode \
AOS_UI_OPENCODE_WORKTREE=/absolute/external/worktree \
bun run dev
```

Open `http://localhost:3000`; compact Agent/Session URLs preserve local EN/HE preference.
Copy `.env.example` to `.env.local` only for local overrides.

Run the production containers:

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json docker compose up --build
```

Run the hot-reloading web container with containerized OpenCode:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/external/worktree \
docker compose -f compose.yaml -f compose.opencode.yaml -f compose.dev.yaml up --build
```

Compose is loopback-only by default. Its browser-facing OpenCode URL uses the
published host and port, not the `opencode` service hostname. Treat any wider
binding as a trusted-private-network deployment: this stack has no TLS or
public multi-user authentication. Nginx serves static assets and restricted integration forwarding.

## Architecture and invariants

- Assistant UI owns threads, messages, runs, branches, composer state, and
  thread lifecycle. `WorkspaceAdapter` adds only Agent ownership, Session
  metadata, Todos, creator identity, and provider capabilities. Creation uses
  an ordinary creator-owned Session opened through `New Agent`; the hidden
  creator is excluded from normal roster and management surfaces. There are no
  provisional Agents or ownership promotion.
- Provider data is authoritative. Every Session belongs to one Agent; delayed
  events stay scoped to their originating Agent and Session. Plans are
  message-scoped and Todos are Session-scoped.
- Runtime selection is strict. Fixture data appears only in explicit `fixture`
  mode; invalid provider configuration renders unavailable state instead of
  falling back to synthetic data. Public fixtures intentionally omit Agent
  creation; configured real runtimes may expose the hidden creator through
  `New Agent`.
- OpenCode and Hermes have independent native integrations. One engine is selected per deployment. Generic AG-UI uses a separate workspace host and degrades visibly when a capability is absent. Monty is optional.
- The app chooses no OpenCode model by default. Set
  `AOS_UI_OPENCODE_PROVIDER_ID` and `AOS_UI_OPENCODE_MODEL_ID` together or
  leave both empty. The three `AOS_UI_OPENAI_COMPATIBLE_*` values are likewise
  all-or-none.
- English LTR and Hebrew RTL are first-class. Update both locales, logical
  layout behavior, accessible labels, keyboard flow, and reduced-motion states
  whenever affected.
- Rich output must remain inspectable and safe. Keep textual fallbacks for
  charts, maps, Plans, tools, and Mermaid; never execute generated code or
  arbitrary HTML in the browser.

## Where changes belong

- `src/app` owns Vite bootstrap, React Router navigation, and selected runtime composition.
- `src/components/aos-ui-workspace.tsx` is the provider-neutral workspace UI;
  `src/components/workspace` owns navigation and catalog observation.
- `src/runtime-adapters/{opencode,hermes,ag-ui,fixture}/composition.tsx` are
  lazily loaded provider composition seams.
- `src/runtime-adapters/{opencode,hermes,ag-ui,fixture}` contain provider behavior.
  Extend `contracts.ts` only for genuinely shared concepts.
- `src/components/tool-ui` owns rich tool lifecycles and safe fallbacks.
- `src/lib/i18n` owns shared locale behavior. Some feature-local copy lives beside
  its component; search for both English and Hebrew variants before editing.
- `shared/presentation` and `shared/agent-creator` define portable assets. `integrations/opencode` and `integrations/hermes` package native tools, safe writers, and creator support. Agent worktrees, profiles, secrets, and state remain external. Never import native implementations into browser code.
- `integrations/monty` is the runtime fork, named `monty`. Preserve its MIT
  license and the upstream commit attribution in `integrations/monty/UPSTREAM.md`.

Treat generated and user-owned material carefully. Do not blindly regenerate
customized shadcn/Assistant UI components. `.agents/skills` is tracked project
tooling, and `.agents/skills/grilling` is also an intentional product dependency.
Preserve unrelated working-tree changes and avoid overwriting existing
`.opencode/agents` definitions.

Assistant UI packages are version-pinned and unpatched. Compose exported APIs;
keep queue, runtime-switching, ownership, and reconnect regressions passing.
Native runtimes own the catalog, visibility, creator role, and persistence.
Hermes uses native HTTP/WebSocket APIs; no AOS server, registry, or SQLite.

## Conventions

- Follow the existing strict TypeScript, ESM, Prettier, and ESLint configuration.
- Prefer focused modules and pure functions at provider/configuration
  boundaries. Validate external HTTP payloads before adapting them.
- Add or update focused tests with behavior changes. Fixtures must stay
  deterministic and provider mocks must preserve ownership semantics.
- Load public runtime configuration from `/runtime-config.json`, separate from the frontend build. Never put credentials in it or `VITE_*`. Production is static Nginx, not a custom app server.
- Use `@/` imports for project modules and logical CSS properties for RTL-safe
  layout.

## Verify changes

Run the smallest relevant check during development, then the full applicable
set before handoff:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```

Additional checks by area:

- UI, locale, runtime-composition, or browser behavior: `bun run test:e2e`.
- Native packaging/shared assets: `bun run integrations:build` and `bun run hermes:test`.
- Monty wrapper or lock changes: `bun run monty:test`.
- Compose or Docker changes:

  ```bash
  bunx vitest run test/containers/compose.test.ts
  docker compose -f compose.yaml config --quiet
  docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
  docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
  ```

  Build affected images and smoke their health and streaming endpoints when runtime container
  behavior changes.

- Live harness acceptance requires credentials and approved disposable external targets. Agent creation writes native definitions. Do not treat mocked or skipped journeys as live passes; never change existing user Agents/profiles for routine tests.
