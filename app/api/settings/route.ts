import { NextResponse } from "next/server";
import { getSettings, setSetting } from "@/lib/store";

export const dynamic = "force-dynamic";

// App-level preferences that must be readable server-side (the per-task run
// controls fall back to these when a task hasn't overridden them). The run
// defaults are agent-scoped ("default_reasoning:<agent>") so each agent carries
// its own defaults; the legacy un-suffixed keys are still accepted for
// back-compat. `default_agent` is the app-wide default agent for new tasks;
// `utility_agent` is the agent that runs project-scoped internal one-shots
// (recaps, context drafts — see lib/agents/oneshots.ts), default "claude".
// `background_jobs` defaults to "on" and gates unattended agent turns;
// `recap_mode` defaults to "automatic" (also accepts "on_open" and "off").
// `suggestion_policy` defaults to "ask_first" (also accepts "auto") and decides
// whether an agent may file unrequested tasks into the Suggested tray.
const ALLOWED = /^(background_jobs|recap_mode|suggestion_policy|default_agent|utility_agent|default_reasoning(:[a-z0-9_-]+)?|default_permission_mode(:[a-z0-9_-]+)?)$/;

export async function GET() {
  return NextResponse.json(getSettings());
}

export async function PATCH(req: Request) {
  const body = (await req.json()) as Record<string, string | null>;
  for (const k of Object.keys(body)) {
    if (ALLOWED.test(k)) setSetting(k, body[k]);
  }
  return NextResponse.json(getSettings());
}
