// How freely an agent may file tasks into the "Suggested" tray.
//
// The tray is only useful if everything in it is something the user wanted, so
// the default is `ask_first`: an agent that spots out-of-scope follow-up work
// lists it in chat and asks before calling `suggest_task`. Explicit planning
// requests ("break this down", "roadmap it") are unaffected in both modes —
// filing tasks IS the answer there. `auto` restores the old always-proactive
// behavior for users who liked it.
//
// Enforcement is prompt-based (see buildProjectContext in lib/agents/shared.ts):
// the server can't tell whether a mid-turn tool call followed a confirmation the
// user gave in chat. What the server CAN do is make drift visible, which is why
// createSuggestedTask() stamps every suggestion with the policy in force
// (lib/agentTools.ts → the `suggestion_created` analytics event).

import { getSetting } from "./store";

export type SuggestionPolicy = "ask_first" | "auto";

/** The app-wide suggestion policy. A missing/garbage key means `ask_first`. */
export function suggestionPolicy(): SuggestionPolicy {
  return getSetting("suggestion_policy") === "auto" ? "auto" : "ask_first";
}
