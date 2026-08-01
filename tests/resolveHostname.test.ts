// Regression: on Fedora-family login shells (Bazzite included) the shell
// profile exports HOSTNAME=<machine name>, which used to become server.js's
// bind address and made the app unreachable on localhost. ORCH_HOSTNAME is the
// collision-free knob; HOSTNAME stays honored so existing setups (including
// the Dockerfile's HOSTNAME=0.0.0.0 shim) keep working.
//
// The env is passed explicitly rather than mutating process.env so this test
// stays hermetic — CI machines and dev boxes carry different ambient HOSTNAME
// values and neither should decide the outcome.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { resolveHostname } = requireCjs("../lib/resolveHostname.js") as {
  resolveHostname: (env: Record<string, string | undefined>) => string;
};

describe("resolveHostname", () => {
  it("prefers ORCH_HOSTNAME over HOSTNAME", () => {
    expect(
      resolveHostname({ ORCH_HOSTNAME: "127.0.0.1", HOSTNAME: "my-laptop" })
    ).toBe("127.0.0.1");
  });

  it("falls back to HOSTNAME when ORCH_HOSTNAME is unset", () => {
    expect(resolveHostname({ HOSTNAME: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("defaults to 0.0.0.0 when neither is set", () => {
    expect(resolveHostname({})).toBe("0.0.0.0");
  });

  it("treats empty strings as unset", () => {
    expect(resolveHostname({ ORCH_HOSTNAME: "", HOSTNAME: "" })).toBe("0.0.0.0");
    expect(resolveHostname({ ORCH_HOSTNAME: "", HOSTNAME: "1.2.3.4" })).toBe(
      "1.2.3.4"
    );
  });

  it("tolerates an undefined env argument", () => {
    expect(resolveHostname(undefined as unknown as Record<string, string>)).toBe(
      "0.0.0.0"
    );
  });
});
