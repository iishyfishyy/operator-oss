import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedModels, catalogStatus, invalidateCatalog, refreshCatalog } from "@/lib/agents/modelCatalog";
import { DB_DIR } from "@/lib/config";
import { claudeModels, codexModels } from "@/lib/agents/modelDiscovery";
import { getCapabilities, modelContextWindow } from "@/lib/agents/capabilities";
const model = { value: "gpt-future", label: "Future", sub: "new", contextWindow: 500_000 };
const result = { models: [model], defaultModel: model.value };
beforeEach(() => { invalidateCatalog("codex"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); invalidateCatalog("codex"); });

describe("model discovery normalization", () => {
  it("uses Claude resolved IDs and deduplicates default/family aliases", () => {
    const r = claudeModels([
      { value: "default", resolvedModel: "claude-opus-6-2[1m]", displayName: "Default" },
      { value: "opus", resolvedModel: "claude-opus-6-2[1m]" },
      { value: "sonnet", displayName: "Sonnet 7" }, // no invented version
      { value: "claude-haiku-4-5-20251001", displayName: "Haiku" },
      null,
    ], []);
    expect(r.models.map(m => [m.value, m.label])).toEqual([
      ["claude-opus-6-2[1m]", "Opus 6.2 (1M)"],
      ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ]);
    expect(r.defaultModel).toBe("claude-opus-6-2[1m]");
    expect(r.models[0].contextWindow).toBe(1_000_000);
  });
  it("uses Codex routing model rather than opaque record ID and skips hidden models", () => {
    const r = codexModels([{ id: "opaque", model: "gpt-future", displayName: "Future", isDefault: true }, { model: "hidden", hidden: true }, { model: "gpt-future" }, null], []);
    expect(r.models).toHaveLength(1);
    expect(r.models[0].value).toBe("gpt-future");
    expect(r.defaultModel).toBe("gpt-future");
  });
});

describe("model catalog cache", () => {
  it("deduplicates requests, persists the catalog, and serves SDK-free consumers", async () => {
    const discover = vi.fn(async () => result);
    await Promise.all([refreshCatalog("codex", discover), refreshCatalog("codex", discover)]);
    await refreshCatalog("codex", discover);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(cachedModels("codex")).toEqual(result);
    expect(getCapabilities("codex").models).toEqual(result.models);
    expect(modelContextWindow("codex", "gpt-future")).toBe(500_000);
    expect(JSON.parse(fs.readFileSync(path.join(DB_DIR, "model-catalog-codex.json"), "utf8")).models).toEqual(result.models);
    await refreshCatalog("codex", discover, true);
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it("refreshes after one hour", async () => {
    vi.useFakeTimers();
    const discover = vi.fn(async () => result);
    await refreshCatalog("codex", discover);
    vi.advanceTimersByTime(3_600_001);
    await refreshCatalog("codex", discover);
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it("retains last good results and throttles failed refreshes", async () => {
    await refreshCatalog("codex", async () => result);
    const fail = vi.fn(async () => { throw new Error("secret upstream diagnostic"); });
    await refreshCatalog("codex", fail, true);
    await refreshCatalog("codex", fail);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(cachedModels("codex")).toEqual(result);
    expect(catalogStatus("codex").source).toBe("cached");
    expect(catalogStatus("codex").error).not.toContain("secret");
  });
  it("uses bundled choices when the first result is empty or invalid", async () => {
    await refreshCatalog("codex", async () => ({ models: [] }));
    expect(cachedModels("codex")).toBeUndefined();
    expect(catalogStatus("codex").source).toBe("fallback");
    expect(getCapabilities("codex").models.some(m => m.value === "gpt-6-sol")).toBe(true);
  });
  it("does not restore an old account catalog after disconnect during refresh", async () => {
    let resolve!: (v: typeof result) => void;
    const flight = refreshCatalog("codex", () => new Promise(r => { resolve = r; }));
    invalidateCatalog("codex");
    resolve(result);
    await flight;
    expect(cachedModels("codex")).toBeUndefined();
  });
  it("invalidates on credential/config changes and discards in-flight old results", async () => {
    let resolve!: (v: typeof result) => void;
    const flight = refreshCatalog("codex", () => new Promise(r => { resolve = r; }));
    vi.stubEnv("OPENAI_BASE_URL", "https://different.example");
    resolve(result);
    await flight;
    expect(cachedModels("codex")).toBeUndefined();
    await refreshCatalog("codex", async () => result);
    vi.stubEnv("OPENAI_BASE_URL", "https://another.example");
    expect(cachedModels("codex")).toBeUndefined();
  });
});
