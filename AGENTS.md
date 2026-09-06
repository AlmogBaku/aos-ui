# AOS-ui agent guide

## Read first

- `README.md` is the operator and contributor guide. Keep its commands aligned
  with `package.json`, the Compose files, and the environment examples.
- `PRODUCT.md` defines product terminology, ownership, scope, and accessibility
  commitments.
- `docs/design/agent-workspace-design-lock.md` is the visual design authority.
  Preserve its direction unless the task explicitly changes it.
- `lib/runtime-adapters/contracts.ts` is the shared provider boundary. Keep
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
bun run monty:sync
bun run opencode:serve
```

```bash
bun run dev
```

Open `http://localhost:3000`; locale negotiation redirects to `/en` or `/he`.
Copy `.env.example` to `.env.local` only for local overrides.

Run the production containers:

```bash
cp .env.compose.example .env
docker compose up --build
```

Run the hot-reloading web container with containerized OpenCode:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

Compose is loopback-only by default. Its browser-facing OpenCode URL uses the
published host and port, not the `opencode` service hostname. Treat any wider
binding as a trusted-private-network deployment: this stack has no TLS,
authentication, or reverse proxy.

## Architecture and invariants

- Assistant UI owns threads, messages, runs, branches, composer state, and
  thread lifecycle. `WorkspaceAdapter` adds only Agent ownership, Session
  metadata, Todos, Builder lifecycle, and provider capabilities.
- Provider data is authoritative. Every Session belongs to one Agent; delayed
  events stay scoped to their originating Agent and Session. Plans are
  message-scoped and Todos are Session-scoped.
- Runtime selection is strict. Fixture data appears only in explicit `fixture`
  mode; invalid provider configuration renders unavailable state instead of
  falling back to synthetic data.
- OpenCode is the primary provider. AG-UI uses a separate workspace host and
  degrades visibly when a capability is absent.
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

- `app/[locale]` composes the selected runtime and owns locale-level routing.
- `components/aos-ui-workspace.tsx` is the provider-neutral workspace UI;
  `components/aos-ui-*-app.tsx` are provider composition seams.
- `lib/runtime-adapters/{opencode,ag-ui,fixture}` contain provider behavior.
  Extend `contracts.ts` only for genuinely shared concepts.
- `components/tool-ui` owns rich tool lifecycles and safe fallbacks.
- `lib/i18n` owns shared locale behavior. Some feature-local copy lives beside
  its component; search for both English and Hebrew variants before editing.
- `opencode.json` and `.opencode` own OpenCode configuration, tools, and the
  shared presentation harness. Product Agents created by the Builder live in
  `.opencode/agents`; root `AGENTS.md` is unrelated to them.
- `integrations/monty` is the runtime fork, named `monty`. Preserve its MIT
  license and the upstream commit attribution in `integrations/monty/UPSTREAM.md`.

Treat generated and user-owned material carefully. Do not blindly regenerate
customized shadcn/Assistant UI components. `.agents/skills` is tracked project
tooling, and `.agents/skills/grilling` is also an intentional product dependency.
Preserve unrelated working-tree changes and avoid overwriting existing
`.opencode/agents` definitions.

## Conventions

- Follow the existing strict TypeScript, ESM, Prettier, and ESLint configuration.
- Prefer focused modules and pure functions at provider/configuration
  boundaries. Validate external HTTP payloads before adapting them.
- Add or update focused tests with behavior changes. Fixtures must stay
  deterministic and provider mocks must preserve ownership semantics.
- Keep server-resolved runtime environment reads dynamic; container runtime
  values must not be frozen into the Next.js image.
- Use `@/` imports for project modules and logical CSS properties for RTL-safe
  layout.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

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
- Monty wrapper or lock changes: `bun run monty:test`.
- Compose or Docker changes:

  ```bash
  bunx vitest run test/containers/compose.test.ts
  docker compose -f compose.yaml config --quiet
  docker compose -f compose.yaml -f compose.dev.yaml config --quiet
  ```

  Build both images and smoke their health endpoints when runtime container
  behavior changes.

- Live OpenCode smoke tests require credentials and may create temporary
  Sessions. Live Agent Builder completion writes a real Agent definition and is
  never part of routine automated verification.
