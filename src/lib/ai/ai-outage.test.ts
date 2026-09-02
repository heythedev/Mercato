import { describe, it, expect, beforeEach } from "vitest";
import {
  AiUnavailableError,
  THINKING_HEADER,
  classifyAiError,
  clearAiOutage,
  createMoonshotFetch,
  getAiOutage,
  noThinkingHeaders,
  noteAiOutage,
} from "./moonshot";

// Moonshot's exact answer for a drained organization (observed 2026-09-02).
// It is an HTTP 429 — the same status as a rate limit — which is how a
// suspended account was retried by the SDK, retried by the sweep, and then
// written into the database as "Needs manual review" for thousands of rows.
const SUSPENDED_BODY = JSON.stringify({
  error: {
    message:
      "Your account org-384d9ed123b248bc9de90dbddbaf954c <ak-x> is suspended due to insufficient balance, " +
      "please recharge your account or check your plan and billing details",
    type: "exceeded_current_quota_error",
  },
});

describe("classifyAiError", () => {
  it("treats a suspended-account 429 as fatal, unwrapping the SDK retry error", () => {
    const api = {
      statusCode: 429,
      message: "Your account org-1 <ak-x> is suspended due to insufficient balance",
      responseBody: SUSPENDED_BODY,
    };
    const retry = { message: "Failed after 3 attempts. Last error: …", lastError: api, errors: [api, api, api] };
    expect(classifyAiError(retry)).toMatchObject({ fatal: true, statusCode: 429 });
    expect(classifyAiError(retry).reason).toMatch(/suspended/);
  });

  it("treats a plain rate-limit 429 as transient", () => {
    expect(classifyAiError({ statusCode: 429, message: "rate limit reached, too many requests" }).fatal).toBe(false);
  });

  it("treats auth, billing and retired-model errors as fatal", () => {
    expect(classifyAiError({ statusCode: 401, message: "invalid api key" }).fatal).toBe(true);
    expect(classifyAiError({ statusCode: 402, message: "payment required" }).fatal).toBe(true);
    expect(
      classifyAiError({ statusCode: 404, message: "Not found the model moonshot-v1-auto or Permission denied" }).fatal,
    ).toBe(true);
    expect(classifyAiError(new AiUnavailableError("balance is $0.00"))).toEqual({
      fatal: true,
      reason: "balance is $0.00",
    });
  });

  it("treats network, server and parse errors as transient", () => {
    expect(classifyAiError({ statusCode: 502, message: "Bad gateway" }).fatal).toBe(false);
    expect(classifyAiError(new Error("fetch failed")).fatal).toBe(false);
    expect(classifyAiError({ statusCode: 404, message: "no such route" }).fatal).toBe(false);
  });
});

describe("createMoonshotFetch", () => {
  beforeEach(() => clearAiOutage());

  it("rewrites a quota 429 into a non-retryable 402 and records the outage", async () => {
    const f = createMoonshotFetch(
      async () => new Response(SUSPENDED_BODY, { status: 429, headers: { "content-type": "application/json" } }),
    );
    const res = await f("https://api.moonshot.ai/v1/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(402);
    expect(await res.text()).toBe(SUSPENDED_BODY);
    expect(getAiOutage()?.reason).toMatch(/HTTP 429: .*suspended/);
  });

  it("leaves a real rate-limit 429 alone", async () => {
    const f = createMoonshotFetch(
      async () => new Response('{"error":{"message":"rate limit reached","type":"rate_limit"}}', { status: 429 }),
    );
    const res = await f("u", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(getAiOutage()).toBeNull();
  });

  it("records an auth failure as an outage without changing the status", async () => {
    const f = createMoonshotFetch(async () => new Response('{"error":{"message":"invalid key"}}', { status: 401 }));
    const res = await f("u", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(getAiOutage()?.reason).toMatch(/HTTP 401/);
  });

  it("short-circuits every call while an outage is active — no request leaves", async () => {
    noteAiOutage("Kimi (AI) balance is $0.00");
    let called = false;
    const f = createMoonshotFetch(async () => {
      called = true;
      return new Response("{}");
    });
    await expect(f("u", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(called).toBe(false);
  });

  it("turns the thinking header into Moonshot's body flag and strips the header", async () => {
    let seen: { body: unknown; header: string | null } | null = null;
    const f = createMoonshotFetch(async (_url, init) => {
      const h = new Headers(init?.headers);
      seen = { body: JSON.parse(String(init?.body)), header: h.get(THINKING_HEADER) };
      return new Response("{}", { status: 200 });
    });
    await f("u", {
      method: "POST",
      headers: { ...noThinkingHeaders("kimi-k2.6"), "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k2.6", messages: [] }),
    });
    expect(seen).toEqual({
      body: { model: "kimi-k2.6", messages: [], thinking: { type: "disabled" } },
      header: null,
    });
  });

  it("only offers the non-thinking flag for kimi-k2.6", () => {
    expect(noThinkingHeaders("kimi-k2.6")).toEqual({ [THINKING_HEADER]: "disabled" });
    expect(noThinkingHeaders("kimi-k3")).toEqual({});
    expect(noThinkingHeaders("kimi-k2.7-code")).toEqual({});
  });
});
