// Codex's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack — see lib/agents/capabilities.ts). Null model = inherit codex's
// built-in default (see DEFAULT_CODEX_MODEL in ./pricing).

import type { AgentCapabilities } from "../types";
import { codexApiKey } from "./auth";

// Every current preset runs the same 272k window, so unlike Claude there's no
// per-model variation here — but keep it per-entry anyway: this descriptor is
// what drives the context gauge, and a future preset may differ.
const CTX = 272_000;

export const CODEX_CAPABILITIES: AgentCapabilities = {
  // Tracks the codex CLI's model line, ordered newest-first. "Previous
  // versions" are still-live older models — selectable for the same reason
  // Claude pins older versions, but not what a new task should default to.
  // Groups must stay contiguous: the picker opens a new section whenever
  // `group` changes (SessionView.tsx).
  //
  // Re-check this list when bumping @openai/codex-sdk; the codex model line
  // moves faster than Claude's, and a stale entry here is a model that 400s the
  // whole turn. Two traps when you do:
  //   - The `{"models":[…]}` catalog embedded in the CLI binary is a stale
  //     FALLBACK, not the truth. The live catalog is fetched at startup and can
  //     both drop models the embedded one lists and keep ones it marks retired.
  //   - Availability is per auth mode. We run on ChatGPT-plan login, and that
  //     account type refuses models the API tier still serves.
  // So verify empirically, on a ChatGPT login:
  //   codex exec --model <slug> "reply with the single word ok"
  // Checked that way against codex-cli 0.146.0: gpt-5.2 and gpt-5.3-codex now
  // 400 with "not supported when using Codex with a ChatGPT account" (both were
  // listed here before), while gpt-5.4 / gpt-5.4-mini still run despite the
  // embedded catalog flagging them for migration to Terra / Luna.
  models: [
    { value: "gpt-6-astra", label: "GPT-6 Astra", sub: "most capable for the hardest end-to-end work", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", sub: "latest frontier agentic coding model (default)", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", sub: "balanced agentic coding for everyday work", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", sub: "fast and affordable agentic coding", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.5", label: "GPT-5.5", sub: "previous frontier coding and research model", contextWindow: CTX, group: "Previous versions" },
    { value: "gpt-5.4", label: "GPT-5.4", sub: "strong model for everyday coding", contextWindow: CTX, group: "Previous versions" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", sub: "small, fast, and cost-efficient", contextWindow: CTX, group: "Previous versions" },
  ],
  // Off/Think/Think hard/Ultrathink → codex's model_reasoning_effort scale
  // (low/medium/high/xhigh — see EFFORT in ./driver.ts). Codex can't disable
  // reasoning ("minimal" 400s the turn), so "Off" is its floor, "low"; the
  // subs name the actual effort each preset sends so the picker stays honest.
  // The 5.6 family also accepts "max" and "ultra" above xhigh; the shared
  // preset vocabulary tops out at ultrathink, so those aren't reachable yet.
  reasoningOptions: [
    { value: "off", label: "Off", sub: "low effort — codex's minimum" },
    { value: "think", label: "Think", sub: "medium effort" },
    { value: "think_hard", label: "Think hard", sub: "high effort" },
    { value: "ultrathink", label: "Ultrathink", sub: "extra-high effort" },
  ],
  // Only the modes with a real codex analog are declared. bypassPermissions maps
  // to workspace-write + approvals-never (auto-run); plan maps to a read-only
  // sandbox. acceptEdits has no distinct codex analog (writes already auto-apply)
  // and on-request approvals can't be answered non-interactively, so neither is
  // offered — both fall back to bypassPermissions.
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "workspace write, no approvals (default)" },
    { value: "plan", label: "Plan mode", sub: "read-only, propose without editing" },
  ],
  // Interactive asks arrive via the MCP bridge's ask_user tool (the card UI and
  // /answer route are shared with Claude's AskUserQuestion flow).
  supportsAsks: true,
  // The orchestrator's suggest_task / expose_service tools reach Codex through
  // the portable stdio MCP bridge (scripts/orch-mcp.mjs), registered per turn
  // by the driver — the same tools the Claude driver mounts in-process.
  supportsMcpTools: true,
  // ChatGPT-plan auth reports tokens only — no billed dollar figure — so the
  // cost the driver emits is an estimate (tokens × published API prices for
  // the resolved model). The descriptor stays honest: reportsCostUsd=false,
  // and costIsEstimated=true has the UI show the figure with an ~.
  reportsCostUsd: false,
  costIsEstimated: true,
  supportsResume: true,
  apiKeyHint: codexApiKey.hint,
  loginStyle: "device_code",
};
