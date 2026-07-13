"use client";

// Thin, safe wrappers around the posthog-js instance loaded by the <head>
// snippet (see lib/analytics.ts posthogSnippet). Everything no-ops when PostHog
// isn't loaded (analytics off, script blocked), so callers never guard.

type PostHog = {
  capture: (event: string, props?: Record<string, unknown>) => void;
  identify: (id: string, props?: Record<string, unknown>) => void;
  get_distinct_id?: () => string;
};

function ph(): PostHog | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { posthog?: PostHog }).posthog;
}

/** Fire a client-side product event (landing_viewed, early_access_requested, …). */
export function track(event: string, props?: Record<string, unknown>): void {
  try {
    ph()?.capture(event, props);
  } catch {
    /* posthog not ready / blocked — ignore */
  }
}

/**
 * Bind the current browser identity to a control-plane account id. Called on
 * signup so the anonymous landing session stitches to the account, and the same
 * id keys every server-side event from that user's container.
 */
export function identify(id: string, props?: Record<string, unknown>): void {
  try {
    ph()?.identify(id, props);
  } catch {
    /* ignore */
  }
}

/**
 * The browser's current PostHog distinct id ("" when PostHog isn't loaded).
 * Hand this to server endpoints that fire their own events (e.g. the demo
 * lead capture) so the server-side event lands on the SAME person as the
 * anonymous browser session — otherwise it would create an orphan identity.
 */
export function distinctId(): string {
  try {
    return ph()?.get_distinct_id?.() || "";
  } catch {
    return "";
  }
}
