import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// lib/analytics reads POSTHOG_KEY / POSTHOG_HOST / ORCH_ACCOUNT_ID at import
// time, so each test resets the module registry and re-imports after stubbing
// env. fetch is stubbed globally — no real network in either direction.

async function loadAnalytics() {
  return await import("@/lib/analytics");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("analytics off (no POSTHOG_KEY)", () => {
  it("no-ops: zero network calls, no throw", async () => {
    vi.stubEnv("POSTHOG_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { track, analyticsEnabled, posthogSnippet } = await loadAnalytics();
    expect(analyticsEnabled()).toBe(false);
    expect(() => track("first_task_started", { task_id: "t1" })).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(posthogSnippet()).toBe("");
  });
});

describe("analytics on (mocked capture endpoint)", () => {
  it("POSTs the capture payload keyed by ORCH_ACCOUNT_ID", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    vi.stubEnv("POSTHOG_HOST", "https://stub.example");
    vi.stubEnv("ORCH_ACCOUNT_ID", "acct_123");
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const { track } = await loadAnalytics();

    track("onboarding_step_completed", { step: "connect_claude" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://stub.example/capture/");
    const body = JSON.parse(init.body);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("onboarding_step_completed");
    expect(body.distinct_id).toBe("acct_123");
    expect(body.properties.step).toBe("connect_claude");
    expect(body.properties.account_id).toBe("acct_123");
  });

  it("distinctId override wins but account_id property stays", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    vi.stubEnv("ORCH_ACCOUNT_ID", "acct_cp");
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const { track } = await loadAnalytics();

    track("instance_provisioned", { plan_id: "free" }, { distinctId: "acct_new" });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.distinct_id).toBe("acct_new");
    expect(body.properties.account_id).toBe("acct_cp");
  });

  it("swallows network failures — a rejecting fetch never propagates", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc_test");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("capture down"));
    vi.stubGlobal("fetch", fetchSpy);
    const { track } = await loadAnalytics();
    expect(() => track("turn_started")).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
