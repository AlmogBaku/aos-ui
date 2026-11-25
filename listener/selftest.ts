// Quick self-test of every listener endpoint against 127.0.0.1 (no TLS, no
// tailnet). Run: bun listener/selftest.ts   Exit code 0 = all checks passed.

import { startListener } from "./listener";

const server = startListener(0, true);
const base = `http://127.0.0.1:${server.port}`;
const wsBase = `ws://127.0.0.1:${server.port}`;
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function wsSession(path: string, script: (ws: WebSocket, messages: unknown[]) => Promise<void>): Promise<{ messages: unknown[]; close?: CloseEvent }> {
  const ws = new WebSocket(`${wsBase}${path}`);
  const messages: unknown[] = [];
  let close: CloseEvent | undefined;
  const closed = new Promise<void>((r) => ws.addEventListener("close", (e) => ((close = e), r())));
  ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  await script(ws, messages);
  await Promise.race([closed, Bun.sleep(3000)]);
  return { messages, close };
}

const until = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(10);
  return pred();
};

try {
  // healthz
  const health = await fetch(`${base}/healthz`);
  check("GET /healthz", health.status === 200 && (await health.text()).includes("ok"));

  // 1. upload 25 MiB
  const size = 25 * 1024 * 1024;
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(body.subarray(i, Math.min(i + 65536, size)));
  const expected = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const up = (await (await fetch(`${base}/upload`, { method: "POST", body })).json()) as { bytes: number; sha256: string };
  check("POST /upload 25 MiB", up.bytes === size && up.sha256 === expected, `${up.bytes} bytes, sha256 ${up.sha256 === expected ? "matches" : "differs"}`);
  check("GET /upload refused", (await fetch(`${base}/upload`)).status === 405);

  // 2. stream
  const t0 = performance.now();
  const res = await fetch(`${base}/stream?chunks=20&interval=200`);
  const reader = res.body!.getReader();
  const arrivals: number[] = [];
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push(Math.round(performance.now() - t0));
    text += new TextDecoder().decode(value);
  }
  const lines = text.trim().split("\n").length;
  const span = arrivals[arrivals.length - 1] - arrivals[0];
  check("GET /stream 20 chunks 200 ms apart", lines === 20 && arrivals.length >= 15 && span >= 3000, `${lines} chunks, ${arrivals.length} reads over ${span} ms`);

  // 3. echo headers
  const echo = (await (await fetch(`${base}/echo-headers`, { headers: { "x-probe": "1", "Tailscale-User-Login": "someone@example.com" } })).json()) as {
    headers: Record<string, string>;
  };
  check("GET /echo-headers echoes", echo.headers["x-probe"] === "1");
  check("GET /echo-headers hides Tailscale-User-* values", echo.headers["tailscale-user-login"] === "<present, value hidden by listener>");
  check("GET /echo-headers no origin when none sent", !("origin" in echo.headers));
  const echoOrigin = (await (await fetch(`${base}/echo-headers`, { headers: { Origin: "tauri://localhost" } })).json()) as {
    headers: Record<string, string>;
  };
  check("GET /echo-headers shows origin when sent", echoOrigin.headers.origin === "tauri://localhost");

  // 5. redirect
  const redirect = await fetch(`${base}/redirect-external`, { redirect: "manual" });
  check("GET /redirect-external is a 302 to example.com", redirect.status === 302 && redirect.headers.get("location") === "https://example.com/");

  // 12. sandbox variants
  const expectedCsp: Record<string, string> = {
    "tauri-localhost": "frame-ancestors tauri://localhost",
    "tauri-scheme": "frame-ancestors tauri:",
    nothing: "frame-ancestors https://nothing.example",
  };
  for (const [variant, csp] of Object.entries(expectedCsp)) {
    const page = await fetch(`${base}/sandbox.html?fa=${variant}&run=selftest`);
    const html = await page.text();
    check(`GET /sandbox.html?fa=${variant} CSP`, page.status === 200 && page.headers.get("content-security-policy") === csp, page.headers.get("content-security-policy") ?? "none");
    // The inline script must be plain JavaScript (no TypeScript left) and must
    // not be cut short by a nested </script>.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let parses = scripts.length === 1;
    try {
      new Function(scripts[0] ?? "");
    } catch (e) {
      parses = false;
      console.log(String(e));
    }
    check(`sandbox.html?fa=${variant} has one parseable inline script`, parses);
  }
  check("GET /sandbox.html unknown variant is 400", (await fetch(`${base}/sandbox.html?fa=other`)).status === 400);

  // 15d. attachment download
  const attachment = await fetch(`${base}/attachment?run=selftest`);
  const attachmentBody = await attachment.text();
  check(
    "GET /attachment is a Content-Disposition attachment",
    attachment.status === 200 &&
      attachment.headers.get("content-disposition") === 'attachment; filename="alm109-probe-attachment.txt"' &&
      attachmentBody === "ALM-109 probe attachment for run selftest\n",
    attachment.headers.get("content-disposition") ?? "no header",
  );

  // 14. leaks and hits
  await fetch(`${base}/leak?from=selftest-http&run=selftest`);
  const hits = (await (await fetch(`${base}/hits?run=selftest`)).json()) as { sandbox: Record<string, number>; leaks: string[]; attachments: number };
  check("GET /hits counts attachment downloads", hits.attachments === 1, String(hits.attachments));
  check("GET /hits counts sandbox loads", hits.sandbox["tauri-localhost"] === 1 && hits.sandbox.nothing === 1, JSON.stringify(hits.sandbox));
  check("GET /hits lists leaks", hits.leaks.length === 1 && hits.leaks[0].includes("selftest-http"), JSON.stringify(hits.leaks));
  const otherRun = (await (await fetch(`${base}/hits?run=other`)).json()) as { leaks: string[] };
  check("GET /hits is per run", otherRun.leaks.length === 0);

  // 4 + 7. hello and close 4001
  const s1 = await wsSession("/ws?mode=hello", async (ws, messages) => {
    await until(() => messages.length > 0, 2000);
    ws.send("close-4001");
  });
  const hello = s1.messages[0] as { type: string; headers: Record<string, string> };
  check("ws hello carries upgrade headers", hello?.type === "hello" && "sec-websocket-key" in hello.headers, Object.keys(hello?.headers ?? {}).join(","));
  check("ws close-4001 closes with 4001", s1.close?.code === 4001 && s1.close?.reason === "probe-close-4001", `${s1.close?.code} ${s1.close?.reason}`);

  // 6. ticks + status
  const s2 = await wsSession("/ws?mode=tick&interval=100", async (ws, messages) => {
    await until(() => messages.filter((m) => (m as { type: string }).type === "tick").length >= 3, 2000);
    ws.send("status");
    await until(() => messages.some((m) => (m as { type: string }).type === "status"), 2000);
    ws.close(1000, "done");
  });
  const ticks = s2.messages.filter((m) => (m as { type: string }).type === "tick") as Array<{ n: number }>;
  const statusMsg = s2.messages.find((m) => (m as { type: string }).type === "status") as { sent: number } | undefined;
  check("ws tick mode sends numbered ticks", ticks.length >= 3 && ticks[0].n === 1 && ticks[2].n === 3, `${ticks.length} ticks`);
  check("ws status reports ticks sent", !!statusMsg && statusMsg.sent >= 3, JSON.stringify(statusMsg));

  // 14. socket leak recorded
  await wsSession("/ws?mode=hello&leak=selftest-socket&run=selftest", async (ws, messages) => {
    await until(() => messages.length > 0, 2000);
    ws.close(1000, "done");
  });
  const hits2 = (await (await fetch(`${base}/hits?run=selftest`)).json()) as { leaks: string[] };
  check("ws leak recorded in /hits", hits2.leaks.some((l) => l.includes("selftest-socket")), JSON.stringify(hits2.leaks));

  check("GET /ws without upgrade is 426", (await fetch(`${base}/ws`)).status === 426);
  check("unknown path is 404", (await fetch(`${base}/nope`)).status === 404);
} catch (e) {
  failures += 1;
  console.log(`FAIL selftest threw: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  server.stop(true);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall listener checks passed");
process.exit(failures ? 1 : 0);
