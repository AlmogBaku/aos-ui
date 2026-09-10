import { expect, test } from "@playwright/test"

import { presentationExamples } from "../shared/presentation/tools"

test.setTimeout(60_000)

test("Hermes authentication errors use a compact dismissible toast", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let ticketRequests = 0
  await page.route("**/hermes/api/auth/ws-ticket", (route) => {
    ticketRequests++
    return route.fulfill({ status: 401 })
  })
  await page.goto("/")
  const toast = page.locator('[data-slot="error-toast"]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText("Hermes authentication failed (401)")
  await expect(
    toast.getByRole("link", { name: "Sign in to Hermes" })
  ).toHaveAttribute("href", "/hermes/login")
  await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(page.getByRole("main", { name: "Conversation" })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(1)
  // Startup and catalog discovery can each encounter the rejected login.
  const requestsBeforeDismiss = ticketRequests
  expect(requestsBeforeDismiss).toBeGreaterThan(0)
  expect(requestsBeforeDismiss).toBeLessThanOrEqual(2)
  const bounds = await toast.boundingBox()
  expect(bounds!.width).toBeLessThanOrEqual(390 - 32)
  expect(bounds!.y).toBeGreaterThan(844 / 2)
  expect(844 - bounds!.y - bounds!.height).toBeGreaterThanOrEqual(112)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(toast).toHaveCSS("bottom", "16px")
  await expect(toast).toHaveCSS("right", "16px")
  await toast.getByRole("button", { name: "Dismiss notification" }).click()
  await expect(toast).toHaveCount(0)
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(ticketRequests).toBe(requestsBeforeDismiss)
})

test("Hermes uses the native authenticated RPC wire without history resubmission", async ({
  page,
}) => {
  // Keep the fixture values owned by this test and assert what the mocked
  // provider sent. The copy is deliberately not a readiness/state contract.
  const fixtureText = {
    history: `hydrated-history-${test.info().parallelIndex}`,
    response: `submitted-response-${test.info().parallelIndex}`,
  }
  let submissions = 0
  let activityAt = 0
  const rpcMethods: string[] = []
  const plan = presentationExamples.present_plan

  await page.route("**/hermes/api/auth/ws-ticket", (route) =>
    route.fulfill({ json: { ticket: "e2e-ticket", ttl_seconds: 30 } })
  )
  await page.route("**/hermes/api/config?**", (route) =>
    route.fulfill({ status: 403 })
  )
  await page.route("**/hermes/api/sessions?**", (route) => {
    const profile = new URL(route.request().url()).searchParams.get("profile")
    return route.fulfill({
      json: {
        sessions:
          profile === "research"
            ? [
                {
                  id: "history",
                  profile: "research",
                  title: "Native history",
                  last_active: 1_788_000_000,
                },
                {
                  id: "older-history",
                  profile: "research",
                  title: "Unobserved older history",
                  last_active: 1_700_000_000,
                },
              ]
            : [],
        total: profile === "research" ? 2 : 0,
        limit: 100,
        offset: 0,
      },
    })
  })
  await page.route("**/hermes/api/sessions/history/messages?**", (route) =>
    route.fulfill({
      json: {
        session_id: "history",
        messages: [
          {
            id: "history-message",
            role: "assistant",
            content: fixtureText.history,
          },
          ...(submissions
            ? [
                {
                  id: "native-user",
                  role: "user",
                  content: "Please respond once",
                },
                {
                  id: "native-answer",
                  role: "assistant",
                  content: fixtureText.response,
                  tool_calls: [
                    {
                      id: "native-plan",
                      function: {
                        name: "present_plan",
                        arguments: JSON.stringify(plan),
                      },
                    },
                  ],
                },
                {
                  id: "native-plan-result",
                  role: "tool",
                  tool_call_id: "native-plan",
                  content: JSON.stringify({ ok: true, value: plan }),
                },
              ]
            : []),
        ],
        pagination: { returned: submissions ? 4 : 1 },
      },
    })
  )

  await page.exposeFunction(
    "__hermesRpc",
    (request: { method: string; params?: Record<string, unknown> }) => {
      rpcMethods.push(request.method)
      if (request.method === "profiles.list")
        return {
          profiles: [
            {
              name: "research",
              display_name: "Research",
              description: "Native profile",
              canonical_session: { id: "history", last_active: activityAt },
              ui_meta: { "hermes-bots": { hidden: false } },
            },
          ],
        }
      if (request.method === "session.resume")
        return {
          session_id: "live-history",
          resumed: "history",
          running: false,
          status: "idle",
          messages: [],
        }
      if (request.method === "session.active_list")
        return {
          sessions: [
            { id: "live-history", session_key: "history", status: "idle" },
          ],
        }
      if (request.method === "prompt.submit") {
        submissions++
        return { status: "streaming" }
      }
      if (request.method === "session.events.since")
        return { events: [], truncated: false, epoch: "e2e" }
      if (request.method === "model.options")
        return {
          provider: "mock",
          model: "chat",
          providers: [
            {
              slug: "mock",
              name: "Mock",
              authenticated: true,
              models: ["chat"],
            },
          ],
        }
      if (request.method === "session.usage")
        return {
          context_used: 2_048,
          context_max: 65_536,
          context_source: "provider_usage",
          context_estimated: false,
        }
      if (request.method === "session.context_breakdown")
        return {
          context_used: 2_048,
          context_max: 65_536,
          context_source: "provider_usage",
          context_estimated: false,
        }
      throw new Error(`Unexpected Hermes RPC ${request.method}`)
    }
  )

  await page.addInitScript((nativePlan) => {
    Object.defineProperty(window.crypto, "randomUUID", { value: undefined })
    class NativeSocket extends EventTarget {
      static readonly OPEN = 1
      readyState = 0
      constructor(
        readonly url: string,
        readonly protocols: string[]
      ) {
        super()
        ;(
          window as unknown as { __hermesSocket?: NativeSocket }
        ).__hermesSocket = this
        setTimeout(() => {
          this.readyState = 1
          this.dispatchEvent(new Event("open"))
        })
      }
      send(raw: string) {
        const request = JSON.parse(raw) as {
          id: string
          method: string
          params?: Record<string, unknown>
        }
        void (
          window as unknown as {
            __hermesRpc(value: typeof request): Promise<unknown>
          }
        )
          .__hermesRpc(request)
          .then((result) => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result,
                }),
              })
            )
            if (request.method !== "prompt.submit") return
            setTimeout(() => {
              for (const event of [
              {
                type: "message.start",
                session_id: "live-history",
                seq: 1,
                payload: {},
              },
              {
                type: "message.delta",
                session_id: "live-history",
                seq: 2,
                payload: {
                  text: fixtureText.response,
                },
              },
              {
                type: "tool.start",
                session_id: "live-history",
                seq: 3,
                payload: {
                  tool_id: "native-plan",
                  name: "present_plan",
                  args: nativePlan,
                },
              },
              {
                type: "tool.complete",
                session_id: "live-history",
                seq: 4,
                payload: {
                  tool_id: "native-plan",
                  name: "present_plan",
                  args: nativePlan,
                  result: { ok: true, value: nativePlan },
                },
              },
              {
                type: "message.complete",
                session_id: "live-history",
                seq: 5,
                payload: {
                  text: fixtureText.response,
                },
              },
              ])
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: JSON.stringify({
                      jsonrpc: "2.0",
                      method: "event",
                      params: event,
                    }),
                  })
                )
            }, 0)
          })
      }
      close() {
        this.readyState = 3
      }
    }
    Object.defineProperty(window, "WebSocket", { value: NativeSocket })
  }, plan)

  await page.goto("/research/hermes%3Aresearch%3Ahistory")
  await expect(
    page.getByText(fixtureText.history, { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Idle", { exact: true }).first()).toBeVisible()
  await expect(
    page.getByText("Status unavailable", { exact: true })
  ).toHaveCount(0)
  expect(submissions).toBe(0)
  const resumeCount = rpcMethods.filter(
    (method) => method === "session.resume"
  ).length
  activityAt = Date.now() / 1000
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible()
  activityAt = 0
  await expect(page.getByText("Active", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Idle", { exact: true }).first()).toBeVisible()
  expect(
    rpcMethods.filter((method) => method === "session.resume")
  ).toHaveLength(resumeCount)
  expect(submissions).toBe(0)
  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Please respond once")
  await page.getByRole("button", { name: "Send message" }).click()
  expect(submissions).toBe(1)
  expect(
    rpcMethods.filter((method) => method === "prompt.submit")
  ).toHaveLength(1)
  // The native completion is authoritative after hydration. Checking the
  // rendered history after reload also proves the response was persisted and
  // avoids coupling this contract to the timing of live event reconciliation.
  await page.reload()
  await expect(
    page.getByText(fixtureText.response, {
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByRole("heading", { name: plan.title })).toBeVisible()
  expect(submissions).toBe(1)
  expect(
    rpcMethods.filter((method) => method === "prompt.submit")
  ).toHaveLength(1)
})

test("Hermes renders and answers a native clarification request", async ({
  page,
}) => {
  const clarificationResponses: Array<Record<string, unknown>> = []
  let resumed = false
  await page.route("**/hermes/api/auth/ws-ticket", (route) =>
    route.fulfill({ json: { ticket: "clarify-ticket", ttl_seconds: 30 } })
  )
  await page.route("**/hermes/api/sessions?**", (route) => {
    const profile = new URL(route.request().url()).searchParams.get("profile")
    return route.fulfill({
      json: {
        sessions:
          profile === "research"
            ? [
                {
                  id: "clarify-history",
                  profile: "research",
                  title: "Clarification Session",
                  last_active: 1_788_000_000,
                },
              ]
            : [],
        total: profile === "research" ? 1 : 0,
      },
    })
  })
  await page.route(
    "**/hermes/api/sessions/clarify-history/messages?**",
    (route) =>
      route.fulfill({
        json: {
          messages: [
            { id: "native-prompt", role: "user", content: "Plan release" },
          ],
          pagination: { returned: 1 },
        },
      })
  )
  await page.exposeFunction(
    "__hermesClarifyRpc",
    (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "profiles.list")
        return {
          profiles: [
            {
              name: "research",
              display_name: "Research",
              ui_meta: { "hermes-bots": { hidden: false } },
            },
          ],
        }
      if (request.method === "session.resume") {
        resumed = true
        return { session_id: "live-clarify", running: false, status: "idle" }
      }
      if (request.method === "session.active_list") return { sessions: [] }
      if (request.method === "clarify.respond") {
        clarificationResponses.push(request.params ?? {})
        return { resolved: true }
      }
      throw new Error(`Unexpected Hermes RPC ${request.method}`)
    }
  )
  await page.addInitScript(() => {
    const BrowserWebSocket = window.WebSocket
    class NativeSocket extends EventTarget {
      static readonly OPEN = 1
      readyState = 0
      constructor() {
        super()
        ;(
          window as unknown as { __hermesClarifySocket?: NativeSocket }
        ).__hermesClarifySocket = this
        setTimeout(() => {
          this.readyState = 1
          this.dispatchEvent(new Event("open"))
        })
      }
      send(raw: string) {
        const request = JSON.parse(raw) as {
          id: string
          method: string
          params?: Record<string, unknown>
        }
        void (
          window as unknown as {
            __hermesClarifyRpc(value: typeof request): Promise<unknown>
          }
        )
          .__hermesClarifyRpc(request)
          .then((result) =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result,
                }),
              })
            )
          )
      }
      emitClarification() {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              jsonrpc: "2.0",
              method: "event",
              params: {
                type: "clarify.request",
                session_id: "live-clarify",
                seq: 1,
                payload: {
                  request_id: "clarify-release",
                  questions: [
                    {
                      qid: "region",
                      question: "Release region?",
                      choices: ["IL", "US"],
                      multi_select: false,
                    },
                    {
                      qid: "goal",
                      question: "Release goal?",
                      choices: null,
                      multi_select: false,
                    },
                  ],
                },
              },
            }),
          })
        )
      }
      close() {
        this.readyState = 3
      }
    }
    const RoutedSocket = new Proxy(BrowserWebSocket, {
      construct(Target, args) {
        const protocols = args[1]
        const protocolList = Array.isArray(protocols)
          ? protocols
          : typeof protocols === "string"
            ? [protocols]
            : []
        if (protocolList.includes("hermes-gateway-v1"))
          return new NativeSocket()
        return Reflect.construct(Target, args)
      },
    })
    Object.defineProperty(window, "WebSocket", { value: RoutedSocket })
  })

  await page.goto("/research/hermes%3Aresearch%3Aclarify-history")
  await expect.poll(() => resumed).toBe(true)
  await page.evaluate(() =>
    (
      window as unknown as {
        __hermesClarifySocket?: { emitClarification(): void }
      }
    ).__hermesClarifySocket?.emitClarification()
  )
  await expect(page.getByRole("region", { name: "Questions" })).toBeVisible()
  await page.getByText("IL", { exact: true }).click()
  await page.getByRole("button", { name: "Next" }).click()
  await page.getByRole("button", { name: "Type an answer" }).click()
  await page.getByLabel("Your answer for Question 2").fill("Ship safely")
  await page.getByRole("button", { name: "Send answer" }).click()
  await expect
    .poll(() => clarificationResponses)
    .toEqual([
      {
        session_id: "live-clarify",
        request_id: "clarify-release",
        question_id: "region",
        answer: "IL",
      },
      {
        session_id: "live-clarify",
        request_id: "clarify-release",
        question_id: "goal",
        answer: "Ship safely",
      },
    ])
})
