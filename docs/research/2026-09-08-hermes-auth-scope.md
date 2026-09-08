# Hermes dashboard authentication scope

Checked against upstream `main` at
[`fef0e16`](https://github.com/NousResearch/hermes-agent/tree/fef0e16fe19b79ded929209f87c7434270b03825)
on 2026-09-08.

## Conclusion

Hermes's ordinary dashboard login authenticates a caller to a dashboard server; it does not
authorize that caller for a particular profile, agent session, or subset of dashboard
capabilities. Once accepted, the same cookie/native bearer session passes the global gate for
the protected HTTP surface and can mint a WebSocket ticket. Hermes does not document or expose
RBAC, per-user ACLs, profile claims, session ownership claims, or read/write roles for this
interactive auth path.

This matches Hermes's stated security model: it is a single-tenant personal agent, session IDs
are routing identifiers rather than credentials, and mutually untrusted callers should be
separated with distinct instances/allowlists rather than treated as users of one RBAC system.
([security model](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/SECURITY.md#L171-L217))

Consequently:

- **Specific profile:** not within one normal machine dashboard. The documented dashboard is a
  machine-level management surface, and the authenticated user selects the managed profile with
  `?profile=<name>`. The practical upstream-supported boundary is to start a profile with
  `--isolated`, producing a separate per-profile server that can have different auth. Separately,
  the agent API server's `API_SERVER_KEY` can be profile-scoped when multiplexed profile routes
  are enabled; that is a different auth surface from a dashboard login.
- **Specific Hermes session/conversation:** no. A dashboard identity is not bound to a Hermes
  conversation ID, and the Sessions surface can inspect, export, rename, and delete sessions in
  the selected profile.
- **Specific routes/capabilities:** not for interactive dashboard users. There is a separate
  service-to-service bearer-token extension where exact routes opt in and a `TokenPrincipal`
  may carry scopes. Upstream's bundled use is the narrow `/api/gateway/drain` endpoint. This is
  an extension seam for purpose-built machine endpoints, not a general ACL over the existing
  dashboard/API/WebSocket surface.

## Evidence

The dashboard documentation explicitly calls the default server a **machine-level management
surface** that manages every profile, says the URL query selects the profile read/write target,
and describes `--isolated` as the opt-out for exposing different profiles with different auth.
The Chat tab and session list follow that same profile selection.
([dashboard profiles](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/website/docs/user-guide/features/web-dashboard.md#managing-multiple-profiles))

The interactive auth `Session` contains identity and provider metadata plus opaque tokens, but
no role, permission, profile, Hermes session ID, or scopes. The gated middleware verifies that
session and attaches it to `request.state.session`; a successful verification simply continues
to the requested route.
([auth data model](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/hermes_cli/dashboard_auth/base.py#L10-L22),
[global gate](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/hermes_cli/dashboard_auth/middleware.py#L123-L177))

Profile selection is operational routing rather than authorization: the session DB helper takes
the requested profile and opens that profile's `state.db`; it does not receive or compare an
authenticated principal.
([profile-selected session DB](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/hermes_cli/web_server_sessions.py#L183-L196))

The separate agent API documents profile-specific keys for `/p/<profile>/...`: a named
profile's own key is required, the default profile key is rejected, missing profile keys fail
closed, and run IDs cannot cross the profile boundary. But the key authorizes the ordinary API
surface for that profile; it is not limited to one conversation, route, or capability.
([profile-scoped API keys](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/website/docs/user-guide/features/api-server.md#L609-L645),
[session REST surface](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/website/docs/user-guide/features/api-server.md#L541-L573))

`X-Hermes-Session-Id` and `X-Hermes-Session-Key` are routing/memory namespace inputs, not
authorization credentials or proof that a caller owns a session.
([session routing headers](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/website/docs/user-guide/features/api-server.md#L588-L599))

WebSocket tickets inherit only `user_id` and provider and are short-lived/single-use; they do
not add a profile or conversation restriction.
([ticket contents](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/hermes_cli/dashboard_auth/ws_tickets.py#L36-L47),
[ticket mint route](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/hermes_cli/dashboard_auth/routes.py#L445-L454))

The distinct machine-token seam registers exact paths. Its `TokenPrincipal.scopes` are optional
and the route itself may enforce them; registering a path does not make it public. The official
documentation identifies the drain endpoint as the first bundled consumer.
([token principal](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/hermes_cli/dashboard_auth/base.py#L24-L35),
[exact-route token seam](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/hermes_cli/dashboard_auth/token_auth.py#L1-L40),
[documented token auth](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/website/docs/user-guide/features/web-dashboard.md#non-interactive-bearer-token-auth))

## Implication for AOS ingress

Treat one upstream Hermes dashboard credential as full control of everything that dashboard
process exposes. AOS's transparent ingress must not claim profile- or session-level isolation.
If AOS needs a profile-specific boundary today, point a dedicated ingress route at a Hermes
`--isolated` server for that profile and enforce outer access per route/server, or use the
profile-scoped API-server key if AOS's required protocol is fully available on that API surface.
Session-specific
or capability-specific access would require an AOS authorization gateway that understands and
filters every HTTP and WebSocket operation, or upstream Hermes authorization support; a simple
reverse proxy is insufficient.

Even the profile boundary is logical data/config separation, not a filesystem sandbox. Use
separate OS/container instances when callers are not mutually trusted.
([profile isolation limits](https://github.com/NousResearch/hermes-agent/blob/fef0e16fe19b79ded929209f87c7434270b03825/website/docs/user-guide/profiles.md#L133-L166))
