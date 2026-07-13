import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror tsconfig's "@/*" -> "./*" path alias so the control-plane/billing
  // modules (which import via "@/lib/...") resolve under vitest the same way
  // they do under Next. Without this, importing any of them throws at collect.
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Each test spawns several real git subprocesses; the default 5s is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run files sequentially: every test shells out to many git subprocesses, and
    // four files in parallel spawn enough concurrent `git` to thrash the machine
    // (process-table contention drives per-test time past the timeout). Serial is
    // both stable and plenty fast here (~1-2s/test).
    fileParallelism: false,
  },
});
