import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ discover: vi.fn(), connected: true, provider: null as string | null }));
vi.mock("@/lib/agents/registry", async () => {
  const { cachedModels } = await import("@/lib/agents/modelCatalog");
  return { DEFAULT_AGENT: "codex", listDrivers: () => [{
    id: "codex", label: "Codex", discoverModels: mocks.discover,
    get capabilities() { return { models: cachedModels("codex")?.models ?? [] }; },
    configuredProvider: () => mocks.provider,
  }] };
});
vi.mock("@/lib/agents/connections", () => ({
  getAgentConnection: () => mocks.connected ? { method: "subscription" } : null,
  getAgentAuthBroken: () => null,
}));
vi.mock("@/lib/agents/oneshots", () => ({ resolveUtilityAgent: () => ({ id: "codex" }) }));
import { GET, POST } from "@/app/api/agents/route";
import { invalidateCatalog } from "@/lib/agents/modelCatalog";
beforeEach(() => {
  invalidateCatalog("codex"); mocks.connected = true; mocks.provider = null;
  mocks.discover.mockReset().mockResolvedValue({ models: [{ value: "gpt-future", label: "Future", sub: "", contextWindow: 272000 }] });
});
it("GET uses the live cached list and POST forces rediscovery", async () => {
  const first = await (await GET()).json();
  expect(first.agents[0].capabilities.models[0].value).toBe("gpt-future");
  expect(first.agents[0].modelCatalog.source).toBe("live");
  await GET();
  expect(mocks.discover).toHaveBeenCalledTimes(1);
  await POST();
  expect(mocks.discover).toHaveBeenCalledTimes(2);
});
it("does not launch disconnected providers or replace configured Bedrock models", async () => {
  mocks.connected = false;
  await GET();
  mocks.connected = true; mocks.provider = "bedrock";
  const response = await (await POST()).json();
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(response.agents[0].modelCatalog.source).toBe("configured");
});
it("reports a failed refresh while retaining the last successful catalog", async () => {
  await GET();
  mocks.discover.mockRejectedValue(new Error("offline"));
  const response = await (await POST()).json();
  expect(response.agents[0].modelCatalog.source).toBe("cached");
  expect(response.agents[0].modelCatalog.error).toBeTruthy();
  expect(response.agents[0].capabilities.models[0].value).toBe("gpt-future");
});
