import { describe, expect, it } from "vitest";
import {
  isLoopbackPeer,
  localHttpRequestAllowed,
  localWebSocketRequestAllowed,
  safeRedirectPath,
  sameOriginHttpRequestAllowed,
} from "../lib/auth/local-origin.mjs";

const emptyEnv = {};

describe("local origin boundary", () => {
  it("allows ordinary loopback HTTP traffic and non-browser local callers", () => {
    expect(localHttpRequestAllowed(
      { host: "localhost:3000", origin: null, secFetchSite: null },
      emptyEnv,
    )).toBe(true);
    expect(localHttpRequestAllowed(
      { host: "127.0.0.1:10001", origin: "http://127.0.0.1:10001", secFetchSite: "same-origin" },
      emptyEnv,
    )).toBe(true);
    expect(localHttpRequestAllowed(
      { host: "[::1]:3000", origin: "http://[::1]:3000", secFetchSite: "same-origin" },
      emptyEnv,
    )).toBe(true);
  });

  it("rejects cross-origin and DNS-rebinding-style HTTP requests", () => {
    expect(localHttpRequestAllowed(
      { host: "localhost:3000", origin: "https://evil.example", secFetchSite: "cross-site" },
      emptyEnv,
    )).toBe(false);
    expect(localHttpRequestAllowed(
      { host: "attacker.example", origin: null, secFetchSite: null },
      emptyEnv,
    )).toBe(false);
    // Fetch Metadata is useful defense-in-depth for browser requests that omit
    // Origin (for example, some cross-site GET/navigation shapes).
    expect(localHttpRequestAllowed(
      { host: "localhost:3000", origin: null, secFetchSite: "cross-site" },
      emptyEnv,
    )).toBe(false);
  });

  it("requires a same-origin browser Origin for WebSocket upgrades", () => {
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: "http://localhost:3000" },
      emptyEnv,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: "https://evil.example" },
      emptyEnv,
    )).toBe(false);
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: null },
      emptyEnv,
    )).toBe(false);
    // Ports are part of an origin; another localhost service is not trusted.
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: "http://localhost:4173" },
      emptyEnv,
    )).toBe(false);
  });

  it("trusts PUBLIC_BASE_URL exactly for reverse-proxied deployments", () => {
    const env = { PUBLIC_BASE_URL: "https://operator.example.com" };
    expect(localWebSocketRequestAllowed(
      { host: "operator.example.com", origin: "https://operator.example.com" },
      env,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "operator.example.com", origin: "http://operator.example.com" },
      env,
    )).toBe(false);
    expect(localHttpRequestAllowed(
      { host: "other.example.com", origin: null, secFetchSite: null },
      env,
    )).toBe(false);
  });

  it("supports explicit comma-separated origins for intentional LAN access", () => {
    const env = {
      ORCH_ALLOWED_ORIGINS: "http://192.168.1.50:3000, https://operator.internal",
    };
    expect(localWebSocketRequestAllowed(
      { host: "192.168.1.50:3000", origin: "http://192.168.1.50:3000" },
      env,
    )).toBe(true);
    expect(localHttpRequestAllowed(
      { host: "operator.internal", origin: "https://operator.internal", secFetchSite: "same-origin" },
      env,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "192.168.1.51:3000", origin: "http://192.168.1.51:3000" },
      env,
    )).toBe(false);
  });

  it("ignores malformed or path-bearing allowlist entries", () => {
    const env = {
      ORCH_ALLOWED_ORIGINS: "not-a-url, https://operator.example.com/path",
    };
    expect(localHttpRequestAllowed(
      { host: "operator.example.com", origin: "https://operator.example.com", secFetchSite: "same-origin" },
      env,
    )).toBe(false);
  });
});

/* The HTTP half of the Cloudflare Access boundary. The JWT proves identity, not
 * intent, and `CF_Authorization` is SameSite=None — so without this a hostile
 * page can drive the victim's browser into any mutating route and the edge will
 * stamp a valid assertion on it.
 *
 * The audit that decided this (see lib/auth/local-origin.mjs) killed the
 * comfortable assumption that CORS already blocked it. Two independent holes:
 * `Request.json()` ignores Content-Type while `text/plain` is CORS-safelisted,
 * so every JSON route parses a preflight-free body; and many routes ignore the
 * body outright and act on the path alone. Both are pinned below as the shapes
 * an attacker actually sends, so deleting the check fails a test that names the
 * attack rather than one that merely asserts a boolean.
 *
 * This rule is NARROWER than localHttpRequestAllowed on purpose, and the
 * navigation case below is the reason. Do not converge them.
 */
describe("authenticated (Access) mode HTTP origin boundary", () => {
  it("allows a cross-site top-level navigation — the reason this is not the local rule", () => {
    // Someone clicking a link to the instance from an email or a wiki. The
    // browser sends no Origin; Sec-Fetch-Site IS cross-site, which is exactly
    // what local mode rejects. Rejecting it here would be a real UX regression
    // (people do link to a tunnel hostname; nobody links to localhost).
    expect(sameOriginHttpRequestAllowed(
      { host: "orch.example.com", origin: null },
      emptyEnv,
    )).toBe(true);
    // The local rule, for contrast — this is the "fix" the next person will be
    // tempted by, and this line is what it would cost.
    expect(localHttpRequestAllowed(
      { host: "orch.example.com", origin: null, secFetchSite: "cross-site" },
      emptyEnv,
    )).toBe(false);
  });

  it("allows raw non-browser callers that omit Origin", () => {
    // curl, the Docker HEALTHCHECK, and the stdio MCP bridge's server-to-server
    // calls into /api/internal/agent-tools/*.
    expect(sameOriginHttpRequestAllowed({ host: "127.0.0.1:3000", origin: null }, emptyEnv)).toBe(true);
    expect(sameOriginHttpRequestAllowed({ host: "orch.example.com", origin: undefined }, emptyEnv)).toBe(true);
  });

  it("allows the app's own same-origin XHR", () => {
    expect(sameOriginHttpRequestAllowed(
      { host: "orch.example.com", origin: "https://orch.example.com" },
      emptyEnv,
    )).toBe(true);
  });

  it("rejects the cross-site form post that needs no preflight", () => {
    // <form method="post" action="https://orch.example.com/api/tasks/X/merge">
    // — the body is ignored by that route, so the form needs no fields at all.
    expect(sameOriginHttpRequestAllowed(
      { host: "orch.example.com", origin: "https://evil.example" },
      emptyEnv,
    )).toBe(false);
  });

  it("rejects the text/plain fetch that smuggles JSON past CORS", () => {
    // fetch("https://orch.example.com/api/tasks/X/messages", {method:"POST",
    //   mode:"no-cors", credentials:"include",
    //   headers:{"content-type":"text/plain"}, body:'{"text":"…"}'})
    // text/plain is CORS-safelisted so this never preflights, and req.json()
    // parses it regardless of Content-Type. Same header shape as above — which
    // is the point: one Origin check covers every simple-request variant.
    expect(sameOriginHttpRequestAllowed(
      { host: "orch.example.com", origin: "http://localhost:5173" },
      emptyEnv,
    )).toBe(false);
  });

  it("rejects an opaque Origin rather than treating it as absent", () => {
    // A sandboxed iframe or a cross-origin-redirected POST sends "null". It is
    // present-but-unattributable, so it must fall on the reject side of the
    // absent-Origin allowance above.
    expect(sameOriginHttpRequestAllowed(
      { host: "orch.example.com", origin: "null" },
      emptyEnv,
    )).toBe(false);
  });

  it("distinguishes port, and is scheme-blind by construction", () => {
    // Port is part of the comparison: another service on the same host is not us.
    expect(sameOriginHttpRequestAllowed(
      { host: "orch.example.com:3000", origin: "https://orch.example.com:4173" },
      emptyEnv,
    )).toBe(false);
    // Scheme is NOT, and cannot be: the Host header carries no scheme, so there
    // is nothing to compare against. It costs nothing here — for
    // http://<same-host> to be a different origin an attacker must already own
    // DNS or the network path for the tunnel hostname, which defeats Access
    // itself long before this check matters. An operator who wants the scheme
    // pinned sets PUBLIC_BASE_URL, which is a full origin.
    expect(sameOriginHttpRequestAllowed(
      { host: "orch.example.com", origin: "http://orch.example.com" },
      emptyEnv,
    )).toBe(true);
  });

  it("falls back to PUBLIC_BASE_URL when the proxy rewrites Host", () => {
    // Cloudflare Tunnel's httpHostHeader: the browser's Origin is the public
    // hostname while Host is the internal one, so the two legitimately differ
    // and the operator names the public origin in PUBLIC_BASE_URL.
    const env = { PUBLIC_BASE_URL: "https://orch.example.com" };
    expect(sameOriginHttpRequestAllowed(
      { host: "internal-app:3000", origin: "https://orch.example.com" },
      env,
    )).toBe(true);
    expect(sameOriginHttpRequestAllowed(
      { host: "internal-app:3000", origin: "https://evil.example" },
      env,
    )).toBe(false);
  });
});

/* The sidecar's own gate. Headers are attacker-controlled; the peer address is
 * not, which is the whole reason this sits alongside the Origin check rather
 * than replacing it. */
describe("isLoopbackPeer", () => {
  it("accepts the proxy on this machine, including IPv4-over-IPv6 peers", () => {
    expect(isLoopbackPeer("127.0.0.1", {})).toBe(true);
    expect(isLoopbackPeer("::1", {})).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1", {})).toBe(true);
    expect(isLoopbackPeer("127.0.0.53", {})).toBe(true);
  });

  it("rejects someone who found PTY_PORT from the network", () => {
    expect(isLoopbackPeer("192.168.1.20", {})).toBe(false);
    expect(isLoopbackPeer("10.0.0.5", {})).toBe(false);
    expect(isLoopbackPeer(undefined, {})).toBe(false);
  });

  it("can be opted out of for a deliberately split deployment", () => {
    expect(isLoopbackPeer("192.168.1.20", { ORCH_PTY_ALLOW_REMOTE: "1" })).toBe(true);
  });
});

/* The post-auth redirect guard. Each rejection below defeats the obvious
 * startsWith("/") && !startsWith("//") version. */
describe("safeRedirectPath", () => {
  it("keeps ordinary in-app paths", () => {
    expect(safeRedirectPath("/tasks/abc?x=1#y")).toBe("/tasks/abc?x=1#y");
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
  });

  it("rejects protocol-relative and absolute targets", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/");
    expect(safeRedirectPath("https://evil.com")).toBe("/");
  });

  it("rejects the backslash browsers normalize into the authority position", () => {
    expect(safeRedirectPath("/\\evil.com")).toBe("/");
  });

  it("rejects tab/CR/LF smuggling browsers strip before parsing", () => {
    expect(safeRedirectPath("/\t/evil.com")).toBe("/");
    expect(safeRedirectPath("/\n\\evil.com")).toBe("/");
    expect(safeRedirectPath("/\r/evil.com")).toBe("/");
  });
});
