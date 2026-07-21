// Pins the module-graph layering that keeps sync route entries working in the
// production build.
//
// The agent SDKs (@anthropic-ai/claude-agent-sdk, @openai/codex-sdk) are
// ESM-only serverExternalPackages, which Turbopack emits as ASYNC externals —
// and async-ness propagates to every transitive importer. A module compiled
// async but consumed by a route entry Turbopack happened to compile sync gets a
// pending Promise instead of its namespace: every export reads back undefined
// at runtime. That's exactly how /api/services/grant (public service links) and
// /api/instance/services-restore (boot restore of managed services) 500'd in
// prod: lib/store.ts imported getDriver from the registry for one context-window
// lookup, dragging both SDKs into lib/services.ts's graph.
//
// The fix is lib/agents/capabilities.ts — capability DATA without the SDKs.
// This test walks the static import graph from the low-level modules and fails
// if any path reaches an SDK again.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const FORBIDDEN = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];

// Modules that must stay SDK-free, and why:
const PINNED = [
  "lib/store.ts", //     imported by nearly everything; the original poison edge
  "lib/services.ts", //  behind sync-compiled routes (grant, services-restore)
  "lib/db.ts",
  "lib/agents/capabilities.ts", // the whole point of the module
  "app/api/services/grant/route.ts",
  "app/api/instance/services-restore/route.ts",
];

// import/export/require specifiers, coarse but sufficient for this repo's
// plain static imports (no dynamic import() in the pinned graph).
const SPECIFIER_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
const IMPORT_BARE_RE = /^\s*import\s+["']([^"']+)["']/gm;

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // bare package specifier
  for (const suffix of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolvable import "${spec}" from ${path.relative(ROOT, fromFile)}`);
}

/** All bare-package deps reachable from `entry`, with one witness path each. */
function reachablePackages(entry: string): Map<string, string[]> {
  const packages = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue: { file: string; trail: string[] }[] = [{ file: path.join(ROOT, entry), trail: [entry] }];
  while (queue.length) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const re of [SPECIFIER_RE, IMPORT_BARE_RE]) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(src)); ) {
        const spec = m[1];
        const local = resolveLocal(file, spec);
        if (local) queue.push({ file: local, trail: [...trail, path.relative(ROOT, local)] });
        else if (!spec.startsWith("node:") && !packages.has(spec)) packages.set(spec, trail);
      }
    }
  }
  return packages;
}

describe("import-graph layering (async-external poisoning)", () => {
  for (const entry of PINNED) {
    it(`${entry} never reaches an agent SDK`, () => {
      const packages = reachablePackages(entry);
      for (const sdk of FORBIDDEN) {
        const trail = packages.get(sdk);
        expect(
          trail,
          trail && `${entry} reaches ${sdk} via:\n  ${trail.join("\n  → ")}\n` +
            `ESM externals compile to async modules under Turbopack and break sync route entries — ` +
            `import capability data from lib/agents/capabilities.ts instead of the driver registry.`
        ).toBeUndefined();
      }
    });
  }

  it("the walker itself sees the SDKs where they ARE used (sanity)", () => {
    const packages = reachablePackages("lib/agents/registry.ts");
    for (const sdk of FORBIDDEN) expect(packages.has(sdk)).toBe(true);
  });
});
