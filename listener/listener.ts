// ALM-109 probe listener. Plain HTTP + WebSocket on 127.0.0.1 only, no TLS and
// no dependencies beyond Bun. Expose it on your tailnet with
//   tailscale serve --bg --https=<port> http://127.0.0.1:<port>
// (see README.md). It logs every request's headers to stdout; the values of
// Tailscale-User-* identity headers are replaced by a placeholder.
//
// Usage: bun listener/listener.ts [port]      (default 8787, or $PORT)

import type { Server, ServerWebSocket } from "bun";

const SANDBOX_VARIANTS: Record<string, string> = {
  "tauri-localhost": "frame-ancestors tauri://localhost",
  "tauri-scheme": "frame-ancestors tauri:",
  nothing: "frame-ancestors https://nothing.example",
};

interface RunHits {
  sandbox: Record<string, number>;
  leaks: string[];
  attachments: number;
}

interface WsData {
  headers: Record<string, string>;
  mode: string;
  interval: number;
  run: string;
  leak: string;
  sent: number;
  openedAt: number;
  timer?: ReturnType<typeof setInterval>;
}

const IDENTITY_HEADER = /^tailscale-user-/i;
const HIDDEN = "<present, value hidden by listener>";

function headerObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = IDENTITY_HEADER.test(name) ? HIDDEN : value;
  });
  return out;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function sandboxPage(variant: string, run: string): string {
  // Everything here runs inside the frame. It reports back to the embedding
  // page with postMessage; it never receives anything secret.
  const probeSource = String(frameProbe);
  const inner = `<!doctype html><meta charset="utf-8"><body style="font:12px sans-serif">inner srcdoc frame<script>${probeSource}\nframeProbe("inner", ${JSON.stringify(variant)}, ${JSON.stringify(run)});<\/script></body>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>probe frame</title></head>
<body style="font:13px sans-serif;margin:4px">
<div>ALM-109 framed page, variant <b>${variant}</b> (rendered)</div>
<iframe id="inner" sandbox="allow-scripts allow-same-origin" style="width:95%;height:28px;border:1px dotted #888"></iframe>
<script>
${probeSource}
window.parent.postMessage({ probe: "alm109", type: "loaded", variant: ${JSON.stringify(variant)}, where: "outer" }, "*");
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || d.probe !== "alm109" || d.type !== "ping") return;
  const reply = { probe: "alm109", type: "pong", variant: ${JSON.stringify(variant)}, seenOrigin: ev.origin, nonce: d.nonce };
  ev.source.postMessage({ ...reply, via: "*" }, "*");
  try { ev.source.postMessage({ ...reply, via: "exact" }, ev.origin); } catch (e) {}
});
document.getElementById("inner").srcdoc = ${JSON.stringify(inner).replace(/</g, "\\u003c")};
frameProbe("outer", ${JSON.stringify(variant)}, ${JSON.stringify(run)});
</script>
</body></html>`;
}

/** Serialised into the framed pages (outer and inner srcdoc) with String(). */
async function frameProbe(where: string, variant: string, run: string): Promise<void> {
  const w = window as unknown as Record<string, any>;
  const has = {
    internals: typeof w.__TAURI_INTERNALS__ !== "undefined",
    tauri: typeof w.__TAURI__ !== "undefined",
    ipc: typeof w.ipc !== "undefined",
    webkitIpc: !!(w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.ipc),
  };
  // self.origin, not location: an about:srcdoc frame has no host of its own.
  const leakHttp = (label: string) => `${self.origin}/leak?from=${where}-${label}&run=${run}`;
  const leakWs = (label: string) =>
    `${self.origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/ws?mode=hello&leak=${where}-${label}&run=${run}`;
  const clientConfig = (label: string) =>
    encodeURIComponent(JSON.stringify({ method: "GET", url: leakHttp(label), headers: [] }));
  const within = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no reply within ${ms} ms`)), ms))]);
  const describe = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));
  const attempts: Record<string, string> = {};
  const tasks: Promise<void>[] = [];
  const attempt = (name: string, fn: () => Promise<string>) =>
    tasks.push(
      within(fn(), 4000).then(
        (v) => void (attempts[name] = v),
        (e) => void (attempts[name] = `failed: ${describe(e)}`),
      ),
    );

  if (has.internals) {
    attempt("internals.invoke(plugin:http|fetch)", async () => {
      const rid = await w.__TAURI_INTERNALS__.invoke("plugin:http|fetch", new Uint8Array(0), {
        headers: { "client-config": clientConfig("internals-http") },
      });
      return `SUCCEEDED (rid ${rid})`;
    });
    attempt("internals.invoke(socket_open)", async () => {
      const cb = w.__TAURI_INTERNALS__.transformCallback(() => {});
      const id = await w.__TAURI_INTERNALS__.invoke("socket_open", { url: leakWs("internals-socket"), onEvent: `__CHANNEL__:${cb}` });
      return `SUCCEEDED (socket ${id})`;
    });
  } else {
    attempts["__TAURI_INTERNALS__.invoke"] = "not possible (absent)";
  }
  if (has.ipc) {
    attempt("window.ipc.postMessage", async () => {
      w.ipc.postMessage(JSON.stringify({ cmd: "socket_open", callback: 1, error: 2, payload: { url: leakWs("ipc-socket"), onEvent: "__CHANNEL__:1" }, __TAURI_INVOKE_KEY__: "guess" }));
      return "posted (no reply channel; the listener leak log decides)";
    });
  }
  if (has.webkitIpc) {
    attempt("webkit.messageHandlers.ipc.postMessage", async () => {
      const post = (cmd: string, payload: unknown, label: string) =>
        w.webkit.messageHandlers.ipc.postMessage(
          JSON.stringify({ cmd, callback: 1, error: 2, payload, options: { headers: { "client-config": clientConfig(label) } }, __TAURI_INVOKE_KEY__: "guess" }),
        );
      post("plugin:http|fetch", [], "webkit-http");
      post("socket_open", { url: leakWs("webkit-socket"), onEvent: "__CHANNEL__:1" }, "webkit-socket");
      return "posted (no reply channel; the listener leak log decides)";
    });
  }
  attempt("fetch ipc://localhost (plugin:http|fetch)", async () => {
    const res = await fetch("ipc://localhost/plugin%3Ahttp%7Cfetch", {
      method: "POST",
      body: new Uint8Array(0),
      headers: {
        "Content-Type": "application/octet-stream",
        "Tauri-Callback": "1",
        "Tauri-Error": "2",
        "Tauri-Invoke-Key": "guess",
        "client-config": clientConfig("ipcproto-http"),
      },
    });
    const body = (await res.text()).slice(0, 120);
    return res.ok ? `SUCCEEDED? HTTP ${res.status}: ${body}` : `refused: HTTP ${res.status}: ${body}`;
  });
  await Promise.allSettled(tasks);
  window.top?.postMessage({ probe: "alm109", type: "bridge", variant, where, has, attempts }, "*");
}

export function startListener(port: number, quiet = false): Server<WsData> {
  const hits = new Map<string, RunHits>();
  const hitsFor = (run: string): RunHits => {
    let h = hits.get(run);
    if (!h) hits.set(run, (h = { sandbox: {}, leaks: [], attachments: 0 }));
    return h;
  };
  const log = (line: string) => {
    if (!quiet) console.log(line);
  };

  const server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 64 * 1024 * 1024,
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const headers = headerObject(req.headers);
      log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}`);
      for (const [name, value] of Object.entries(headers)) log(`    ${name}: ${value}`);

      switch (url.pathname) {
        case "/":
        case "/healthz":
          return new Response("alm-109 probe listener ok\n", { headers: { "content-type": "text/plain" } });

        case "/upload": {
          if (req.method !== "POST") return new Response("POST only\n", { status: 405 });
          const body = new Uint8Array(await req.arrayBuffer());
          const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
          log(`    -> received ${body.byteLength} bytes, sha256 ${sha256}`);
          return json({ bytes: body.byteLength, sha256 });
        }

        case "/stream": {
          const chunks = intParam(url, "chunks", 20, 1, 200);
          const interval = intParam(url, "interval", 200, 0, 5000);
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let i = 1; i <= chunks; i++) {
                controller.enqueue(encoder.encode(`${JSON.stringify({ i, of: chunks, serverTime: Date.now() })}\n`));
                if (i < chunks) await Bun.sleep(interval);
              }
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" },
          });
        }

        case "/echo-headers":
          return json({ method: req.method, headers });

        case "/redirect-external":
          return new Response(null, { status: 302, headers: { location: "https://example.com/" } });

        case "/sandbox.html": {
          const variant = url.searchParams.get("fa") ?? "";
          const csp = SANDBOX_VARIANTS[variant];
          if (!csp) return new Response(`unknown variant; use one of ${Object.keys(SANDBOX_VARIANTS).join(", ")}\n`, { status: 400 });
          const run = (url.searchParams.get("run") ?? "").slice(0, 40);
          const h = hitsFor(run);
          h.sandbox[variant] = (h.sandbox[variant] ?? 0) + 1;
          return new Response(sandboxPage(variant, run), {
            headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" },
          });
        }

        case "/attachment": {
          // 15d: a file the webview must download, not display.
          const run = (url.searchParams.get("run") ?? "").slice(0, 40);
          hitsFor(run).attachments += 1;
          return new Response(`ALM-109 probe attachment for run ${run}\n`, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "content-disposition": 'attachment; filename="alm109-probe-attachment.txt"',
              "cache-control": "no-store",
            },
          });
        }

        case "/leak": {
          const run = (url.searchParams.get("run") ?? "").slice(0, 40);
          const from = (url.searchParams.get("from") ?? "?").slice(0, 80);
          hitsFor(run).leaks.push(`http ${req.method} from ${from}`);
          log(`    !! LEAK: a frame reached the listener through the app bridge (${from})`);
          return new Response("leaked\n");
        }

        case "/hits":
          return json(hitsFor((url.searchParams.get("run") ?? "").slice(0, 40)));

        case "/ws": {
          const data: WsData = {
            headers,
            mode: url.searchParams.get("mode") ?? "hello",
            interval: intParam(url, "interval", 5000, 50, 60_000),
            run: (url.searchParams.get("run") ?? "").slice(0, 40),
            leak: (url.searchParams.get("leak") ?? "").slice(0, 80),
            sent: 0,
            openedAt: Date.now(),
          };
          if (srv.upgrade(req, { data })) return undefined;
          return new Response("expected a WebSocket upgrade\n", { status: 426 });
        }

        default:
          return new Response("not found\n", { status: 404 });
      }
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const d = ws.data;
        log(`    ws open mode=${d.mode}`);
        if (d.leak) {
          hitsFor(d.run).leaks.push(`socket from ${d.leak}`);
          log(`    !! LEAK: a frame opened a socket through the app bridge (${d.leak})`);
        }
        ws.send(JSON.stringify({ type: "hello", headers: d.headers }));
        if (d.mode === "tick") {
          d.timer = setInterval(() => {
            d.sent += 1;
            ws.send(JSON.stringify({ type: "tick", n: d.sent, serverTime: Date.now() }));
          }, d.interval);
        }
      },
      message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
        const text = typeof message === "string" ? message : message.toString();
        if (text === "close-4001") ws.close(4001, "probe-close-4001");
        else if (text === "status") ws.send(JSON.stringify({ type: "status", sent: ws.data.sent, openedAt: ws.data.openedAt }));
        else ws.send(JSON.stringify({ type: "echo", text: text.slice(0, 200) }));
      },
      close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
        if (ws.data.timer) clearInterval(ws.data.timer);
        log(`    ws closed code=${code} reason=${JSON.stringify(reason)} after ${ws.data.sent} ticks`);
      },
    },
  });
  return server;
}

if (import.meta.main) {
  const port = Number.parseInt(Bun.argv[2] ?? process.env.PORT ?? "8787", 10);
  const server = startListener(port);
  console.log(`ALM-109 probe listener on http://127.0.0.1:${server.port} (loopback only).`);
  console.log(`Expose it on your tailnet:  tailscale serve --bg --https=${server.port} http://127.0.0.1:${server.port}`);
}
