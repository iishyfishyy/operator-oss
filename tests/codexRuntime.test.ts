import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

type LockPackage = { version?: string; dependencies?: Record<string, string> };
type PackageLock = { packages: Record<string, LockPackage> };

function atLeast(actual: string, minimum: string): boolean {
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  return b.every((part, i) => (a[i] ?? 0) === part) || a.some((part, i) => {
    const priorMatches = b.slice(0, i).every((prior, j) => (a[j] ?? 0) === prior);
    return priorMatches && part > (b[i] ?? 0);
  });
}

describe("Codex SDK runtime", () => {
  it("keeps the SDK and the CLI it spawns on the same version", () => {
    const lock = JSON.parse(
      readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8")
    ) as PackageLock;
    const sdk = lock.packages["node_modules/@openai/codex-sdk"];
    const cli = lock.packages["node_modules/@openai/codex"];

    expect(atLeast(sdk.version!, "0.156.1")).toBe(true);
    expect(sdk.version).toBe(cli.version);
    expect(sdk.dependencies?.["@openai/codex"]).toBe(cli.version);
    expect(lock.packages["node_modules/@openai/codex-sdk/node_modules/@openai/codex"])
      .toBeUndefined();
  });
});
