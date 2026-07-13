import { getSetting, setSetting } from "./store";
import { track } from "@/lib/analytics";

// First-run wizard state, persisted in the settings table so an abandoned setup
// resumes at the right step after a reload or restart. Distinct from the
// client-only UI prefs in localStorage — this must be readable server-side and
// shared across every browser that opens the instance.
//
// Keys:
//   onboarding_complete      "1" once finished or skipped
//   onboarding_step          the step to resume on: connect | verify
//   onboarding_method        how Claude was connected: subscription | api_key
//   onboarding_account       "email|plan" snapshot for the "Connected as …" line

export type OnbStep = "connect" | "verify";
const STEPS: OnbStep[] = ["connect", "verify"];

export interface OnboardingState {
  complete: boolean;
  step: OnbStep;
  method: "subscription" | "api_key" | null;
  account: { email: string | null; plan: string | null } | null;
}

export function getOnboarding(): OnboardingState {
  const step = getSetting("onboarding_step");
  const method = getSetting("onboarding_method");
  const acct = getSetting("onboarding_account");
  const [email, plan] = acct ? acct.split("|") : [null, null];
  return {
    complete: getSetting("onboarding_complete") === "1",
    step: STEPS.includes(step as OnbStep) ? (step as OnbStep) : "connect",
    method: method === "subscription" || method === "api_key" ? method : null,
    account: acct ? { email: email || null, plan: plan || null } : null,
  };
}

export function setOnboardingStep(step: OnbStep): void {
  if (STEPS.includes(step)) setSetting("onboarding_step", step);
}

export function setOnboardingMethod(method: "subscription" | "api_key"): void {
  setSetting("onboarding_method", method);
  // Funnel: the wizard's Connect step succeeded. Guarded to the first run so
  // reconnecting a different account later doesn't re-count the step.
  if (getSetting("onboarding_complete") !== "1")
    track("onboarding_step_completed", { step: "connect_claude", method });
}

export function setOnboardingAccount(email: string | null, plan: string | null): void {
  if (!email && !plan) setSetting("onboarding_account", null);
  else setSetting("onboarding_account", `${email ?? ""}|${plan ?? ""}`);
}

export function completeOnboarding(): void {
  setSetting("onboarding_complete", "1");
}

/** Re-run setup from Settings: clear completion + progress, keep the connection. */
export function resetOnboarding(): void {
  setSetting("onboarding_complete", null);
  setSetting("onboarding_step", null);
}
