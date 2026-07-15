import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { jsonGuard } from "../lib/apiGuard";

describe("jsonGuard", () => {
  it("passes a successful handler's response through untouched", async () => {
    const inner = NextResponse.json({ ok: true }, { status: 200 });
    const res = await jsonGuard("test", async () => inner);
    expect(res).toBe(inner);
  });

  it("converts an uncaught throw into a JSON 500 instead of an HTML error page", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await jsonGuard("test", async () => {
        throw new Error("boom");
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ ok: false, error: "boom" });
    } finally {
      spy.mockRestore();
    }
  });

  it("stringifies non-Error throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await jsonGuard("test", async () => {
        throw "raw failure";
      });
      expect(await res.json()).toEqual({ ok: false, error: "raw failure" });
    } finally {
      spy.mockRestore();
    }
  });
});
