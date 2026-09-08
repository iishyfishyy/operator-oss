import { describe, expect, it } from "vitest";
import { createCommand, createProject, deleteCommand, getCommand, listCommands, updateCommand } from "../lib/store";
import { getDb, init } from "../lib/db";
import { effectiveCommands, expandCommand } from "../lib/commands";
import { GET, POST, PATCH, DELETE } from "../app/api/commands/route";

const preset = (name: string, project_id: string | null = null) => ({ name, project_id, description: "A preset", body: "Review {{task.title}}: {{args}}" });
const req = (method: string, body?: unknown, query = "") => new Request(`http://localhost/api/commands${query}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });

describe("command persistence and scope", () => {
  it("migrates idempotently, enforces uniqueness including NULL scopes, and cascades project deletion", () => {
    const project = createProject({ name: "Commands" });
    const other = createProject({ name: "Other" });
    const global = createCommand(preset("scope-test"));
    const local = createCommand(preset("scope-test", project.id));
    const elsewhere = createCommand(preset("scope-test", other.id));
    expect(() => createCommand(preset("scope-test"))).toThrow();
    expect(() => createCommand(preset("scope-test", project.id))).toThrow();
    expect(listCommands().map((c) => c.id)).toContain(global.id);
    expect(listCommands().map((c) => c.id)).not.toContain(local.id);
    expect(listCommands(project.id).map((c) => c.id)).not.toContain(elsewhere.id);
    expect(effectiveCommands(listCommands(project.id)).find((c) => c.name === "scope-test")?.id).toBe(local.id);
    init(getDb());
    expect(getCommand(local.id)).toEqual(local);
    const edited = updateCommand(local.id, { ...preset("renamed", project.id), body: "New body" })!;
    expect(edited.body).toBe("New body");
    expect(edited.created_at).toBe(local.created_at);
    expect(edited.updated_at).toBeGreaterThanOrEqual(local.updated_at);
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    expect(getCommand(local.id)).toBeUndefined();
    expect(getCommand(global.id)).toBeDefined();
    expect(deleteCommand(global.id)).toBe(true);
    expect(deleteCommand(global.id)).toBe(false);
  });
});

describe("commands API", () => {
  it("creates, filters, updates scope, reports conflicts and missing ids, and hard deletes", async () => {
    const p = createProject({ name: "API" });
    const created = await POST(req("POST", preset("api-test", p.id)));
    expect(created.status).toBe(201);
    const command = await created.json();
    expect((await (await GET(req("GET", undefined, `?project_id=${p.id}`))).json()).some((c: { id: string }) => c.id === command.id)).toBe(true);
    expect((await (await GET(req("GET"))).json()).some((c: { id: string }) => c.id === command.id)).toBe(false);
    expect((await POST(req("POST", preset("api-test", p.id)))).status).toBe(409);
    const updated = await PATCH(req("PATCH", { ...preset("api-renamed"), id: command.id }));
    expect(updated.status).toBe(200);
    expect((await updated.json()).project_id).toBeNull();
    const second = await (await POST(req("POST", preset("api-second")))).json();
    expect((await PATCH(req("PATCH", { ...preset("api-renamed"), id: second.id }))).status).toBe(409);
    expect((await PATCH(req("PATCH", { ...preset("x"), id: "missing" }))).status).toBe(404);
    expect((await DELETE(req("DELETE", undefined, `?id=${command.id}`))).status).toBe(200);
    expect(getCommand(command.id)).toBeUndefined();
    expect((await DELETE(req("DELETE", undefined, `?id=${command.id}`))).status).toBe(404);
    expect((await DELETE(req("DELETE"))).status).toBe(400);
  });
  it("rejects invalid names, reserved commands, malformed input and missing projects", async () => {
    for (const name of ["clear", "/hi", "Uppercase", "two words", "-bad", "a--b", ""]) {
      expect((await POST(req("POST", preset(name)))).status).toBe(400);
    }
    for (const body of [null, [], { ...preset("valid"), body: "  " }, { ...preset("valid"), description: 42 }, { ...preset("valid"), extra: true }]) {
      expect((await POST(req("POST", body))).status).toBe(400);
    }
    expect((await POST(new Request("http://localhost/api/commands", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await POST(req("POST", preset("valid", "missing")))).status).toBe(404);
    expect((await GET(req("GET", undefined, "?project_id=missing"))).status).toBe(404);
  });
});

describe("client prompt expansion", () => {
  const task = { title: "Task $&", description: "Description {{args}}" };
  const command = { ...preset("analyze-ai-comments"), id: "one", created_at: 1, updated_at: 1, body: "{{task.title}}\n{{task.description}}\n{{args}}\n{{args}}" };
  it("expands multiline arguments and task fields literally in one pass", () => {
    expect(expandCommand("/analyze-ai-comments first\nsecond $& {{task.title}}", [command], task))
      .toBe("Task $&\nDescription {{args}}\nfirst\nsecond $& {{task.title}}\nfirst\nsecond $& {{task.title}}");
  });
  it("preserves arguments when the template omits args and supports empty args", () => {
    expect(expandCommand("/analyze-ai-comments more", [{ ...command, body: "Review" }], task)).toBe("Review\n\nmore");
    expect(expandCommand("/analyze-ai-comments", [{ ...command, body: "Review {{args}}" }], task)).toBe("Review ");
  });
  it("uses project overrides regardless of listing order and leaves other messages alone", () => {
    const local = { ...command, project_id: "p", body: "Local" };
    expect(expandCommand("/analyze-ai-comments", [local, command], task)).toBe("Local");
    for (const message of ["/clear", "/unknown", "normal text", "/analyze-ai-comments-extra"]) expect(expandCommand(message, [command], task)).toBe(message);
  });
});
