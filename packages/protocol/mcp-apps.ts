import {
  CallToolResultSchema,
  ReadResourceResultSchema,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

/**
 * MCP Apps (spec 2026-01-26) as the proxy hands them to the browser. A tool
 * declares its view with `_meta.ui.resourceUri`; the proxy resolves that
 * resource server-side and the browser only ever sees the view below, keyed
 * by the tool call that opened it, never the resource URI.
 */

export { CallToolResultSchema, ReadResourceResultSchema }
export type { CallToolResult, ReadResourceResult }

const DomainListSchema = z.array(z.string().min(1).max(2048)).max(64)

/** A UI resource's `_meta.ui.csp`: the origins its view may reach. */
export const McpUiCspSchema = z.object({
  connectDomains: DomainListSchema.optional(),
  resourceDomains: DomainListSchema.optional(),
  frameDomains: DomainListSchema.optional(),
  baseUriDomains: DomainListSchema.optional(),
})
export type McpUiCsp = z.infer<typeof McpUiCspSchema>

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const HOST = `${LABEL}(?:\\.${LABEL})*`
const PORT = "(?::\\d{1,5})?"
/** An origin with no path or credentials, optionally one wildcard label. */
const TLS = new RegExp(`^https://(?:\\*\\.)?${HOST}${PORT}$`, "iu")
/** The same shape for a connection, which may also be a secure socket. */
const TLS_CONNECT = new RegExp(
  `^(?:https|wss)://(?:\\*\\.)?${HOST}${PORT}$`,
  "iu"
)
/** A plain-text connection only to this machine. */
const LOOPBACK_CONNECT = new RegExp(
  `^(?:http|ws)://(?:127\\.0\\.0\\.1|(?:(?:\\*|${HOST})\\.)?localhost)${PORT}$`,
  "iu"
)

/**
 * Whether a view may name this origin in the given `_meta.ui.csp` list.
 * Connections admit `https://` and `wss://` hosts, and plain `http://` or
 * `ws://` only to a loopback host; every other list admits `https://` only.
 */
export function isMcpAppCspDomain(list: keyof McpUiCsp, value: string) {
  return list === "connectDomains"
    ? TLS_CONNECT.test(value) || LOOPBACK_CONNECT.test(value)
    : TLS.test(value)
}

const PermissionSchema = z.object({})

/** A UI resource's `_meta.ui.permissions`: the device features it asks for. */
export const McpUiPermissionsSchema = z.object({
  camera: PermissionSchema.optional(),
  microphone: PermissionSchema.optional(),
  geolocation: PermissionSchema.optional(),
  clipboardWrite: PermissionSchema.optional(),
})
export type McpUiPermissions = z.infer<typeof McpUiPermissionsSchema>

/** `GET` an MCP App view: its HTML, sandbox policy, and the call it renders. */
export const McpAppViewSchema = z.strictObject({
  html: z.string().max(5_000_000),
  csp: McpUiCspSchema.optional(),
  permissions: McpUiPermissionsSchema.optional(),
  prefersBorder: z.boolean().optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  toolResult: CallToolResultSchema.optional(),
})
export type McpAppView = z.infer<typeof McpAppViewSchema>

/** A view's `tools/call`, answered with a `CallToolResult`. */
export const McpAppToolCallRequestSchema = z.strictObject({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()),
})
export type McpAppToolCallRequest = z.infer<typeof McpAppToolCallRequestSchema>

/** A view's `resources/read`, answered with a `ReadResourceResult`. */
export const McpAppResourceReadRequestSchema = z.strictObject({
  uri: z.string().min(1).max(2048),
})
export type McpAppResourceReadRequest = z.infer<
  typeof McpAppResourceReadRequestSchema
>

/**
 * The MCP App sandbox proxy: a static page, served beside the workspace on
 * every listener, that holds only the relay creating the App's own frame. It
 * is a real document rather than `srcdoc` so it carries this policy instead of
 * inheriting the embedding page's, which on the guest surface forbids inline
 * scripts. The App frame inherits it too, so it is the widest any view may
 * reach — every source `buildMcpAppCsp` can grant — and the view's own policy,
 * injected into its document, narrows it to what it declared.
 */
export const MCP_APP_SANDBOX_PATH = "/mcp-app-sandbox.html"

/** CSP has no syntax for an IPv6 literal, so `[::1]` cannot be named here. */
const LOOPBACK_SOURCES = (scheme: "http" | "ws") =>
  ["127.0.0.1", "localhost", "*.localhost"].map(
    (host) => `${scheme}://${host}:*`
  )

export const MCP_APP_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: https:",
  [
    "connect-src https: wss:",
    ...LOOPBACK_SOURCES("http"),
    ...LOOPBACK_SOURCES("ws"),
  ].join(" "),
  "worker-src 'self' blob:",
  "frame-src https:",
  "base-uri https:",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ")
