/* node-pty ships prebuilt `spawn-helper` binaries that npm can extract without
 * the executable bit, which makes pty.spawn() fail with "posix_spawnp failed".
 * Restore +x after every install. No-op on platforms without the prebuild. */
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds");
try {
  for (const sub of fs.readdirSync(dir)) {
    const helper = path.join(dir, sub, "spawn-helper");
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
    }
  }
} catch {
  /* node-pty not installed or no prebuilds — nothing to do */
}
