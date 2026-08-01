/* Bind-address resolution for server.js.
 *
 * Why this exists: Fedora-family login shells (Bazzite, etc.) export a global
 * `HOSTNAME=<machine name>` — a near-universal shell convention. server.js
 * previously read `process.env.HOSTNAME` directly as its bind address, so on
 * those shells the app bound the machine's public hostname and localhost
 * refused connections. `ORCH_HOSTNAME` is the collision-free name; `HOSTNAME`
 * is still honored so existing setups (including the Dockerfile's explicit
 * `HOSTNAME=0.0.0.0` shim, which counters Docker injecting the container id)
 * keep working unchanged.
 *
 * Plain CommonJS so server.js can require() it synchronously before listen().
 */
function resolveHostname(env) {
  const e = env || {};
  if (e.ORCH_HOSTNAME) return e.ORCH_HOSTNAME;
  if (e.HOSTNAME) return e.HOSTNAME;
  return "0.0.0.0";
}

module.exports = { resolveHostname };
