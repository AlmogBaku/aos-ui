# AOS Docker and Compose Implementation Plan

## Goal

Ship reproducible production and development containers for the AOS web app and its OpenCode backend while letting OpenCode automatically select from providers and models that are actually available at runtime.

## Global Constraints

- Pin the OpenCode container to version `1.18.27` and include Python 3.12+, uv, and the locked Monty environment.
- The browser connects directly to the published OpenCode server; no reverse proxy, TLS, or authentication layer is included. Document that the stack is for trusted private networks only.
- Do not send a model override unless both `AOS_UI_OPENCODE_PROVIDER_ID` and `AOS_UI_OPENCODE_MODEL_ID` are non-empty. If exactly one is configured, return the unavailable reason `incomplete-opencode-model-override`.
- Remove root, small-model, and Agent Builder model pins from `opencode.json` so OpenCode's native configured/available model selection applies.
- Preserve AWS Bedrock support through the standard AWS credential chain.
- Configure an optional `openai-compatible` provider only when its environment variables are supplied, using `@ai-sdk/openai-compatible` and the provider id `openai-compatible`.
- Production uses a Next.js standalone image and a separate OpenCode image. Development hot-reloads only the web service.
- Bind-mount the repository as the writable OpenCode workspace and persist OpenCode state in a named volume. Keep the Monty virtual environment outside the workspace mount.
- The locale page must render dynamically so runtime environment variables are not frozen into the image.
- Add `GET /api/health`, returning exactly `{ "status": "ok" }` with HTTP 200.
- Preserve unrelated working-tree changes and the known pre-existing Agent Builder prompt test failure.

## Task 1: Runtime model auto-selection and web health

Implement the application-layer behavior required by containers.

- Update `lib/runtime-config.test.ts` first and observe focused failures.
- Make the OpenCode-ready configuration omit `defaultModel` when neither override variable is set.
- Include `defaultModel` only when both trimmed override variables are set.
- Return `incomplete-opencode-model-override` when exactly one override is set.
- Thread the optional model through `app/[locale]/page.tsx` and `components/aos-ui-opencode-app.tsx` without inventing a fallback.
- Call `await connection()` before reading runtime environment variables in the locale page, using the installed Next.js 16 API.
- Add a focused test and implementation for `app/api/health/route.ts`; it must return HTTP 200 and `{ "status": "ok" }`.
- Run focused tests, typecheck, and the existing OpenCode component tests. Commit only task files.

## Task 2: OpenCode provider discovery and server configuration

Make the OpenCode service derive its usable provider/model catalog from its runtime environment.

- Update `test/opencode/agent-configuration.test.ts` first for removal of all hard-coded model pins and for the optional custom provider contract; preserve all unrelated existing assertions.
- Remove `model`, `small_model`, and `agent.agent-builder.model` from `opencode.json`.
- Add a small startup/config-generation module and focused tests that materialize an OpenCode configuration overlay only when all three custom-provider variables are set: `AOS_UI_OPENAI_COMPATIBLE_BASE_URL`, `AOS_UI_OPENAI_COMPATIBLE_API_KEY`, and `AOS_UI_OPENAI_COMPATIBLE_MODEL_ID`.
- The generated provider must use npm package `@ai-sdk/openai-compatible`, provider id `openai-compatible`, configured `baseURL` and `apiKey`, and model id `default` mapped to the supplied upstream model id. Incomplete custom-provider configuration must fail clearly rather than be partially applied.
- Update `scripts/opencode-serve.ts` and focused tests to accept comma-separated `AOS_UI_OPENCODE_CORS_ORIGINS`, retain safe localhost defaults, and pass each origin as a separate OpenCode `--cors` argument.
- Keep local non-container development working.
- Run focused tests, typecheck, and lint. Commit only task files.

## Task 3: Container images and Compose orchestration

Add the container and orchestration files.

- Add a multi-stage production `Dockerfile` for Bun/Next 16 that installs locked dependencies, builds with `output: "standalone"`, and copies `.next/standalone`, `.next/static`, and `public` into a minimal non-root runtime image.
- Add `Dockerfile.opencode`, based on the pinned OpenCode 1.18.27 image or an equally pinned compatible source, with Python 3.12+, uv 0.12.5, Monty synced from its lock file, and the repository startup script as its entrypoint.
- Add `.dockerignore` that excludes dependencies, build/test output, VCS metadata, local env/credential files, and local virtual environments while retaining build inputs.
- Add production `compose.yaml` with `web` and `opencode`, service health checks, dependency ordering, named OpenCode state and Monty environment volumes, and a writable repository bind mount for the OpenCode workspace.
- Add `compose.dev.yaml` that switches only `web` to the development command and source mounts while retaining containerized OpenCode.
- Support `AOS_UI_BIND_ADDRESS`, `AOS_UI_WEB_PUBLISHED_PORT`, `AOS_UI_OPENCODE_PUBLISHED_PORT`, and `AOS_UI_OPENCODE_CORS_ORIGINS` with documented safe defaults.
- Set the browser-facing OpenCode URL to the published host/port, not the Compose service hostname.
- Add compose-focused static tests if practical, then validate both merged configurations and build both images.
- Commit only task files.

## Task 4: Operator documentation and end-to-end verification

Document and verify the complete stack.

- Add `.env.compose.example` with defaults, optional explicit model override, AWS credential-chain examples, and optional OpenAI-compatible provider variables.
- Update `README.md` with production and development commands, port/bind customization, provider auto-detection behavior, explicit override pairing, Bedrock credentials, the custom provider contract, persistence/mount behavior, health endpoints, and the trusted-private-network security boundary.
- Verify unit tests (noting only the pre-existing unrelated failure if still present), typecheck, lint, production build, dynamic locale route output, both Compose configurations, both image builds, web health, OpenCode reachability, and a provider-catalog smoke check where credentials are available.
- Make only fixes necessary for this plan, commit them, and report any credential-dependent smoke checks that could not be exercised.
