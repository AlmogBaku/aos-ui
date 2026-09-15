/** Run with `bun run test/containers/hermes-audio-proxy-smoke.ts`.
 *
 * The filename is retained for command compatibility. The smoke validates
 * the normalized AOS proxy boundary and never exposes a native provider path.
 * It uses only disposable containers and a loopback-published Nginx port.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const prefix = `aos-ui-proxy-smoke-${randomUUID().slice(0, 8)}`
const network = `${prefix}-network`
const upstream = `${prefix}-upstream`
const proxy = `${prefix}-nginx`
const image =
  process.env.AOS_UI_AUDIO_SMOKE_IMAGE ??
  "nginxinc/nginx-unprivileged:1.29.3-alpine"

const upstreamScript = `
import { createServer } from "node:http";
createServer(async (request, response) => {
  if (request.url === "/api/aos/v1/smoke/stream") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write("data: started\\n\\n");
    setTimeout(() => response.end("data: finished\\n\\n"), 300);
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (!request.url.startsWith("/api/aos/v1/smoke/request?")) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": "aos-proxy-smoke=accepted; Path=/; HttpOnly; SameSite=Lax",
  });
  response.end(JSON.stringify({
    ok: true,
    received: {
      url: request.url,
      bodyBytes: raw.length,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      host: request.headers.host,
      forwardedHost: request.headers["x-forwarded-host"],
      forwardedFor: request.headers["x-forwarded-for"],
      protocol: request.headers["x-forwarded-proto"],
      connection: request.headers.connection,
      httpVersion: request.httpVersion,
    },
  }));
}).listen(8123, "0.0.0.0");
`

function docker(...args: string[]) {
  return execFileSync("docker", args, { cwd: root, encoding: "utf8" }).trim()
}

async function waitForHealth(baseUrl: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { status: "ok" })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error("The disposable Nginx did not become healthy")
}

async function runSmoke(baseUrl: string) {
  await waitForHealth(baseUrl)
  const body = JSON.stringify({ message: "normalized proxy" })
  const response = await fetch(
    `${baseUrl}/api/aos/v1/smoke/request?profile=smoke+profile`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "aos-session=synthetic-smoke",
        authorization: "Bearer synthetic-smoke",
        "x-forwarded-for": "203.0.113.7",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    }
  )
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result, {
    ok: true,
    received: {
      url: "/api/aos/v1/smoke/request?profile=smoke+profile",
      bodyBytes: Buffer.byteLength(body),
      cookie: "aos-session=synthetic-smoke",
      authorization: "Bearer synthetic-smoke",
      host: new URL(baseUrl).host,
      forwardedHost: new URL(baseUrl).host,
      forwardedFor: result.received.forwardedFor,
      protocol: "http",
      connection: "close",
      httpVersion: "1.1",
    },
  })
  assert.match(result.received.forwardedFor, /^203\.0\.113\.7, .+$/u)
  assert.equal(
    response.headers.get("set-cookie"),
    "aos-proxy-smoke=accepted; Path=/; HttpOnly; SameSite=Lax"
  )

  const nativePath = await fetch(`${baseUrl}/hermes/api/sessions`, {
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(nativePath.status, 404)
  await nativePath.arrayBuffer()

  const stream = await fetch(`${baseUrl}/api/aos/v1/smoke/stream`, {
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/u)
  const reader = stream.body!.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), "data: started\n\n")
  let remaining = ""
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    remaining += new TextDecoder().decode(part.value)
  }
  assert.equal(remaining, "data: finished\n\n")
  console.log(
    "AOS normalized proxy smoke passed: request forwarding, auth/cookie/header forwarding, native-route isolation, health, and streaming."
  )
}

if (process.env.AOS_UI_AUDIO_SMOKE_CLIENT_URL) {
  await runSmoke(process.env.AOS_UI_AUDIO_SMOKE_CLIENT_URL)
} else {
  let networkCreated = false
  let upstreamCreated = false
  let proxyCreated = false
  const errors: unknown[] = []
  try {
    docker("network", "create", network)
    networkCreated = true
    docker(
      "run",
      "--rm",
      "-d",
      "--name",
      upstream,
      "--network",
      network,
      "--network-alias",
      "proxy-upstream",
      "node:22-slim",
      "node",
      "--input-type=module",
      "-e",
      upstreamScript
    )
    upstreamCreated = true
    docker(
      "run",
      "--rm",
      "-d",
      "--name",
      proxy,
      "--network",
      network,
      "-p",
      "127.0.0.1::3000",
      "-e",
      "AOS_UI_WEB_PORT=3000",
      "-e",
      "AOS_UI_PROXY_HOST=proxy-upstream",
      "-e",
      "AOS_UI_PROXY_PORT=8123",
      "-v",
      `${resolve(root, "deploy/nginx/default.conf.template")}:/etc/nginx/templates/default.conf.template:ro`,
      image
    )
    proxyCreated = true
    const published = docker("port", proxy, "3000/tcp")
    assert.match(published, /^127\.0\.0\.1:\d+$/u)
    // Share only the disposable proxy's network namespace: the requester uses
    // real loopback even when the Docker daemon is outside the caller's namespace.
    console.log(
      docker(
        "run",
        "--rm",
        "--name",
        `${prefix}-client`,
        "--network",
        `container:${proxy}`,
        "-e",
        "AOS_UI_AUDIO_SMOKE_CLIENT_URL=http://127.0.0.1:3000",
        "-v",
        `${resolve(root, "test/containers/hermes-audio-proxy-smoke.ts")}:/smoke.ts:ro`,
        "node:22-slim",
        "node",
        "--experimental-strip-types",
        "/smoke.ts"
      )
    )
  } catch (error) {
    errors.push(error)
  } finally {
    for (const [created, args] of [
      [proxyCreated, ["rm", "-f", proxy]],
      [upstreamCreated, ["rm", "-f", upstream]],
      [networkCreated, ["network", "rm", network]],
    ] as const) {
      if (!created) continue
      try {
        docker(...args)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "AOS proxy smoke or cleanup failed")
}
