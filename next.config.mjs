// Plain JS (not .ts) on purpose: the production container prunes dev deps, and
// Next needs the `typescript` package at RUNTIME to load a next.config.ts —
// without it the server tries to install typescript on boot (read-only /app in
// the image → crash). JS config loads dependency-free in dev and prod alike.

/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 and node-pty are native modules and the agent SDKs spawn
  // their CLIs (`claude` / `codex`) — none should be bundled by Next's server
  // compiler.
  serverExternalPackages: ["better-sqlite3", "node-pty", "@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"],
};

export default nextConfig;
