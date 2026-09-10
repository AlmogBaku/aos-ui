# Deploy AOS

AOS is a Vite application that builds to static assets. The supplied production image serves those assets with Nginx and loads runtime selection from a read-only configuration file.

## Build static assets

```bash
bun install
bun run build
```

The output is written to `dist/`. Serve it through a static host that:

- returns `index.html` for valid application routes;
- serves `/runtime-config.json` without long-lived caching;
- gives hashed assets immutable caching;
- exposes `/api/health` for the web service; and
- forwards the selected native integration paths without turning proxy failures into SPA responses.

The supplied Nginx configuration implements these behaviors.

## Run fixture mode with Compose

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
  docker compose up --build
```

Open <http://localhost:3000>. The web health endpoint is <http://localhost:3000/api/health>.

## Add OpenCode

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The overlay builds and starts OpenCode, mounts the external worktree at `/workspace`, and publishes native port `4096` on loopback by default. Its health endpoint is `/global/health`.

Read [Run with OpenCode](runtimes/opencode.md) before adding model credentials or changing host identity settings.

## Connect operator-managed Hermes

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes-native.json \
  docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

The Hermes overlay does not start Hermes. It configures the web container to forward `/hermes` and native authentication traffic to `AOS_UI_HERMES_HOST:AOS_UI_HERMES_PORT`.

Read [Run with Hermes](runtimes/hermes.md) for native plugin, profile, and authentication setup.

## Use hot reload in containers

Add `compose.dev.yaml` to the selected composition. For example:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose \
    -f compose.yaml \
    -f compose.opencode.yaml \
    -f compose.dev.yaml \
    up --build
```

The development overlay bind-mounts frontend source and keeps `node_modules` in a named volume. Native worktree and state mounts remain separate.

## Change public configuration

Compose mounts the file selected by `AOS_UI_RUNTIME_CONFIG_FILE` at `/runtime-config.json`. Modify or replace that host file, then recreate the web container. The frontend image does not need to be rebuilt.

See the [configuration reference](configuration.md) for accepted fields and secret boundaries.

## Network exposure

All published ports bind to `127.0.0.1` by default. Set `AOS_UI_BIND_ADDRESS` only when another host must connect, and use browser-reachable runtime URLs and CORS origins.

> [!WARNING]
> The Compose stack does not provide TLS or public multi-user authentication. Treat a wider bind as a trusted-private-network deployment and place appropriate access controls in front of it.

Hermes must listen on an address reachable from the web container. A host-loopback-only listener is not reachable through `host.docker.internal`.

## Persistence and shutdown

Provider persistence remains native:

- OpenCode uses the external worktree plus the `opencode-data` named volume.
- Hermes keeps all state in the operator-managed Hermes installation.
- The web container holds no conversation database.

Stop a composition with the same file set used to start it:

```bash
docker compose -f compose.yaml -f compose.opencode.yaml down
```

Do not add `-v` unless you intend to delete named native-state volumes.

## Validate Compose changes

```bash
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
```

When runtime container behavior changes, also build the affected image and smoke its health and streaming endpoints.
