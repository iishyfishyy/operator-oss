// Product analytics → ONE central PostHog project (cloud free tier).
//
// The whole fleet is many isolated containers, each with its own SQLite, so
// there is no shared server to aggregate on. Instead every container ships its
// events straight to a single PostHog project, stamped with the control-plane
// account id (ORCH_ACCOUNT_ID, injected at provision time) as the person's
// distinct_id. That makes every event — landing visit, signup, each turn — line
// up under one identity, and lets anonymous landing sessions stitch to the
// account the moment the browser calls posthog.identify() with the same id.
//
// Server-side capture is dependency-free (a fire-and-forget POST to the capture
// endpoint): more reliable than the browser SDK, and it catches headless
// turn-runner errors no page is watching. It no-ops unless POSTHOG_KEY is set,
// so local/self-host runs need zero config.

const KEY = process.env.POSTHOG_KEY || "";
const HOST = (process.env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/+$/, "");

/** Who this container's events belong to. In a provisioned instance this is the
 *  control-plane account id; a self-host/local run falls back to the slug (or a
 *  constant) so events still land under one stable identity. */
const ACCOUNT_ID = process.env.ORCH_ACCOUNT_ID || process.env.ORCH_SLUG || "self-hosted";

export function analyticsEnabled(): boolean {
  return !!KEY;
}

/**
 * Emit one product-analytics event to the central PostHog project. Keyed by the
 * container's account id unless `distinctId` overrides it (the control plane
 * emits `signed_up` under the brand-new account's id, since it runs in its own
 * container, not the user's). `setPerson` sets person properties ($set).
 *
 * Fire-and-forget: a telemetry hiccup must never break a turn or a request, so
 * we never await and swallow every failure.
 */
export function track(
  event: string,
  properties: Record<string, unknown> = {},
  opts: { distinctId?: string; setPerson?: Record<string, unknown> } = {},
): void {
  if (!KEY) return;
  const distinctId = opts.distinctId || ACCOUNT_ID;
  const props: Record<string, unknown> = {
    ...properties,
    $lib: "orchestrator-server",
    // Carry the container's own account id even when distinctId is overridden
    // (signup), so events can still be grouped by the instance that emitted them.
    account_id: process.env.ORCH_ACCOUNT_ID || undefined,
  };
  if (opts.setPerson) props.$set = opts.setPerson;
  const body = JSON.stringify({ api_key: KEY, event, distinct_id: distinctId, properties: props });
  try {
    void fetch(`${HOST}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // fetch itself can throw synchronously in rare runtimes — never propagate.
  }
}

/** Public config for the browser snippet (see posthogSnippet). The PostHog
 *  project API key is a write-only ingest key and safe to expose client-side. */
export function analyticsClientConfig(): { key: string; host: string; accountId: string } {
  return { key: KEY, host: HOST, accountId: process.env.ORCH_ACCOUNT_ID || "" };
}

/**
 * The inline PostHog browser snippet for <head>, with the key/host baked in
 * server-side so no build-time NEXT_PUBLIC_ var is needed. Returns "" (nothing
 * rendered) when analytics is off. When the container knows its account id (a
 * provisioned user instance) it auto-identifies, so the app's browser sessions
 * — on every device — resolve to one person profile. The control-plane landing
 * has no account id, so it stays anonymous until the signup page identifies.
 */
export function posthogSnippet(): string {
  if (!KEY) return "";
  const accountId = process.env.ORCH_ACCOUNT_ID || "";
  // Official PostHog loader (2026-05 snippet). array.js is served from the
  // assets host (derived from api_host: us.i.posthog.com -> us-assets.i.posthog.com;
  // a self-hosted host is unchanged and serves it from /static itself).
  const loader = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="ki Ci init qi Hi pr ji zi Di capture calculateEventProperties Qi register register_once register_for_session unregister unregister_for_session Ki getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Xi identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty Ji Gi createPersonProfile setInternalOrTestUser Yi Ai rn opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing Vi debug mr it getPageViewId captureTraceFeedback captureTraceMetric Oi".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;
  // defaults:'2026-05-30' turns on the modern bundle (autocapture, $pageview,
  // $pageleave — the retention/time-in-app signals we want) so we don't hand-set them.
  const init = `posthog.init(${JSON.stringify(KEY)},{api_host:${JSON.stringify(HOST)},defaults:"2026-05-30",person_profiles:"identified_only"});`;
  // A provisioned instance identifies itself so app usage attributes to the
  // person; the landing stays anonymous (identify happens at signup).
  const id = accountId ? `posthog.identify(${JSON.stringify(accountId)});` : "";
  return loader + init + id;
}
