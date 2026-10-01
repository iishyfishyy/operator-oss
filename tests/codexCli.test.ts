import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DB_DIR } from "@/lib/config";
import { codexCommand, codexIdentityFile, codexInstall, codexSdkPath, compareVersions, maybeUpdateCodex } from "@/lib/agents/codex/cli";

const ROOT = path.join(DB_DIR, "codex-cli");
const bundled = JSON.parse(fs.readFileSync(path.join(process.cwd(), "node_modules/@openai/codex/package.json"), "utf8")).version as string;

// A fake managed install: launcher + package.json + the platform package.
function fakeInstall(version: string, withPlatform = true) {
  const nm = path.join(ROOT, version, "node_modules", "@openai");
  fs.mkdirSync(path.join(nm, "codex", "bin"), { recursive: true });
  fs.writeFileSync(path.join(nm, "codex", "package.json"), JSON.stringify({ name: "@openai/codex", version }));
  fs.writeFileSync(path.join(nm, "codex", "bin", "codex.js"), "");
  if (withPlatform) {
    fs.mkdirSync(path.join(nm, `codex-${process.platform}-${process.arch}`), { recursive: true });
    fs.writeFileSync(path.join(nm, `codex-${process.platform}-${process.arch}`, "package.json"), "{}");
  }
  return path.join(nm, "codex");
}
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

it("compares CLI versions numerically", () => {
  expect(compareVersions("0.159.3", "0.156.10")).toBeGreaterThan(0);
  expect(compareVersions("0.99.0", "0.100.0")).toBeLessThan(0);
  expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
});

it("uses the bundled CLI and lets the SDK resolve it when nothing newer is managed", () => {
  fakeInstall("0.0.1");
  expect(codexInstall()?.version).toBe(bundled);
  expect(codexSdkPath()).toBeUndefined();
  expect(codexCommand()).toEqual({ command: process.execPath, args: [path.join(process.cwd(), "node_modules/@openai/codex/bin/codex.js")] });
});

it("prefers a newer managed install everywhere, including the catalog cache key", () => {
  const dir = fakeInstall("999.0.0");
  expect(codexInstall()?.version).toBe("999.0.0");
  expect(codexSdkPath()).toBe(path.join(dir, "bin", "codex.js"));
  expect(codexCommand().args).toEqual([path.join(dir, "bin", "codex.js")]);
  expect(codexIdentityFile()).toBe(path.join(dir, "package.json"));
});

it("ignores a managed install missing its native platform package", () => {
  fakeInstall("999.0.0", false);
  expect(codexInstall()?.version).toBe(bundled);
});

it("never checks the registry when auto-update is off", () => {
  maybeUpdateCodex();
  expect(fs.existsSync(path.join(ROOT, "state.json"))).toBe(false);
});
