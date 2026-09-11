# AOS UI OpenClaw plugin

Native OpenClaw tools for AOS UI structured presentations and workspace artifact
validation. Agent creation, Session handoff, and downloadable artifact publication
are unsupported in this package.

The package pins the experimental OpenClaw SDK version it was tested against.
Build the package before installing it into OpenClaw:

```bash
bun install
bun run test
bun run build
```

The registered tools are `render_chart`, `render_map`, `render_stats`,
`present_plan`, and `present_artifact`. The plugin takes no configuration;
remove the previously advertised `creatorAgentId` setting when upgrading.

`create_agent` and `start_session` are omitted from registration and manifest
metadata. OpenClaw 2026.9.4 documents `api.runtime.gateway` as restricted to
bundled or trusted official plugins, rejecting arbitrary external plugins; it
also grants only `operator.write`, whereas Agent writes require `operator.admin`.
An approval prompt does not grant that Gateway authority.

The official `OpenClawPluginToolContext` supplies Agent/Session identity and
current-route delivery, but no operator-authenticated creation transport.
`plugin-sdk/gateway-method-runtime` dispatch is reserved for authenticated HTTP
request scopes. `plugin-sdk/gateway-runtime` exports `GatewayClient`, but using it
would require a separately provisioned authenticated connection and its native
scopes. This package has no such credential or identity binding. Re-enabling
these workflows requires designing and testing that authority boundary first.

`present_artifact` currently performs the full workspace path, symlink,
sensitivity, regular-file, MIME, and size checks, then returns a text-only
fallback with `status: "unsupported"` and `published: false`; `ok: true` describes
successful validation only. OpenClaw 2026.9.4's `artifacts.list`, `artifacts.get`,
and `artifacts.download` expose transcript-derived media, with unsupported
downloads for unsafe/local URL sources. No documented tool API registers this
workspace file and returns native download authority. Current-route
`toolContext.delivery.send` is a channel delivery helper and is unavailable for
Gateway-owned delivery, so it cannot provide a general AOS artifact publisher.

These boundaries were checked against the docs and declarations shipped in the
pinned `openclaw@2026.9.4` package:

- `docs/plugins/sdk-runtime/gateway-and-nodes.md`
- `docs/plugins/tool-plugins.md` (factory context and delivery)
- `docs/plugins/manifest/capabilities.md` (`gatewayMethodDispatch` entitlement)
- `docs/plugins/sdk-subpaths.md` (`gateway-runtime` and `gateway-method-runtime`)
- `docs/gateway/protocol/rpc-talk-config-and-agents.md` (artifact RPCs)
- `dist/plugin-sdk/gateway-runtime.d.ts` and its exported `GatewayClientOptions`
- `OpenClawPluginToolContext` in the SDK's exported declarations
