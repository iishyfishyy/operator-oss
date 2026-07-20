#!/usr/bin/env node
/* Portable stdio MCP bridge — gives non-Claude agent CLIs (Codex today, any
 * future one) the orchestrator's suggest_task / expose_service tools.
 *
 * The Claude driver mounts these as an in-process SDK MCP server, a construct
 * that only exists inside the Claude Agent SDK. This is the portable equivalent:
 * a plain-Node stdio MCP server (@modelcontextprotocol/sdk) the CLI spawns and
 * talks to over stdio. It's a thin proxy — every tool call POSTs to the app's
 * internal endpoints (app/api/internal/agent-tools/*), which run the SAME shared
 * logic (lib/agentTools.ts) the in-process server calls.
 *
 * Per-turn wiring comes from env, injected by the driver when it registers this
 * server (lib/agents/codex/driver.ts):
 *   ORCH_TASK_ID     the task this turn belongs to
 *   ORCH_PROJECT_ID  the owning project (tasks/services are created under it)
 *   ORCH_BASE_URL    the app's loopback origin (e.g. http://127.0.0.1:3000)
 *   SERVICE_TOKEN    the per-instance secret the internal endpoints require
 *
 * Tool names / descriptions / param docs come from lib/agentToolDefs.mjs so this
 * bridge and the in-process server never drift. Plain .mjs: this file AND
 * agentToolDefs.mjs must be COPY'd into the runtime image (see Dockerfile).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SUGGEST_TASK, EXPOSE_SERVICE, ASK_USER } from "../lib/agentToolDefs.mjs";

const TASK_ID = process.env.ORCH_TASK_ID || "";
const PROJECT_ID = process.env.ORCH_PROJECT_ID || "";
const BASE_URL = (process.env.ORCH_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";

// Titles created this turn → their task ids, so `blocked_by` can reference an
// earlier suggestion by title (mirrors the in-process server's per-turn map).
// This process lives exactly one turn, so the map is naturally turn-scoped.
const createdByTitle = new Map();

/** POST a tool call to an internal endpoint; return its `text` (thrown on error). */
async function callInternal(path, payload) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/internal/agent-tools/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": SERVICE_TOKEN },
      body: JSON.stringify({ projectId: PROJECT_ID, taskId: TASK_ID, ...payload }),
    });
  } catch (e) {
    throw new Error(`orchestrator unreachable at ${BASE_URL}: ${e?.message || e}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body (e.g. a 403 text) — handled below */
  }
  if (!res.ok) throw new Error((data && data.error) || `orchestrator returned ${res.status}`);
  return data;
}

const server = new McpServer({ name: "orchestrator", version: "1.0.0" });

server.registerTool(
  EXPOSE_SERVICE.name,
  {
    description: EXPOSE_SERVICE.description,
    inputSchema: {
      name: z.string().describe(EXPOSE_SERVICE.params.name),
      port: z.number().int().positive().describe(EXPOSE_SERVICE.params.port),
    },
  },
  async ({ name, port }) => {
    const data = await callInternal("expose-service", { name, port });
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  SUGGEST_TASK.name,
  {
    description: SUGGEST_TASK.description,
    inputSchema: {
      title: z.string().describe(SUGGEST_TASK.params.title),
      description: z.string().describe(SUGGEST_TASK.params.description),
      priority: z.enum(SUGGEST_TASK.priorities).default(SUGGEST_TASK.defaultPriority),
      blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
    },
  },
  async ({ title, description, priority, blocked_by }) => {
    // Resolve refs (id passes through; a title from earlier this turn → its id)
    // before handing off — the endpoint just forwards ids to setTaskDeps.
    const deps = (blocked_by ?? []).map((ref) => createdByTitle.get(ref) ?? ref);
    const data = await callInternal("suggest-task", { title, description, priority, blocked_by: deps });
    if (data.id) createdByTitle.set(title, data.id);
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  ASK_USER.name,
  {
    description: ASK_USER.description,
    inputSchema: {
      questions: z
        .array(
          z.object({
            question: z.string().describe("The full question to ask the user."),
            header: z.string().max(24).optional().describe("Short chip label for the question (≤12 chars ideal)."),
            multiSelect: z.boolean().optional().describe("Allow choosing more than one option."),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .min(1)
              .max(8)
              .describe("2–4 choices work best. The user can always type a free-text answer too."),
          })
        )
        .min(1)
        .max(4)
        .describe(ASK_USER.params.questions),
    },
  },
  async ({ questions }) => {
    // Start the ask (persists + publishes the interactive card), then poll for
    // the outcome. Polling instead of one held request: the user may take hours,
    // far beyond any HTTP timeout, and the ask survives page reloads server-side.
    const { askId } = await callInternal("ask-user", { questions });
    const deadline = Date.now() + 24 * 60 * 60 * 1000; // mirror the Claude hook's ~1-day cap
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await callInternal("ask-user/wait", { askId });
      if (r.status === "done") return { content: [{ type: "text", text: r.text }] };
      if (Date.now() > deadline) {
        return { content: [{ type: "text", text: "The user did not answer the question. Proceed with your best judgment." }] };
      }
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
